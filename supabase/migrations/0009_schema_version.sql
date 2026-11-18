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
