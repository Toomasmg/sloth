import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acotar, redactar, type ContextoRedaccion } from './redactar'

const ctx: ContextoRedaccion = { home: 'C:\\Users\\Maria', userData: 'C:\\Users\\Maria\\AppData\\Roaming\\Sloth' }

// Se arman por partes para que ningún escáner de secretos del repo los tome por reales.
const GHP = 'ghp_' + 'a1B2c3D4'.repeat(4) + 'wxyz'
const GH_PAT = 'github_pat_' + '11ABC0123456789' + '_xyzXYZ0123'
const SB_SECRET = 'sb_secret_' + 'Zx9Qw8Er7Ty6Ui5'
const SB_PUBLISHABLE = 'sb_publishable_' + 'Ab1Cd2Ef3Gh4Ij5'
const ANTHROPIC = 'sk-ant-' + 'api03-AbC123_xyz-0123456789abcdef'
const OPENAI = 'sk-' + 'proj1234567890abcdefghij'
const SLACK = 'xox' + 'b-1234-5678-abcdef'
const AWS = 'AKIA' + 'IOSFODNN7EXAMPLE'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc_def-ghi'
const CLAVE_CELU = 'q7Zk3Vn0Rt5Yp2Lm8Xc4Hb6Jd9Fs1Gw-AaBbCcDdEe'

function sinSecreto(entrada: string, secreto: string, conserva: string[] = []): string {
  const salida = redactar(entrada, ctx)
  assert.ok(!salida.includes(secreto), `se coló «${secreto}» en: ${salida}`)
  for (const c of conserva) assert.ok(salida.includes(c), `faltó «${c}» en: ${salida}`)
  assert.equal(redactar(salida, ctx), salida, 'no es idempotente')
  return salida
}

test('tokens de Anthropic y OpenAI', () => {
  sinSecreto(`falló la llamada con ${ANTHROPIC} (401)`, ANTHROPIC, ['falló la llamada con', '(401)'])
  sinSecreto(`OPENAI usó ${OPENAI}.`, OPENAI, ['OPENAI usó'])
})

test('tokens de GitHub: ghp_ y github_pat_', () => {
  sinSecreto(`git push https://x@github.com con ${GHP} listo`, GHP, ['git push', 'listo'])
  sinSecreto(`token nuevo ${GH_PAT} guardado`, GH_PAT, ['guardado'])
  for (const p of ['gho_', 'ghu_', 'ghs_', 'ghr_']) {
    const t = p + 'Ab12'.repeat(8)
    sinSecreto(`usé ${t} ayer`, t, ['usé', 'ayer'])
  }
})

test('claves de Supabase sb_secret_ y sb_publishable_', () => {
  sinSecreto(`SUPABASE_KEY ${SB_SECRET} y más`, SB_SECRET, ['y más'])
  sinSecreto(`anon ${SB_PUBLISHABLE} y más`, SB_PUBLISHABLE, ['y más'])
})

test('Slack y AWS', () => {
  sinSecreto(`slack ${SLACK} ok`, SLACK, ['slack', 'ok'])
  sinSecreto(`aws ${AWS} ok`, AWS, ['aws', 'ok'])
})

test('JWT', () => {
  const salida = sinSecreto(`sesión ${JWT} vencida`, JWT, ['sesión', 'vencida'])
  assert.ok(!salida.includes('eyJ'))
  sinSecreto(`{"access":"${JWT}"}`, JWT)
})

test('Bearer, Basic y el encabezado Authorization', () => {
  sinSecreto('Authorization: Bearer abc.def', 'abc.def', ['Authorization'])
  sinSecreto('curl -H "Authorization: Bearer abc.def" https://api.example.com/x', 'abc.def', ['https://api.example.com/x'])
  sinSecreto('bearer tok_12345 y sigue', 'tok_12345', ['y sigue'])
  sinSecreto('Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA==', ['Authorization'])
  sinSecreto('{"headers":{"Authorization":"Bearer zzz.yyy.xxx"}}', 'zzz.yyy.xxx')
})

