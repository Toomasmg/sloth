-- =====================================================================
-- Sloth · Chat del equipo — editar, borrar, responder, reaccionar, «escribiendo…» y «visto»
-- Correr en el SQL Editor DESPUÉS de 0001, 0002 y 0003. Es idempotente. Se aplica a mano: la app
-- detecta si está y, si no, sigue andando como antes.
--
-- Seguridad:
--  * Editar y borrar: solo el autor, y solo las columnas `body` y `deleted_at` (permiso por columna).
--    El trigger guard_message_update repone todo lo demás desde la fila vieja y pone las horas.
--  * El borrado es blando: queda la fila con el cuerpo vacío. Ya no hay DELETE directo.
--  * Reacciones: cada uno agrega o saca solo las suyas, sobre mensajes que puede ver, de una lista fija.
--  * Lo que se publica por Broadcast lo manda la base desde triggers o desde chat_typing, que chequea
--    la membresía; ningún cliente publica directo en los tópicos del chat.
--  * Los clientes viejos siguen andando: el evento 'message' trae claves de más que ignoran.
-- =====================================================================

alter table public.messages add column if not exists edited_at timestamptz;
alter table public.messages add column if not exists deleted_at timestamptz;
alter table public.messages add column if not exists reply_to uuid references public.messages (id) on delete set null;

alter table public.messages drop constraint if exists messages_body_check;
alter table public.messages drop constraint if exists messages_body_ok;
alter table public.messages add constraint messages_body_ok check (
  (deleted_at is null and char_length(body) between 1 and 4000 and btrim(body) <> '')
  or (deleted_at is not null and body = '')
);

-- Alta: la hora y el autor los pone el servidor, tope de 30 por minuto, y la respuesta tiene que ser
-- a un mensaje vivo de la misma conversación.
create or replace function public.guard_message() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.created_at := now();
  new.author_id := auth.uid();
  new.edited_at := null;
  new.deleted_at := null;
  if (select count(*) from public.messages
      where author_id = new.author_id and created_at > now() - interval '1 minute') >= 30 then
    raise exception 'Demasiados mensajes seguidos: esperá un minuto.';
  end if;
  if new.reply_to is not null and not exists (
    select 1 from public.messages r
    where r.id = new.reply_to
      and r.team_id is not distinct from new.team_id
      and r.thread_id is not distinct from new.thread_id
      and r.deleted_at is null
  ) then
    raise exception 'Solo podés responder a un mensaje de esta conversación.';
  end if;
  return new;
end
$$;

-- Edición o borrado: solo cambian el cuerpo y el borrado; las horas las pone el servidor.
create or replace function public.guard_message_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- `reply_to` no se puede tocar desde la API (permiso por columna): si pasa a null es el
  -- `on delete set null` de la FK al borrarse de verdad el mensaje respondido, y hay que dejarlo.
  if old.reply_to is not null and new.reply_to is null then
    return new;
  end if;
  if old.deleted_at is not null then
    raise exception 'Ese mensaje ya se eliminó.';
  end if;
  new.id := old.id;
  new.author_id := old.author_id;
  new.client_id := old.client_id;
  new.team_id := old.team_id;
  new.thread_id := old.thread_id;
  new.created_at := old.created_at;
  new.reply_to := old.reply_to;
  if new.deleted_at is not null then
    new.deleted_at := now();
    new.body := '';
    new.edited_at := old.edited_at;
  elsif new.body is distinct from old.body then
    new.edited_at := now();
  else
    new.edited_at := old.edited_at;
  end if;
  return new;
end
$$;
drop trigger if exists message_update_guard on public.messages;
create trigger message_update_guard before update on public.messages
  for each row execute function public.guard_message_update();

drop policy if exists messages_delete on public.messages;
drop policy if exists messages_update on public.messages;
create policy messages_update on public.messages for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());
revoke update, delete on public.messages from authenticated;
grant update (body, deleted_at) on public.messages to authenticated;

-- ---------------------------------------------------------------------
-- Reacciones
-- ---------------------------------------------------------------------

