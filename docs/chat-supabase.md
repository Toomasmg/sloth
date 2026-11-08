# Chat del equipo en Sloth (Supabase propio)

Desde la v0.5, Sloth tiene un chat para personas: equipos con nombre, descripción y foto, chat grupal por equipo y mensajes directos (por ejemplo, con Mateo). Funciona sobre **tu propio proyecto de Supabase**, que es gratis. Sloth no tiene servidor propio y no ve tus mensajes.

Esto lo hace **una sola persona del equipo, una vez**. Son unos 15 minutos. Después, cada compañero solo inicia sesión con GitHub.

> **Seguridad, lo más importante.** En Sloth se pega solo la **anon key** (también llamada *publishable key*): está hecha para ser pública y la protege la Row Level Security de la migración. La **service_role key** (o *secret key*) **nunca** va en Sloth, ni en `.sloth/team.json`, ni en ningún repo. Sloth la rechaza si la pegás por error.

## 1. Crear el proyecto de Supabase

1. Entrá a <https://supabase.com> y creá una cuenta. Podés entrar con GitHub.
2. Tocá **New project**. Elegí un nombre (por ejemplo `sloth-chat-cosmos`), una contraseña de base de datos (guardala en tu gestor de contraseñas: Sloth no la usa) y la región más cercana (por ejemplo *South America (São Paulo)*).
3. Esperá a que termine de crearse. Tarda 1 o 2 minutos.
4. Andá a **Project Settings → API** (o **Data API**) y anotá:
   - **Project URL**: `https://<ref>.supabase.co`
   - **anon public** (o **Publishable key**): empieza con `eyJ…` o con `sb_publishable_…`

## 2. Crear la GitHub OAuth App

1. En GitHub, andá a **Settings → Developer settings → OAuth Apps → New OAuth App**. Si querés que la app sea de la organización, hacelo en la organización: **Settings → Developer settings → OAuth Apps**.
2. Completá así:
   - **Application name**: `Sloth chat`
   - **Homepage URL**: `https://github.com/Toomasmg/sloth`
   - **Authorization callback URL**: `https://<ref>.supabase.co/auth/v1/callback`. Es la URL de tu proyecto más `/auth/v1/callback`.
3. Tocá **Register application**. Después tocá **Generate a new client secret** y copiá el **Client ID** y el **Client secret**. Este secreto va **solo** en Supabase, en el paso 3.

## 3. Habilitar GitHub en Supabase Auth

1. En Supabase, andá a **Authentication → Sign In / Providers**.
2. En **GitHub**, activalo y pegá el Client ID y el Client secret. Guardá.
3. Desactivá el proveedor **Email**: el chat usa solo GitHub, y así nadie se crea una cuenta con un usuario inventado.
4. Andá a **Authentication → URL Configuration**:
   - En **Site URL**, poné `http://127.0.0.1:53682/auth/callback`.
   - En **Redirect URLs**, agregá estas tres. Son los puertos que prueba Sloth para recibir el login:
     - `http://127.0.0.1:53682/auth/callback`
     - `http://127.0.0.1:53683/auth/callback`
     - `http://127.0.0.1:53684/auth/callback`

¿Por qué `127.0.0.1`? Cuando tocás «Iniciar sesión con GitHub», Sloth abre tu navegador normal. Al terminar, GitHub y Supabase te devuelven a un mini servidor que Sloth levanta **solo en tu PC** y solo durante el login. Sloth nunca ve tu contraseña de GitHub.

## 4. Correr la migración, con las tablas y la seguridad

1. En Supabase, andá a **SQL Editor → New query**.
2. Copiá todo el contenido de [`supabase/migrations/0001_chat.sql`](../supabase/migrations/0001_chat.sql) de este repo, pegalo y tocá **Run**. Tiene que terminar sin errores. Después hacé lo mismo con [`supabase/migrations/0002_hardening.sql`](../supabase/migrations/0002_hardening.sql), que cierra el acceso por API a las funciones internas (responde a los avisos del Security Advisor).
3. Comprobá que quedó bien:
   - En **Table Editor** tienen que aparecer `profiles`, `teams`, `team_members`, `team_invite_codes`, `team_invites`, `dm_threads` y `messages`. Todas tienen que tener el candado de RLS activado.
   - En **Storage** tiene que aparecer el bucket `team-photos`, **privado**.
   - En **Database → Publications → supabase_realtime** tiene que estar la tabla `messages`.

Si el editor da un error de permisos en `storage.objects` o en `auth.identities`, avisá en el repo con un issue y el texto del error. No hay que tocar nada más.

## 5. Conectar Sloth

