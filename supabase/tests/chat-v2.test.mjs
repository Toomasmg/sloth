// Prueba de la migración supabase/migrations/0003_chat_v2.sql sobre PGlite (Postgres en WASM), con los stubs
// de auth/storage/roles de Supabase. Aplica 0001 y 0002, deja datos «viejos», aplica 0003 dos veces
// (idempotencia) y corre los casos de acceso permitido y prohibido del Chat v2.
// Uso: node chat-v2.test.mjs <carpeta con 0001_chat.sql, 0002_hardening.sql y 0003_chat_v2.sql>
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('Uso: node chat-v2.test.mjs <carpeta de migraciones>')
  process.exit(2)
}
const sql = (f) => readFileSync(join(dir, f), 'utf8')

const db = new PGlite({ extensions: { pgcrypto } })
const stub = `
create role anon nologin; create role authenticated nologin;
create schema auth; create schema storage; create schema extensions;
grant usage on schema public, auth, storage, extensions to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to public;
create table auth.users (id uuid primary key, raw_user_meta_data jsonb);
create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users, provider text, identity_data jsonb);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
grant execute on function auth.uid() to anon, authenticated;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
grant all on storage.objects to authenticated;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
grant execute on function storage.foldername(text) to authenticated;
create publication supabase_realtime;
`
await db.exec(stub)
await db.exec(sql('0001_chat.sql'))
await db.exec(sql('0002_hardening.sql'))

const U = {
  tomy: '00000000-0000-0000-0000-000000000001',
  mateo: '00000000-0000-0000-0000-000000000002',
  evil: '00000000-0000-0000-0000-000000000003'
}
for (const [login, id] of Object.entries(U)) {
  await db.query('insert into auth.users(id, raw_user_meta_data) values ($1, $2)', [id, { user_name: login }])
  await db.query("insert into auth.identities(user_id, provider, identity_data) values ($1,'github',$2)", [
    id,
    { user_name: login, avatar_url: 'https://avatars.githubusercontent.com/u/1', full_name: login }
  ])
}

async function as(user, q, params = []) {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user ?? ''])
  await db.exec(user ? 'set role authenticated' : 'set role anon')
  try {
    return (await db.query(q, params)).rows
  } finally {
    await db.exec('reset role')
  }
}
let fails = 0
const ok = (c, m) => {
  console.log(c ? 'OK   ' : 'FALLA', m)
  if (!c) fails++
}
const throws = async (p, m) => {
  try {
    await p
    ok(false, m + ' (no tiró)')
  } catch (e) {
    ok(true, m + ' -> ' + e.message.slice(0, 70))
  }
}
const uuid = () => '00000000-0000-4000-8000-' + String(Math.floor(Math.random() * 1e12)).padStart(12, '0')
const v4 = () => crypto.randomUUID()

// ---------- datos «viejos» (0.5): equipo, invitación, mensajes de equipo y un DM ----------
const team = (await as(U.tomy, "select public.create_team('Cosmos', 'desc') as id"))[0].id
const code = (await as(U.tomy, 'select code from public.team_invite_codes where team_id=$1', [team]))[0].code
await as(U.tomy, 'insert into public.team_invites(team_id, github_login_lower) values ($1, $2)', [team, 'mateo'])
const invId = (await as(U.mateo, 'select id from public.team_invites'))[0].id
await as(U.mateo, 'select public.accept_invite($1)', [invId])
const legacyId = (await as(U.tomy, "insert into public.messages(team_id, client_id, body) values ($1, $2, 'mensaje viejo') returning id", [team, v4()]))[0].id
const dm = (await as(U.tomy, 'select public.open_dm($1) as id', [U.mateo]))[0].id
await as(U.mateo, "insert into public.messages(thread_id, client_id, body) values ($1, $2, 'che tomy')", [dm, v4()])

// ---------- migración 0003: dos veces (idempotencia) ----------
await db.exec(sql('0003_chat_v2.sql'))
await db.exec(sql('0003_chat_v2.sql'))
ok(true, 'la migración 0003 corre dos veces sin error')

