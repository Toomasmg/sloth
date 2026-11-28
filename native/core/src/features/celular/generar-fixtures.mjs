// Regenera lo que el núcleo Rust de «celular» compara contra el TypeScript:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/test-hooks.mjs native/core/src/features/celular/generar-fixtures.mjs [--assets]
// Sin `--assets` solo escribe fixtures/ts.json (huellas y vectores). Con `--assets` también extrae la página (html, css, js)
// de celular-pagina.ts a pagina/, que es lo que Rust embebe con include_str!.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const aqui = dirname(fileURLToPath(import.meta.url))
const raiz = join(aqui, '../../../../..')
const feat = (n) => import(pathToFileURL(join(raiz, 'src/main/features', n)).href)

const { PAGINA_HTML, PAGINA_CSS, PAGINA_JS, manifiesto } = await feat('celular-pagina.ts')
const { SELLO_JS } = await feat('celular-sello-web.ts')
const sello = await feat('celular-sello.ts')
const term = await feat('celular-terminal-core.ts')
const core = await feat('celular-core.ts')
const act = await feat('celular-actividad.ts')
const remoto = await import(pathToFileURL(join(raiz, 'src/shared/celu-remoto.ts')).href)

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const huella = (s) => ({ sha256: sha(s), utf8: Buffer.byteLength(s, 'utf8') })

if (process.argv.includes('--assets')) {
  const dir = join(aqui, 'pagina')
  mkdirSync(dir, { recursive: true })
  // PAGINA_JS = SELLO_JS + '\n' + cuerpo: se guardan por separado y Rust los junta igual.
  if (!PAGINA_JS.startsWith(SELLO_JS + '\n')) throw new Error('PAGINA_JS ya no empieza con SELLO_JS')
  writeFileSync(join(dir, 'index.html'), PAGINA_HTML)
  writeFileSync(join(dir, 'app.css'), PAGINA_CSS)
  writeFileSync(join(dir, 'sello.js'), SELLO_JS)
  writeFileSync(join(dir, 'app.js'), PAGINA_JS.slice(SELLO_JS.length + 1))
}

const buf = (n, v) => Buffer.alloc(n, v)
const CLAVE = buf(32, 7).toString('base64url')
const claves = sello.derivarClaves(CLAVE)
const iv = buf(16, 3)
const ivR = buf(16, 5)
const jsonUnicode = '{"t":1800000000000,"b":{"a":"ñandú 😀","x":[1,2,3]}}'

const E = '\x1b'
const piezas = [E, '[', ']', 'P', '\\', '\x07', ';', ':', '?', '<', '>', '=', '$', '~', 'M', 'm', 'R', 'c', 'n', 't', 'I', 'O', 'y', 'a', ' ', '0', '1', '2', '4', '5', '6', '8', '9', '!', 'ñ', '😀', '\r']
let semilla = 12345
const azar = (n) => {
  semilla = (Math.imul(semilla, 1103515245) + 12345) >>> 0
  return semilla % n
}
const entradas = [
  `${E}[24;80R`, `${E}[?1;2c`, `${E}[200~hola ${E}[I ${E}[24;80R chau${E}[201~`, `${E}[200~sin cierre ${E}[I`, `${E}[1;5R`, `${E}[1;9R`, `${E}[<64;3;4M`, `${E}[<640;3;4M`,
  `${E}[M !!`, `${E}[M😀x`, `${E}]10;rgb:e8e8/eaea/eded\x07`, `${E}P1$r0m${E}\\`, `${E}[${E}[II`, `${E}[<${E}[O0;1;1M`, 'hola', 'ñandú', `${E}[24;`
]
for (let i = 0; i < 600; i++) {
  let s = ''
  const largo = 1 + azar(26)
  for (let j = 0; j < largo; j++) s += azar(3) === 0 ? E : piezas[azar(piezas.length)]
  entradas.push(s)
}

const secreto = Buffer.alloc(32, 9).toString('base64url')
const userId = '0a1b2c3d-0000-4000-8000-00000000abcd'
const topic = remoto.topicCelu(userId)
const clave = await remoto.claveCelu(secreto, userId)
const datoRemoto = { estado: { ahora: 1, aprobar: false, terminal: false, cuentas: [], sesiones: [], pedidos: [] }, n: 3 }
const sobreRemoto = await remoto.sellar(clave, topic, 'estado', datoRemoto)

const salida = {
  pagina: { html: huella(PAGINA_HTML), css: huella(PAGINA_CSS), js: huella(PAGINA_JS), sello_js: huella(SELLO_JS), manifiesto: manifiesto() },
  sello: {
    clave: CLAVE,
    enc: claves.enc.toString('hex'),
    mac: claves.mac.toString('hex'),
    iv: iv.toString('hex'),
    iv_respuesta: ivR.toString('hex'),
    ruta: '/api/estado',
    json: jsonUnicode,
    pedido: sello.sellarPedido(claves, '/api/estado', jsonUnicode, iv),
    respuesta: sello.sellarRespuesta(claves, iv, '{"ok":true,"n":"ü"}', ivR),
    vacio: sello.sellarPedido(claves, '/a', '', iv)
  },
  sin_automaticas: entradas.map((e) => [e, term.sinAutomaticas(e)]),
  peso_json: ['abc', '\x1b[0m', 'dijo "hola" y \\ \r\n\t', 'ñandú café', '─│╭╯', '😀👍', '\u0001\u007f', ''].map((t) => [t, term.pesoJson(t)]),
  dispositivos: [
    'Mozilla/5.0 (Linux; Android 13; SM-G965F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone) CriOS/120 Safari/604',
    'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120 EdgA/1',
    'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15',
    ''
  ].map((u) => [u, act.dispositivoDe(u)]),
  a_ms: [1_800_000_000, 1_800_000_000_000, '1800000000', '2027-01-15T12:00:00Z', 'mañana', null, 0, -5, ' 42 ', '', '2027-01-15'].map((v) => [v, core.aMs(v)]),
  servidor_ntfy: [undefined, '', 'https://ntfy.ejemplo.com', 'https://ntfy.ejemplo.com/sub', 'https://ntfy.ejemplo.com/a//', 'http://x.com/', 'https://u@x.com/', 'https://x.com/?a=1', 'https://x.com/#a', 'https://X.COM:443/p', 'https://x.com:8443', 'no es url', 5].map((v) => [v ?? null, core.servidorNtfy(v)]),
  remoto: { secreto, userId, topic, evento: 'estado', dato: datoRemoto, sobre: sobreRemoto }
}

// Así era celular.json antes de numerarlo (v1): una sola clave para todos.
const archivoV1 = {
  encendido: true,
  puerto: 47321,
  clave: CLAVE,
  aprobar: true,
  terminal: false,
  ntfy: { encendido: false, tema: 'sloth-abcdefabcdefabcdefabcdef', servidor: 'https://ntfy.sh' },
  remoto: { encendido: false, aprobar: false, secreto: buf(32, 8).toString('base64url') },
  campoQueNoConozco: 1
}

mkdirSync(join(aqui, 'fixtures'), { recursive: true })
writeFileSync(join(aqui, 'fixtures/ts.json'), JSON.stringify(salida, null, 1) + '\n')
writeFileSync(join(aqui, 'fixtures/celular-v1.json'), JSON.stringify(archivoV1, null, 2) + '\n')