Elegí una de las dos formas.

**A. Para vos solo:** en Sloth, andá a **Configuración (Ctrl+,) → Equipo y datos → Chat del equipo**. Pegá la **Project URL** y la **anon key** y tocá **Guardar**. Después tocá **Iniciar sesión con GitHub**.

**B. Para todo el equipo:** agregá esto al `.sloth/team.json` del repo y commitealo:

```json
{
  "chat": {
    "supabaseUrl": "https://<ref>.supabase.co",
    "anonKey": "eyJ...o sb_publishable_..."
  }
}
```

Cuando un compañero abre Sloth con ese repo, la app le pregunta si quiere usar el chat de ese proyecto. Le muestra el dominio y solo lo usa si acepta. Si tiene configurado otro chat a mano en Configuración, gana el suyo.

## 6. Usarlo

- **Crear un equipo:** abrí el **Chat** (botón en la barra de arriba) y tocá **Nuevo equipo**. Elegí nombre, descripción y foto. La foto se recorta en cuadrado y se achica antes de subirla; puede pesar hasta 512 KB.
- **Invitar:** hay dos maneras.
  - **Por usuario de GitHub** (por ejemplo `mateo`): la invitación le aparece cuando inicia sesión.
  - **Por código:** pasale el código del equipo. Lo ven solo los owners y los admins, y lo pueden cambiar cuando quieran; el código viejo deja de andar.
- **Mensaje directo:** desde la lista de miembros de un equipo, tocá **Escribirle**. Solo podés abrir un DM con gente con la que compartís un equipo.
- **No leídos y avisos:** el botón Chat muestra cuántos mensajes tenés sin leer. Si la ventana de Sloth no tiene el foco, te llega una notificación de Windows.

## Qué protege la migración (RLS)

- Un equipo, sus miembros y sus mensajes los leen **solo sus miembros**. Un DM lo leen **solo sus dos participantes**.
- Nadie puede escribir en nombre de otro: el autor y la hora los pone la base de datos. Hay un tope de 30 mensajes por minuto por persona, y un mensaje puede tener hasta 4000 caracteres.
- Entrar a un equipo, abrir un DM y marcar como leído pasan solo por funciones que revisan permisos; no se puede insertar directo. El código de invitación lo ven solo los owners y los admins.
- El usuario de GitHub sale de la identidad que guarda Supabase al iniciar sesión, y el usuario no la puede editar. Por eso nadie puede hacerse pasar por `mateo` para quedarse con su invitación.
- Las fotos van en un bucket **privado**. Las ven solo los miembros del equipo y las cambian solo los owners y los admins.

La migración tiene una prueba con PGlite (Postgres en WASM), con 40 casos de acceso permitido y prohibido: `npm i --no-save @electric-sql/pglite` y después `node supabase/tests/rls.test.mjs supabase/migrations/0001_chat.sql`.

## Costos y consumo

- El plan gratis de Supabase alcanza de sobra para un equipo chico: 500 MB de base, 1 GB de storage y 200 conexiones realtime simultáneas.
- Sloth abre **una sola** conexión realtime, y solo mientras la app está abierta. Si cerrás Sloth, se corta. Si lo dejás en la bandeja, sigue conectado para avisarte.
- Ojo: Supabase **pausa** los proyectos gratis después de una semana sin uso. Si pasa, entrá al panel y tocá **Restore project**.

## Si algo falla

| Problema | Qué hacer |
|---|---|
| «redirect_to no permitido» o vuelve a la página de Supabase | Revisá las **Redirect URLs** del paso 3.4. Tienen que estar las tres. |
| El navegador dice que no puede conectarse a `127.0.0.1` | Sloth tiene que estar abierto mientras iniciás sesión. Probá de nuevo desde Sloth. |
| «Tu usuario no tiene perfil de GitHub» | Entraste con otro proveedor. Cerrá sesión y entrá con GitHub. |
| «Solo podés escribirle a gente de tus equipos» | Primero tienen que estar en un mismo equipo. |

---

## Chat v2 (Sloth 0.6): migración 0003

Agrega canales por equipo, mensajes con respuestas, hilos, edición y borrado propio, fijados, reacciones, tarjetas (ticket, espacio, PR, código), adjuntos, perfiles con estado, lecturas, silenciar y presencia. Todo sigue con RLS estricta: solo miembros del equipo ven y escriben, nadie edita lo ajeno, y no hace falta `service_role`.

### Qué hace

