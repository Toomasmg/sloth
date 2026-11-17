-- =====================================================================
-- Sloth · Chat del equipo — 0008: abusos
-- Correr en el SQL Editor DESPUÉS de 0001–0007. Es idempotente. Se aplica a mano.
-- Si volvés a correr cualquiera de 0001–0007, corré esta otra vez después: aquellas pisan funciones
-- y políticas de esta, y vuelven los topes viejos, el vaciado de DM para los dos y los DMs sin equipo.
--
-- Qué cierra:
--  * Los topes de mensajes, ediciones y reacciones contaban filas: vaciar o borrar los reiniciaba.
--    Ahora van en chat_rate, que nadie lee ni escribe por la API. También hay topes para el aviso de
--    «visto», vaciar, borrado automático, invitaciones y abrir DMs nuevos. Entrar a un equipo tiene
--    tope para los intentos que entran; los códigos falsos no lo gastan (el código tiene 64 bits).
--  * Vaciar un DM borraba la conversación del otro. Ahora la oculta solo para quien vacía; las filas
--    se borran de verdad cuando vaciaron los dos (hasta la marca más vieja).
--  * Un DM con alguien que ya no comparte equipo se puede leer, pero no escribir, editar, reaccionar
--    ni avisar «escribiendo…».
--  * Las invitaciones vencen a los 7 días (tope de 50 pendientes por equipo). El código vence a los
--    7 días y sirve para 50 altas; regenerarlo o expulsar a alguien lo repone.
--  * El SELECT de Broadcast queda atado al tópico del canal, y al expulsar a alguien la base avisa
--    'member_removed' en el tópico del equipo para que su app cierre el canal.
--
-- Cliente viejo:
--  * Vaciar un DM lo vacía solo para quien lo hace y ya no deja el aviso «se vació», aunque su botón
--    diga «Vaciar para todos».
--  * Las invitaciones y los códigos vencidos fallan con un mensaje que dice qué pasó.
--  * El evento 'member_removed' lo ignora: el expulsado sigue con el canal abierto hasta reconectar.
--
-- Para cortar antes el Broadcast de un expulsado que no actualiza la app, bajá Auth → JWT expiry
-- (por ejemplo a 600 s): Realtime vuelve a chequear el permiso al renovar el token.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Topes por usuario que no se reinician
-- ---------------------------------------------------------------------

-- Sin FK a profiles: un usuario sin perfil tiraría la FK en vez del error que corresponde.
create table if not exists public.chat_rate (
  user_id      uuid not null,
  kind         text not null,
  window_start timestamptz not null,
  n            integer not null,
  primary key (user_id, kind)
);
alter table public.chat_rate enable row level security;
revoke all on public.chat_rate from anon, authenticated;

