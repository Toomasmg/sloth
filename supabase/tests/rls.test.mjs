// Prueba de las migraciones de supabase/migrations sobre PGlite (Postgres en WASM) con stubs de
// auth/storage/realtime/roles de Supabase. Uso: node rls.test.mjs <0001_chat.sql> [0002…] [0003…]
// Las pruebas de Broadcast corren solo si se pasa 0003_realtime_broadcast.sql.
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readFileSync } from 'node:fs'

const db = new PGlite({ extensions: { pgcrypto } })
const stub = `
create role anon nologin; create role authenticated nologin;
create schema auth; create schema storage; create schema extensions;
grant usage on schema public, auth, storage, extensions to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
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
create schema realtime;
grant usage on schema realtime to anon, authenticated;
create table realtime.messages (id bigserial primary key, topic text not null, extension text not null,
  payload jsonb, event text, private boolean default false, inserted_at timestamptz default now());
alter table realtime.messages enable row level security;
grant select, insert on realtime.messages to anon, authenticated;
grant usage on sequence realtime.messages_id_seq to anon, authenticated;
create function realtime.topic() returns text language sql stable as $$ select nullif(current_setting('realtime.topic', true), '') $$;
grant execute on function realtime.topic() to anon, authenticated;
create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
language sql security definer as $$ insert into realtime.messages(topic, extension, payload, event, private) values (topic, 'broadcast', payload, event, private) $$;
`
await db.exec(stub)
const files = process.argv.slice(2)
for (const f of files) await db.exec(readFileSync(f, 'utf8'))
const withBroadcast = files.some((f) => f.includes('0003_realtime_broadcast'))
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

await as(U.ana, 'update public.teams set name=$2, created_by=$3 where id=$1', [team, 'Acme AI', U.bruno])
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

await throws(as(null, 'select * from public.messages'), 'anon sin acceso a messages')
await throws(as(null, 'select public.unread_counts()'), 'anon no ejecuta RPC')
console.log(fails ? `\n${fails} FALLAS` : '\nTodo OK')
process.exit(fails ? 1 : 0)