- **Canales.** Cada equipo tiene un canal `general` (no se borra). Los demás se crean, se renombran y cambian de tema y descripción solo owner/admin (`create_channel`, `update_channel`). Los mensajes de 0.5 pasan al `general` al migrar.
- **Mensajes.** Se pueden editar y borrar los propios (borrado lógico: queda «Mensaje borrado», sin cuerpo ni adjuntos ni reacciones). Responder citando (`reply_to`). Hilos (`thread_root`, con contador de respuestas y última respuesta). Fijar: el autor o un owner/admin del equipo. Hay un tope de 30 por minuto por persona, como en 0001.
- **Tarjetas.** Columna `kind` (`text`, `file`, `code`, `ticket`, `space`, `pr`) y `payload jsonb`. Una función `valid_chat_payload()` valida claves, tipos y formatos en un CHECK (por ejemplo, un PR solo acepta links de github.com).
- **Reacciones.** Tabla `message_reactions`, única por persona, mensaje y tipo (`visto`, `aprobado`, `mesumo`, `importante`, `idea`, `gracias`). Al reaccionar se actualiza `messages.reactions_at` para que Realtime avise a todos sin emitir borrados de reacciones (que no pasan por RLS).
- **Adjuntos.** Metadatos en `message_files`; el archivo va al bucket privado **`chat-files`** (≤ 10 MB) en `<team_id>/<uuid>` o `dm/<thread_id>/<uuid>`. Solo se ven en mensajes vivos.
- **Lecturas y silencio.** Tabla `conv_state` (última lectura y silencio por persona y conversación), sin escritura directa: `chat_mark_read`, `chat_set_muted`, `chat_unread`, `conv_read_marks` («Visto por», sin exponer silencios). `mark_read` de 0.5 sigue funcionando.
- **Perfiles.** Columnas nuevas en `profiles`: `handle` (@usuario, único, `^[a-z0-9-]{3,30}$`), `display_name`, `color`, `photo_path`, `presence` (`disponible`, `ausente`, `no_molestar`, `invisible`), `status_text` y `status_until`, `role_title`, `timezone`. Se editan por `update_profile(jsonb)` y la foto por `set_profile_photo`. Foto en el bucket privado **`profile-photos`** (≤ 512 KB), carpeta = id del usuario.
- **Presencia y «escribiendo».** Sin tablas: canales privados de Realtime `team:<team_id>` (presencia y «escribiendo») y `dm:<thread_id>` («escribiendo»). Las políticas `chat_rt_read` y `chat_rt_write` sobre `realtime.messages` dejan entrar solo a miembros del equipo o participantes del DM. Quien está en «invisible» no se anuncia.
- **Publicación Realtime.** Se agregan `team_channels` y `profiles`; `messages` ya estaba (ahora también se escuchan sus UPDATE).

### Cómo aplicarla

Solo cuando el dueño lo autorice. Es **una sola vez**, después de 0001 y 0002, en el SQL Editor del proyecto (igual que en el paso 4):

1. Copiá todo `supabase/migrations/0003_chat_v2.sql`, pegalo y tocá **Run**. Tiene que terminar sin errores.
2. Comprobá: en **Table Editor** aparecen `team_channels`, `message_reactions`, `message_files` y `conv_state`, con RLS activado. En **Storage** aparecen `chat-files` y `profile-photos`, privados. En **Database → Publications → supabase_realtime** están `messages`, `team_channels` y `profiles`.
3. Es idempotente: se puede correr de nuevo sin romper nada (`if not exists`, `or replace`, `drop ... if exists`).

Prueba automática (PGlite, sin tocar Supabase): `npm i --no-save @electric-sql/pglite` y después `node supabase/tests/chat-v2.test.mjs supabase/migrations`. Aplica 0001, 0002 y 0003 (dos veces), carga datos de la versión 0.5 y corre los casos de acceso permitido y prohibido. Para la regresión de 0.5: `node supabase/tests/rls.test.mjs <archivo con 0001+0002+0003 concatenados>`.

### Compatibilidad con 0.5

- Un cliente 0.5 que escribe en un equipo cae en el canal `general` (un trigger completa `channel_id`).
- `mark_read(p_team, p_thread)` sigue existiendo y además deja leído el `general` en `conv_state`.
- `unread_counts()` no cambió. Un cliente 0.5 ve todos los mensajes del equipo mezclados, porque no conoce canales: es un efecto esperado mientras dura la transición.

### Cómo revertirla

Solo si hace falta, y **borra datos nuevos** (canales, reacciones, adjuntos, lecturas v2 y los campos nuevos). Antes, avisá a los compañeros. En este orden, en el SQL Editor:

