-- =====================================================================
-- Sloth v0.6 · Chat v2 — canales, mensajes ricos, hilos, reacciones, adjuntos, perfiles y lecturas.
-- Va DESPUÉS de 0001_chat.sql y 0002_hardening.sql. Ver docs/chat-supabase.md (cómo aplicarla y revertirla).
-- Idempotente: se puede correr más de una vez (if not exists / or replace / drop ... if exists).
--
-- Modelo de seguridad (igual que 0001/0002):
--  * RLS estricta: solo miembros del equipo ven y escriben en sus canales; solo los participantes, en sus DMs.
--  * Nadie edita lo ajeno: el trigger guard_message_update no deja cambiar el cuerpo, el borrado ni la
--    fijación de un mensaje que no sea tuyo (salvo fijar: también lo puede hacer un owner/admin del equipo).
--  * Los escritos de canales, perfil, lecturas y silencios van por RPC (security definer, search_path vacío,
--    permisos revocados a anon/public). Las tablas no tienen INSERT/UPDATE directo para authenticated salvo
--    donde la RLS lo justifica (mensajes, reacciones, adjuntos).
--  * Nada de esto necesita service_role. La app sigue usando solo la anon/publishable key.
--  * Presencia y «está escribiendo» van por Realtime (canales privados): no hay tablas para eso. Las políticas
--    de realtime.messages dejan entrar solo a miembros del equipo (topic team:<id>) o participantes del DM
--    (topic dm:<id>). Si el esquema realtime no existe, ese bloque se salta.
--
-- Lo que NO hace (se deja para después): borrar canales, moderación por admin de mensajes ajenos, cuotas de
-- almacenamiento por equipo, limpieza de archivos huérfanos de Storage (ver docs).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Perfiles: datos que cada persona edita (nombre visible, @usuario, color, foto, estado, puesto, zona horaria)
-- ---------------------------------------------------------------------
alter table public.profiles
  add column if not exists handle       text,
  add column if not exists display_name text,
  add column if not exists color        text not null default 'blue',
  add column if not exists photo_path   text,
  add column if not exists presence     text not null default 'disponible',
  add column if not exists status_text  text,
  add column if not exists status_until timestamptz,
  add column if not exists role_title   text,
  add column if not exists timezone     text not null default 'America/Argentina/Buenos_Aires';

alter table public.profiles
  drop constraint if exists profiles_handle_check,
  add constraint profiles_handle_check check (handle is null or handle ~ '^[a-z0-9-]{3,30}$'),
  drop constraint if exists profiles_display_name_check,
  add constraint profiles_display_name_check check (display_name is null or char_length(btrim(display_name)) between 1 and 60),
  drop constraint if exists profiles_color_check,
  add constraint profiles_color_check check (color in ('blue', 'green', 'coral', 'amber', 'lila', 'gris')),
  drop constraint if exists profiles_photo_path_check,
  add constraint profiles_photo_path_check check (photo_path is null or (char_length(photo_path) <= 200 and photo_path like id::text || '/%')),
  drop constraint if exists profiles_presence_check,
  add constraint profiles_presence_check check (presence in ('disponible', 'ausente', 'no_molestar', 'invisible')),
  drop constraint if exists profiles_status_text_check,
  add constraint profiles_status_text_check check (status_text is null or char_length(status_text) <= 100),
  drop constraint if exists profiles_role_title_check,
  add constraint profiles_role_title_check check (role_title is null or char_length(role_title) <= 60),
  drop constraint if exists profiles_timezone_check,
  add constraint profiles_timezone_check check (char_length(timezone) between 1 and 64 and timezone ~ '^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+){0,2}$');

-- @usuario inicial = el login de GitHub en minúsculas, si cumple el formato y no lo tiene otro.
update public.profiles set handle = login_lower
 where handle is null and login_lower ~ '^[a-z0-9-]{3,30}$'
   and not exists (select 1 from public.profiles p2 where p2.handle = public.profiles.login_lower);
create unique index if not exists profiles_handle_key on public.profiles (handle);

-- El perfil nuevo (desde la identidad de GitHub) ya nace con @usuario si está libre.
create or replace function public.sync_profile_from_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_login  text := new.identity_data ->> 'user_name';
  v_avatar text := new.identity_data ->> 'avatar_url';
  v_handle text := lower(new.identity_data ->> 'user_name');
begin
  if new.provider <> 'github' or v_login is null or v_login !~ '^[A-Za-z0-9-]{1,39}$' then
    return new;
  end if;
  insert into public.profiles (id, login, name, avatar_url, handle)
  values (new.user_id, v_login,
          nullif(left(coalesce(new.identity_data ->> 'full_name', new.identity_data ->> 'name', ''), 255), ''),
          case when v_avatar like 'https://avatars.githubusercontent.com/%' then v_avatar end,
          case when v_handle ~ '^[a-z0-9-]{3,30}$'
                and not exists (select 1 from public.profiles p where p.handle = v_handle)
               then v_handle end)
  on conflict (id) do update
    set login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url, updated_at = now();
  return new;