test('URLs con credenciales', () => {
  const s = sinSecreto('clonando https://user:pa55@host.example/x.git ahora', 'pa55', ['host.example/x.git', 'ahora'])
  assert.ok(!s.includes('user:'))
  sinSecreto('postgres://admin:s3cr3t-pw@db.interno:5432/app', 's3cr3t-pw', ['db.interno:5432/app'])
})

test('pares clave=valor y JSON', () => {
  sinSecreto('{"apiKey":"abc123"}', 'abc123', ['apiKey'])
  sinSecreto('{"password": "con espacios y más"}', 'con espacios', ['password'])
  sinSecreto("{'secret': 'hola mundo'}", 'hola mundo', ['secret'])
  sinSecreto('password=hunter2', 'hunter2', ['password='])
  sinSecreto('login falló password=hunter2 usuario=ana', 'hunter2', ['login falló', 'usuario=ana'])
  sinSecreto('GITHUB_TOKEN=abcd1234efgh', 'abcd1234efgh', ['GITHUB_TOKEN='])
  sinSecreto('ANTHROPIC_API_KEY: valorSecreto77', 'valorSecreto77', ['ANTHROPIC_API_KEY'])
  sinSecreto('x-api-key: valorSecreto77', 'valorSecreto77')
  sinSecreto('Cookie: sid=abc123xyz; theme=dark', 'abc123xyz')
  sinSecreto('?access_token=tok99zz&page=2', 'tok99zz', ['page=2'])
  sinSecreto('client_secret = "shh-no-contar"', 'shh-no-contar')
  sinSecreto('{\\"password\\":\\"hunter2\\"}', 'hunter2')
  sinSecreto('password="sin cierre', 'sin cierre')
  sinSecreto('clave: miClaveSecreta1', 'miClaveSecreta1')
})

test('rutas del usuario con la ruta literal de home y de userData', () => {
  const s = sinSecreto('Error en C:\\Users\\Maria\\Documents\\repo\\x.ts:10', 'Maria', ['Documents\\repo\\x.ts:10'])
  assert.equal(s, 'Error en ~\\Documents\\repo\\x.ts:10')
  assert.equal(redactar('C:/Users/Maria/Documents/repo/x.ts', ctx), '~/Documents/repo/x.ts')
  assert.equal(redactar('c:\\users\\maria\\docs', ctx), '~\\docs')
  assert.equal(redactar('C:\\\\Users\\\\Maria\\\\docs', ctx), '~\\\\docs')
  assert.equal(redactar('C:\\Users\\Maria\\AppData\\Roaming\\Sloth\\logs\\sloth.log', ctx), '<userData>\\logs\\sloth.log')
  assert.equal(redactar('file:///C:/Users/Maria/AppData/Roaming/Sloth/x', ctx), 'file:///<userData>/x')
})

test('rutas de otros usuarios y de otros sistemas', () => {
  assert.equal(redactar('C:\\Users\\Pedro\\x.ts', ctx), 'C:\\Users\\<usuario>\\x.ts')
  assert.equal(redactar('C:/Users/Pedro/x.ts', ctx), 'C:/Users/<usuario>/x.ts')
  assert.equal(redactar('/home/pepe/.config/sloth', ctx), '/home/<usuario>/.config/sloth')
  assert.equal(redactar('/Users/lola/Library/x', ctx), '/Users/<usuario>/Library/x')
  assert.equal(redactar('C:\\Users\\MariaLopez\\x', ctx), 'C:\\Users\\<usuario>\\x')
  sinSecreto('open /home/pepe/.config/sloth falló', 'pepe', ['falló'])
})

test('home y userData de otros sistemas, con y sin barra final', () => {
  const linux: ContextoRedaccion = { home: '/home/pepe', userData: '/home/pepe/.config/Sloth' }
  assert.equal(redactar('leí /home/pepe/.config/Sloth/logs/a y /home/pepe/b', linux), 'leí <userData>/logs/a y ~/b')
  assert.equal(redactar('/home/pepeluis/x', linux), '/home/<usuario>/x')
})

