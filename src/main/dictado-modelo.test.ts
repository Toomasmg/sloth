import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { ModeloError, asegurarModelo, hostPermitido } from './dictado-modelo'
import type { ModeloDeps, OpcionesModelo, RespuestaModelo } from './dictado-modelo'

const CONTENIDO = new TextEncoder().encode('contenido de prueba del modelo, lo bastante largo para partirlo en chunks')
const HASH = createHash('sha256').update(CONTENIDO).digest('hex')
const HOSTS = ['huggingface.co', 'cdn.hf.co']
const URL_MODELO = 'https://huggingface.co/x/modelo.bin'

function stream(bytes: Uint8Array, partes = 3): ReadableStream<Uint8Array> {
  const tam = Math.ceil(bytes.length / partes)
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= bytes.length) return c.close()
      c.enqueue(bytes.slice(i, i + tam))
      i += tam
    }
  })
}

function resp(status: number, bytes: Uint8Array | null, headers: Record<string, string> = {}): RespuestaModelo {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: bytes ? stream(bytes) : null,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null }
  }
}

interface Falso {
  deps: ModeloDeps
  fs: Map<string, Uint8Array>
  pedidos: string[]
  esperas: number[]
}

function falso(respuestas: Array<(url: string) => RespuestaModelo | Error>, opc: { escribirFalla?: Error } = {}): Falso {
  const fs = new Map<string, Uint8Array>()
  const pedidos: string[] = []
  const esperas: number[] = []
  let n = 0
  const deps: ModeloDeps = {
    async fetch(url) {
      pedidos.push(url)
      const r = respuestas[Math.min(n++, respuestas.length - 1)](url)
      if (r instanceof Error) throw r
      return r
    },
    async mkdir() {},
    async abrir(path) {
      const partes: Uint8Array[] = []
      fs.set(path, new Uint8Array())
      return {
        async write(chunk) {
          if (opc.escribirFalla) throw opc.escribirFalla
          partes.push(chunk)
          fs.set(path, new Uint8Array(Buffer.concat(partes)))
        },
        async close() {}
      }
    },
    async rename(a, b) {
      const v = fs.get(a)
      assert.ok(v, 'el .part tiene que existir al renombrar')
      fs.delete(a)
      fs.set(b, v)
    },
    async rm(path) {
      fs.delete(path)
    },
    async existe(path) {
      return fs.has(path)
    },
    async sleep(ms) {
      esperas.push(ms)
    }
  }
  return { deps, fs, pedidos, esperas }
}

function opciones(extra: Partial<OpcionesModelo> = {}): OpcionesModelo {
  return { url: URL_MODELO, sha256: HASH, destino: '/datos/modelo.bin', hosts: HOSTS, maxBytes: 1000, bytesAprox: CONTENIDO.length, ...extra }
}

async function tipoDe(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    assert.ok(e instanceof ModeloError, `se esperaba ModeloError y llegó ${String(e)}`)
    return e.tipo
  }
  return 'sin error'
}

test('descarga bien: renombra el .part al destino y avisa el progreso', async () => {
  const f = falso([() => resp(200, CONTENIDO, { 'content-length': String(CONTENIDO.length) })])
  const avances: Array<[number, number]> = []
  await asegurarModelo(opciones({ onProgreso: (r, t) => avances.push([r, t]) }), f.deps)
  assert.deepEqual(f.fs.get('/datos/modelo.bin'), CONTENIDO)
  assert.equal(f.fs.has('/datos/modelo.bin.part'), false)
  assert.ok(avances.length >= 2)
  assert.deepEqual(avances.at(-1), [CONTENIDO.length, CONTENIDO.length])
})

test('hash incorrecto: borra el .part, reintenta y al agotar falla sin dejar el destino', async () => {
  const roto = new TextEncoder().encode('otro contenido distinto')
  const f = falso([() => resp(200, roto)])
  assert.equal(await tipoDe(asegurarModelo(opciones(), f.deps)), 'hash')
  assert.equal(f.pedidos.length, 3)
  assert.equal(f.fs.size, 0)
  assert.deepEqual(f.esperas, [1000, 3000])
})