end
$$;

-- ---------------------------------------------------------------------
-- 2. Canales por equipo. Cada equipo tiene un canal «general» (is_default) que no se borra.
-- ---------------------------------------------------------------------
create table if not exists public.team_channels (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams (id) on delete cascade,
  name        text not null check (name ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  topic       text not null default '' check (char_length(topic) <= 200),
  description text not null default '' check (char_length(description) <= 500),
  is_default  boolean not null default false,
  created_by  uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  unique (team_id, name)
);
create unique index if not exists team_channels_default_key on public.team_channels (team_id) where is_default;

create or replace function public.teams_add_default_channel() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.team_channels (team_id, name, is_default, created_by)
  values (new.id, 'general', true, new.created_by)
  on conflict do nothing;
  return new;
end
$$;
drop trigger if exists team_default_channel on public.teams;
create trigger team_default_channel after insert on public.teams
  for each row execute function public.teams_add_default_channel();

-- Equipos que ya existían (0001) y todavía no tienen su «general».
insert into public.team_channels (team_id, name, is_default, created_by)
select t.id, 'general', true, t.created_by from public.teams t
 where not exists (select 1 from public.team_channels c where c.team_id = t.id and c.is_default)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 3. Mensajes: canal, tipo y tarjeta (ticket / espacio / PR / código), respuestas citadas, hilos,
--    edición, borrado lógico, fijado y contador de reacciones.
-- ---------------------------------------------------------------------
alter table public.messages
  add column if not exists channel_id     uuid references public.team_channels (id) on delete cascade,
  add column if not exists kind           text not null default 'text',
  add column if not exists payload        jsonb not null default '{}'::jsonb,
  add column if not exists reply_to       uuid references public.messages (id) on delete set null,
  add column if not exists thread_root    uuid references public.messages (id) on delete set null,
  add column if not exists reply_count    integer not null default 0,
  add column if not exists last_reply_at  timestamptz,
  add column if not exists edited_at      timestamptz,
  add column if not exists deleted_at     timestamptz,
  add column if not exists pinned_at      timestamptz,
  add column if not exists pinned_by      uuid references public.profiles (id) on delete set null,
  add column if not exists reactions_at   timestamptz;

-- Validación de tarjetas. Pura y sin acceso a tablas: se usa en un CHECK.
create or replace function public.valid_chat_payload(p_kind text, p_payload jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  k text;
  allowed text[];
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then return false; end if;
  allowed := case p_kind
    when 'text' then array[]::text[]
    when 'file' then array[]::text[]
    when 'code' then array['code', 'lang']
    when 'ticket' then array['id', 'title', 'state']
    when 'space' then array['name', 'sub', 'st']
    when 'pr' then array['url', 'repo', 'kind', 'num', 'title', 'st', 'chk']
    else null
  end;
  if allowed is null then return false; end if;
  for k in select jsonb_object_keys(p_payload) loop
    if not (k = any (allowed)) then return false; end if;
    if jsonb_typeof(p_payload -> k) <> 'string' then return false; end if;
  end loop;
  if p_kind in ('text', 'file') then
    return p_payload = '{}'::jsonb;
  elsif p_kind = 'code' then
    return coalesce(
      char_length(coalesce(p_payload ->> 'code', '')) between 1 and 4000
      and char_length(coalesce(p_payload ->> 'lang', '')) <= 20, false);
  elsif p_kind = 'ticket' then
    return coalesce(
      (coalesce(p_payload ->> 'id', '') ~ '^TCK-[0-9]{1,10}$')
      and char_length(coalesce(p_payload ->> 'title', '')) between 1 and 200
      and char_length(coalesce(p_payload ->> 'state', '')) <= 40, false);
  elsif p_kind = 'space' then
    return coalesce(
      char_length(coalesce(p_payload ->> 'name', '')) between 1 and 120
      and char_length(coalesce(p_payload ->> 'sub', '')) <= 200
      and char_length(coalesce(p_payload ->> 'st', '')) <= 40, false);
  else -- pr
    return coalesce(
      (coalesce(p_payload ->> 'url', '') ~ '^https://github\.com/[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}/(pull|issues)/[0-9]{1,9}$')
      and char_length(coalesce(p_payload ->> 'repo', '')) <= 200
      and char_length(coalesce(p_payload ->> 'kind', '')) <= 40
      and char_length(coalesce(p_payload ->> 'num', '')) <= 12
      and char_length(coalesce(p_payload ->> 'title', '')) <= 200
      and char_length(coalesce(p_payload ->> 'st', '')) <= 40
      and char_length(coalesce(p_payload ->> 'chk', '')) <= 80, false);
  end if;
end
$$;

-- Equipos ya existentes: sus mensajes van al canal «general» (antes eran del equipo entero).
update public.messages m set channel_id = c.id
  from public.team_channels c
 where m.team_id is not null and m.channel_id is null and c.team_id = m.team_id and c.is_default;

-- Límites nuevos. Un cuerpo vacío solo vale si es una tarjeta/adjunto o un mensaje borrado.
alter table public.messages
  drop constraint if exists messages_body_check,
  add constraint messages_body_check check (char_length(body) <= 4000 and (btrim(body) <> '' or kind <> 'text' or deleted_at is not null)),
  drop constraint if exists messages_scope_check,
  add constraint messages_scope_check check ((team_id is null) = (channel_id is null)),
  drop constraint if exists messages_kind_check,
  add constraint messages_kind_check check (kind in ('text', 'file', 'code', 'ticket', 'space', 'pr')),
  drop constraint if exists messages_payload_check,
  add constraint messages_payload_check check (deleted_at is not null or public.valid_chat_payload(kind, payload)),
  drop constraint if exists messages_self_ref_check,
  add constraint messages_self_ref_check check (reply_to is distinct from id and thread_root is distinct from id);

create index if not exists messages_channel_idx on public.messages (channel_id, created_at desc) where channel_id is not null;
create index if not exists messages_root_idx on public.messages (thread_root, created_at) where thread_root is not null;

-- ---------------------------------------------------------------------
-- 4. Reacciones (único por persona, mensaje y tipo), adjuntos y lecturas/silencios
-- ---------------------------------------------------------------------
create table if not exists public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  kind       text not null check (kind in ('visto', 'aprobado', 'mesumo', 'importante', 'idea', 'gracias')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, kind)
);

-- Adjuntos: metadatos. El archivo vive en el bucket privado chat-files (ruta: <team_id>/... o dm/<thread_id>/...).
create table if not exists public.message_files (
  id         uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  team_id    uuid references public.teams (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 255 and name !~ '[/\\]'),
  size_bytes bigint not null check (size_bytes between 0 and 10485760),
  mime       text not null default 'application/octet-stream' check (char_length(mime) <= 100),
  path       text not null unique check (char_length(path) <= 300 and (
               (team_id is not null and path like team_id::text || '/%')
            or (team_id is null and path like 'dm/%'))),
  created_by uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists message_files_message_idx on public.message_files (message_id);

-- Lectura y silencio por persona y conversación (canal o DM). Sustituye a last_read_at del equipo
-- para los canales nuevos; los clientes 0.5 siguen funcionando vía mark_read (ver abajo).
create table if not exists public.conv_state (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  channel_id   uuid references public.team_channels (id) on delete cascade,
  thread_id    uuid references public.dm_threads (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  muted        boolean not null default false,
  check (num_nonnulls(channel_id, thread_id) = 1)
);
create unique index if not exists conv_state_channel_key on public.conv_state (user_id, channel_id) where channel_id is not null;
create unique index if not exists conv_state_thread_key on public.conv_state (user_id, thread_id) where thread_id is not null;

-- Lecturas que ya existían en 0001 pasan a conv_state (idempotente).
insert into public.conv_state (user_id, channel_id, last_read_at)
select tm.user_id, c.id, tm.last_read_at
  from public.team_members tm
  join public.team_channels c on c.team_id = tm.team_id and c.is_default
on conflict (user_id, channel_id) where channel_id is not null do nothing;

insert into public.conv_state (user_id, thread_id, last_read_at)
select t.user_a, t.id, t.last_read_a from public.dm_threads t
union all
select t.user_b, t.id, t.last_read_b from public.dm_threads t
on conflict (user_id, thread_id) where thread_id is not null do nothing;

-- ---------------------------------------------------------------------
-- 5. Funciones auxiliares de RLS (security definer, search_path vacío)
-- ---------------------------------------------------------------------
create or replace function public.can_see_message(p_message uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.messages m
     where m.id = p_message
       and ((m.team_id is not null and public.is_team_member(m.team_id))
            or (m.thread_id is not null and public.is_thread_participant(m.thread_id))))
$$;

create or replace function public.can_see_conv(p_channel uuid, p_thread uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (p_channel is not null and exists (
            select 1 from public.team_channels c where c.id = p_channel and public.is_team_member(c.team_id)))
      or (p_thread is not null and public.is_thread_participant(p_thread))
$$;

-- Ruta de un objeto de chat-files: <team_id>/... (miembros del equipo) o dm/<thread_id>/... (participantes).
create or replace function public.can_access_chat_file(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when (storage.foldername(p_name))[1] = 'dm'
      then public.is_thread_participant(public.uuid_or_null((storage.foldername(p_name))[2]))
    else public.is_team_member(public.uuid_or_null((storage.foldername(p_name))[1]))
  end
$$;

-- ---------------------------------------------------------------------
-- 6. Triggers
-- ---------------------------------------------------------------------

-- Alta de mensajes: hora y autor los pone la base; tope de 30 por minuto; canal por defecto (clientes 0.5);
-- el canal tiene que ser del equipo; la respuesta citada y el hilo tienen que ser de la misma conversación.
create or replace function public.guard_message() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_default uuid;
  v_chan_team uuid;
  v_root public.messages%rowtype;
begin
  new.created_at := now();
  new.author_id := auth.uid();
  if (select count(*) from public.messages
      where author_id = new.author_id and created_at > now() - interval '1 minute') >= 30 then
    raise exception 'Demasiados mensajes seguidos: esperá un minuto.';
  end if;
  if new.team_id is not null then
    if new.channel_id is null then
      select c.id into v_default from public.team_channels c where c.team_id = new.team_id and c.is_default;
      new.channel_id := v_default;
    end if;
    select c.team_id into v_chan_team from public.team_channels c where c.id = new.channel_id;
    if v_chan_team is distinct from new.team_id then
      raise exception 'Ese canal no es de este equipo.';
    end if;
  end if;
  if new.reply_to is not null and not exists (
      select 1 from public.messages r
       where r.id = new.reply_to
         and r.team_id is not distinct from new.team_id
         and r.channel_id is not distinct from new.channel_id
         and r.thread_id is not distinct from new.thread_id) then
    raise exception 'La respuesta citada no está en esta conversación.';
  end if;
  if new.thread_root is not null then
    select * into v_root from public.messages where id = new.thread_root;
    if not found or v_root.thread_root is not null
       or v_root.team_id is distinct from new.team_id
       or v_root.channel_id is distinct from new.channel_id
       or v_root.thread_id is distinct from new.thread_id then
      raise exception 'Ese hilo no existe en esta conversación.';
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists message_guard on public.messages;
create trigger message_guard before insert on public.messages
  for each row execute function public.guard_message();

-- Cambios: solo el autor cambia el cuerpo y puede borrar; fijar lo hacen el autor o un owner/admin del equipo.
-- Las columnas de sistema (ids, autor, tipo, tarjeta, hilo) no cambian nunca. Los contadores los mantienen triggers.
create or replace function public.guard_message_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.id is distinct from old.id
     or new.team_id is distinct from old.team_id
     or new.thread_id is distinct from old.thread_id
     or new.author_id is distinct from old.author_id
     or new.client_id is distinct from old.client_id
     or new.created_at is distinct from old.created_at
     or new.kind is distinct from old.kind
     or new.reply_to is distinct from old.reply_to
     or new.thread_root is distinct from old.thread_root
     or (old.channel_id is not null and new.channel_id is distinct from old.channel_id) then
    raise exception 'Ese dato del mensaje no se puede cambiar.';
  end if;
  -- Contadores y marcas de tiempo de reacciones: solo los escriben los triggers (pg_trigger_depth > 1).
  if pg_trigger_depth() <= 1 and (
       new.reply_count is distinct from old.reply_count
    or new.last_reply_at is distinct from old.last_reply_at
    or new.reactions_at is distinct from old.reactions_at) then
    raise exception 'Ese dato del mensaje no se puede cambiar.';
  end if;

  if new.body is distinct from old.body or new.deleted_at is distinct from old.deleted_at
     or new.payload is distinct from old.payload or new.edited_at is distinct from old.edited_at then
    if auth.uid() is distinct from old.author_id then
      raise exception 'Solo podés cambiar tus propios mensajes.';
    end if;
  end if;

  if new.deleted_at is distinct from old.deleted_at then
    if old.deleted_at is not null then
      raise exception 'Ese mensaje ya está borrado.';
    end if;
    -- Borrado lógico: se vacían cuerpo, tarjeta, fijado y ediciones; el registro queda como «Mensaje borrado».
    new.deleted_at := now();
    new.body := '';
    new.payload := '{}'::jsonb;
    new.edited_at := null;
    new.pinned_at := null;
    new.pinned_by := null;
  elsif new.payload is distinct from old.payload then
    raise exception 'El contenido de una tarjeta no se edita.';
  elsif new.body is distinct from old.body then
    if old.deleted_at is not null then raise exception 'Ese mensaje ya está borrado.'; end if;
    new.edited_at := now();
  else
    new.edited_at := old.edited_at;
  end if;

  if new.pinned_at is distinct from old.pinned_at then
    if not (auth.uid() = old.author_id
            or (old.team_id is not null and public.team_role(old.team_id) in ('owner', 'admin'))) then
      raise exception 'Solo el autor o un admin del equipo puede fijar mensajes.';
    end if;
    if new.deleted_at is not null and new.pinned_at is not null then
      raise exception 'Un mensaje borrado no se puede fijar.';
    end if;
    new.pinned_by := case when new.pinned_at is null then null else auth.uid() end;
  end if;
  return new;
end
$$;
drop trigger if exists message_guard_update on public.messages;
create trigger message_guard_update before update on public.messages
  for each row execute function public.guard_message_update();

-- Una respuesta de hilo suma al contador y a la última respuesta de la raíz.
create or replace function public.on_reply_inserted() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.thread_root is not null then
    update public.messages set reply_count = reply_count + 1, last_reply_at = new.created_at
     where id = new.thread_root;
  end if;
  return null;
end
$$;
drop trigger if exists message_reply_count on public.messages;
create trigger message_reply_count after insert on public.messages
  for each row execute function public.on_reply_inserted();

-- Borrado lógico: se van las reacciones y la respuesta deja de contar en su raíz.
create or replace function public.on_message_deleted() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.message_reactions where message_id = new.id;
  if old.thread_root is not null then
    update public.messages set reply_count = greatest(reply_count - 1, 0) where id = old.thread_root;
  end if;
  return null;
end
$$;
drop trigger if exists message_on_deleted on public.messages;
create trigger message_on_deleted after update of deleted_at on public.messages
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function public.on_message_deleted();

-- Reaccionar avisa al mensaje (UPDATE) para que Realtime lo mande a todos. Así no se emiten DELETE de
-- reacciones (que no pasan por la RLS y mostrarían quién reaccionó a qué).
create or replace function public.touch_reactions() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.messages set reactions_at = now()
   where id = coalesce(new.message_id, old.message_id);
  return null;
end
$$;
drop trigger if exists reactions_touch on public.message_reactions;
create trigger reactions_touch after insert or delete on public.message_reactions
  for each row execute function public.touch_reactions();

-- ---------------------------------------------------------------------
-- 7. Row Level Security de las tablas nuevas y de messages
-- ---------------------------------------------------------------------
alter table public.team_channels     enable row level security;
alter table public.message_reactions enable row level security;
alter table public.message_files     enable row level security;
alter table public.conv_state        enable row level security;

-- Canales: los ven los miembros. Crear y renombrar, owner/admin, por RPC.
drop policy if exists channels_select on public.team_channels;
create policy channels_select on public.team_channels for select to authenticated
  using (public.is_team_member(team_id));

-- Reacciones: las ven quienes ven el mensaje; reaccionan solo en mensajes vivos; quitan las propias.
drop policy if exists reactions_select on public.message_reactions;
create policy reactions_select on public.message_reactions for select to authenticated
  using (public.can_see_message(message_id));
drop policy if exists reactions_insert on public.message_reactions;
create policy reactions_insert on public.message_reactions for insert to authenticated
  with check (user_id = auth.uid()
              and public.can_see_message(message_id)
              and exists (select 1 from public.messages m where m.id = message_id and m.deleted_at is null));
drop policy if exists reactions_delete on public.message_reactions;
create policy reactions_delete on public.message_reactions for delete to authenticated
  using (user_id = auth.uid());

-- Adjuntos: ver los de mensajes vivos que se ven; adjuntar en tus propios mensajes; borrar los que subiste.
drop policy if exists files_select on public.message_files;
create policy files_select on public.message_files for select to authenticated
  using (public.can_see_message(message_id)
         and exists (select 1 from public.messages m where m.id = message_id and m.deleted_at is null));
drop policy if exists files_insert on public.message_files;
create policy files_insert on public.message_files for insert to authenticated
  with check (created_by = auth.uid()
              and exists (
                select 1 from public.messages m
                 where m.id = message_id
                   and m.author_id = auth.uid()
                   and m.deleted_at is null
                   and m.team_id is not distinct from message_files.team_id
                   and (m.thread_id is null or message_files.path like 'dm/' || m.thread_id::text || '/%')));
drop policy if exists files_delete on public.message_files;
create policy files_delete on public.message_files for delete to authenticated
  using (created_by = auth.uid());

-- Estado de lectura y silencio: solo lo propio. Se escribe por RPC (chat_mark_read, chat_set_muted).
drop policy if exists conv_state_select on public.conv_state;
create policy conv_state_select on public.conv_state for select to authenticated
  using (user_id = auth.uid());

-- Mensajes: la lectura y el alta siguen como en 0001. Se puede editar, borrar (lógico) y fijar:
-- el autor siempre; un owner/admin, solo para fijar (lo controla guard_message_update).
-- Se quita el DELETE: el borrado es lógico para no romper hilos ni respuestas citadas.
drop policy if exists messages_update on public.messages;
create policy messages_update on public.messages for update to authenticated
  using (author_id = auth.uid() or (team_id is not null and public.team_role(team_id) in ('owner', 'admin')))
  with check (author_id = auth.uid() or (team_id is not null and public.team_role(team_id) in ('owner', 'admin')));
drop policy if exists messages_delete on public.messages;

-- Sin escritura directa en estas tablas (lo hacen las RPC):
revoke insert, update, delete on public.team_channels from authenticated;
revoke insert, update, delete on public.conv_state from authenticated;
revoke insert, update, delete on public.profiles from authenticated;
revoke all on public.team_channels, public.message_reactions, public.message_files, public.conv_state from anon;

-- ---------------------------------------------------------------------
-- 8. RPC nuevas (solo authenticated, cada una con sus chequeos)
-- ---------------------------------------------------------------------

-- Crear canal (owner/admin).
create or replace function public.create_channel(p_team uuid, p_name text, p_topic text default '', p_description text default '')
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Iniciá sesión.'; end if;
  if public.team_role(p_team) not in ('owner', 'admin') then raise exception 'Solo owner o admin pueden crear canales.'; end if;
  insert into public.team_channels (team_id, name, topic, description, created_by)
    values (p_team, lower(btrim(p_name)), coalesce(btrim(p_topic), ''), coalesce(btrim(p_description), ''), auth.uid())
    returning id into v_id;
  return v_id;
exception
  when unique_violation then raise exception 'Ya hay un canal con ese nombre.';
  when check_violation then raise exception 'Nombre de canal no válido: minúsculas, números y guiones (1 a 40).';
end
$$;

-- Renombrar, cambiar tema y descripción (owner/admin). Un parámetro null = no tocar.
create or replace function public.update_channel(p_channel uuid, p_name text default null, p_topic text default null, p_description text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_team uuid;
begin
  if auth.uid() is null then raise exception 'Iniciá sesión.'; end if;
  select c.team_id into v_team from public.team_channels c where c.id = p_channel;
  if v_team is null then raise exception 'Ese canal no existe.'; end if;
  if public.team_role(v_team) not in ('owner', 'admin') then raise exception 'Solo owner o admin pueden editar canales.'; end if;
  update public.team_channels set
    name        = coalesce(lower(btrim(p_name)), name),
    topic       = coalesce(btrim(p_topic), topic),
    description = coalesce(btrim(p_description), description)
   where id = p_channel;
  return;
exception
  when unique_violation then raise exception 'Ya hay un canal con ese nombre.';
  when check_violation then raise exception 'Nombre de canal no válido: minúsculas, números y guiones (1 a 40).';
end
$$;

-- Perfil propio. p_patch es un objeto JSON: solo se tocan las claves que vienen.
--   display_name (1-60) · handle (^[a-z0-9-]{3,30}$, único) · color · presence · status_text ('' la borra)
--   status_until (ISO o null) · role_title ('' la borra) · timezone (IANA, p. ej. America/Argentina/Buenos_Aires)
create or replace function public.update_profile(p_patch jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  if auth.uid() is null then raise exception 'Iniciá sesión.'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid()) then raise exception 'Tu usuario no tiene perfil de GitHub.'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'Datos de perfil inválidos.'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('display_name', 'handle', 'color', 'presence', 'status_text', 'status_until', 'role_title', 'timezone') then
      raise exception 'Campo de perfil no válido: %', k;
    end if;
  end loop;
  if p_patch ? 'handle' and coalesce(p_patch ->> 'handle', '') !~ '^[a-z0-9-]{3,30}$' then
    raise exception 'El usuario tiene entre 3 y 30 caracteres: minúsculas, números y guiones.';
  end if;
  update public.profiles p set
    display_name = case when p_patch ? 'display_name' then nullif(btrim(p_patch ->> 'display_name'), '') else p.display_name end,
    handle       = case when p_patch ? 'handle' then p_patch ->> 'handle' else p.handle end,
    color        = case when p_patch ? 'color' then p_patch ->> 'color' else p.color end,
    presence     = case when p_patch ? 'presence' then p_patch ->> 'presence' else p.presence end,
    status_text  = case when p_patch ? 'status_text' then nullif(btrim(p_patch ->> 'status_text'), '') else p.status_text end,
    status_until = case when p_patch ? 'status_until' then (p_patch ->> 'status_until')::timestamptz else p.status_until end,
    role_title   = case when p_patch ? 'role_title' then nullif(btrim(p_patch ->> 'role_title'), '') else p.role_title end,
    timezone     = case when p_patch ? 'timezone' then p_patch ->> 'timezone' else p.timezone end,
    updated_at   = now()
   where p.id = auth.uid();
exception
  when unique_violation then raise exception 'Ese usuario ya está en uso. Probá otro.';
  when check_violation then raise exception 'Algún dato del perfil no es válido: revisá color, estado, puesto o zona horaria.';
end
$$;

-- Foto de perfil: la ruta es <auth.uid()>/<uuid>.(webp|png|jpg) en el bucket profile-photos. null la quita.
create or replace function public.set_profile_photo(p_path text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Iniciá sesión.'; end if;
  if p_path is not null and p_path !~ ('^' || auth.uid()::text
       || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|png|jpg)$') then
    raise exception 'La foto no tiene una ruta válida.';
  end if;
  update public.profiles set photo_path = p_path, updated_at = now() where id = auth.uid();
end
$$;

-- Lectura de una conversación (canal o DM): sin soltar otros datos.
create or replace function public.chat_mark_read(p_channel uuid default null, p_thread uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Iniciá sesión.'; end if;
  if (p_channel is null) = (p_thread is null) then raise exception 'Conversación inválida.'; end if;
  if not public.can_see_conv(p_channel, p_thread) then raise exception 'No podés leer esa conversación.'; end if;
  if p_channel is not null then
    insert into public.conv_state (user_id, channel_id, last_read_at) values (auth.uid(), p_channel, now())
    on conflict (user_id, channel_id) where channel_id is not null
    do update set last_read_at = excluded.last_read_at;
  else
    insert into public.conv_state (user_id, thread_id, last_read_at) values (auth.uid(), p_thread, now())
    on conflict (user_id, thread_id) where thread_id is not null
    do update set last_read_at = excluded.last_read_at;
  end if;
end
$$;

-- Silenciar o volver a recibir avisos de una conversación (solo para mí).
create or replace function public.chat_set_muted(p_channel uuid default null, p_thread uuid default null, p_muted boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare v_base timestamptz;
begin
  if auth.uid() is null then raise exception 'Iniciá sesión.'; end if;
  if (p_channel is null) = (p_thread is null) then raise exception 'Conversación inválida.'; end if;
  if not public.can_see_conv(p_channel, p_thread) then raise exception 'No podés cambiar esa conversación.'; end if;
  if p_channel is not null then
    select tm.joined_at into v_base from public.team_members tm
      join public.team_channels c on c.team_id = tm.team_id
     where c.id = p_channel and tm.user_id = auth.uid();
    insert into public.conv_state (user_id, channel_id, last_read_at, muted)
    values (auth.uid(), p_channel, coalesce(v_base, now()), p_muted)
    on conflict (user_id, channel_id) where channel_id is not null
    do update set muted = excluded.muted;
  else
    select t.created_at into v_base from public.dm_threads t where t.id = p_thread;
    insert into public.conv_state (user_id, thread_id, last_read_at, muted)
    values (auth.uid(), p_thread, coalesce(v_base, now()), p_muted)
    on conflict (user_id, thread_id) where thread_id is not null
    do update set muted = excluded.muted;
  end if;
end
$$;

-- No leídos por conversación (canales y DMs del usuario), con silencio y última lectura.
-- Cuenta hasta 99 por conversación. Sin lectura previa, la base es el alta en el equipo / el DM.
create or replace function public.chat_unread()
returns table (kind text, id uuid, unread integer, last_at timestamptz, muted boolean, last_read_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select 'channel'::text, c.id,
         (select count(*)::int from (select 1 from public.messages x
            where x.channel_id = c.id and x.deleted_at is null and x.author_id <> auth.uid()
              and x.created_at > coalesce(cs.last_read_at, tm.joined_at) limit 99) s),
         (select max(x.created_at) from public.messages x where x.channel_id = c.id),
         coalesce(cs.muted, false),
         coalesce(cs.last_read_at, tm.joined_at)
    from public.team_channels c
    join public.team_members tm on tm.team_id = c.team_id and tm.user_id = auth.uid()
    left join public.conv_state cs on cs.user_id = auth.uid() and cs.channel_id = c.id
  union all
  select 'dm'::text, t.id,
         (select count(*)::int from (select 1 from public.messages x
            where x.thread_id = t.id and x.deleted_at is null and x.author_id <> auth.uid()
              and x.created_at > coalesce(cs.last_read_at, t.created_at) limit 99) s),
         (select max(x.created_at) from public.messages x where x.thread_id = t.id),
         coalesce(cs.muted, false),
         coalesce(cs.last_read_at, t.created_at)
    from public.dm_threads t
    left join public.conv_state cs on cs.user_id = auth.uid() and cs.thread_id = t.id
   where auth.uid() in (t.user_a, t.user_b)
$$;

-- «Visto por»: cuándo leyó cada persona la conversación. No expone silencios ni nada más.
create or replace function public.conv_read_marks(p_channel uuid default null, p_thread uuid default null)
returns table (user_id uuid, last_read_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select cs.user_id, cs.last_read_at
    from public.conv_state cs
   where public.can_see_conv(p_channel, p_thread)
     and ((p_channel is not null and cs.channel_id = p_channel)
          or (p_thread is not null and cs.thread_id = p_thread))
$$;

-- mark_read de 0.5 (lo siguen llamando clientes viejos): además de lo que hacía, deja leído el canal general.
create or replace function public.mark_read(p_team uuid default null, p_thread uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Iniciá sesión.'; end if;
  if p_team is not null then
    update public.team_members set last_read_at = now() where team_id = p_team and user_id = auth.uid();
    insert into public.conv_state (user_id, channel_id, last_read_at)
    select auth.uid(), c.id, now() from public.team_channels c
     where c.team_id = p_team and c.is_default
       and exists (select 1 from public.team_members tm where tm.team_id = p_team and tm.user_id = auth.uid())
    on conflict (user_id, channel_id) where channel_id is not null do update set last_read_at = excluded.last_read_at;
  end if;
  if p_thread is not null then
    update public.dm_threads set last_read_a = now() where id = p_thread and user_a = auth.uid();
    update public.dm_threads set last_read_b = now() where id = p_thread and user_b = auth.uid();
    insert into public.conv_state (user_id, thread_id, last_read_at)
    select auth.uid(), t.id, now() from public.dm_threads t
     where t.id = p_thread and auth.uid() in (t.user_a, t.user_b)
    on conflict (user_id, thread_id) where thread_id is not null do update set last_read_at = excluded.last_read_at;
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 9. Permisos de funciones: solo authenticated; los triggers no los llama nadie por API.
-- ---------------------------------------------------------------------
revoke execute on function
  public.create_channel(uuid, text, text, text), public.update_channel(uuid, text, text, text),
  public.update_profile(jsonb), public.set_profile_photo(text),
  public.chat_mark_read(uuid, uuid), public.chat_set_muted(uuid, uuid, boolean),
  public.chat_unread(), public.conv_read_marks(uuid, uuid),
  public.can_see_message(uuid), public.can_see_conv(uuid, uuid), public.can_access_chat_file(text),
  public.valid_chat_payload(text, jsonb),
  public.mark_read(uuid, uuid)
  from public, anon;
grant execute on function
  public.create_channel(uuid, text, text, text), public.update_channel(uuid, text, text, text),
  public.update_profile(jsonb), public.set_profile_photo(text),
  public.chat_mark_read(uuid, uuid), public.chat_set_muted(uuid, uuid, boolean),
  public.chat_unread(), public.conv_read_marks(uuid, uuid),
  public.can_see_message(uuid), public.can_see_conv(uuid, uuid), public.can_access_chat_file(text),
  public.valid_chat_payload(text, jsonb),
  public.mark_read(uuid, uuid)
  to authenticated;

revoke execute on function
  public.guard_message(), public.guard_message_update(), public.on_reply_inserted(),
  public.on_message_deleted(), public.touch_reactions(), public.teams_add_default_channel()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 10. Realtime: tablas que la app escucha (la RLS filtra cada evento para cada suscriptor).
-- Reacciones NO van en la publicación: se avisan con UPDATE de messages (ver touch_reactions).
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'team_channels') then
    alter publication supabase_realtime add table public.team_channels;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles') then
    alter publication supabase_realtime add table public.profiles;
  end if;
end
$$;

-- Presencia y «está escribiendo» (canales privados): solo miembros del equipo (team:<id>) o
-- participantes del DM (dm:<id>). Se salta si el proyecto no tiene el esquema realtime.
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists chat_rt_read on realtime.messages';
    execute $p$
      create policy chat_rt_read on realtime.messages for select to authenticated
      using (
        (realtime.topic() like 'team:%' and public.is_team_member(public.uuid_or_null(split_part(realtime.topic(), ':', 2))))
        or (realtime.topic() like 'dm:%' and public.is_thread_participant(public.uuid_or_null(split_part(realtime.topic(), ':', 2))))
      )
    $p$;
    execute 'drop policy if exists chat_rt_write on realtime.messages';
    execute $p$
      create policy chat_rt_write on realtime.messages for insert to authenticated
      with check (
        (realtime.topic() like 'team:%' and public.is_team_member(public.uuid_or_null(split_part(realtime.topic(), ':', 2))))
        or (realtime.topic() like 'dm:%' and public.is_thread_participant(public.uuid_or_null(split_part(realtime.topic(), ':', 2))))
      )
    $p$;
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 11. Storage: adjuntos (bucket PRIVADO chat-files, ≤ 10 MB) y foto de perfil (profile-photos, ≤ 512 KB).
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-files', 'chat-files', false, 10485760, null)
on conflict (id) do update
  set public = false, file_size_limit = 10485760, allowed_mime_types = null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-photos', 'profile-photos', false, 524288, array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = 524288, allowed_mime_types = array['image/webp', 'image/png', 'image/jpeg'];

-- chat-files: leer y subir, quienes pueden ver esa conversación; borrar, quien escribió el mensaje.
drop policy if exists chat_files_select on storage.objects;
create policy chat_files_select on storage.objects for select to authenticated
  using (bucket_id = 'chat-files' and public.can_access_chat_file(name));
drop policy if exists chat_files_insert on storage.objects;
create policy chat_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-files' and public.can_access_chat_file(name));
-- Security definer: el adjunto de un mensaje borrado ya no se ve por RLS, y la app borra el objeto DESPUÉS del borrado lógico.
create or replace function public.is_chat_file_author(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.message_files f
                   join public.messages m on m.id = f.message_id
                  where f.path = p_name and m.author_id = auth.uid())
$$;
revoke execute on function public.is_chat_file_author(text) from public, anon;
grant execute on function public.is_chat_file_author(text) to authenticated;

drop policy if exists chat_files_delete on storage.objects;
create policy chat_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'chat-files' and public.is_chat_file_author(name));

-- profile-photos: la ven quienes ven el perfil; la suben y cambian solo los dueños (carpeta = su id).
drop policy if exists profile_photos_select on storage.objects;
create policy profile_photos_select on storage.objects for select to authenticated
  using (bucket_id = 'profile-photos'
         and public.can_see_profile(public.uuid_or_null((storage.foldername(name))[1])));
drop policy if exists profile_photos_insert on storage.objects;
create policy profile_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists profile_photos_update on storage.objects;
create policy profile_photos_update on storage.objects for update to authenticated
  using (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists profile_photos_delete on storage.objects;
create policy profile_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text);
