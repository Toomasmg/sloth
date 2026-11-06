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