create table if not exists public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  emoji      text not null check (emoji in ('👍', '❤️', '😂', '🎉', '😮', '😢', '🙏', '👀')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

-- ¿El usuario ve este mensaje y sigue vivo? (mismas reglas que messages_select)
create or replace function public.can_see_message(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.messages m
    where m.id = p_id
      and m.deleted_at is null
      and ((m.team_id is not null and public.is_team_member(m.team_id))
           or (m.thread_id is not null and public.is_thread_participant(m.thread_id)))
  )
$$;
revoke execute on function public.can_see_message(uuid) from public, anon;
grant execute on function public.can_see_message(uuid) to authenticated;

create or replace function public.guard_reaction() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.user_id := auth.uid();
  new.created_at := now();
  if (select count(*) from public.message_reactions
      where user_id = new.user_id and created_at > now() - interval '1 minute') >= 60 then
    raise exception 'Demasiadas reacciones seguidas: esperá un minuto.';
  end if;
  return new;
end
$$;
drop trigger if exists reaction_guard on public.message_reactions;
create trigger reaction_guard before insert on public.message_reactions
  for each row execute function public.guard_reaction();

alter table public.message_reactions enable row level security;

drop policy if exists reactions_select on public.message_reactions;
create policy reactions_select on public.message_reactions for select to authenticated
  using (public.can_see_message(message_id));
drop policy if exists reactions_insert on public.message_reactions;
create policy reactions_insert on public.message_reactions for insert to authenticated
  with check (user_id = auth.uid() and public.can_see_message(message_id));
drop policy if exists reactions_delete on public.message_reactions;
create policy reactions_delete on public.message_reactions for delete to authenticated
  using (user_id = auth.uid());

revoke all on public.message_reactions from anon;
revoke update on public.message_reactions from authenticated;

-- ---------------------------------------------------------------------
-- Broadcast
-- ---------------------------------------------------------------------

-- Alta → 'message' (igual que 0003); edición o borrado → 'message_update'. Al borrar se van sus reacciones.
create or replace function public.broadcast_message() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.deleted_at is not null then
    delete from public.message_reactions where message_id = new.id;
  end if;
  begin
    perform realtime.send(
      jsonb_build_object(
        'id', new.id,
        'client_id', new.client_id,
        'team_id', new.team_id,
        'thread_id', new.thread_id,
        'author_id', new.author_id,
        'body', new.body,
        'created_at', new.created_at,
        'edited_at', new.edited_at,
        'deleted_at', new.deleted_at,
        'reply_to', new.reply_to
      ),
      case when tg_op = 'UPDATE' then 'message_update' else 'message' end,
      case when new.team_id is not null then 'team:' || new.team_id::text else 'thread:' || new.thread_id::text end,
      true
    );
  exception when others then
    raise warning 'sloth: broadcast_message falló (%), queda postgres_changes', sqlstate;
  end;
  return null;
end
$$;

drop trigger if exists message_broadcast on public.messages;
create trigger message_broadcast after insert on public.messages
  for each row execute function public.broadcast_message();
drop trigger if exists message_broadcast_update on public.messages;
create trigger message_broadcast_update after update on public.messages
  for each row execute function public.broadcast_message();

create or replace function public.broadcast_reaction() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  m record;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  select team_id, thread_id into m from public.messages where id = r.message_id;
  if not found then
    return null;
  end if;
  begin
    perform realtime.send(
      jsonb_build_object(
        'message_id', r.message_id,
        'user_id', r.user_id,
        'emoji', r.emoji,
        'op', case when tg_op = 'DELETE' then 'remove' else 'add' end
      ),
      'reaction',
      case when m.team_id is not null then 'team:' || m.team_id::text else 'thread:' || m.thread_id::text end,
      true
    );
  exception when others then
    raise warning 'sloth: broadcast_reaction falló (%)', sqlstate;
  end;
  return null;
end
$$;

drop trigger if exists reaction_broadcast on public.message_reactions;
create trigger reaction_broadcast after insert or delete on public.message_reactions
  for each row execute function public.broadcast_reaction();

-- «Visto» en los DMs: avisa cuando cambia la última lectura de cada lado.
create or replace function public.broadcast_read() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.last_read_a is distinct from old.last_read_a then
      perform realtime.send(
        jsonb_build_object('user_id', new.user_a, 'at', new.last_read_a),
        'read', 'thread:' || new.id::text, true);
    end if;
    if new.last_read_b is distinct from old.last_read_b then
      perform realtime.send(
        jsonb_build_object('user_id', new.user_b, 'at', new.last_read_b),
        'read', 'thread:' || new.id::text, true);
    end if;
  exception when others then
    raise warning 'sloth: broadcast_read falló (%)', sqlstate;
  end;
  return null;
end
$$;

drop trigger if exists thread_read_broadcast on public.dm_threads;
create trigger thread_read_broadcast after update of last_read_a, last_read_b on public.dm_threads
  for each row execute function public.broadcast_read();

-- «Escribiendo…»: lo publica la base después de chequear que el usuario está en la conversación.
create or replace function public.chat_typing(p_team uuid default null, p_thread uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Iniciá sesión.';
  end if;
  if num_nonnulls(p_team, p_thread) <> 1 then
    raise exception 'Conversación inválida.';
  end if;
  if p_team is not null then
    if not public.is_team_member(p_team) then
      raise exception 'No sos miembro de ese equipo.';
    end if;
    perform realtime.send(jsonb_build_object('user_id', auth.uid()), 'typing', 'team:' || p_team::text, true);
  else
    if not public.is_thread_participant(p_thread) then
      raise exception 'No participás de esa conversación.';
    end if;
    perform realtime.send(jsonb_build_object('user_id', auth.uid()), 'typing', 'thread:' || p_thread::text, true);
  end if;
end
$$;
revoke execute on function public.chat_typing(uuid, uuid) from public, anon;
grant execute on function public.chat_typing(uuid, uuid) to authenticated;

revoke execute on function
  public.guard_message(),
  public.guard_message_update(),
  public.guard_reaction(),
  public.broadcast_message(),
  public.broadcast_reaction(),
  public.broadcast_read()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- No leídos: los borrados no cuentan.
-- ---------------------------------------------------------------------

create or replace function public.unread_counts()
returns table (kind text, id uuid, unread integer, last_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select 'team'::text, m.team_id,
         (select count(*)::int from (select 1 from public.messages x
            where x.team_id = m.team_id and x.created_at > m.last_read_at and x.author_id <> auth.uid()
              and x.deleted_at is null limit 99) s),
         (select max(x.created_at) from public.messages x where x.team_id = m.team_id)
    from public.team_members m where m.user_id = auth.uid()
  union all
  select 'dm'::text, t.id,
         (select count(*)::int from (select 1 from public.messages x
            where x.thread_id = t.id
              and x.created_at > case when t.user_a = auth.uid() then t.last_read_a else t.last_read_b end
              and x.author_id <> auth.uid() and x.deleted_at is null limit 99) s),
         (select max(x.created_at) from public.messages x where x.thread_id = t.id)
    from public.dm_threads t where auth.uid() in (t.user_a, t.user_b)
$$;
