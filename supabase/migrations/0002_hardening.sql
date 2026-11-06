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
