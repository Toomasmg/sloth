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