const general = (await as(U.tomy, 'select id from public.team_channels where team_id=$1 and is_default', [team]))[0].id
ok(!!general, 'el equipo tiene canal general')
ok((await as(U.tomy, 'select channel_id from public.messages where id=$1', [legacyId]))[0].channel_id === general, 'mensaje viejo queda en general')
ok((await as(U.mateo, 'select count(*)::int as n from public.conv_state where user_id=$1 and channel_id=$2', [U.mateo, general]))[0].n === 1, 'lecturas viejas pasan a conv_state')
ok((await as(U.tomy, 'select handle from public.profiles where id=$1', [U.tomy]))[0].handle === 'tomy', 'handle inicial = login')

// Mensaje del cliente 0.5 (sin canal): cae en general.
const old05 = (await as(U.mateo, "insert into public.messages(team_id, client_id, body) values ($1, $2, 'desde 0.5') returning channel_id", [team, v4()]))[0]
ok(old05.channel_id === general, 'cliente 0.5 sin canal escribe en general')

// ---------- canales ----------
const deploys = (await as(U.tomy, "select public.create_channel($1, 'deploys', 'Avisos de staging', '') as id", [team]))[0].id
ok(!!deploys, 'owner crea canal')
await throws(as(U.tomy, "select public.create_channel($1, 'deploys')", [team]), 'nombre de canal repetido')
await throws(as(U.tomy, "select public.create_channel($1, 'Bad Name')", [team]), 'nombre con mayúsculas y espacios')
await throws(as(U.mateo, "select public.create_channel($1, 'otro')", [team]), 'member no crea canales')
await throws(as(U.tomy, "insert into public.team_channels(team_id, name) values ($1, 'directo')", [team]), 'insert directo en team_channels prohibido')
await as(U.tomy, "select public.update_channel($1, 'despliegues', 'Staging y prod', null)", [deploys])
ok((await as(U.mateo, 'select name, topic from public.team_channels where id=$1', [deploys]))[0].name === 'despliegues', 'owner renombra; member lo ve')
await throws(as(U.mateo, "select public.update_channel($1, 'hack', null, null)", [deploys]), 'member no renombra canal')
ok((await as(U.evil, 'select * from public.team_channels')).length === 0, 'ajeno no ve canales')

// ---------- mensajes en canales, respuestas e hilos ----------
const m1 = (await as(U.tomy, "insert into public.messages(team_id, channel_id, client_id, body) values ($1, $2, $3, 'deploy listo') returning id", [team, deploys, v4()]))[0].id
ok((await as(U.mateo, 'select * from public.messages where channel_id=$1', [deploys])).length === 1, 'member ve mensajes del canal')
await throws(as(U.tomy, "insert into public.messages(team_id, channel_id, client_id, body) values ($1, $2, $3, 'x')", [team, uuid(), v4()]), 'canal que no es del equipo')
const otherTeam = (await as(U.evil, "select public.create_team('Otro', '') as id"))[0].id
const otherGeneral = (await as(U.evil, 'select id from public.team_channels where team_id=$1 and is_default', [otherTeam]))[0].id
await throws(as(U.tomy, "insert into public.messages(team_id, channel_id, client_id, body) values ($1, $2, $3, 'x')", [team, otherGeneral, v4()]), 'canal de otro equipo rechazado')
const replyGeneral = (await as(U.tomy, "insert into public.messages(team_id, client_id, body, reply_to) values ($1, $2, 'cita', $3) returning id", [team, v4(), legacyId]))[0]
ok(!!replyGeneral.id, 'cita de mensaje de la misma conversación')
await throws(as(U.tomy, "insert into public.messages(team_id, channel_id, client_id, body, reply_to) values ($1, $2, $3, 'cita cruzada', $4)", [team, deploys, v4(), legacyId]), 'cita de otro canal rechazada')

const root = (await as(U.tomy, "insert into public.messages(team_id, channel_id, client_id, body) values ($1, $2, $3, 'hilo raíz') returning id", [team, deploys, v4()]))[0].id
await as(U.mateo, "insert into public.messages(team_id, channel_id, client_id, body, thread_root) values ($1, $2, $3, 'respuesta', $4)", [team, deploys, v4(), root])
ok((await as(U.tomy, 'select reply_count, last_reply_at from public.messages where id=$1', [root]))[0].reply_count === 1, 'la raíz cuenta la respuesta')
await throws(as(U.tomy, "insert into public.messages(team_id, channel_id, client_id, body, thread_root) values ($1, $2, $3, 'hilo de hilo', $4)", [team, deploys, v4(), (await as(U.mateo, "select id from public.messages where body='respuesta'"))[0].id]), 'no se responde un hilo dentro de otro hilo')

