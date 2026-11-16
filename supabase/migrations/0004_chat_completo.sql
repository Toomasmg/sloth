-- =====================================================================
-- Sloth · Chat del equipo — editar, borrar, responder, reaccionar, «escribiendo…», «visto»,
-- borrado automático por equipo y vaciar una conversación
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
--  * Borrado automático y vaciar: solo por RPC (chat_set_retention, chat_clear), que chequean el rol y
--    dejan un aviso en la conversación. La API no puede escribir `teams.retention_hours` ni `messages.kind`.
--    Los mensajes vencidos los oculta la RLS al instante; chat_purge_expired los borra de verdad.
-- =====================================================================

alter table public.messages add column if not exists edited_at timestamptz;
alter table public.messages add column if not exists deleted_at timestamptz;
alter table public.messages add column if not exists reply_to uuid references public.messages (id) on delete set null;
-- Sin este índice, cada fila borrada (vaciar, purgar, cascada de un equipo) recorre toda la tabla
-- buscando quién le respondía para el `on delete set null`.
create index if not exists messages_reply_to_idx on public.messages (reply_to) where reply_to is not null;
-- 'text' es un mensaje común; 'retention' y 'clear' son avisos que solo dejan las RPC de abajo.
alter table public.messages add column if not exists kind text not null default 'text';
alter table public.messages drop constraint if exists messages_kind_ok;
alter table public.messages add constraint messages_kind_ok check (kind in ('text', 'retention', 'clear'));

-- Borrado automático del equipo, en horas. null = apagado.
alter table public.teams add column if not exists retention_hours integer;
alter table public.teams drop constraint if exists teams_retention_ok;
alter table public.teams add constraint teams_retention_ok check (retention_hours is null or retention_hours in (24, 168, 720, 2160));

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
  if old.kind <> 'text' then
    raise exception 'Los avisos de la conversación no se editan.';
  end if;
  if (select count(*) from public.messages
      where author_id = old.author_id and edited_at > now() - interval '1 minute') >= 30 then
    raise exception 'Demasiadas ediciones seguidas: esperá un minuto.';
  end if;
  new.id := old.id;
  new.kind := old.kind;
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
-- Alta por columnas: `kind` queda en 'text' para todo lo que llega por la API.
revoke insert on public.messages from authenticated;
grant insert (team_id, thread_id, client_id, body, reply_to) on public.messages to authenticated;
-- El borrado automático se cambia solo con chat_set_retention, que deja el aviso.
revoke update on public.teams from authenticated;
grant update (name, description, photo_path) on public.teams to authenticated;

-- ¿Sigue vivo un mensaje de equipo según su borrado automático? (true si está apagado)
create or replace function public.team_message_alive(p_team uuid, p_at timestamptz) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p_at > now() - make_interval(hours => t.retention_hours) from public.teams t where t.id = p_team),
    true)
$$;
revoke execute on function public.team_message_alive(uuid, timestamptz) from public, anon;
grant execute on function public.team_message_alive(uuid, timestamptz) to authenticated;