test('contexto vacío o demasiado corto no tapa todo', () => {
  const vacio: ContextoRedaccion = { home: '', userData: '/' }
  assert.equal(redactar('ruta /a/b/c y x', vacio), 'ruta /a/b/c y x')
})

test('emails', () => {
  sinSecreto('avisar a me@empresa.com mañana', 'me@empresa.com', ['avisar a', 'mañana'])
  sinSecreto('de ana.perez+sloth@sub.dominio.com.ar', 'ana.perez')
})

test('bloques de clave privada, completos y cortados', () => {
  const clave = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo', '4lgOEePzNm0tRgeLezV6ffAt0gun', '-----END RSA PRIVATE KEY-----'].join('\n')
  const s = sinSecreto(`antes\n${clave}\ndespués`, 'MIIEowIBAAKC', ['antes', 'después', '[clave privada]'])
  assert.ok(!s.includes('4lgOEePz') && !s.includes('BEGIN'))
  const dos = `${clave} intermedio ${clave}`
  assert.equal(redactar(dos, ctx), '[clave privada] intermedio [clave privada]')
  const cortada = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC'
  assert.equal(redactar(`x ${cortada}`, ctx), 'x [clave privada]')
  sinSecreto('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1')
})

test('la clave #k= del celu y el topic de ntfy', () => {
  sinSecreto(`abrí http://192.168.1.20:8765/#k=${CLAVE_CELU} en el celu`, CLAVE_CELU, ['http://192.168.1.20:8765/#k=', 'en el celu'])
  sinSecreto(`clave suelta ${CLAVE_CELU} fin`, CLAVE_CELU, ['clave suelta', 'fin'])
  const topic = 'sloth-0123456789abcdef01234567'
  sinSecreto(`POST https://ntfy.sh/${topic} 200`, topic, ['POST https://ntfy.sh/', '200'])
  sinSecreto(`{"topic":"mi-tema-privado","title":"Terminó"}`, 'mi-tema-privado', ['"title":"Terminó"'])
})

test('stack de Error con rutas y un secreto en el mensaje', () => {
  const stack = [
    `Error: 401 con ${ANTHROPIC}`,
    '    at llamar (C:\\Users\\Maria\\Documents\\Sloth\\src\\main\\x.ts:12:5)',
    '    at async C:/Users/Maria/AppData/Roaming/Sloth/features/y.js:3:1'
  ].join('\n')
  const s = sinSecreto(stack, ANTHROPIC, ['Error: 401 con', 'at llamar', 'x.ts:12:5', 'y.js:3:1'])
  assert.ok(!s.includes('Maria'))
})

test('no tapa texto normal', () => {
  const normales = [
    'Sloth 0.6.28 arrancó',
    'commit e9d7265 en staging',
    'Merge pull request #85 from Toomasmg/sync/main-en-staging',
    'el token venció, pedí uno nuevo',
    'la palabra token sin valor',
    'Basic setup terminado',
    'Electron 33.0.0, Node 20.18.0 y Chrome 130.0.6723.44',
    'react@18.3.1 y @types/node@22.0.0',
    'versión 1.2.3-beta.4 (build 9981)',
    'task-manager-service-handler-extra-largo-x',
    'feat/diagnostico-etapa-1-redaccion-de-secretos-largos',
    'sha 5d68d2f0c1ab9e8d7f6a5b4c3d2e1f0a9b8c7d6e completo',
    'Error: ENOENT: no such file or directory',
    'Grupo A: 3 cuentas, 5 espacios',
    'a:b, c=d; x: y'
  ]
  for (const t of normales) assert.equal(redactar(t, ctx), t)
})

