-- Generado por scripts/build-supabase-setup.mjs. No lo edites: editá las migraciones y corré
-- `node scripts/build-supabase-setup.mjs`. Es seguro correrlo más de una vez. Pegalo entero en el SQL Editor
-- de tu proyecto de Supabase.

-- ===== 0001_chat.sql =====
-- =====================================================================
-- Sloth v0.5 · Chat del equipo (personas) — esquema + Row Level Security
-- Correr UNA vez en el SQL Editor del proyecto Supabase del equipo (ver docs/chat-supabase.md).
-- Es idempotente donde se puede (if not exists / or replace), pero pensado para un proyecto nuevo.
--
-- Modelo de seguridad:
--  * Solo usuarios con identidad de GitHub tienen perfil (el login sale de auth.identities, que el
--    usuario NO puede editar; raw_user_meta_data sí se puede editar con auth.updateUser y por eso
--    no se usa). Sin perfil no se puede ser miembro ni escribir.
--  * Equipos: solo los miembros leen el equipo, sus miembros y sus mensajes. Invitación por código
--    (tabla aparte, solo owner/admin lo ven) o por usuario de GitHub (lo ve el invitado).
--  * Mensajes directos (DM): solo los dos participantes. Solo se abren con alguien con quien
--    compartís un equipo.
--  * Altas de equipos, membresías, DMs y lecturas solo por funciones RPC con chequeos (no hay INSERT directo).
--  * Límites: largo de textos, 30 mensajes por minuto por usuario, 50 equipos por usuario,
--    200 miembros por equipo, fotos ≤ 512 KB webp/png/jpeg en un bucket PRIVADO.
--  * La app usa SOLO la anon/publishable key. La service_role nunca sale del panel de Supabase.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  login       text not null check (char_length(login) between 1 and 39),
  login_lower text generated always as (lower(login)) stored,
  name        text check (name is null or char_length(name) <= 255),
  avatar_url  text check (avatar_url is null or avatar_url like 'https://avatars.githubusercontent.com/%'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists profiles_login_lower_idx on public.profiles (login_lower);

create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  description text not null default '' check (char_length(description) <= 500),
  -- Ruta dentro del bucket team-photos: '<team_id>/<archivo>'.
  photo_path  text check (photo_path is null or (char_length(photo_path) <= 200 and photo_path like id::text || '/%')),
  created_by  uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

create table if not exists public.team_members (
  team_id      uuid not null references public.teams (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at    timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index if not exists team_members_user_idx on public.team_members (user_id);

-- Código de invitación: tabla aparte para que solo owner/admin lo lean (los miembros leen teams).
create table if not exists public.team_invite_codes (
  team_id    uuid primary key references public.teams (id) on delete cascade,
  code       text not null unique default encode(extensions.gen_random_bytes(8), 'hex'),
  created_at timestamptz not null default now()
);

create table if not exists public.team_invites (
  id                 uuid primary key default gen_random_uuid(),
  team_id            uuid not null references public.teams (id) on delete cascade,
  github_login_lower text not null check (github_login_lower ~ '^[a-z0-9-]{1,39}$'),
  invited_by         uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at         timestamptz not null default now(),
  unique (team_id, github_login_lower)
);
create index if not exists team_invites_login_idx on public.team_invites (github_login_lower);

create table if not exists public.dm_threads (
  id          uuid primary key default gen_random_uuid(),
  user_a      uuid not null references public.profiles (id) on delete cascade,
  user_b      uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  last_read_a timestamptz not null default now(),
  last_read_b timestamptz not null default now(),
  check (user_a < user_b),
  unique (user_a, user_b)
);
create index if not exists dm_threads_b_idx on public.dm_threads (user_b);

create table if not exists public.messages (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid references public.teams (id) on delete cascade,
  thread_id  uuid references public.dm_threads (id) on delete cascade,
  author_id  uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  client_id  uuid not null,
  body       text not null check (char_length(body) between 1 and 4000 and btrim(body) <> ''),
  created_at timestamptz not null default now(),
  check (num_nonnulls(team_id, thread_id) = 1),
  unique (author_id, client_id)
);
create index if not exists messages_team_idx on public.messages (team_id, created_at desc) where team_id is not null;
create index if not exists messages_thread_idx on public.messages (thread_id, created_at desc) where thread_id is not null;

-- ---------------------------------------------------------------------
-- Funciones auxiliares (SECURITY DEFINER: evitan recursión de RLS; search_path vacío)
-- ---------------------------------------------------------------------

create or replace function public.uuid_or_null(p text) returns uuid
language sql immutable set search_path = '' as $$
  select case when p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p::uuid end
$$;

create or replace function public.is_team_member(p_team uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.team_members m where m.team_id = p_team and m.user_id = auth.uid())
$$;

create or replace function public.team_role(p_team uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.team_members m where m.team_id = p_team and m.user_id = auth.uid()
$$;

create or replace function public.is_thread_participant(p_thread uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.dm_threads t where t.id = p_thread and auth.uid() in (t.user_a, t.user_b))
$$;

create or replace function public.my_login() returns text
language sql stable security definer set search_path = '' as $$
  select p.login_lower from public.profiles p where p.id = auth.uid()
$$;

create or replace function public.shares_team(p_other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.team_members a
    join public.team_members b on b.team_id = a.team_id
    where a.user_id = auth.uid() and b.user_id = p_other
  )
$$;

create or replace function public.can_see_profile(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_id = auth.uid()
      or public.shares_team(p_id)
      or exists (select 1 from public.dm_threads t
                 where (t.user_a = auth.uid() and t.user_b = p_id) or (t.user_b = auth.uid() and t.user_a = p_id))
      or exists (select 1 from public.team_invites i
                 where i.invited_by = p_id and i.github_login_lower = public.my_login())
$$;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------

-- Perfil desde la identidad de GitHub (identity_data lo escribe Supabase con lo que dice GitHub).
create or replace function public.sync_profile_from_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_login  text := new.identity_data ->> 'user_name';
  v_avatar text := new.identity_data ->> 'avatar_url';
begin
  if new.provider <> 'github' or v_login is null or v_login !~ '^[A-Za-z0-9-]{1,39}$' then
    return new;
  end if;
  insert into public.profiles (id, login, name, avatar_url)
  values (new.user_id, v_login,
          nullif(left(coalesce(new.identity_data ->> 'full_name', new.identity_data ->> 'name', ''), 255), ''),
          case when v_avatar like 'https://avatars.githubusercontent.com/%' then v_avatar end)
  on conflict (id) do update
    set login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url, updated_at = now();
  return new;
end
$$;
drop trigger if exists on_identity_github on auth.identities;
create trigger on_identity_github
  after insert or update of identity_data on auth.identities
  for each row execute function public.sync_profile_from_identity();

-- No se puede cambiar quién creó el equipo ni su id.
create or replace function public.guard_team_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.id := old.id;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  return new;
end
$$;
drop trigger if exists team_guard on public.teams;
create trigger team_guard before update on public.teams for each row execute function public.guard_team_update();

-- Topes de membresía.
create or replace function public.guard_membership() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.team_members where user_id = new.user_id) >= 50 then
    raise exception 'Llegaste al máximo de 50 equipos.';
  end if;
  if (select count(*) from public.team_members where team_id = new.team_id) >= 200 then
    raise exception 'El equipo llegó al máximo de 200 miembros.';
  end if;
  return new;
end
$$;
drop trigger if exists membership_guard on public.team_members;
create trigger membership_guard before insert on public.team_members for each row execute function public.guard_membership();

-- Mensajes: la hora la pone el servidor y hay un tope de 30 por minuto por persona.
create or replace function public.guard_message() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.created_at := now();
  new.author_id := auth.uid();
  if (select count(*) from public.messages
      where author_id = new.author_id and created_at > now() - interval '1 minute') >= 30 then
    raise exception 'Demasiados mensajes seguidos: esperá un minuto.';
  end if;
  return new;
end
$$;
drop trigger if exists message_guard on public.messages;
create trigger message_guard before insert on public.messages for each row execute function public.guard_message();

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

alter table public.profiles          enable row level security;
alter table public.teams             enable row level security;
alter table public.team_members      enable row level security;
alter table public.team_invite_codes enable row level security;
alter table public.team_invites      enable row level security;
alter table public.dm_threads        enable row level security;
alter table public.messages          enable row level security;

-- profiles: ver el propio y el de gente con la que compartís equipo, DM o invitación. Sin escritura directa.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (public.can_see_profile(id));

-- teams
drop policy if exists teams_select on public.teams;
create policy teams_select on public.teams for select to authenticated
  using (public.is_team_member(id)
         or exists (select 1 from public.team_invites i where i.team_id = teams.id and i.github_login_lower = public.my_login()));
-- Sin INSERT directo: se crea con la RPC create_team (alta del owner y del código en la misma transacción).
drop policy if exists teams_update on public.teams;
create policy teams_update on public.teams for update to authenticated
  using (public.team_role(id) in ('owner', 'admin'))
  with check (public.team_role(id) in ('owner', 'admin'));
drop policy if exists teams_delete on public.teams;
create policy teams_delete on public.teams for delete to authenticated
  using (public.team_role(id) = 'owner');

-- team_members: leen los miembros; salir (si no sos owner) o que owner/admin saque a un member.
drop policy if exists members_select on public.team_members;
create policy members_select on public.team_members for select to authenticated
  using (public.is_team_member(team_id));
drop policy if exists members_delete on public.team_members;
create policy members_delete on public.team_members for delete to authenticated
  using ((user_id = auth.uid() and role <> 'owner')
         or (role = 'member' and public.team_role(team_id) in ('owner', 'admin')));

-- team_invite_codes: solo owner/admin leen el código (cambiarlo: RPC regenerate_invite_code).
drop policy if exists codes_select on public.team_invite_codes;
create policy codes_select on public.team_invite_codes for select to authenticated
  using (public.team_role(team_id) in ('owner', 'admin'));

-- team_invites: las ven los miembros del equipo y el invitado; crean owner/admin; borran ellos o el invitado.
drop policy if exists invites_select on public.team_invites;
create policy invites_select on public.team_invites for select to authenticated
  using (public.is_team_member(team_id) or github_login_lower = public.my_login());
drop policy if exists invites_insert on public.team_invites;
create policy invites_insert on public.team_invites for insert to authenticated
  with check (invited_by = auth.uid() and public.team_role(team_id) in ('owner', 'admin'));
drop policy if exists invites_delete on public.team_invites;
create policy invites_delete on public.team_invites for delete to authenticated
  using (public.team_role(team_id) in ('owner', 'admin') or github_login_lower = public.my_login());

-- dm_threads: solo los dos participantes (alta: RPC open_dm).
drop policy if exists threads_select on public.dm_threads;
create policy threads_select on public.dm_threads for select to authenticated
  using (auth.uid() in (user_a, user_b));

-- messages: leer y escribir solo miembros del equipo / participantes del DM; borrar solo los propios.
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
  using ((team_id is not null and public.is_team_member(team_id))
         or (thread_id is not null and public.is_thread_participant(thread_id)));
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (author_id = auth.uid()
              and ((team_id is not null and public.is_team_member(team_id))
                   or (thread_id is not null and public.is_thread_participant(thread_id))));
drop policy if exists messages_delete on public.messages;
create policy messages_delete on public.messages for delete to authenticated
  using (author_id = auth.uid());

-- El rol anon no ve nada (sin políticas para anon) y además se le sacan los permisos.
revoke all on public.profiles, public.teams, public.team_members, public.team_invite_codes,
              public.team_invites, public.dm_threads, public.messages from anon;

-- ---------------------------------------------------------------------
-- RPC (la app las llama con supabase.rpc). Todas exigen sesión.
-- ---------------------------------------------------------------------

create or replace function public.create_team(p_name text, p_description text default '') returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_team uuid;
begin
  if auth.uid() is null then raise exception 'Iniciá sesión.'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid()) then raise exception 'Tu usuario no tiene perfil de GitHub.'; end if;
  insert into public.teams (name, description, created_by)
    values (btrim(p_name), coalesce(p_description, ''), auth.uid()) returning id into v_team;
  insert into public.team_members (team_id, user_id, role) values (v_team, auth.uid(), 'owner');
  insert into public.team_invite_codes (team_id) values (v_team);
  return v_team;
end
$$;

create or replace function public.join_team_by_code(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_team uuid;
begin
  if auth.uid() is null then raise exception 'Iniciá sesión.'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid()) then raise exception 'Tu usuario no tiene perfil de GitHub.'; end if;
  if p_code is null or p_code !~ '^[0-9a-f]{16}$' then raise exception 'Código inválido.'; end if;
  select team_id into v_team from public.team_invite_codes where code = p_code;
  if v_team is null then raise exception 'Ese código no existe o ya lo cambiaron.'; end if;
  insert into public.team_members (team_id, user_id, role) values (v_team, auth.uid(), 'member')
    on conflict do nothing;
  delete from public.team_invites where team_id = v_team and github_login_lower = public.my_login();
  return v_team;
end
$$;

create or replace function public.regenerate_invite_code(p_team uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  if public.team_role(p_team) not in ('owner', 'admin') then raise exception 'Solo owner o admin.'; end if;
  update public.team_invite_codes set code = encode(extensions.gen_random_bytes(8), 'hex'), created_at = now()
    where team_id = p_team returning code into v_code;
  return v_code;
end
$$;

create or replace function public.accept_invite(p_invite uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_team uuid;
begin
  if auth.uid() is null then raise exception 'Iniciá sesión.'; end if;
  select team_id into v_team from public.team_invites
    where id = p_invite and github_login_lower = public.my_login();
  if v_team is null then raise exception 'Esa invitación no es para vos o ya no existe.'; end if;
  insert into public.team_members (team_id, user_id, role) values (v_team, auth.uid(), 'member')
    on conflict do nothing;
  delete from public.team_invites where id = p_invite;
  return v_team;
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
  insert into public.dm_threads (user_a, user_b) values (v_a, v_b)
    on conflict (user_a, user_b) do nothing returning id into v_id;
  if v_id is null then select id into v_id from public.dm_threads where user_a = v_a and user_b = v_b; end if;
  return v_id;
end
$$;

create or replace function public.mark_read(p_team uuid default null, p_thread uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Iniciá sesión.'; end if;
  if p_team is not null then
    update public.team_members set last_read_at = now() where team_id = p_team and user_id = auth.uid();
  end if;
  if p_thread is not null then
    update public.dm_threads set last_read_a = now() where id = p_thread and user_a = auth.uid();
    update public.dm_threads set last_read_b = now() where id = p_thread and user_b = auth.uid();
  end if;
end
$$;

-- No leídos y último mensaje por conversación (equipos y DMs del usuario). Cuenta hasta 99 por conversación.
create or replace function public.unread_counts()
returns table (kind text, id uuid, unread integer, last_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select 'team'::text, m.team_id,
         (select count(*)::int from (select 1 from public.messages x
            where x.team_id = m.team_id and x.created_at > m.last_read_at and x.author_id <> auth.uid() limit 99) s),
         (select max(x.created_at) from public.messages x where x.team_id = m.team_id)
    from public.team_members m where m.user_id = auth.uid()
  union all
  select 'dm'::text, t.id,
         (select count(*)::int from (select 1 from public.messages x
            where x.thread_id = t.id
              and x.created_at > case when t.user_a = auth.uid() then t.last_read_a else t.last_read_b end
              and x.author_id <> auth.uid() limit 99) s),
         (select max(x.created_at) from public.messages x where x.thread_id = t.id)
    from public.dm_threads t where auth.uid() in (t.user_a, t.user_b)
$$;

-- Las funciones solo para usuarios con sesión.
revoke execute on function
  public.create_team(text, text), public.join_team_by_code(text), public.regenerate_invite_code(uuid), public.accept_invite(uuid),
  public.open_dm(uuid), public.mark_read(uuid, uuid), public.unread_counts()
  from public, anon;
grant execute on function
  public.create_team(text, text), public.join_team_by_code(text), public.regenerate_invite_code(uuid), public.accept_invite(uuid),
  public.open_dm(uuid), public.mark_read(uuid, uuid), public.unread_counts()
  to authenticated;

-- ---------------------------------------------------------------------
-- Realtime: la app escucha INSERT en messages (Realtime aplica la RLS de arriba a cada suscriptor).
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- Storage: fotos de equipo en un bucket PRIVADO, ≤ 512 KB, solo imágenes.
-- Ruta: team-photos/<team_id>/<archivo>. Leen los miembros; suben/cambian/borran owner y admin.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('team-photos', 'team-photos', false, 524288, array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = 524288, allowed_mime_types = array['image/webp', 'image/png', 'image/jpeg'];

drop policy if exists team_photos_select on storage.objects;
create policy team_photos_select on storage.objects for select to authenticated
  using (bucket_id = 'team-photos'
         and public.is_team_member(public.uuid_or_null((storage.foldername(name))[1])));
drop policy if exists team_photos_insert on storage.objects;
create policy team_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'team-photos'
              and public.team_role(public.uuid_or_null((storage.foldername(name))[1])) in ('owner', 'admin'));
drop policy if exists team_photos_update on storage.objects;
create policy team_photos_update on storage.objects for update to authenticated
  using (bucket_id = 'team-photos'
         and public.team_role(public.uuid_or_null((storage.foldername(name))[1])) in ('owner', 'admin'));
drop policy if exists team_photos_delete on storage.objects;
create policy team_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'team-photos'
         and public.team_role(public.uuid_or_null((storage.foldername(name))[1])) in ('owner', 'admin'));

-- ===== 0002_hardening.sql =====
-- =====================================================================
-- Sloth v0.5 · Chat del equipo — endurecimiento de permisos de funciones
-- Responde a los avisos del Security Advisor de Supabase (lints 0028/0029):
--  * Las funciones auxiliares de RLS no se pueden ejecutar sin sesión (anon). Los usuarios con
--    sesión SÍ las necesitan: las políticas RLS las evalúan con los permisos de quien consulta.
--  * Las funciones de trigger no las ejecuta nadie por API (los triggers no necesitan EXECUTE).
--  * Las RPC del chat siguen solo para `authenticated` (ver 0001), cada una con sus chequeos.
-- =====================================================================

revoke execute on function
  public.uuid_or_null(text),
  public.is_team_member(uuid),
  public.team_role(uuid),
  public.is_thread_participant(uuid),
  public.my_login(),
  public.shares_team(uuid),
  public.can_see_profile(uuid)
  from public, anon;
grant execute on function
  public.uuid_or_null(text),
  public.is_team_member(uuid),
  public.team_role(uuid),
  public.is_thread_participant(uuid),
  public.my_login(),
  public.shares_team(uuid),
  public.can_see_profile(uuid)
  to authenticated;

revoke execute on function
  public.sync_profile_from_identity(),
  public.guard_team_update(),
  public.guard_membership(),
  public.guard_message()
  from public, anon, authenticated;

-- ===== 0003_realtime_broadcast.sql =====
-- =====================================================================
-- Sloth · Chat del equipo — entrega rápida con Realtime Broadcast (canales privados)
-- Correr en el SQL Editor DESPUÉS de 0001 y 0002. Es idempotente.
--
-- Por qué: postgres_changes evalúa la RLS de `messages` por cada suscriptor y cada fila, y tarda
-- ~0,5–2 s. Con esto, cada mensaje nuevo se publica además en el tópico de su conversación
-- (`team:<id>` o `thread:<id>`) y la app lo recibe por un canal PRIVADO de Broadcast, donde
-- Realtime chequea el permiso una sola vez, al entrar al canal.
--
-- Seguridad:
--  * Publica SOLO la base, desde un trigger, con la fila ya guardada (autor y hora los puso
--    guard_message). No hay política de INSERT en realtime.messages para estos tópicos: ningún
--    cliente, ni siquiera un miembro, puede publicar en ellos, así que nadie puede falsear un autor.
--  * Leer un tópico: solo miembros del equipo o los dos participantes del DM (mismas funciones que
--    la RLS de `messages`).
--  * Si Broadcast falla, el mensaje se guarda igual y llega por postgres_changes (sigue activo).
-- =====================================================================

-- Tópico con formato exacto → ¿lo puede leer el usuario?
create or replace function public.can_read_chat_topic(p_topic text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when p_topic ~ '^team:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.is_team_member(substr(p_topic, 6)::uuid)
    when p_topic ~ '^thread:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.is_thread_participant(substr(p_topic, 8)::uuid)
    else false
  end
$$;

revoke execute on function public.can_read_chat_topic(text) from public, anon;
grant execute on function public.can_read_chat_topic(text) to authenticated;

drop policy if exists sloth_chat_broadcast_select on realtime.messages;
create policy sloth_chat_broadcast_select on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast' and public.can_read_chat_topic((select realtime.topic())));

-- Publica la fila guardada en el tópico de su conversación. Un fallo de Realtime no frena el INSERT.
create or replace function public.broadcast_message() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform realtime.send(
      jsonb_build_object(
        'id', new.id,
        'client_id', new.client_id,
        'team_id', new.team_id,
        'thread_id', new.thread_id,
        'author_id', new.author_id,
        'body', new.body,
        'created_at', new.created_at
      ),
      'message',
      case when new.team_id is not null then 'team:' || new.team_id::text else 'thread:' || new.thread_id::text end,
      true
    );
  exception when others then
    raise warning 'sloth: broadcast_message falló (%), queda postgres_changes', sqlstate;
  end;
  return null;
end
$$;

revoke execute on function public.broadcast_message() from public, anon, authenticated;

drop trigger if exists message_broadcast on public.messages;
create trigger message_broadcast after insert on public.messages
  for each row execute function public.broadcast_message();

-- ===== 0004_chat_completo.sql =====
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
-- Si pg_cron se activa después, corré solo el bloque `do $$ … $$` de abajo para agendarla: correr toda
-- la 0004 deshace la 0008.
do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    perform cron.schedule('sloth-chat-purge', '17 * * * *', 'select public.chat_purge_expired_all()');
  end if;
exception when others then
  raise warning 'sloth: no se pudo agendar la purga con pg_cron (%)', sqlstate;
end
$$;

-- ===== 0005_chat_via_claude.sql =====
-- =====================================================================
-- Sloth · Chat del equipo — marca «vía Claude» en los mensajes
-- Opcional. Correr en el SQL Editor DESPUÉS de 0004. Es idempotente. Se aplica a mano: la app
-- detecta si está y, si no, manda el prefijo «[vía Claude] » en el texto.
--
-- Seguridad:
--  * La marca es INFORMATIVA. La pone el cliente del autor al enviar, y cualquier miembro podría
--    mandarla por la API en un mensaje escrito a mano. No prueba que lo haya escrito un agente.
--  * El autor real lo sigue fijando la RLS (author_id = auth.uid()).
--  * Solo se puede poner al crear el mensaje: el permiso de update sigue siendo solo sobre las
--    columnas (body, deleted_at), así que nadie la cambia después.
--  * Los clientes viejos siguen andando: el evento 'message' trae una clave de más que ignoran.
-- =====================================================================

alter table public.messages add column if not exists via text;
alter table public.messages drop constraint if exists messages_via_ok;
alter table public.messages add constraint messages_via_ok check (via is null or via = 'claude');
grant insert (team_id, thread_id, client_id, body, reply_to, via) on public.messages to authenticated;

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
        'kind', new.kind,
        'via', new.via
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

-- ===== 0006_celu_remoto.sql =====
-- =====================================================================
-- Sloth · Celular desde cualquier red — canal privado `celu:<uid>` de Realtime Broadcast
-- Correr en el SQL Editor DESPUÉS de 0001 a 0005. Es idempotente.
--
-- Por qué: la PC publica el estado de las sesiones y el celu manda «hola» y decisiones de permisos
-- por un canal Broadcast privado. Todo va cifrado de punta a punta con una clave que sale del QR,
-- así que la base solo ve ruido; esto decide quién puede entrar al canal.
--
-- Seguridad:
--  * Cada usuario lee y escribe SOLO `celu:<su propio uid>`. Nadie puede leer ni publicar en el de otro.
--  * Es la única política de INSERT en realtime.messages y no abre nada más: los tópicos del chat
--    (`team:` y `thread:`) siguen sin INSERT para los clientes.
--  * SELECT e INSERT atan también la columna `topic` de la fila al tópico del canal (Realtime la llena con
--    él): aunque un cliente llegara a tocar realtime.messages directo, no lee filas de otro tópico ni
--    cuela una con `team:` o `thread:`.
--  * anon no tiene acceso: hace falta sesión (GitHub).
-- =====================================================================

create or replace function public.can_use_celu_topic(p_topic text) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and p_topic = 'celu:' || auth.uid()::text
$$;

revoke execute on function public.can_use_celu_topic(text) from public, anon;
grant execute on function public.can_use_celu_topic(text) to authenticated;

drop policy if exists sloth_celu_select on realtime.messages;
create policy sloth_celu_select on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.messages.topic = (select realtime.topic())
    and public.can_use_celu_topic((select realtime.topic()))
  );

drop policy if exists sloth_celu_insert on realtime.messages;
create policy sloth_celu_insert on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and realtime.messages.topic = (select realtime.topic())
    and public.can_use_celu_topic((select realtime.topic()))
  );

-- ===== 0007_expulsar.sql =====
-- Sloth · chat · 0007: expulsar de verdad.
-- Antes, expulsar era un DELETE en team_members y el código de invitación seguía igual: el expulsado
-- volvía a entrar con la misma invitación. remove_member borra la membresía, las invitaciones
-- pendientes de esa persona y regenera el código en la misma transacción.
-- Idempotente: se puede correr más de una vez.

create or replace function public.remove_member(p_team uuid, p_user uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_code text;
begin
  if auth.uid() is null then raise exception 'Iniciá sesión.'; end if;
  if p_team is null or p_user is null then raise exception 'Faltan el equipo o la persona.'; end if;
  if coalesce(public.team_role(p_team), '') not in ('owner', 'admin') then raise exception 'Solo owner o admin.'; end if;
  if p_user = auth.uid() then raise exception 'Para irte del equipo usá «Salir del equipo».'; end if;
  select m.role into v_role from public.team_members m where m.team_id = p_team and m.user_id = p_user for update;
  if v_role is null then raise exception 'Esa persona ya no está en el equipo.'; end if;
  if v_role <> 'member' then raise exception 'Solo se puede expulsar a un miembro, no a un owner ni a un admin.'; end if;
  delete from public.team_members where team_id = p_team and user_id = p_user;
  delete from public.team_invites i
    using public.profiles p
    where i.team_id = p_team and p.id = p_user and i.github_login_lower = p.login_lower;
  update public.team_invite_codes set code = encode(extensions.gen_random_bytes(8), 'hex'), created_at = now()
    where team_id = p_team returning code into v_code;
  if v_code is null then
    insert into public.team_invite_codes (team_id) values (p_team) returning code into v_code;
  end if;
  return v_code;
end
$$;

-- `null not in (...)` es null y el IF no saltaba: alguien de afuera del equipo podía regenerar el código y leerlo.
create or replace function public.regenerate_invite_code(p_team uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  if auth.uid() is null then raise exception 'Iniciá sesión.'; end if;
  if coalesce(public.team_role(p_team), '') not in ('owner', 'admin') then raise exception 'Solo owner o admin.'; end if;
  update public.team_invite_codes set code = encode(extensions.gen_random_bytes(8), 'hex'), created_at = now()
    where team_id = p_team returning code into v_code;
  return v_code;
end
$$;

revoke execute on function public.remove_member(uuid, uuid), public.regenerate_invite_code(uuid) from public, anon;
grant execute on function public.remove_member(uuid, uuid), public.regenerate_invite_code(uuid) to authenticated;

-- ===== 0008_chat_abuso.sql =====
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

-- ===== 0009_schema_version.sql =====
-- =====================================================================
-- Sloth · Chat del equipo — 0009: versión del esquema
-- Correr en el SQL Editor DESPUÉS de 0001–0008. Es idempotente. Se aplica a mano.
--
-- Qué suma: chat_schema_version(), que devuelve un entero constante. Sloth la llama con la clave
-- anónima para saber hasta qué migración llegó tu proyecto. No lee tablas ni expone datos.
-- =====================================================================

create or replace function public.chat_schema_version() returns integer
language sql immutable security invoker set search_path = '' as $$ select 9 $$;
revoke execute on function public.chat_schema_version() from public;
grant execute on function public.chat_schema_version() to anon, authenticated;
comment on function public.chat_schema_version() is 'Versión del esquema del chat de Sloth (la última migración aplicada).';