// ---------- edición, borrado lógico, fijado ----------
await as(U.tomy, "update public.messages set body = 'deploy listo (editado)' where id=$1", [m1])
const ed = (await as(U.tomy, 'select body, edited_at from public.messages where id=$1', [m1]))[0]
ok(ed.body === 'deploy listo (editado)' && ed.edited_at !== null, 'el autor edita y se marca editado_at')
await as(U.mateo, "update public.messages set body = 'hackeado' where id=$1", [m1])
ok((await as(U.tomy, 'select body from public.messages where id=$1', [m1]))[0].body === 'deploy listo (editado)', 'member no edita mensaje ajeno (RLS)')
await throws(as(U.tomy, "update public.messages set author_id=$2 where id=$1", [m1, U.mateo]), 'no se cambia el autor')
await throws(as(U.tomy, "update public.messages set reply_count=50 where id=$1", [root]), 'el contador de respuestas no se fuerza')
await as(U.mateo, 'update public.messages set pinned_at = now() where id=$1', [m1])
ok((await as(U.tomy, 'select pinned_at from public.messages where id=$1', [m1]))[0].pinned_at === null, 'member no fija mensaje ajeno')
await as(U.tomy, 'update public.messages set pinned_at = now() where id=$1', [m1])
const pin = (await as(U.tomy, 'select pinned_at, pinned_by from public.messages where id=$1', [m1]))[0]
ok(pin.pinned_at !== null && pin.pinned_by === U.tomy, 'owner fija y queda registrado quién')
const own = (await as(U.mateo, "insert into public.messages(team_id, channel_id, client_id, body) values ($1, $2, $3, 'mío') returning id", [team, deploys, v4()]))[0].id
await as(U.mateo, 'update public.messages set pinned_at = now() where id=$1', [own])
ok((await as(U.mateo, 'select pinned_at from public.messages where id=$1', [own]))[0].pinned_at !== null, 'el autor fija lo suyo')
await as(U.mateo, 'update public.messages set deleted_at = now() where id=$1', [m1])
ok((await as(U.tomy, 'select deleted_at from public.messages where id=$1', [m1]))[0].deleted_at === null, 'member no borra mensaje ajeno (RLS filtra)')
await as(U.tomy, 'update public.messages set deleted_at = now() where id=$1', [root])
const del = (await as(U.tomy, 'select body, deleted_at, pinned_at from public.messages where id=$1', [root]))[0]
ok(del.body === '' && del.deleted_at !== null, 'borrado lógico vacía el cuerpo y deja la marca')
ok((await as(U.tomy, 'select count(*)::int as n from public.messages where id=$1', [root]))[0].n === 1, 'el borrado no quita la fila')
await throws(as(U.tomy, "update public.messages set body='revive' where id=$1", [root]), 'un mensaje borrado no vuelve a editarse')
await as(U.mateo, "delete from public.messages where id=$1", [own])
ok((await as(U.mateo, 'select count(*)::int as n from public.messages where id=$1', [own]))[0].n === 1, 'DELETE físico no existe para nadie')
await as(U.mateo, "update public.messages set deleted_at = now() where id=$1", [own])
ok((await as(U.mateo, 'select count(*)::int as n from public.messages where id=$1', [own]))[0].n === 1, 'el autor borra lo suyo (lógico)')

// ---------- tarjetas (ticket / espacio / PR / código) ----------
const card = (kind, payload, body = '') =>
  as(U.tomy, 'insert into public.messages(team_id, channel_id, client_id, body, kind, payload) values ($1, $2, $3, $4, $5, $6::jsonb) returning kind', [team, deploys, v4(), body, kind, JSON.stringify(payload)])
