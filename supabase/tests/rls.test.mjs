// Prueba de las migraciones de supabase/migrations sobre PGlite (Postgres en WASM) con stubs de
// auth/storage/realtime/roles de Supabase. Uso: node rls.test.mjs <0001_chat.sql> [0002…] … [0009…]
// o node rls.test.mjs supabase/setup.sql, que activa todos los bloques.
// Las pruebas de Broadcast corren solo si se pasa 0003_realtime_broadcast.sql; las del celu, con 0006_celu_remoto.sql;
// las de abusos, con 0008_chat_abuso.sql (pide 0001–0007 antes); la versión del esquema, con 0009_schema_version.sql.
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { stub } from './stub.mjs'

const db = new PGlite({ extensions: { pgcrypto } })
await db.exec(stub)
const files = process.argv.slice(2)
for (const f of files) await db.exec(readFileSync(f, 'utf8'))
const withSetup = files.some((f) => basename(f) === 'setup.sql')
const conMigracion = (nombre) => withSetup || files.some((f) => f.includes(nombre))
const withBroadcast = conMigracion('0003_realtime_broadcast')
const withCelu = conMigracion('0006_celu_remoto')
const withExpulsar = conMigracion('0007_expulsar')
const withAbuso = conMigracion('0008_chat_abuso')
const withVersion = conMigracion('0009_schema_version')

// setup.sql pega 0001–0009 en un solo archivo: de ahí se saca solo el tramo de la migración pedida.
const migracion = (nombre) => {
  const archivo = files.find((f) => basename(f) === 'setup.sql' || f.includes(nombre))
  const sql = readFileSync(archivo, 'utf8')
  if (basename(archivo) !== 'setup.sql') return sql
  const ini = sql.indexOf(`-- ===== ${nombre}.sql =====`)
  const fin = sql.indexOf('\n-- ===== ', ini + 1)
  return sql.slice(ini, fin === -1 ? undefined : fin)
}
console.log('migraciones OK')

const U = {
  ana: '00000000-0000-0000-0000-000000000001',
  bruno: '00000000-0000-0000-0000-000000000002',
  evil: '00000000-0000-0000-0000-000000000003',
  mail: '00000000-0000-0000-0000-000000000004'
}
for (const [login, id] of Object.entries(U)) {
  await db.query('insert into auth.users(id, raw_user_meta_data) values ($1, $2)', [id, { user_name: login === 'mail' ? 'bruno' : login }])
  if (login !== 'mail')
    await db.query("insert into auth.identities(user_id, provider, identity_data) values ($1,'github',$2)", [
      id,
      { user_name: login === 'ana' ? 'Ana' : login, avatar_url: 'https://avatars.githubusercontent.com/u/1', full_name: login }
    ])
  else await db.query("insert into auth.identities(user_id, provider, identity_data) values ($1,'email',$2)", [id, { user_name: 'bruno' }])
}