```sql
-- 1. Restaurar lo de 0001/0002 que 0003 reemplazó (volver a correr esos bloques):
--    guard_message() y mark_read() de 0001 (y mark_read de 0003 es compatible: se puede dejar),
--    sync_profile_from_identity() de 0001, y la política messages_delete de 0001.
drop trigger if exists message_guard_update on public.messages;
drop trigger if exists message_reply_count on public.messages;
drop trigger if exists message_on_deleted on public.messages;
drop trigger if exists reactions_touch on public.message_reactions;
drop trigger if exists team_default_channel on public.teams;
drop policy if exists messages_update on public.messages;
create policy messages_delete on public.messages for delete to authenticated using (author_id = auth.uid());

-- 2. Realtime y storage.
alter publication supabase_realtime drop table public.team_channels, public.profiles;
drop policy if exists chat_rt_read on realtime.messages;
drop policy if exists chat_rt_write on realtime.messages;
delete from storage.objects where bucket_id in ('chat-files', 'profile-photos');
delete from storage.buckets where id in ('chat-files', 'profile-photos');

-- 3. Quitar lo de mensajes (solo si no hay mensajes borrados; si los hay, borrarlos antes).
delete from public.messages where deleted_at is not null;
alter table public.messages
  drop constraint if exists messages_scope_check, drop constraint if exists messages_kind_check,
  drop constraint if exists messages_payload_check, drop constraint if exists messages_self_ref_check,
  drop constraint if exists messages_body_check;
alter table public.messages add constraint messages_body_check check (char_length(body) between 1 and 4000 and btrim(body) <> '');
alter table public.messages
  drop column if exists channel_id, drop column if exists kind, drop column if exists payload,
  drop column if exists reply_to, drop column if exists thread_root, drop column if exists reply_count,
  drop column if exists last_reply_at, drop column if exists edited_at, drop column if exists deleted_at,
  drop column if exists pinned_at, drop column if exists pinned_by, drop column if exists reactions_at;

-- 4. Tablas nuevas, funciones nuevas y perfiles.
drop table if exists public.message_reactions, public.message_files, public.conv_state, public.team_channels cascade;
drop function if exists public.create_channel(uuid, text, text, text), public.update_channel(uuid, text, text, text),
  public.update_profile(jsonb), public.set_profile_photo(text), public.chat_mark_read(uuid, uuid),
  public.chat_set_muted(uuid, uuid, boolean), public.chat_unread(), public.conv_read_marks(uuid, uuid),
  public.can_see_message(uuid), public.can_see_conv(uuid, uuid), public.can_access_chat_file(text),
  public.is_chat_file_author(text), public.valid_chat_payload(text, jsonb),
  public.guard_message_update(), public.on_reply_inserted(), public.on_message_deleted(),
  public.touch_reactions(), public.teams_add_default_channel();
alter table public.profiles
  drop column if exists handle, drop column if exists display_name, drop column if exists color,
  drop column if exists photo_path, drop column if exists presence, drop column if exists status_text,
  drop column if exists status_until, drop column if exists role_title, drop column if exists timezone;
```

(`mark_read` y `guard_message` vuelven a su versión 0001 al re-correr esos bloques de 0001, y `sync_profile_from_identity` también. Mientras la versión 0.6 esté en uso, no se revierte.)

### Contrato IPC v2 (`feat:chat:<op>`)

Tipos en `src/main/features/chat-model.ts` (pasar a `src/shared/chat.ts` al integrar). Todos devuelven Promise. Los nombres y formas de la API de 0.5 siguen existiendo, con estas diferencias:

- `ChatConv` = `{ kind: 'channel' | 'team' | 'dm'; id }`. `team` es el alias de 0.5 y se resuelve al canal `general`. Los mensajes y eventos nuevos llevan `kind: 'channel'` con el id del canal.
- `messages`, `send`, `threadReplies`, `editMessage`, `pinMessage` y los eventos de mensaje devuelven `ChatMessageFull`. No es un `ChatMessage` de 0.5: `conv` puede ser `channel`.
- `setView` ahora acepta `ChatViewV2` (un `ChatConv` en `conv`).