test('hash incorrecto una vez y bien la siguiente: queda el contenido bueno', async () => {
  const f = falso([() => resp(200, new TextEncoder().encode('malo')), () => resp(200, CONTENIDO)])
  await asegurarModelo(opciones(), f.deps)
  assert.deepEqual(f.fs.get('/datos/modelo.bin'), CONTENIDO)
})

test('sin red: reintenta y anda a la tercera; si no, sin-red', async () => {
  const caida = (): Error => new TypeError('fetch failed')
  const f = falso([caida, caida, () => resp(200, CONTENIDO)])
  await asegurarModelo(opciones(), f.deps)
  assert.equal(f.pedidos.length, 3)
  assert.deepEqual(f.esperas, [1000, 3000])

  const g = falso([caida])
  assert.equal(await tipoDe(asegurarModelo(opciones(), g.deps)), 'sin-red')
  assert.equal(g.pedidos.length, 3)
  assert.equal(g.fs.size, 0)
})

test('un stream que se corta a la mitad cuenta como sin red y no deja nada', async () => {
  const cortado = (): RespuestaModelo => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(CONTENIDO.slice(0, 10))
        c.error(new Error('conexión reiniciada'))
      }
    })
  })
  const f = falso([cortado])
  assert.equal(await tipoDe(asegurarModelo(opciones(), f.deps)), 'sin-red')
  assert.equal(f.fs.size, 0)
})

test('si llegan menos bytes que el content-length, no se acepta aunque no haya error', async () => {
  const f = falso([() => resp(200, CONTENIDO.slice(0, 10), { 'content-length': String(CONTENIDO.length) })])
  assert.equal(await tipoDe(asegurarModelo(opciones(), f.deps)), 'sin-red')
  assert.equal(f.fs.has('/datos/modelo.bin'), false)
})

test('404 falla como http sin reintentar; 503 sí reintenta', async () => {
  const a = falso([() => resp(404, null)])
  assert.equal(await tipoDe(asegurarModelo(opciones(), a.deps)), 'http')
  assert.equal(a.pedidos.length, 1)

  const b = falso([() => resp(503, null), () => resp(200, CONTENIDO)])
  await asegurarModelo(opciones(), b.deps)
  assert.equal(b.pedidos.length, 2)
})

test('redirect a un host fuera de la lista: http y no se pide', async () => {
  const f = falso([() => resp(302, null, { location: 'https://malo.example.com/modelo.bin' })])
  assert.equal(await tipoDe(asegurarModelo(opciones(), f.deps)), 'http')
  assert.deepEqual(f.pedidos, [URL_MODELO])
})

test('redirect a http plano: http y no se pide', async () => {
  const f = falso([() => resp(302, null, { location: 'http://cdn.hf.co/modelo.bin' })])
  assert.equal(await tipoDe(asegurarModelo(opciones(), f.deps)), 'http')
  assert.equal(f.pedidos.length, 1)
})

test('redirect a un host permitido (también relativo): se sigue y baja', async () => {
  const f = falso([
    () => resp(302, null, { location: 'https://cdn.hf.co/blob?firma=abc' }),
    () => resp(307, null, { location: '/otro' }),
    () => resp(200, CONTENIDO)
  ])
  await asegurarModelo(opciones(), f.deps)
  assert.deepEqual(f.pedidos, [URL_MODELO, 'https://cdn.hf.co/blob?firma=abc', 'https://cdn.hf.co/otro'])
  assert.deepEqual(f.fs.get('/datos/modelo.bin'), CONTENIDO)
})

test('redirecciones en bucle: corta', async () => {
  const f = falso([() => resp(302, null, { location: URL_MODELO })])
  assert.equal(await tipoDe(asegurarModelo(opciones(), f.deps)), 'http')
  assert.ok(f.pedidos.length <= 6)
})

