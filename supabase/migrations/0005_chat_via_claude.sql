-- =====================================================================
-- Sloth · Chat del equipo — marca «vía Claude» en los mensajes
-- Opcional. Correr en el SQL Editor DESPUÉS de 0004. Es idempotente. Se aplica a mano: la app
-- detecta si está y, si no, manda el prefijo «[vía Claude] » en el texto.
--
-- Seguridad:
--  * La marca es INFORMATIVA. La pone el cliente del autor al enviar, y cualquier miembro podría
--    mandarla por la API en un mensaje escrito a mano. No prueba que lo haya escrito un agente.
--  * El autor real lo sigue fijando la RLS (author_id = auth.uid()).
--  * Solo se puede poner al crear el mensaje: el permiso de update sigue siendo (body, deleted_at)
--    y guard_message_update repone el resto desde la fila vieja, así que nadie la cambia después.
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