| Operación | Firma | Notas |
|---|---|---|
| `channels` | `(teamId: string) → ChatChannel[]` | `general` primero. Incluye no leídos y silencio. |
| `createChannel` | `(teamId: string, input: { name; topic?; description? }) → ChatChannel` | owner/admin |
| `updateChannel` | `(channelId: string, patch: { name?; topic?; description? }) → ChatChannel` | owner/admin |
| `messages` | `(conv: ChatConv, before?: string, limit?: number) → ChatMessageFull[]` | viejo → nuevo; sin respuestas de hilo |
| `send` | `(conv: ChatConv, body: string, clientId: string) → ChatMessageFull` | compat. 0.5 |
| `sendMessage` | `(input: ChatSendInput) → ChatMessageFull` | `{ conv, clientId, body?, card?, replyTo?, threadRoot?, files?: ChatFileRef[] }`. Idempotente por `clientId`. Tarjeta y adjuntos no van juntos. |
| `threadReplies` | `(rootId: string, limit?: number) → ChatMessageFull[]` | respuestas de un hilo, viejo → nuevo |
| `editMessage` | `(messageId: string, body: string) → ChatMessageFull` | solo el autor |
| `deleteMessage` | `(messageId: string) → void` | borrado lógico; borra también los objetos del bucket |
| `pinMessage` | `(messageId: string, pinned: boolean) → ChatMessageFull` | autor o owner/admin |
| `pinnedMessages` | `(conv: ChatConv) → ChatMessageFull[]` | |
| `toggleReaction` | `(messageId: string, kind: ChatReactionKind, on: boolean) → ChatReaction[]` | `ChatReaction = { kind; userIds }` |
| `uploadFile` | `(conv: ChatConv, file: { name; mime?; base64 }) → ChatFileRef` | sube al bucket; después va en `sendMessage.files` |
| `downloadFile` | `(fileId: string) → { name; mime; base64 }` | |
| `convFiles` | `(conv: ChatConv) → ChatFile[]` | pestaña «Archivos» |
| `readMarks` | `(conv: ChatConv) → ChatReadMark[]` | «Visto por»: `{ userId; lastReadAt }` |
| `markRead` | `(conv: ChatConv) → void` | acepta `channel`, `team` o `dm` |
| `setMuted` | `(conv: ChatConv, muted: boolean) → void` | |
| `setView` | `(view: ChatViewV2) → void` | |
| `setTyping` | `(conv: ChatConv, typing: boolean) → void` | con tope de 1 cada 2 s |
| `presence` | `(teamId: string) → ChatPresenceEvent` | estado actual de presencia del equipo |
| `profile` | `(userId?: string) → ChatPerson` | sin `userId`, el propio |
| `updateProfile` | `(patch: ChatProfilePatch) → ChatPerson` | `{ displayName?; handle?; color?; presence?; statusText?; statusUntil?: number \| null; roleTitle?; timezone? }` |
| `setProfilePhoto` | `(base64: string \| null) → ChatPerson` | `null` la quita. Webp, png o jpeg, ≤ 512 KB. |
| `people` | `(teamId: string) → ChatTeamPerson[]` | miembros con perfil v2, `role` y `joinedAt` |
| `createTeam`, `updateTeam`, `members`, `inviteByLogin`, `regenerateCode`, `joinByCode`, `acceptInvite`, `declineInvite`, `leaveTeam`, `removeMember`, `openDm` | sin cambios | ver 0.5 |

Eventos (main → UI): `snapshot` (igual que antes), `message` (`ChatMessageFull`, propio o ajeno), `messageChanged` (`ChatMessageFull`: edición, borrado, fijado, reacciones, contadores), `presence` (`ChatPresenceEvent`), `typing` (`ChatTypingEvent`), `open`.

Evento **interno de main** (no va a la UI): `chatEvents` de `src/main/features/chat-events.ts`, evento `'message'` con `ChatNoticeEvent = { teamId: string | null; conversationId; from; preview; mentionsMe; muted }`. Se emite por cada mensaje nuevo de otra persona, con la ventana en cualquier estado, para el aviso de Windows y el permiso. `muted` indica si la conversación está silenciada.

### Pedidos para el integrador

- Mover `chat-model.ts` (tipos y constantes) a `src/shared/chat.ts`, y extender `ChatMessage.conv` a `ChatConv` (hoy solo `team | dm`).
- El renderer 0.5 (`features/chat`) usa `ChatMessage` y `kind: 'team'`. Con 0.6 cambia el contrato: lo adapta el paquete 11.
- Los adjuntos y las fotos de perfil dependen de los buckets `chat-files` y `profile-photos` y de las políticas de 0003. Sin 0003 aplicada, esas operaciones fallan con un mensaje claro.

### Pendiente (no entra en 0003)

- Borrar canales. Moderación de mensajes ajenos por admin (hoy solo se fijan). Cuotas de Storage por equipo.
- Limpieza de adjuntos huérfanos (un objeto cuya subida no llegó a un mensaje). Hoy quedan en el bucket.
- «Tomar ticket» y «Crear ticket con este mensaje» son de la interfaz: no tienen tabla propia en 0003.