-- Los vencidos desaparecen para todos al instante, aunque todavía no se hayan purgado.
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
  using ((team_id is not null and public.is_team_member(team_id) and public.team_message_alive(team_id, created_at))
         or (thread_id is not null and public.is_thread_participant(thread_id)));

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
      and m.kind = 'text'
      and ((m.team_id is not null and public.is_team_member(m.team_id) and public.team_message_alive(m.team_id, m.created_at))
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
        'reply_to', new.reply_to,
        'kind', new.kind
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

-- Última vez que cada uno avisó «escribiendo…»: tope de uno cada 2 s aunque el cliente no lo respete.
-- Sin políticas: solo la toca chat_typing.
create table if not exists public.chat_typing_last (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  at      timestamptz not null
);
alter table public.chat_typing_last enable row level security;
revoke all on public.chat_typing_last from anon, authenticated;

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
  else
    if not public.is_thread_participant(p_thread) then
      raise exception 'No participás de esa conversación.';
    end if;
  end if;
  insert into public.chat_typing_last (user_id, at) values (auth.uid(), now())
    on conflict (user_id) do update set at = excluded.at
    where public.chat_typing_last.at <= now() - interval '2 seconds';
  if not found then
    return;
  end if;
  if p_team is not null then
    perform realtime.send(jsonb_build_object('user_id', auth.uid()), 'typing', 'team:' || p_team::text, true);
  else
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
-- No leídos: los borrados y los avisos no cuentan.
-- ---------------------------------------------------------------------

create or replace function public.unread_counts()
returns table (kind text, id uuid, unread integer, last_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select 'team'::text, m.team_id,
         (select count(*)::int from (select 1 from public.messages x
            where x.team_id = m.team_id and x.created_at > m.last_read_at and x.author_id <> auth.uid()
              and x.deleted_at is null and x.kind = 'text' and public.team_message_alive(x.team_id, x.created_at) limit 99) s),
         (select max(x.created_at) from public.messages x
            where x.team_id = m.team_id and public.team_message_alive(x.team_id, x.created_at))
    from public.team_members m where m.user_id = auth.uid()
  union all
  select 'dm'::text, t.id,
         (select count(*)::int from (select 1 from public.messages x
            where x.thread_id = t.id
              and x.created_at > case when t.user_a = auth.uid() then t.last_read_a else t.last_read_b end
              and x.author_id <> auth.uid() and x.deleted_at is null and x.kind = 'text' limit 99) s),
         (select max(x.created_at) from public.messages x where x.thread_id = t.id)
    from public.dm_threads t where auth.uid() in (t.user_a, t.user_b)
$$;

-- ---------------------------------------------------------------------
-- Borrado automático y vaciar una conversación
-- En un equipo los cambian owner o admin; en un DM, cualquiera de los dos. Queda un aviso en la
-- conversación (kind 'retention' o 'clear') a nombre de quien lo hizo, que llega a todos por Realtime.
-- ---------------------------------------------------------------------

create or replace function public.can_manage_conversation(p_team uuid, p_thread uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when num_nonnulls(p_team, p_thread) <> 1 then false
    when p_team is not null then coalesce(public.team_role(p_team) in ('owner', 'admin'), false)
    else public.is_thread_participant(p_thread)
  end
$$;
revoke execute on function public.can_manage_conversation(uuid, uuid) from public, anon;
grant execute on function public.can_manage_conversation(uuid, uuid) to authenticated;

create or replace function public.chat_set_retention(p_team uuid, p_hours integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Iniciá sesión.';
  end if;
  if p_hours is not null and p_hours not in (24, 168, 720, 2160) then
    raise exception 'Plazo inválido.';
  end if;
  if p_team is null or not public.is_team_member(p_team) then
    raise exception 'No sos miembro de ese equipo.';
  end if;
  if not public.can_manage_conversation(p_team, null) then
    raise exception 'Solo owner o admin pueden cambiar el borrado automático.';
  end if;
  update public.teams set retention_hours = p_hours
    where id = p_team and retention_hours is distinct from p_hours;
  if not found then
    return;
  end if;
  insert into public.messages (team_id, client_id, body, kind)
    values (p_team, gen_random_uuid(), coalesce(p_hours, 0)::text, 'retention');
end
$$;
revoke execute on function public.chat_set_retention(uuid, integer) from public, anon;
grant execute on function public.chat_set_retention(uuid, integer) to authenticated;

-- Borra de verdad todos los mensajes (las reacciones caen en cascada) y deja el aviso.
create or replace function public.chat_clear(p_team uuid default null, p_thread uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Iniciá sesión.';
  end if;
  if num_nonnulls(p_team, p_thread) <> 1 then
    raise exception 'Conversación inválida.';
  end if;
  if p_team is not null and not public.is_team_member(p_team) then
    raise exception 'No sos miembro de ese equipo.';
  end if;
  if p_thread is not null and not public.is_thread_participant(p_thread) then
    raise exception 'No participás de esa conversación.';
  end if;
  if not public.can_manage_conversation(p_team, p_thread) then
    raise exception 'Solo owner o admin pueden vaciar la conversación del equipo.';
  end if;
  if p_team is not null then
    delete from public.messages where team_id = p_team;
    insert into public.messages (team_id, client_id, body, kind) values (p_team, gen_random_uuid(), 'clear', 'clear');
  else
    delete from public.messages where thread_id = p_thread;
    insert into public.messages (thread_id, client_id, body, kind) values (p_thread, gen_random_uuid(), 'clear', 'clear');
  end if;
end
$$;
revoke execute on function public.chat_clear(uuid, uuid) from public, anon;
grant execute on function public.chat_clear(uuid, uuid) to authenticated;

-- Purga de los vencidos en los equipos de quien llama. La app la corre al conectarse y cada hora.
create or replace function public.chat_purge_expired() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  if auth.uid() is null then
    raise exception 'Iniciá sesión.';
  end if;
  delete from public.messages m
    using public.teams t, public.team_members tm
    where m.team_id = t.id
      and tm.team_id = t.id and tm.user_id = auth.uid()
      and t.retention_hours is not null
      and m.created_at <= now() - make_interval(hours => t.retention_hours);
  get diagnostics n = row_count;
  return n;
end
$$;
revoke execute on function public.chat_purge_expired() from public, anon;
grant execute on function public.chat_purge_expired() to authenticated;

-- La misma purga para todos los equipos: es para pg_cron, nadie la llama por la API.
create or replace function public.chat_purge_expired_all() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  delete from public.messages m
    using public.teams t
    where m.team_id = t.id
      and t.retention_hours is not null
      and m.created_at <= now() - make_interval(hours => t.retention_hours);
  get diagnostics n = row_count;
  return n;
end
$$;
revoke execute on function public.chat_purge_expired_all() from public, anon, authenticated;

-- Con pg_cron la purga corre sola cada hora; sin él alcanza con la que piden los clientes.
-- Si pg_cron se activa después, hay que volver a correr este bloque (o toda la 0004) para agendarla.
do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    perform cron.schedule('sloth-chat-purge', '17 * * * *', 'select public.chat_purge_expired_all()');
  end if;
exception when others then
  raise warning 'sloth: no se pudo agendar la purga con pg_cron (%)', sqlstate;
end
$$;