-- Ventana fija por (usuario, tipo). Si quien llama falla después, el rollback deshace la cuenta: los
-- intentos fallidos no gastan tope. Sin usuario (pg_cron, SQL Editor) no hay tope.
create or replace function public.chat_rate_hit(p_kind text, p_max integer, p_secs integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_n integer;
begin
  if auth.uid() is null then
    return true;
  end if;
  insert into public.chat_rate as r (user_id, kind, window_start, n)
    values (auth.uid(), p_kind, now(), 1)
    on conflict (user_id, kind) do update set
      n = case when r.window_start <= now() - make_interval(secs => p_secs) then 1 else r.n + 1 end,
      window_start = case when r.window_start <= now() - make_interval(secs => p_secs) then now() else r.window_start end
    returning n into v_n;
  return v_n <= p_max;
end
$$;
revoke execute on function public.chat_rate_hit(text, integer, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Mensajes
-- ---------------------------------------------------------------------

-- Falso si el otro participante del DM ya no comparte equipo con quien llama. Sin usuario o sin ser
-- participante da verdadero: eso lo frenan la RLS y los otros chequeos.
create or replace function public.dm_writable(p_thread uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select public.shares_team(case when t.user_a = auth.uid() then t.user_b else t.user_a end)
                     from public.dm_threads t
                     where t.id = p_thread and auth.uid() in (t.user_a, t.user_b)), true)
$$;
revoke execute on function public.dm_writable(uuid) from public, anon, authenticated;

create or replace function public.guard_message() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.created_at := now();
  new.author_id := auth.uid();
  new.edited_at := null;
  new.deleted_at := null;
  if not public.chat_rate_hit('msg', 30, 60) or not public.chat_rate_hit('msg_h', 500, 3600) then
    raise exception 'Demasiados mensajes seguidos: esperá un minuto.';
  end if;
  if new.thread_id is not null and not public.dm_writable(new.thread_id) then
    raise exception 'Ya no comparten equipo: no se pueden mandar mensajes directos.';
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
  -- Borrar un mensaje propio queda libre; cambiarle el texto le llega al otro como uno nuevo.
  if old.thread_id is not null and new.deleted_at is null and new.body is distinct from old.body
     and not public.dm_writable(old.thread_id) then
    raise exception 'Ya no comparten equipo: no se pueden editar mensajes directos.';
  end if;
  if not public.chat_rate_hit('edit', 30, 60) then
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

-- ---------------------------------------------------------------------
-- Reacciones: poner y sacar cuentan para el mismo tope
-- ---------------------------------------------------------------------

create or replace function public.guard_reaction() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.user_id := auth.uid();
  new.created_at := now();
  if exists (select 1 from public.messages m
             where m.id = new.message_id and m.thread_id is not null and not public.dm_writable(m.thread_id)) then
    raise exception 'Ya no comparten equipo: no se puede reaccionar en mensajes directos.';
  end if;
  if not public.chat_rate_hit('react', 60, 60) then
    raise exception 'Demasiadas reacciones seguidas: esperá un minuto.';
  end if;
  return new;
end
$$;

-- Solo el DELETE que hace el usuario: la cascada al vaciar o borrar un mensaje y el que hace
-- broadcast_message al borrar blando corren con pg_trigger_depth() > 1.
create or replace function public.guard_reaction_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() = 1 and auth.uid() is not null and not public.chat_rate_hit('react', 60, 60) then
    raise exception 'Demasiadas reacciones seguidas: esperá un minuto.';
  end if;
  return old;
end
$$;
drop trigger if exists reaction_guard_delete on public.message_reactions;
create trigger reaction_guard_delete before delete on public.message_reactions
  for each row execute function public.guard_reaction_delete();

-- ---------------------------------------------------------------------
-- «Visto», DMs nuevos y borrado automático
-- ---------------------------------------------------------------------

-- La marca se guarda siempre: si no, vuelven los no leídos de lo que ya se leyó. El tope es solo para el
-- aviso «visto» que le llega al otro del DM, y pasado el tope no falla porque la app lo llama sola.
create or replace function public.mark_read(p_team uuid default null, p_thread uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Iniciá sesión.'; end if;
  if p_team is not null then
    update public.team_members set last_read_at = now() where team_id = p_team and user_id = auth.uid();
  end if;
  if p_thread is not null then
    if not public.chat_rate_hit('read', 120, 60) then
      perform set_config('sloth.read_quiet', 'on', true);
    end if;
    update public.dm_threads set last_read_a = now() where id = p_thread and user_a = auth.uid();
    update public.dm_threads set last_read_b = now() where id = p_thread and user_b = auth.uid();
    perform set_config('sloth.read_quiet', '', true);
  end if;
end
$$;

-- Igual que en 0004, salvo que no avisa cuando mark_read pasó su tope.
create or replace function public.broadcast_read() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('sloth.read_quiet', true) = 'on' then
    return null;
  end if;
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

-- Igual que en 0004, salvo que un DM sin equipo en común no recibe «escribiendo…». Sin error: la app lo llama sola.
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
    if not public.dm_writable(p_thread) then
      return;
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

create or replace function public.open_dm(p_other uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_a uuid := least(auth.uid(), p_other);
  v_b uuid := greatest(auth.uid(), p_other);
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Iniciá sesión.'; end if;
  if p_other is null or p_other = auth.uid() then raise exception 'Elegí a otra persona.'; end if;
  select id into v_id from public.dm_threads where user_a = v_a and user_b = v_b;
  if v_id is not null then return v_id; end if;
  if not public.shares_team(p_other) then raise exception 'Solo podés escribirle a gente de tus equipos.'; end if;
  if not public.chat_rate_hit('dm_new', 20, 3600) then
    raise exception 'Abriste demasiadas conversaciones nuevas: esperá un rato.';
  end if;
  insert into public.dm_threads (user_a, user_b) values (v_a, v_b)
    on conflict (user_a, user_b) do nothing returning id into v_id;
  if v_id is null then select id into v_id from public.dm_threads where user_a = v_a and user_b = v_b; end if;
  return v_id;
end
$$;

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
  if not public.chat_rate_hit('manage', 10, 3600) then
    raise exception 'Demasiados cambios seguidos: esperá un rato.';
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

-- ---------------------------------------------------------------------
-- Vaciar un DM es solo para quien lo vacía
-- El otro participante puede ver en dm_threads que lo vaciaste (cleared_a / cleared_b): aceptado.
-- ---------------------------------------------------------------------

alter table public.dm_threads
  add column if not exists cleared_a timestamptz,
  add column if not exists cleared_b timestamptz;

create or replace function public.dm_cleared_at(p_thread uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select case when t.user_a = auth.uid() then t.cleared_a when t.user_b = auth.uid() then t.cleared_b end
    from public.dm_threads t where t.id = p_thread
$$;
revoke execute on function public.dm_cleared_at(uuid) from public, anon;
grant execute on function public.dm_cleared_at(uuid) to authenticated;

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
  using ((team_id is not null and public.is_team_member(team_id) and public.team_message_alive(team_id, created_at))
         or (thread_id is not null and public.is_thread_participant(thread_id)
             and created_at > coalesce(public.dm_cleared_at(thread_id), '-infinity')));

create or replace function public.can_see_message(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.messages m
    where m.id = p_id
      and m.deleted_at is null
      and m.kind = 'text'
      and ((m.team_id is not null and public.is_team_member(m.team_id) and public.team_message_alive(m.team_id, m.created_at))
           or (m.thread_id is not null and public.is_thread_participant(m.thread_id)
               and m.created_at > coalesce(public.dm_cleared_at(m.thread_id), '-infinity')))
  )
$$;

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
              and x.created_at > coalesce(case when t.user_a = auth.uid() then t.cleared_a else t.cleared_b end, '-infinity')
              and x.author_id <> auth.uid() and x.deleted_at is null and x.kind = 'text' limit 99) s),
         (select max(x.created_at) from public.messages x
            where x.thread_id = t.id
              and x.created_at > coalesce(case when t.user_a = auth.uid() then t.cleared_a else t.cleared_b end, '-infinity'))
    from public.dm_threads t where auth.uid() in (t.user_a, t.user_b)
$$;

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
  if not public.chat_rate_hit('manage', 10, 3600) then
    raise exception 'Demasiados cambios seguidos: esperá un rato.';
  end if;
  if p_team is not null then
    delete from public.messages where team_id = p_team;
    insert into public.messages (team_id, client_id, body, kind) values (p_team, gen_random_uuid(), 'clear', 'clear');
  else
    update public.dm_threads set cleared_a = now(), last_read_a = now() where id = p_thread and user_a = auth.uid();
    update public.dm_threads set cleared_b = now(), last_read_b = now() where id = p_thread and user_b = auth.uid();
    -- Lo que ya vaciaron los dos no lo ve nadie: se borra de verdad.
    delete from public.messages m
      using public.dm_threads t
      where t.id = p_thread and m.thread_id = p_thread
        and t.cleared_a is not null and t.cleared_b is not null
        and m.created_at <= least(t.cleared_a, t.cleared_b);
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- Invitaciones con vencimiento
-- ---------------------------------------------------------------------

alter table public.team_invites
  add column if not exists expires_at timestamptz not null default (now() + interval '7 days');

create or replace function public.guard_invite() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.created_at := now();
  new.expires_at := now() + interval '7 days';
  new.invited_by := auth.uid();
  -- Sin esto, reinvitar a alguien con la invitación vencida chocaría con el unique (equipo, login).
  delete from public.team_invites where team_id = new.team_id and expires_at <= now();
  if not public.chat_rate_hit('invite', 20, 3600) then
    raise exception 'Demasiadas invitaciones seguidas: esperá un rato.';
  end if;
  if (select count(*) from public.team_invites where team_id = new.team_id and expires_at > now()) >= 50 then
    raise exception 'El equipo tiene 50 invitaciones pendientes: borrá alguna.';
  end if;
  return new;
end
$$;
drop trigger if exists invite_guard on public.team_invites;
create trigger invite_guard before insert on public.team_invites
  for each row execute function public.guard_invite();

drop policy if exists invites_select on public.team_invites;
create policy invites_select on public.team_invites for select to authenticated
  using (expires_at > now() and (public.is_team_member(team_id) or github_login_lower = public.my_login()));

drop policy if exists teams_select on public.teams;
create policy teams_select on public.teams for select to authenticated
  using (public.is_team_member(id)
         or exists (select 1 from public.team_invites i
                    where i.team_id = teams.id and i.github_login_lower = public.my_login() and i.expires_at > now()));

create or replace function public.can_see_profile(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_id = auth.uid()
      or public.shares_team(p_id)
      or exists (select 1 from public.dm_threads t
                 where (t.user_a = auth.uid() and t.user_b = p_id) or (t.user_b = auth.uid() and t.user_a = p_id))
      or exists (select 1 from public.team_invites i
                 where i.invited_by = p_id and i.github_login_lower = public.my_login() and i.expires_at > now())
$$;

create or replace function public.accept_invite(p_invite uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_team uuid;
  v_exp timestamptz;
begin
  if auth.uid() is null then raise exception 'Iniciá sesión.'; end if;
  if not public.chat_rate_hit('join', 10, 60) then
    raise exception 'Demasiados intentos seguidos: esperá un minuto.';
  end if;
  select team_id, expires_at into v_team, v_exp from public.team_invites
    where id = p_invite and github_login_lower = public.my_login();
  if v_team is null then raise exception 'Esa invitación no es para vos o ya no existe.'; end if;
  if v_exp <= now() then raise exception 'Esa invitación venció: pedí una nueva.'; end if;
  insert into public.team_members (team_id, user_id, role) values (v_team, auth.uid(), 'member')
    on conflict do nothing;
  delete from public.team_invites where id = p_invite;
  return v_team;
end
$$;

-- ---------------------------------------------------------------------
-- Código de invitación con vencimiento y usos
-- ---------------------------------------------------------------------

alter table public.team_invite_codes
  add column if not exists expires_at timestamptz not null default (now() + interval '7 days'),
  add column if not exists uses_left integer not null default 50;
alter table public.team_invite_codes drop constraint if exists team_invite_codes_uses_ok;
alter table public.team_invite_codes add constraint team_invite_codes_uses_ok check (uses_left >= 0);

-- Cubre regenerate_invite_code y remove_member (0007) sin redefinirlas.
create or replace function public.reset_invite_code() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.code is distinct from old.code then
    new.expires_at := now() + interval '7 days';
    new.uses_left := 50;
  end if;
  return new;
end
$$;
drop trigger if exists invite_code_reset on public.team_invite_codes;
create trigger invite_code_reset before update on public.team_invite_codes
  for each row execute function public.reset_invite_code();

create or replace function public.join_team_by_code(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_team uuid;
  v_exp timestamptz;
  v_left integer;
begin
  if auth.uid() is null then raise exception 'Iniciá sesión.'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid()) then raise exception 'Tu usuario no tiene perfil de GitHub.'; end if;
  if p_code is null or p_code !~ '^[0-9a-f]{16}$' then raise exception 'Código inválido.'; end if;
  if not public.chat_rate_hit('join', 10, 60) then
    raise exception 'Demasiados intentos seguidos: esperá un minuto.';
  end if;
  select team_id, expires_at, uses_left into v_team, v_exp, v_left
    from public.team_invite_codes where code = p_code for update;
  if v_team is null then raise exception 'Ese código no existe o ya lo cambiaron.'; end if;
  if v_exp <= now() then raise exception 'Ese código venció: pedile uno nuevo a quien administra el equipo.'; end if;
  if v_left <= 0 then raise exception 'Ese código ya se usó demasiadas veces: pedile uno nuevo.'; end if;
  insert into public.team_members (team_id, user_id, role) values (v_team, auth.uid(), 'member')
    on conflict do nothing;
  if found then
    update public.team_invite_codes set uses_left = uses_left - 1 where team_id = v_team;
  end if;
  delete from public.team_invites where team_id = v_team and github_login_lower = public.my_login();
  return v_team;
end
$$;

-- ---------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------

-- Sin el filtro por tópico, con el canal de su equipo abierto un miembro leía las filas de
-- cualquier tópico, de equipos y DMs ajenos.
drop policy if exists sloth_chat_broadcast_select on realtime.messages;
create policy sloth_chat_broadcast_select on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast'
         and realtime.messages.topic = (select realtime.topic())
         and public.can_read_chat_topic((select realtime.topic())));

create or replace function public.broadcast_member_removed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform realtime.send(
      jsonb_build_object('team_id', old.team_id, 'user_id', old.user_id),
      'member_removed', 'team:' || old.team_id::text, true);
  exception when others then
    raise warning 'sloth: broadcast_member_removed falló (%)', sqlstate;
  end;
  return null;
end
$$;
drop trigger if exists member_removed_broadcast on public.team_members;
create trigger member_removed_broadcast after delete on public.team_members
  for each row execute function public.broadcast_member_removed();

revoke execute on function
  public.guard_message(),
  public.guard_message_update(),
  public.guard_reaction(),
  public.guard_reaction_delete(),
  public.broadcast_read(),
  public.guard_invite(),
  public.reset_invite_code(),
  public.broadcast_member_removed()
  from public, anon, authenticated;