ok((await card('ticket', { id: 'TCK-1290', title: 'Exportar tickets a CSV', state: 'Por hacer' }, 'Ticket:'))[0].kind === 'ticket', 'tarjeta ticket válida')
ok((await card('space', { name: 'Back · migración', sub: 'Espacio de tomy', st: 'Trabajando' }))[0].kind === 'space', 'tarjeta espacio válida')
ok((await card('pr', { url: 'https://github.com/cosmos-ai/dashboard/pull/482', repo: 'cosmos-ai/dashboard', num: '482', title: 'Filtro', st: 'Abierto' }))[0].kind === 'pr', 'tarjeta PR válida')
ok((await card('code', { code: 'Error: VITE_API_URL', lang: 'text' }))[0].kind === 'code', 'tarjeta código válida')
await throws(card('ticket', { id: 'X-1', title: 't' }), 'ticket con id inválido')
await throws(card('ticket', { id: 'TCK-1', title: 't', extra: 'no' }), 'ticket con clave de más')
await throws(card('pr', { url: 'https://evil.example.com/pull/1' }), 'PR fuera de github rechazado')
await throws(card('space', { name: 5 }), 'espacio con tipo no texto')
await throws(card('nope', {}), 'tipo de mensaje desconocido')
await throws(as(U.tomy, "insert into public.messages(team_id, channel_id, client_id, body, payload) values ($1, $2, $3, 'hola', '{\"x\":1}')", [team, deploys, v4()]), 'texto con payload rechazado')
await throws(as(U.tomy, "insert into public.messages(team_id, channel_id, client_id, body) values ($1, $2, $3, '   ')", [team, deploys, v4()]), 'texto vacío sigue prohibido')

// ---------- reacciones ----------
await as(U.mateo, "insert into public.message_reactions(message_id, kind) values ($1, 'visto')", [m1])
await as(U.mateo, "insert into public.message_reactions(message_id, user_id, kind) values ($1, $2, 'aprobado')", [m1, U.mateo])
ok((await as(U.tomy, 'select count(*)::int as n from public.message_reactions where message_id=$1', [m1]))[0].n === 2, 'member reacciona y el equipo ve las reacciones')
await throws(as(U.mateo, "insert into public.message_reactions(message_id, user_id, kind) values ($1, $2, 'visto')", [m1, U.tomy]), 'no reaccionar como otro')
await throws(as(U.mateo, "insert into public.message_reactions(message_id, kind) values ($1, 'loquesea')", [m1]), 'tipo de reacción inválido')
await throws(as(U.mateo, "insert into public.message_reactions(message_id, kind) values ($1, 'visto')", [m1]), 'reacción repetida (único por persona y tipo)')
await throws(as(U.evil, "insert into public.message_reactions(message_id, kind) values ($1, 'visto')", [m1]), 'ajeno no reacciona')
ok((await as(U.evil, 'select * from public.message_reactions')).length === 0, 'ajeno no ve reacciones')
ok((await as(U.tomy, 'select reactions_at from public.messages where id=$1', [m1]))[0].reactions_at !== null, 'reaccionar avisa al mensaje (reactions_at)')
await as(U.mateo, "delete from public.message_reactions where message_id=$1 and kind='visto'", [m1])
ok((await as(U.tomy, 'select count(*)::int as n from public.message_reactions where message_id=$1', [m1]))[0].n === 1, 'quitar la reacción propia')
await throws(as(U.mateo, "insert into public.message_reactions(message_id, kind) values ($1, 'idea')", [root]), 'no reaccionar a un mensaje borrado')