test('es idempotente con todos los casos juntos', () => {
  const todo = [
    ANTHROPIC, GHP, GH_PAT, SB_SECRET, SLACK, AWS, JWT,
    'Authorization: Bearer abc.def',
    'https://user:pa55@host/x',
    '{"apiKey":"abc123"}',
    'password=hunter2',
    'C:\\Users\\Maria\\Documents\\repo\\x.ts',
    '/home/pepe/.config',
    'me@empresa.com',
    `http://10.0.0.2:8765/#k=${CLAVE_CELU}`,
    '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
  ].join('\n')
  const una = redactar(todo, ctx)
  assert.equal(redactar(una, ctx), una)
  for (const s of ['pa55', 'hunter2', 'abc123', 'Maria', 'pepe', 'empresa.com', CLAVE_CELU]) assert.ok(!una.includes(s), s)
})

test('texto enorme sin forma de secreto no se cuelga', () => {
  const casos = [
    'a'.repeat(100_000),
    'eyJ'.repeat(33_000),
    'sk-'.repeat(33_000),
    'Bearer '.repeat(14_000),
    'token'.repeat(20_000),
    'a@'.repeat(50_000),
    '-----BEGIN PRIVATE KEY-----'.repeat(3_000),
    'a.'.repeat(50_000),
    ' '.repeat(100_000),
    '://'.repeat(30_000),
    'password='.repeat(11_000),
    'C:\\Users\\'.repeat(10_000),
    '"'.repeat(100_000)
  ]
  for (const c of casos) {
    const ini = performance.now()
    redactar(c, ctx)
    const ms = performance.now() - ini
    assert.ok(ms < 2500, `tardó ${ms.toFixed(0)} ms con «${c.slice(0, 12)}…»`)
  }
  const ini = performance.now()
  assert.equal(redactar('a'.repeat(100_000), ctx).length, 100_000)
  assert.ok(performance.now() - ini < 500)
})

test('acotar corta y avisa, y no parte un par sustituto', () => {
  assert.equal(acotar('hola', 10), 'hola')
  assert.equal(acotar('hola', 4), 'hola')
  assert.equal(acotar('abcdefgh', 3), 'abc…[cortado]')
  assert.equal(acotar('abcdefgh', 0), '…[cortado]')
  const emoji = 'ab😀cd'
  assert.equal(acotar(emoji, 3), 'ab…[cortado]')
  assert.equal(acotar(emoji, 4), 'ab😀…[cortado]')
})

test('claves de Google y GitLab', () => {
  const g = 'AIza' + 'Sy' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'
  assert.equal(g.length, 39)
  sinSecreto(`maps usó ${g} ayer`, g, ['maps usó', 'ayer'])
  const gl = 'glpat-' + 'Ab12Cd34Ef56Gh78Ij90'
  sinSecreto(`clone con ${gl} ok`, gl, ['clone con', 'ok'])
})

test('pass, *_KEY, session id y tema en asignaciones', () => {
  sinSecreto('pass=hunter2 listo', 'hunter2', ['listo'])
  sinSecreto('password=hunter3', 'hunter3')
  sinSecreto('SUPABASE_KEY=abc123xyz y más', 'abc123xyz', ['y más'])
  sinSecreto('MI_TOKEN=zzz999 fin', 'zzz999', ['fin'])
  sinSecreto('session_id: s3cr3t7', 's3cr3t7')
  sinSecreto('{"tema":"mi-canal-privado"}', 'mi-canal-privado')
})

test('no se pasa de rosca con palabras parecidas', () => {
  assert.equal(redactar('passed: 5 tests', ctx), 'passed: 5 tests')
  assert.equal(redactar('compass bypass listo', ctx), 'compass bypass listo')
  assert.equal(redactar('la sesión: iniciada', ctx), 'la sesión: iniciada')
  assert.equal(redactar('key: valor', ctx), 'key: valor')
})

test('token como usuario en una URL, sin contraseña', () => {
  const t = 'Zq8Xw7Ee6Rr5Tt4Yy3Uu2Ii1'
  sinSecreto(`git clone https://${t}@github.com/a/b`, t, ['github.com/a/b'])
  assert.equal(redactar('https://ana@localhost/a/b', ctx), 'https://ana@localhost/a/b')
})