test('disco lleno (ENOSPC) al escribir: disco, sin reintentos y sin .part', async () => {
  const enospc = Object.assign(new Error('no space left'), { code: 'ENOSPC' })
  const f = falso([() => resp(200, CONTENIDO)], { escribirFalla: enospc })
  assert.equal(await tipoDe(asegurarModelo(opciones(), f.deps)), 'disco')
  assert.equal(f.pedidos.length, 1)
  assert.equal(f.fs.size, 0)
})

test('otro error de escritura: escritura, sin reintentos', async () => {
  const f = falso([() => resp(200, CONTENIDO)], { escribirFalla: Object.assign(new Error('denegado'), { code: 'EPERM' }) })
  assert.equal(await tipoDe(asegurarModelo(opciones(), f.deps)), 'escritura')
  assert.equal(f.pedidos.length, 1)
})

test('si el destino ya existe no pide nada', async () => {
  const f = falso([() => resp(200, CONTENIDO)])
  f.fs.set('/datos/modelo.bin', CONTENIDO)
  await asegurarModelo(opciones(), f.deps)
  assert.equal(f.pedidos.length, 0)
})

test('tope de tamaño: por content-length y por lo que llega de verdad', async () => {
  const a = falso([() => resp(200, CONTENIDO, { 'content-length': '999999' })])
  assert.equal(await tipoDe(asegurarModelo(opciones(), a.deps)), 'http')
  assert.equal(a.fs.size, 0)

  const b = falso([() => resp(200, CONTENIDO)])
  assert.equal(await tipoDe(asegurarModelo(opciones({ maxBytes: 20 }), b.deps)), 'http')
  assert.equal(b.fs.size, 0)
})

test('sin recibir nada durante el tiempo de inactividad: sin-red', async () => {
  const f = falso([() => resp(200, CONTENIDO)])
  f.deps.fetch = async (_url, init) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: new ReadableStream<Uint8Array>({
      start(c) {
        init.signal.addEventListener('abort', () => c.error(new Error('abortado')))
      }
    })
  })
  assert.equal(await tipoDe(asegurarModelo(opciones({ inactividadMs: 20, intentos: 1 }), f.deps)), 'sin-red')
})

test('hostPermitido: solo https, host exacto de la lista, sin credenciales ni puerto', () => {
  assert.equal(hostPermitido('https://huggingface.co/a/b', HOSTS), true)
  assert.equal(hostPermitido('http://huggingface.co/a/b', HOSTS), false)
  assert.equal(hostPermitido('https://huggingface.co.evil.com/a', HOSTS), false)
  assert.equal(hostPermitido('https://evil.com/huggingface.co', HOSTS), false)
  assert.equal(hostPermitido('https://usuario:clave@huggingface.co/a', HOSTS), false)
  assert.equal(hostPermitido('https://huggingface.co:8443/a', HOSTS), false)
  assert.equal(hostPermitido('file:///C:/modelo.bin', HOSTS), false)
  assert.equal(hostPermitido('no es una url', HOSTS), false)
})

test('un sha256 mal formado tira antes de pedir nada', async () => {
  const f = falso([() => resp(200, CONTENIDO)])
  for (const mal of ['', 'abc', HASH.toUpperCase(), `${HASH}0`, 'z'.repeat(64)]) {
    await assert.rejects(asegurarModelo(opciones({ sha256: mal }), f.deps), /SHA-256/)
  }
  assert.equal(f.pedidos.length, 0)
})

test('una URL inicial fuera de la lista falla sin pedir nada', async () => {
  const f = falso([() => resp(200, CONTENIDO)])
  assert.equal(await tipoDe(asegurarModelo(opciones({ url: 'https://evil.com/m.bin' }), f.deps)), 'http')
  assert.equal(f.pedidos.length, 0)
})