// ---------- adjuntos y storage ----------
const fileMsg = (await as(U.mateo, "insert into public.messages(team_id, channel_id, client_id, body, kind) values ($1, $2, $3, '', 'file') returning id", [team, deploys, v4()]))[0].id
const teamPath = `${team}/${v4()}`
await as(U.mateo, "insert into storage.objects(bucket_id, name) values ('chat-files', $1)", [teamPath])
await as(U.mateo, 'insert into public.message_files(message_id, team_id, name, size_bytes, mime, path) values ($1, $2, $3, $4, $5, $6)', [fileMsg, team, 'reporte.xlsx', 84000, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', teamPath])
ok((await as(U.tomy, 'select name from public.message_files where message_id=$1', [fileMsg]))[0].name === 'reporte.xlsx', 'el equipo ve el adjunto')
ok((await as(U.tomy, 'select * from storage.objects where name=$1', [teamPath])).length === 1, 'miembro lee el objeto del equipo')
ok((await as(U.evil, 'select * from storage.objects where name=$1', [teamPath])).length === 0, 'ajeno no lee el objeto')
await throws(as(U.evil, "insert into storage.objects(bucket_id, name) values ('chat-files', $1)", [`${team}/${v4()}`]), 'ajeno no sube a la carpeta del equipo')
await throws(as(U.tomy, 'insert into public.message_files(message_id, team_id, name, size_bytes, path) values ($1, $2, $3, 1, $4)', [fileMsg, team, 'x', `${team}/${v4()}`]), 'adjuntar a mensaje ajeno rechazado')
await throws(as(U.mateo, 'insert into public.message_files(message_id, team_id, name, size_bytes, path) values ($1, $2, $3, 1, $4)', [fileMsg, team, 'x', `${otherTeam}/${v4()}`]), 'ruta de otro equipo rechazada')
await throws(as(U.mateo, "insert into public.message_files(message_id, team_id, name, size_bytes, path) values ($1, $2, $3, 1, $4)", [fileMsg, team, 'x/y', `${team}/${v4()}`]), 'nombre con barra rechazado')
await throws(as(U.mateo, 'insert into public.message_files(message_id, team_id, name, size_bytes, path) values ($1, $2, $3, 11000000, $4)', [fileMsg, team, 'grande', `${team}/${v4()}`]), 'adjunto de más de 10 MB rechazado')
await as(U.mateo, "insert into storage.objects(bucket_id, name) values ('chat-files', $1)", [`${team}/del-${v4()}`]).catch(() => {})
const dmPath = `dm/${dm}/${v4()}`
await as(U.mateo, "insert into storage.objects(bucket_id, name) values ('chat-files', $1)", [dmPath])
const dmMsg = (await as(U.mateo, "insert into public.messages(thread_id, client_id, body, kind) values ($1, $2, '', 'file') returning id", [dm, v4()]))[0].id
await as(U.mateo, 'insert into public.message_files(message_id, team_id, name, size_bytes, path) values ($1, null, $2, 10, $3)', [dmMsg, 'dm.png', dmPath])
ok((await as(U.tomy, 'select * from storage.objects where name=$1', [dmPath])).length === 1, 'participante del DM lee su adjunto')
ok((await as(U.evil, 'select * from storage.objects where name=$1', [dmPath])).length === 0, 'tercero no lee adjunto de DM')
await throws(as(U.mateo, 'insert into public.message_files(message_id, team_id, name, size_bytes, path) values ($1, null, $2, 10, $3)', [dmMsg, 'x', `dm/${uuid()}/${v4()}`]), 'adjunto de DM con otro hilo rechazado')
await as(U.mateo, "update public.messages set deleted_at = now() where id=$1", [fileMsg])
ok((await as(U.tomy, 'select * from public.message_files where message_id=$1', [fileMsg])).length === 0, 'un mensaje borrado no muestra sus adjuntos')
ok((await as(U.mateo, "select * from storage.objects where bucket_id='chat-files' and name=$1", [teamPath])).length === 1, 'el objeto sigue (lo borra la app)')
await as(U.mateo, "delete from storage.objects where bucket_id='chat-files' and name=$1", [teamPath])
ok((await as(U.mateo, "select * from storage.objects where bucket_id='chat-files' and name=$1", [teamPath])).length === 0, 'el autor borra el objeto del adjunto')

// ---------- lecturas, no leídos, silencio ----------
await as(U.tomy, 'select public.chat_mark_read($1, null)', [deploys])
const before = (await as(U.tomy, 'select * from public.chat_unread()')).find((r) => r.kind === 'channel' && r.id === deploys)
ok(before && before.unread === 0, 'tomy al día en deploys')
await as(U.mateo, 'select public.chat_mark_read($1, null)', [deploys])
await as(U.mateo, "insert into public.messages(team_id, channel_id, client_id, body) values ($1, $2, $3, 'nuevo')", [team, deploys, v4()])
ok((await as(U.tomy, 'select * from public.chat_unread()')).find((r) => r.kind === 'channel' && r.id === deploys).unread === 1, 'mensaje nuevo cuenta como no leído')
ok((await as(U.mateo, 'select * from public.chat_unread()')).find((r) => r.kind === 'channel' && r.id === deploys).unread === 0, 'mis propios mensajes no cuentan')
await as(U.tomy, 'select public.chat_set_muted($1, null, true)', [deploys])
ok((await as(U.tomy, 'select * from public.chat_unread()')).find((r) => r.kind === 'channel' && r.id === deploys).muted === true, 'silenciar se guarda')
await as(U.tomy, 'select public.chat_set_muted($1, null, false)', [deploys])
ok((await as(U.mateo, 'select * from public.conv_read_marks($1, null)', [deploys])).length >= 1, 'miembros ven quién leyó (Visto por)')
ok((await as(U.evil, 'select * from public.conv_read_marks($1, null)', [deploys])).length === 0, 'ajeno no ve lecturas')
ok((await as(U.mateo, 'select * from public.conv_read_marks(null, $1)', [dm])).length >= 1, 'lecturas del DM para participantes')
await throws(as(U.tomy, 'select public.chat_mark_read($1, null)', [uuid()]), 'marcar leído en canal ajeno rechazado')
await throws(as(U.tomy, 'insert into public.conv_state(user_id, channel_id) values ($1, $2)', [U.tomy, deploys]), 'conv_state no se escribe directo')
await as(U.tomy, 'select public.mark_read($1, null)', [team])
ok((await as(U.tomy, 'select * from public.unread_counts()')).find((r) => r.kind === 'team')?.unread === 0, 'mark_read de 0.5 sigue andando')

// ---------- perfil ----------
await as(U.tomy, `select public.update_profile('{"display_name":"Tomy","handle":"tomy-dev","presence":"ausente","status_text":"En reunión","status_until":"2026-11-08T20:00:00Z","role_title":"Admin","timezone":"America/Bogota","color":"green"}'::jsonb)`)
const p = (await as(U.mateo, 'select display_name, handle, presence, status_text, role_title, timezone, color from public.profiles where id=$1', [U.tomy]))[0]
ok(p.display_name === 'Tomy' && p.handle === 'tomy-dev' && p.presence === 'ausente' && p.color === 'green' && p.timezone === 'America/Bogota', 'perfil actualizado y visible para el equipo')
await throws(as(U.tomy, `select public.update_profile('{"handle":"X"}'::jsonb)`), 'usuario de menos de 3 caracteres')
await throws(as(U.tomy, `select public.update_profile('{"handle":"Tomy_Dev"}'::jsonb)`), 'usuario con mayúsculas y guion bajo')
await throws(as(U.tomy, `select public.update_profile('{"handle":"mateo"}'::jsonb)`), 'usuario de otro equipo ya en uso (no se puede tomar el de mateo)')
await throws(as(U.tomy, `select public.update_profile('{"presence":"busy"}'::jsonb)`), 'estado de presencia inválido')
await throws(as(U.tomy, `select public.update_profile('{"is_admin":true}'::jsonb)`), 'campo de perfil desconocido')
await throws(as(U.tomy, `select public.update_profile('{"timezone":"Mars/Olympus Mons"}'::jsonb)`), 'zona horaria inválida')
await throws(as(U.tomy, "update public.profiles set display_name='directo' where id=$1", [U.tomy]), 'update directo de profiles prohibido')
await throws(as(U.tomy, `select public.set_profile_photo($1)`, [`${U.mateo}/${v4()}.webp`]), 'foto de perfil ajena rechazada')
const photo = `${U.tomy}/${v4()}.webp`
await as(U.tomy, 'insert into storage.objects(bucket_id, name) values (\'profile-photos\', $1)', [photo])
await as(U.tomy, 'select public.set_profile_photo($1)', [photo])
ok((await as(U.mateo, 'select * from storage.objects where bucket_id=\'profile-photos\' and name=$1', [photo])).length === 1, 'el equipo ve la foto de perfil')
ok((await as(U.evil, 'select * from storage.objects where bucket_id=\'profile-photos\' and name=$1', [photo])).length === 0, 'ajeno no ve la foto de perfil')
await throws(as(U.mateo, 'insert into storage.objects(bucket_id, name) values (\'profile-photos\', $1)', [photo]), 'no se sube foto en la carpeta de otro')

// ---------- anon ----------
await throws(as(null, 'select * from public.team_channels'), 'anon no ve canales')
await throws(as(null, 'select * from public.chat_unread()'), 'anon no ejecuta chat_unread')
await throws(as(null, 'select * from public.message_reactions'), 'anon no ve reacciones')

console.log(fails ? `\n${fails} FALLAS` : '\nTodo OK')
process.exit(fails ? 1 : 0)
