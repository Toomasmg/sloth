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