async function as(user, sql, params = [], topic = '') {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user ?? ''])
  await db.query(`select set_config('realtime.topic', $1, false)`, [topic])
  await db.exec(user ? 'set role authenticated' : 'set role anon')
  try {
    return (await db.query(sql, params)).rows
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

ok((await as(U.ana, 'select * from public.profiles')).length === 1, 'ana solo ve su perfil al principio')
ok((await as(U.mail, 'select * from public.profiles')).length === 0, 'usuario por email no tiene perfil')
const team = (await as(U.ana, "select public.create_team('Acme', 'desc') as id"))[0].id
ok(!!team, 'ana crea equipo')
await throws(as(U.ana, "insert into public.teams(name) values ('directo')"), 'insert directo en teams prohibido')
await throws(as(U.mail, "select public.create_team('x')"), 'sin perfil no crea equipo')
const code = (await as(U.ana, 'select code from public.team_invite_codes where team_id=$1', [team]))[0]?.code
ok(/^[0-9a-f]{16}$/.test(code ?? ''), 'owner ve el código')
ok((await as(U.bruno, 'select * from public.teams')).length === 0, 'bruno no ve el equipo antes de entrar')
ok((await as(U.bruno, 'select * from public.messages')).length === 0, 'bruno no ve mensajes')
await as(U.ana, "insert into public.messages(team_id, client_id, body) values ($1, gen_random_uuid(), 'hola')", [team])
await throws(as(U.bruno, "insert into public.messages(team_id, client_id, body) values ($1, gen_random_uuid(), 'intruso')", [team]), 'no miembro no escribe')
await throws(as(U.ana, 'insert into public.team_members(team_id,user_id) values ($1,$2)', [team, U.evil]), 'insert directo en team_members prohibido')

await as(U.ana, 'insert into public.team_invites(team_id, github_login_lower) values ($1, $2)', [team, 'bruno'])
ok((await as(U.bruno, 'select name from public.teams')).length === 1, 'bruno invitado ve el nombre del equipo')
ok((await as(U.mail, 'select * from public.team_invites')).length === 0, 'cuenta email que dice llamarse bruno NO ve la invitación')
ok((await as(U.bruno, 'select * from public.team_invite_codes')).length === 0, 'invitado no ve el código')
ok((await as(U.bruno, 'select * from public.profiles where id=$1', [U.ana])).length === 1, 'invitado ve el perfil de quien invitó')
const inv = (await as(U.bruno, 'select id from public.team_invites'))[0].id
await throws(as(U.evil, 'select public.accept_invite($1)', [inv]), 'otro no acepta invitación ajena')
await as(U.bruno, 'select public.accept_invite($1)', [inv])
ok((await as(U.bruno, 'select * from public.messages')).length === 1, 'bruno ya miembro ve el mensaje')
ok((await as(U.bruno, 'select * from public.team_invite_codes')).length === 0, 'member no ve el código')
await throws(as(U.evil, "select public.join_team_by_code('0000000000000000')"), 'código falso')
await as(U.evil, 'select public.join_team_by_code($1)', [code])
ok((await as(U.evil, 'select * from public.team_members where team_id=$1', [team])).length === 3, 'evil entra con código')
const newCode = (await as(U.ana, 'select public.regenerate_invite_code($1) as c', [team]))[0].c
ok(newCode !== code, 'código regenerado')
await throws(as(U.evil, 'select public.regenerate_invite_code($1)', [team]), 'member no regenera código')

await as(U.ana, 'delete from public.team_members where team_id=$1 and user_id=$2', [team, U.evil])
ok((await as(U.evil, 'select * from public.messages')).length === 0, 'evil expulsado no ve mensajes')
await as(U.bruno, 'delete from public.team_members where team_id=$1 and user_id=$2', [team, U.ana])
ok((await as(U.ana, 'select * from public.team_members where team_id=$1', [team])).length === 2, 'member no puede sacar al owner')
await as(U.ana, 'delete from public.team_members where team_id=$1 and user_id=$2', [team, U.ana])
ok((await as(U.ana, 'select * from public.team_members where team_id=$1', [team])).length === 2, 'owner no se va (tiene que borrar el equipo)')

const dm = (await as(U.ana, 'select public.open_dm($1) as id', [U.bruno]))[0].id
ok(dm === (await as(U.bruno, 'select public.open_dm($1) as id', [U.ana]))[0].id, 'mismo DM desde ambos lados')
await throws(as(U.ana, 'select public.open_dm($1)', [U.evil]), 'DM con alguien sin equipo en común prohibido')
await as(U.bruno, "insert into public.messages(thread_id, client_id, body) values ($1, gen_random_uuid(), 'che ana')", [dm])
ok((await as(U.evil, 'select * from public.messages where thread_id=$1', [dm])).length === 0, 'tercero no ve el DM')
await throws(as(U.evil, "insert into public.messages(thread_id, client_id, body) values ($1, gen_random_uuid(), 'x')", [dm]), 'tercero no escribe en el DM')
const unread = await as(U.ana, 'select * from public.unread_counts()')
ok(unread.find((r) => r.kind === 'dm')?.unread === 1, 'ana tiene 1 no leído en el DM')
await as(U.ana, 'select public.mark_read(null, $1)', [dm])
ok((await as(U.ana, 'select * from public.unread_counts()')).find((r) => r.kind === 'dm')?.unread === 0, 'mark_read limpia')

try {
  await as(U.bruno, "insert into public.messages(team_id, client_id, body, author_id, created_at) values ($1, gen_random_uuid(), 'spoof', $2, '2000-01-01')", [team, U.ana])
} catch (e) {
  console.log('     (spoof rechazado: ' + e.message.slice(0, 60) + ')')
}
const sp = await as(U.ana, "select author_id, created_at from public.messages where body='spoof'")
ok(sp.length === 0 || (sp[0].author_id === U.bruno && new Date(sp[0].created_at).getFullYear() > 2000), 'no se puede falsear autor ni hora')

let hit = false
for (let i = 0; i < 31; i++) {
  try {
    await as(U.bruno, "insert into public.messages(team_id, client_id, body) values ($1, gen_random_uuid(), 'x')", [team])
  } catch {
    hit = true
    break
  }
}
ok(hit, 'tope de 30 por minuto')
await throws(as(U.ana, "insert into public.messages(team_id, client_id, body) values ($1, gen_random_uuid(), '   ')", [team]), 'mensaje vacío')

// Desde 0004 el permiso de update es por columna y tocar created_by ni siquiera pasa.
try {
  await as(U.ana, 'update public.teams set name=$2, created_by=$3 where id=$1', [team, 'Acme AI', U.bruno])
} catch (e) {
  if (!/permission denied/.test(e.message)) throw e
  await as(U.ana, 'update public.teams set name=$2 where id=$1', [team, 'Acme AI'])
}
const t = (await as(U.ana, 'select name, created_by from public.teams where id=$1', [team]))[0]
ok(t.name === 'Acme AI' && t.created_by === U.ana, 'owner renombra, created_by no cambia')
await as(U.bruno, 'update public.teams set name=$2 where id=$1', [team, 'hack'])
ok((await as(U.ana, 'select name from public.teams where id=$1', [team]))[0].name === 'Acme AI', 'member no renombra')

await as(U.ana, "insert into storage.objects(bucket_id, name) values ('team-photos', $1)", [team + '/a.webp'])
await throws(as(U.bruno, "insert into storage.objects(bucket_id, name) values ('team-photos', $1)", [team + '/b.webp']), 'member no sube foto')
ok((await as(U.bruno, 'select * from storage.objects')).length === 1, 'member ve la foto')
ok((await as(U.evil, 'select * from storage.objects')).length === 0, 'ajeno no ve la foto')
await throws(as(U.ana, "insert into storage.objects(bucket_id, name) values ('team-photos', 'basura/a.webp')"), 'ruta sin uuid rechazada')

if (withBroadcast) {
  // Realtime pregunta así al entrar a un canal privado: SELECT sobre realtime.messages con el tópico seteado.
  const reads = async (user, topic) => (await as(user, 'select payload from realtime.messages where topic = realtime.topic()', [], topic)).length
  const tTeam = `team:${team}`
  const tDm = `thread:${dm}`
  const sent = await as(U.bruno, "select payload from realtime.messages where topic = $1 and event = 'message' order by id desc limit 1", [tTeam], tTeam)
  ok(sent[0]?.payload?.team_id === team && sent[0]?.payload?.thread_id === null, 'el trigger publica en el tópico del equipo')
  ok((await reads(U.ana, tTeam)) > 0, 'miembro lee el tópico de su equipo')
  ok((await reads(U.evil, tTeam)) === 0, 'expulsado/no miembro no lee el tópico del equipo')
  ok((await reads(U.ana, tDm)) > 0 && (await reads(U.bruno, tDm)) > 0, 'participantes leen el tópico del DM')
  ok((await reads(U.evil, tDm)) === 0, 'tercero no lee el tópico del DM')
  ok((await as(U.evil, 'select * from realtime.messages', [], tTeam)).length === 0, 'tercero no ve nada aunque no filtre por tópico')
  ok((await as(U.evil, 'select * from realtime.messages', [], `TEAM:${team}`)).length === 0, 'tópico con otro formato no abre nada')
  ok((await as(U.ana, 'select * from realtime.messages', [], `team:${team}x`)).length === 0, 'tópico con basura al final no abre nada')
  await throws(as(U.evil, "insert into realtime.messages(topic, extension, payload, event, private) values ($1, 'broadcast', '{}', 'message', true)", [tTeam], tTeam), 'no miembro no publica en el tópico')
  await throws(as(U.ana, "insert into realtime.messages(topic, extension, payload, event, private) values ($1, 'broadcast', '{\"author_id\":\"x\"}', 'message', true)", [tTeam], tTeam), 'tampoco un miembro: solo publica la base (no se falsea autor)')
  ok((await as(null, 'select * from realtime.messages', [], tTeam)).length === 0, 'anon no lee el tópico')
  const before = (await as(U.ana, 'select count(*)::int as n from public.messages where team_id=$1', [team]))[0].n
  await db.exec("create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language plpgsql as $$ begin raise exception 'realtime caído'; end $$")
  await as(U.ana, "insert into public.messages(team_id, client_id, body) values ($1, gen_random_uuid(), 'sin broadcast')", [team])
  ok((await as(U.ana, 'select count(*)::int as n from public.messages where team_id=$1', [team]))[0].n === before + 1, 'si Broadcast falla el mensaje se guarda igual')
}

if (withCelu) {
  const tAna = `celu:${U.ana}`
  const tBruno = `celu:${U.bruno}`
  const pub = "insert into realtime.messages(topic, extension, payload, event, private) values ($1, 'broadcast', '{}', 'estado', true)"
  await as(U.ana, pub, [tAna], tAna)
  ok(true, 'ana publica en su celu')
  ok((await as(U.ana, 'select * from realtime.messages where topic = realtime.topic()', [], tAna)).length > 0, 'ana lee su celu')
  ok((await as(U.bruno, 'select * from realtime.messages where topic = realtime.topic()', [], tAna)).length === 0, 'bruno no lee el celu de ana (no se suscribe)')
  ok((await as(U.bruno, 'select * from realtime.messages', [], tBruno)).every((r) => r.topic !== tAna), 'bruno en su celu no ve filas del de ana')
  await throws(as(U.bruno, pub, [tAna], tAna), 'bruno no publica en el celu de ana')
  await throws(as(U.bruno, pub, [tAna], tBruno), 'bruno con su tópico no cuela una fila en el celu de ana')
  await throws(as(U.ana, pub, [`team:${team}`], tAna), 'ana con su tópico no cuela una fila en team:')
  await throws(as(U.ana, pub, [`celu:${U.ana.toUpperCase()}x`], tAna), 'ana no cuela una fila con otro tópico parecido')
  await throws(as(U.ana, "insert into realtime.messages(topic, extension, payload, event, private) values ($1, 'presence', '{}', 'x', true)", [tAna], tAna), 'solo broadcast, no presence')
  ok((await as(null, 'select * from realtime.messages', [], tAna)).length === 0, 'anon no lee el celu')
  await throws(as(null, pub, [tAna], tAna), 'anon no publica en el celu')
  await throws(as(null, 'select public.can_use_celu_topic($1)', [tAna]), 'anon no ejecuta can_use_celu_topic')
}

if (withExpulsar) {
  const t2 = (await as(U.ana, "select public.create_team('Expulsar', '') as id"))[0].id
  const code2 = (await as(U.ana, 'select code from public.team_invite_codes where team_id=$1', [t2]))[0].code
  await as(U.bruno, 'select public.join_team_by_code($1)', [code2])
  await as(U.evil, 'select public.join_team_by_code($1)', [code2])
  await as(U.ana, 'insert into public.team_invites(team_id, github_login_lower) values ($1, $2)', [t2, 'evil'])
  const members = async () => (await as(U.ana, 'select user_id from public.team_members where team_id=$1', [t2])).map((r) => r.user_id)
  await throws(as(U.bruno, 'select public.remove_member($1, $2)', [t2, U.evil]), 'un member no expulsa')
  await throws(as(U.mail, 'select public.remove_member($1, $2)', [t2, U.evil]), 'alguien de afuera no expulsa')
  await throws(as(null, 'select public.remove_member($1, $2)', [t2, U.evil]), 'anon no ejecuta remove_member')
  await throws(as(U.ana, 'select public.remove_member($1, $2)', [t2, U.ana]), 'el owner no se expulsa a sí mismo')
  await throws(as(U.ana, 'select public.remove_member($1, $2)', [t2, U.mail]), 'no se expulsa a quien no está')
  ok((await members()).length === 3, 'los intentos fallidos no tocaron a nadie')
  const nuevo = (await as(U.ana, 'select public.remove_member($1, $2) as c', [t2, U.evil]))[0].c
  ok(/^[0-9a-f]{16}$/.test(nuevo ?? '') && nuevo !== code2, 'expulsar devuelve un código nuevo')
  ok(!(await members()).includes(U.evil), 'el expulsado ya no es miembro')
  ok((await as(U.ana, 'select * from public.team_invites where team_id=$1', [t2])).length === 0, 'se borran sus invitaciones pendientes')
  ok((await as(U.ana, 'select code from public.team_invite_codes where team_id=$1', [t2]))[0].code === nuevo, 'el código guardado es el nuevo')
  await throws(as(U.evil, 'select public.join_team_by_code($1)', [code2]), 'el expulsado no vuelve a entrar con el código viejo')
  ok(!(await members()).includes(U.evil), 'sigue afuera')
  ok((await as(U.evil, 'select * from public.messages where team_id=$1', [t2])).length === 0, 'el expulsado no lee el equipo')
  await throws(as(U.evil, 'select public.regenerate_invite_code($1)', [t2]), 'alguien de afuera no regenera ni lee el código')
  ok((await as(U.ana, 'select code from public.team_invite_codes where team_id=$1', [t2]))[0].code === nuevo, 'el código no cambió por el intento de afuera')
  await as(U.ana, 'delete from public.team_members where team_id=$1 and user_id=$2', [t2, U.bruno])
  ok(!(await members()).includes(U.bruno), 'el DELETE directo de antes sigue andando (apps viejas)')
}

if (withAbuso) {
  await db.exec(`create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
    language sql security definer as $$ insert into realtime.messages(topic, extension, payload, event, private) values (topic, 'broadcast', payload, event, private) $$`)
  const reset = () => db.exec('delete from public.chat_rate')
  // created_at sale del reloj: sin la pausa, un mensaje y un vaciado pueden caer en el mismo milisegundo.
  const tick = () => new Promise((r) => setTimeout(r, 5))
  const send = (user, col, id, body = 'x') =>
    as(user, `insert into public.messages(${col}, client_id, body) values ($1, gen_random_uuid(), $2) returning id`, [id, body])
  const tTeam = `team:${team}`

  await db.exec(migracion('0008_chat_abuso'))
  ok(true, '0008 corre dos veces seguidas')

  await reset()
  await send(U.bruno, 'thread_id', dm, 'antes 1')
  await send(U.bruno, 'thread_id', dm, 'antes 2')
  await tick()
  await as(U.ana, 'select public.chat_clear(null, $1)', [dm])
  await tick()
  ok((await as(U.ana, 'select * from public.messages where thread_id=$1', [dm])).length === 0, 'ana vacía el DM y no ve nada')
  ok((await as(U.bruno, 'select * from public.messages where thread_id=$1', [dm])).length >= 2, 'bruno sigue viendo el DM que vació ana')
  const dmRow = (await as(U.ana, 'select * from public.unread_counts()')).find((r) => r.kind === 'dm' && r.id === dm)
  ok(dmRow?.unread === 0 && dmRow?.last_at === null, 'ana no tiene no leídos ni último mensaje en el DM vaciado')
  ok((await db.query("select * from public.messages where thread_id=$1 and kind='clear'", [dm])).rows.length === 0, 'vaciar un DM no deja aviso')

  await reset()
  for (let i = 0; i < 30; i++) await send(U.bruno, 'thread_id', dm)
  await tick()
  await as(U.bruno, 'select public.chat_clear(null, $1)', [dm])
  await throws(send(U.bruno, 'thread_id', dm), 'vaciar el DM no reinicia el tope de 30 por minuto')
  const before = (await db.query('select m.id from public.messages m join public.dm_threads t on t.id = m.thread_id where t.id=$1 and m.created_at <= least(t.cleared_a, t.cleared_b)', [dm])).rows
  ok(before.length === 0, 'vaciado por los dos: lo anterior a las dos marcas se borra de verdad')
  ok((await db.query("select * from public.messages where thread_id=$1 and body='x'", [dm])).rows.length === 30, 'lo posterior al vaciado de ana sigue guardado')
  ok((await as(U.ana, "select * from public.messages where thread_id=$1 and body='x'", [dm])).length === 30, 'ana ve lo que llegó después de vaciar')
  ok((await as(U.bruno, 'select * from public.messages where thread_id=$1', [dm])).length === 0, 'bruno ya no ve nada tras vaciar')
  await tick()
  await reset()
  await send(U.ana, 'thread_id', dm, 'después')

  await reset()
  const mid = (await send(U.bruno, 'team_id', team, 'editame'))[0].id
  let edits = 0
  for (let i = 0; i < 30; i++) {
    await as(U.bruno, 'update public.messages set body=$2 where id=$1', [mid, 'e' + i])
    edits++
  }
  ok(edits === 30, '30 ediciones pasan')
  await throws(as(U.bruno, 'update public.messages set body=$2 where id=$1', [mid, 'e31']), 'la edición 31 en un minuto tira')

  await reset()
  const rid = (await send(U.ana, 'team_id', team, 'reaccioname'))[0].id
  const addR = (user, id) => as(user, "insert into public.message_reactions(message_id, emoji) values ($1, '👍')", [id])
  const delR = (user, id) => as(user, "delete from public.message_reactions where message_id=$1 and emoji='👍'", [id])
  let toggles = 0
  for (let i = 0; i < 60; i++) {
    await (i % 2 === 0 ? addR(U.bruno, rid) : delR(U.bruno, rid))
    toggles++
  }
  ok(toggles === 60, 'poner y sacar 60 veces pasa')
  await throws(addR(U.bruno, rid), 'la reacción 61 (poner o sacar) en un minuto tira')

  await reset()
  const sid = (await send(U.bruno, 'team_id', team, 'borrame'))[0].id
  await addR(U.ana, sid)
  await addR(U.bruno, sid)
  await db.exec("update public.chat_rate set n = 60 where kind = 'react'")
  await as(U.bruno, 'update public.messages set deleted_at=now() where id=$1', [sid])
  ok((await db.query('select * from public.message_reactions where message_id=$1', [sid])).rows.length === 0, 'borrar un mensaje con reacciones ajenas no choca con el tope de reacciones')
  await reset()
  const cid = (await send(U.bruno, 'team_id', team, 'vaciame'))[0].id
  await addR(U.ana, cid)
  await addR(U.bruno, cid)
  await db.exec("update public.chat_rate set n = 60 where kind = 'react'")
  await as(U.ana, 'select public.chat_clear($1, null)', [team])
  ok((await db.query('select * from public.messages where id=$1', [cid])).rows.length === 0, 'vaciar el equipo con reacciones no choca con el tope de reacciones')

  await reset()
  const maxId = (await db.query('select coalesce(max(id), 0) as m from realtime.messages')).rows[0].m
  for (let i = 0; i < 40; i++) {
    await as(U.ana, 'select public.mark_read(null, $1)', [dm])
    await tick()
  }
  ok(true, 'mark_read 40 veces seguidas no tira')
  const readsIn = async (from) =>
    (await db.query("select count(*)::int as n from realtime.messages where id > $1 and event = 'read' and topic = $2", [from, `thread:${dm}`])).rows[0].n
  ok((await readsIn(maxId)) === 40, '40 «visto» en un minuto se publican todos')
  const lastReadA = async () => (await db.query('select last_read_a, last_read_b, user_a from public.dm_threads where id=$1', [dm])).rows[0]
  await db.exec("update public.chat_rate set n = 120 where kind = 'read'")
  const maxId2 = (await db.query('select coalesce(max(id), 0) as m from realtime.messages')).rows[0].m
  const r0 = await lastReadA()
  const mine = (r) => (r.user_a === U.ana ? r.last_read_a : r.last_read_b).getTime()
  await tick()
  await as(U.ana, 'select public.mark_read(null, $1)', [dm])
  ok(mine(await lastReadA()) > mine(r0), 'pasado el tope de «visto», mark_read igual guarda la marca')
  ok((await readsIn(maxId2)) === 0, 'pasado el tope de «visto», no se publica')
  await db.exec("update public.chat_rate set n = 1000 where kind = 'read'")
  const tr0 = (await db.query('select last_read_at from public.team_members where team_id=$1 and user_id=$2', [team, U.ana])).rows[0].last_read_at.getTime()
  await tick()
  await as(U.ana, 'select public.mark_read($1, null)', [team])
  const tr1 = (await db.query('select last_read_at from public.team_members where team_id=$1 and user_id=$2', [team, U.ana])).rows[0].last_read_at.getTime()
  ok(tr1 > tr0, 'mark_read de un equipo no tiene tope')

  await reset()
  for (let i = 1; i <= 50; i++) {
    if (i % 20 === 0) await reset()
    await as(U.ana, 'insert into public.team_invites(team_id, github_login_lower) values ($1, $2)', [team, 'u' + i])
  }
  ok(true, '50 invitaciones pendientes en un equipo pasan')
  await reset()
  await throws(as(U.ana, 'insert into public.team_invites(team_id, github_login_lower) values ($1, $2)', [team, 'u51']), 'la invitación 51 tira')
  await db.query("delete from public.team_invites where team_id=$1 and github_login_lower like 'u%'", [team])
  await reset()
  for (let i = 0; i < 20; i++) await as(U.ana, 'insert into public.team_invites(team_id, github_login_lower) values ($1, $2)', [team, 'r' + i])
  await throws(as(U.ana, 'insert into public.team_invites(team_id, github_login_lower) values ($1, $2)', [team, 'r20']), 'más de 20 invitaciones por hora tira')
  await db.query("delete from public.team_invites where team_id=$1 and github_login_lower like 'r%'", [team])

  await reset()
  await as(U.ana, 'insert into public.team_invites(team_id, github_login_lower) values ($1, $2)', [team, 'evil'])
  const evilInv = (await as(U.evil, 'select id from public.team_invites'))[0]?.id
  ok(!!evilInv, 'evil ve su invitación vigente')
  await db.query("update public.team_invites set expires_at = now() - interval '1 minute' where id=$1", [evilInv])
  ok((await as(U.evil, 'select * from public.team_invites')).length === 0, 'la invitación vencida no se ve')
  ok((await as(U.evil, 'select * from public.teams where id=$1', [team])).length === 0, 'con la invitación vencida no se ve el equipo')
  ok((await as(U.evil, 'select * from public.profiles where id=$1', [U.ana])).length === 0, 'con la invitación vencida no se ve el perfil de quien invitó')
  await throws(as(U.evil, 'select public.accept_invite($1)', [evilInv]), 'accept_invite de una vencida tira')
  ok(!(await as(U.ana, 'select user_id from public.team_members where team_id=$1', [team])).some((r) => r.user_id === U.evil), 'evil no entró')
  await as(U.ana, 'insert into public.team_invites(team_id, github_login_lower) values ($1, $2)', [team, 'evil'])
  ok((await as(U.evil, 'select * from public.team_invites')).length === 1, 'reinvitar con una vencida no choca')
  await db.query("delete from public.team_invites where team_id=$1 and github_login_lower='evil'", [team])

  const caro = '00000000-0000-0000-0000-000000000005'
  await db.query('insert into auth.users(id, raw_user_meta_data) values ($1, $2)', [caro, { user_name: 'caro' }])
  await db.query("insert into auth.identities(user_id, provider, identity_data) values ($1,'github',$2)", [
    caro,
    { user_name: 'caro', avatar_url: 'https://avatars.githubusercontent.com/u/1', full_name: 'caro' }
  ])
  await reset()
  const codeRow = async () => (await db.query('select code, uses_left, expires_at from public.team_invite_codes where team_id=$1', [team])).rows[0]
  const c1 = (await codeRow()).code
  await db.query("update public.team_invite_codes set expires_at = now() - interval '1 minute' where team_id=$1", [team])
  await throws(as(U.evil, 'select public.join_team_by_code($1)', [c1]), 'código vencido tira')
  const c2 = (await as(U.ana, 'select public.regenerate_invite_code($1) as c', [team]))[0].c
  const r2 = await codeRow()
  const days = (new Date(r2.expires_at).getTime() - Date.now()) / 86400000
  ok(r2.code === c2 && r2.uses_left === 50 && days > 6.9 && days <= 7, 'regenerar repone 50 usos y vence en 7 días')
  await db.query('update public.team_invite_codes set uses_left = 1 where team_id=$1', [team])
  await as(U.bruno, 'select public.join_team_by_code($1)', [c2])
  ok((await codeRow()).uses_left === 1, 'un miembro que ya estaba no gasta uso')
  await as(U.evil, 'select public.join_team_by_code($1)', [c2])
  ok((await codeRow()).uses_left === 0, 'el primero entra y gasta el uso')
  await throws(as(caro, 'select public.join_team_by_code($1)', [c2]), 'sin usos el segundo tira')
  await reset()
  await as(U.ana, 'select public.remove_member($1, $2)', [team, U.evil])
  ok((await codeRow()).uses_left === 50, 'expulsar también repone los usos')

  await reset()
  const bOld = (await send(U.bruno, 'thread_id', dm, 'viejo de bruno'))[0].id
  const bOld2 = (await send(U.bruno, 'thread_id', dm, 'otro viejo de bruno'))[0].id
  const aOld = (await send(U.ana, 'thread_id', dm, 'viejo de ana'))[0].id
  await addR(U.bruno, aOld)
  await db.query('delete from public.team_members where user_id=$1 and team_id <> $2', [U.bruno, team])
  await as(U.ana, 'select public.remove_member($1, $2)', [team, U.bruno])
  const removed = (await db.query("select payload from realtime.messages where topic=$1 and event='member_removed' order by id desc limit 1", [tTeam])).rows[0]
  ok(removed?.payload?.user_id === U.bruno && removed?.payload?.team_id === team, 'remove_member avisa member_removed en el tópico del equipo')
  await throws(send(U.bruno, 'thread_id', dm), 'sin equipo en común no se escribe en el DM')
  ok((await as(U.bruno, 'select * from public.messages where thread_id=$1', [dm])).length > 0, 'pero el DM se sigue leyendo')
  await throws(as(U.bruno, 'update public.messages set body=$2 where id=$1', [bOld, 'acoso']), 'sin equipo en común no se edita un mensaje del DM')
  await throws(as(U.ana, 'update public.messages set body=$2 where id=$1', [aOld, 'cambio']), 'tampoco del otro lado')
  ok((await db.query('select body from public.messages where id=$1', [bOld])).rows[0].body === 'viejo de bruno', 'el texto no cambió')
  await as(U.bruno, 'update public.messages set deleted_at=now() where id=$1', [bOld2])
  ok((await db.query('select deleted_at from public.messages where id=$1', [bOld2])).rows[0].deleted_at !== null, 'sin equipo en común sí se borra un mensaje propio')
  await throws(as(U.bruno, "insert into public.message_reactions(message_id, emoji) values ($1, '😀')", [aOld]), 'sin equipo en común no se reacciona en el DM')
  await delR(U.bruno, aOld)
  ok((await db.query('select * from public.message_reactions where message_id=$1', [aOld])).rows.length === 0, 'sin equipo en común sí se saca una reacción propia')
  const maxT = (await db.query('select coalesce(max(id), 0) as m from realtime.messages')).rows[0].m
  await db.query('delete from public.chat_typing_last where user_id=$1', [U.bruno])
  await as(U.bruno, 'select public.chat_typing(null, $1)', [dm])
  const typed = (await db.query("select count(*)::int as n from realtime.messages where id > $1 and event = 'typing'", [maxT])).rows[0].n
  ok(typed === 0, 'sin equipo en común «escribiendo…» no se publica ni tira')
  await as(U.ana, 'select public.chat_typing($1, null)', [team])
  ok((await db.query("select count(*)::int as n from realtime.messages where id > $1 and event = 'typing'", [maxT])).rows[0].n === 1, '«escribiendo…» en el equipo sigue andando')

  const rows = await as(U.ana, 'select topic from realtime.messages', [], tTeam)
  ok(rows.length > 0 && rows.every((r) => r.topic === tTeam), 'con el canal del equipo solo se leen filas de ese tópico')

  await throws(as(U.ana, "select public.chat_rate_hit('msg', 1, 1)"), 'authenticated no ejecuta chat_rate_hit')
  await throws(as(null, "select public.chat_rate_hit('msg', 1, 1)"), 'anon no ejecuta chat_rate_hit')
  await throws(as(U.ana, 'select * from public.chat_rate'), 'authenticated no lee chat_rate')
  await throws(as(null, 'select * from public.chat_rate'), 'anon no lee chat_rate')
}

if (withVersion) {
  await db.exec(migracion('0009_schema_version'))
  ok(true, '0009 corre dos veces seguidas')
  ok((await as(null, 'select public.chat_schema_version() as v'))[0].v === 9, 'anon lee chat_schema_version() = 9')
  ok((await as(U.ana, 'select public.chat_schema_version() as v'))[0].v === 9, 'authenticated lee chat_schema_version() = 9')
  const denegada = async (sql, m) => {
    try {
      await as(null, sql)
      ok(false, m + ' (no tiró)')
    } catch (e) {
      ok(e.code === '42501', m + ' -> ' + e.code)
    }
  }
  await denegada("select public.remove_member('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')", 'anon no ejecuta remove_member (42501)')
  await denegada("select public.chat_rate_hit('msg', 1, 1)", 'anon no ejecuta chat_rate_hit (42501)')
  await denegada("select public.dm_cleared_at('00000000-0000-0000-0000-000000000000')", 'anon no ejecuta dm_cleared_at (42501)')
  await denegada("select public.dm_writable('00000000-0000-0000-0000-000000000000')", 'anon no ejecuta dm_writable (42501)')
}

await throws(as(null, 'select * from public.messages'), 'anon sin acceso a messages')
await throws(as(null, 'select public.unread_counts()'), 'anon no ejecuta RPC')
console.log(fails ? `\n${fails} FALLAS` : '\nTodo OK')
process.exit(fails ? 1 : 0)
