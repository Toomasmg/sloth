// Prueba de la migración supabase/migrations/0001_chat.sql sobre PGlite (Postgres en WASM) con
// stubs de auth/storage/roles de Supabase. Uso: node test.mjs <ruta a 0001_chat.sql>
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
`
await db.exec(stub)
await db.exec(readFileSync(process.argv[2], 'utf8'))
console.log('migración OK')

const U = {
  tomy: '00000000-0000-0000-0000-000000000001',
  mateo: '00000000-0000-0000-0000-000000000002',
  evil: '00000000-0000-0000-0000-000000000003',
  mail: '00000000-0000-0000-0000-000000000004'
}
for (const [login, id] of Object.entries(U)) {
  await db.query('insert into auth.users(id, raw_user_meta_data) values ($1, $2)', [id, { user_name: login === 'mail' ? 'mateo' : login }])
  if (login !== 'mail')
    await db.query("insert into auth.identities(user_id, provider, identity_data) values ($1,'github',$2)", [
      id,
      { user_name: login === 'tomy' ? 'Tomy' : login, avatar_url: 'https://avatars.githubusercontent.com/u/1', full_name: login }
    ])
  else await db.query("insert into auth.identities(user_id, provider, identity_data) values ($1,'email',$2)", [id, { user_name: 'mateo' }])
}

async function as(user, sql, params = []) {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user ?? ''])
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

ok((await as(U.tomy, 'select * from public.profiles')).length === 1, 'tomy solo ve su perfil al principio')
ok((await as(U.mail, 'select * from public.profiles')).length === 0, 'usuario por email no tiene perfil')
const team = (await as(U.tomy, "select public.create_team('Cosmos', 'desc') as id"))[0].id
ok(!!team, 'tomy crea equipo')
await throws(as(U.tomy, "insert into public.teams(name) values ('directo')"), 'insert directo en teams prohibido')
await throws(as(U.mail, "select public.create_team('x')"), 'sin perfil no crea equipo')
const code = (await as(U.tomy, 'select code from public.team_invite_codes where team_id=$1', [team]))[0]?.code
ok(/^[0-9a-f]{16}$/.test(code ?? ''), 'owner ve el código')
ok((await as(U.mateo, 'select * from public.teams')).length === 0, 'mateo no ve el equipo antes de entrar')
ok((await as(U.mateo, 'select * from public.messages')).length === 0, 'mateo no ve mensajes')
await as(U.tomy, "insert into public.messages(team_id, client_id, body) values ($1, gen_random_uuid(), 'hola')", [team])
await throws(as(U.mateo, "insert into public.messages(team_id, client_id, body) values ($1, gen_random_uuid(), 'intruso')", [team]), 'no miembro no escribe')
await throws(as(U.tomy, 'insert into public.team_members(team_id,user_id) values ($1,$2)', [team, U.evil]), 'insert directo en team_members prohibido')

await as(U.tomy, 'insert into public.team_invites(team_id, github_login_lower) values ($1, $2)', [team, 'mateo'])
ok((await as(U.mateo, 'select name from public.teams')).length === 1, 'mateo invitado ve el nombre del equipo')
ok((await as(U.mail, 'select * from public.team_invites')).length === 0, 'cuenta email que dice llamarse mateo NO ve la invitación')
ok((await as(U.mateo, 'select * from public.team_invite_codes')).length === 0, 'invitado no ve el código')
ok((await as(U.mateo, 'select * from public.profiles where id=$1', [U.tomy])).length === 1, 'invitado ve el perfil de quien invitó')
const inv = (await as(U.mateo, 'select id from public.team_invites'))[0].id
await throws(as(U.evil, 'select public.accept_invite($1)', [inv]), 'otro no acepta invitación ajena')
await as(U.mateo, 'select public.accept_invite($1)', [inv])
ok((await as(U.mateo, 'select * from public.messages')).length === 1, 'mateo ya miembro ve el mensaje')
ok((await as(U.mateo, 'select * from public.team_invite_codes')).length === 0, 'member no ve el código')
await throws(as(U.evil, "select public.join_team_by_code('0000000000000000')"), 'código falso')
await as(U.evil, 'select public.join_team_by_code($1)', [code])
ok((await as(U.evil, 'select * from public.team_members where team_id=$1', [team])).length === 3, 'evil entra con código')
const newCode = (await as(U.tomy, 'select public.regenerate_invite_code($1) as c', [team]))[0].c
ok(newCode !== code, 'código regenerado')
await throws(as(U.evil, 'select public.regenerate_invite_code($1)', [team]), 'member no regenera código')

await as(U.tomy, 'delete from public.team_members where team_id=$1 and user_id=$2', [team, U.evil])
ok((await as(U.evil, 'select * from public.messages')).length === 0, 'evil expulsado no ve mensajes')
await as(U.mateo, 'delete from public.team_members where team_id=$1 and user_id=$2', [team, U.tomy])
ok((await as(U.tomy, 'select * from public.team_members where team_id=$1', [team])).length === 2, 'member no puede sacar al owner')
await as(U.tomy, 'delete from public.team_members where team_id=$1 and user_id=$2', [team, U.tomy])
ok((await as(U.tomy, 'select * from public.team_members where team_id=$1', [team])).length === 2, 'owner no se va (tiene que borrar el equipo)')

const dm = (await as(U.tomy, 'select public.open_dm($1) as id', [U.mateo]))[0].id
ok(dm === (await as(U.mateo, 'select public.open_dm($1) as id', [U.tomy]))[0].id, 'mismo DM desde ambos lados')
await throws(as(U.tomy, 'select public.open_dm($1)', [U.evil]), 'DM con alguien sin equipo en común prohibido')
await as(U.mateo, "insert into public.messages(thread_id, client_id, body) values ($1, gen_random_uuid(), 'che tomy')", [dm])
ok((await as(U.evil, 'select * from public.messages where thread_id=$1', [dm])).length === 0, 'tercero no ve el DM')
await throws(as(U.evil, "insert into public.messages(thread_id, client_id, body) values ($1, gen_random_uuid(), 'x')", [dm]), 'tercero no escribe en el DM')
const unread = await as(U.tomy, 'select * from public.unread_counts()')
ok(unread.find((r) => r.kind === 'dm')?.unread === 1, 'tomy tiene 1 no leído en el DM')
await as(U.tomy, 'select public.mark_read(null, $1)', [dm])
ok((await as(U.tomy, 'select * from public.unread_counts()')).find((r) => r.kind === 'dm')?.unread === 0, 'mark_read limpia')

try {
  await as(U.mateo, "insert into public.messages(team_id, client_id, body, author_id, created_at) values ($1, gen_random_uuid(), 'spoof', $2, '2000-01-01')", [team, U.tomy])
} catch (e) {
  console.log('     (spoof rechazado: ' + e.message.slice(0, 60) + ')')
}
const sp = await as(U.tomy, "select author_id, created_at from public.messages where body='spoof'")
ok(sp.length === 0 || (sp[0].author_id === U.mateo && new Date(sp[0].created_at).getFullYear() > 2000), 'no se puede falsear autor ni hora')

let hit = false
for (let i = 0; i < 31; i++) {
  try {
    await as(U.mateo, "insert into public.messages(team_id, client_id, body) values ($1, gen_random_uuid(), 'x')", [team])
  } catch {
    hit = true
    break
  }
}
ok(hit, 'tope de 30 por minuto')
await throws(as(U.tomy, "insert into public.messages(team_id, client_id, body) values ($1, gen_random_uuid(), '   ')", [team]), 'mensaje vacío')

await as(U.tomy, 'update public.teams set name=$2, created_by=$3 where id=$1', [team, 'Cosmos AI', U.mateo])
const t = (await as(U.tomy, 'select name, created_by from public.teams where id=$1', [team]))[0]
ok(t.name === 'Cosmos AI' && t.created_by === U.tomy, 'owner renombra, created_by no cambia')
await as(U.mateo, 'update public.teams set name=$2 where id=$1', [team, 'hack'])
ok((await as(U.tomy, 'select name from public.teams where id=$1', [team]))[0].name === 'Cosmos AI', 'member no renombra')

await as(U.tomy, "insert into storage.objects(bucket_id, name) values ('team-photos', $1)", [team + '/a.webp'])
await throws(as(U.mateo, "insert into storage.objects(bucket_id, name) values ('team-photos', $1)", [team + '/b.webp']), 'member no sube foto')
ok((await as(U.mateo, 'select * from storage.objects')).length === 1, 'member ve la foto')
ok((await as(U.evil, 'select * from storage.objects')).length === 0, 'ajeno no ve la foto')
await throws(as(U.tomy, "insert into storage.objects(bucket_id, name) values ('team-photos', 'basura/a.webp')"), 'ruta sin uuid rechazada')

await throws(as(null, 'select * from public.messages'), 'anon sin acceso a messages')
await throws(as(null, 'select public.unread_counts()'), 'anon no ejecuta RPC')
console.log(fails ? `\n${fails} FALLAS` : '\nTodo OK')
process.exit(fails ? 1 : 0)
