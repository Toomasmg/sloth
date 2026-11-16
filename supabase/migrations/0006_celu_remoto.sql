-- =====================================================================
-- Sloth · Celular desde cualquier red — canal privado `celu:<uid>` de Realtime Broadcast
-- Correr en el SQL Editor DESPUÉS de 0001 a 0004. Es idempotente.
--
-- Por qué: la PC publica el estado de las sesiones y el celu manda «hola» y decisiones de permisos
-- por un canal Broadcast privado. Todo va cifrado de punta a punta con una clave que sale del QR,
-- así que la base solo ve ruido; esto decide quién puede entrar al canal.
--
-- Seguridad:
--  * Cada usuario lee y escribe SOLO `celu:<su propio uid>`. Nadie puede leer ni publicar en el de otro.
--  * Es la única política de INSERT en realtime.messages y no abre nada más: los tópicos del chat
--    (`team:` y `thread:`) siguen sin INSERT para los clientes.
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
  using (realtime.messages.extension = 'broadcast' and public.can_use_celu_topic((select realtime.topic())));

drop policy if exists sloth_celu_insert on realtime.messages;
create policy sloth_celu_insert on realtime.messages for insert to authenticated
  with check (realtime.messages.extension = 'broadcast' and public.can_use_celu_topic((select realtime.topic())));
