import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crearLogger } from './logger'

function carpeta(): { raiz: string; dir: string; limpiar: () => void } {
  const raiz = mkdtempSync(join(tmpdir(), 'sloth-logger-'))
  return { raiz, dir: join(raiz, 'logs'), limpiar: () => rmSync(raiz, { recursive: true, force: true }) }
}

const CASA = join(tmpdir(), 'casa-de-maria')
const opts = (dir: string, raiz: string) => ({ dir, home: CASA, userData: raiz })

test('escribe líneas con fecha, nivel y origen, y las devuelve en recientes', () => {
  const c = carpeta()
  try {
    let t = Date.UTC(2026, 10, 17, 12, 0, 0)
    const log = crearLogger({ ...opts(c.dir, c.raiz), ahora: () => t })
    log.info('main', 'arrancó')
    t += 1000
    log.aviso('avisos', 'archivo dañado')
    t += 1000
    log.error('renderer', new Error('se rompió'))
    const lineas = readFileSync(join(c.dir, 'sloth.log'), 'utf8').trimEnd().split('\n')
    assert.equal(lineas.length, 3)
    assert.equal(lineas[0], '2026-11-17T12:00:00.000Z info [main] arrancó')
    assert.equal(lineas[1], '2026-11-17T12:00:01.000Z aviso [avisos] archivo dañado')
    assert.match(lineas[2], /^2026-11-17T12:00:02\.000Z error \[renderer\] Error: se rompió \| +at /)
    assert.deepEqual(log.recientes(2).map((e) => e.nivel), ['aviso', 'error'])
    assert.equal(log.recientes(50).length, 3)
    assert.equal(log.fallo(), undefined)
  } finally {
    c.limpiar()
  }
})

test('una entrada es una sola línea aunque traiga saltos', () => {
  const c = carpeta()
  try {
    const log = crearLogger(opts(c.dir, c.raiz))
    log.aviso('x', 'uno\ndos\r\ntres')
    const texto = readFileSync(join(c.dir, 'sloth.log'), 'utf8')
    assert.equal(texto.trimEnd().split('\n').length, 1)
    assert.match(texto, /uno \| dos \| tres/)
  } finally {
    c.limpiar()
  }
})

test('redacta secretos y rutas antes de escribir y antes de guardar en memoria', () => {
  const c = carpeta()
  try {
    const log = crearLogger(opts(c.dir, c.raiz))
    const token = 'ghp_' + 'a1B2c3D4'.repeat(4) + 'wxyz'
    const casa = join(CASA, 'repo', 'x.ts')
    log.error('main', new Error(`falló con ${token} en ${casa} para me@empresa.com`))
    log.aviso('main', 'password=hunter2')
    const texto = readFileSync(join(c.dir, 'sloth.log'), 'utf8')
    for (const s of [token, 'casa-de-maria', 'me@empresa.com', 'hunter2']) {
      assert.ok(!texto.includes(s), `se coló ${s}`)
      assert.ok(!JSON.stringify(log.recientes(10)).includes(s), `se coló ${s} en memoria`)
    }
    assert.match(texto, /\[token\]/)
    assert.match(texto, /~/)
  } finally {
    c.limpiar()
  }
})

test('acota las líneas largas', () => {
  const c = carpeta()
  try {
    const log = crearLogger(opts(c.dir, c.raiz))
    log.info('main', 'z'.repeat(50_000))
    const linea = readFileSync(join(c.dir, 'sloth.log'), 'utf8')
    assert.ok(linea.length < 4200)
    assert.match(linea, /…\[cortado\]\n$/)
  } finally {
    c.limpiar()
  }
})

test('errores que no son Error se escriben igual', () => {
  const c = carpeta()
  try {
    const log = crearLogger(opts(c.dir, c.raiz))
    log.error('main', 'texto suelto')
    log.error('main', { raro: true })
    log.error('main', undefined)
    assert.equal(log.recientes(10).length, 3)
    assert.equal(log.fallo(), undefined)
  } finally {
    c.limpiar()
  }
})

test('rota por tamaño sin pasar de `mantener` + 1 archivos', () => {
  const c = carpeta()
  try {
    const log = crearLogger({ ...opts(c.dir, c.raiz), max: 300, mantener: 3 })
    for (let i = 0; i < 80; i++) log.info('main', `línea número ${i} con algo de relleno para ocupar lugar`)
    const archivos = readdirSync(c.dir).sort()
    assert.deepEqual(archivos, ['sloth.1.log', 'sloth.2.log', 'sloth.3.log', 'sloth.log'])
    assert.match(readFileSync(join(c.dir, 'sloth.log'), 'utf8'), /línea número 79/)
    assert.equal(log.fallo(), undefined)
  } finally {
    c.limpiar()
  }
})

test('la rotación no toca archivos ajenos de la carpeta', () => {
  const c = carpeta()
  try {
    const log = crearLogger({ ...opts(c.dir, c.raiz), max: 200, mantener: 1 })
    writeFileSync(join(c.dir, 'sesion.json'), '{}')
    for (let i = 0; i < 20; i++) log.info('main', `relleno relleno relleno relleno ${i}`)
    assert.deepEqual(readdirSync(c.dir).sort(), ['sesion.json', 'sloth.1.log', 'sloth.log'])
  } finally {
    c.limpiar()
  }
})

test('retoma un log que ya existía', () => {
  const c = carpeta()
  try {
    crearLogger(opts(c.dir, c.raiz)).info('main', 'primera')
    const log = crearLogger(opts(c.dir, c.raiz))
    log.info('main', 'segunda')
    const lineas = readFileSync(join(c.dir, 'sloth.log'), 'utf8').trimEnd().split('\n')
    assert.equal(lineas.length, 2)
  } finally {
    c.limpiar()
  }
})

test('con la carpeta inescribible no lanza, informa el fallo y sigue en memoria', () => {
  const c = carpeta()
  try {
    const archivo = join(c.raiz, 'es-un-archivo')
    writeFileSync(archivo, 'x')
    const log = crearLogger(opts(join(archivo, 'logs'), c.raiz))
    assert.ok(log.fallo() && log.fallo()!.length > 0)
    assert.doesNotThrow(() => log.error('main', new Error('sigue andando')))
    assert.equal(log.recientes(5).length, 1)
  } finally {
    c.limpiar()
  }
})

test('si falla el append más tarde guarda el motivo y no lanza', () => {
  const c = carpeta()
  try {
    const log = crearLogger(opts(c.dir, c.raiz))
    log.info('main', 'ok')
    rmSync(c.dir, { recursive: true, force: true })
    writeFileSync(c.dir, 'ahora soy un archivo')
    assert.doesNotThrow(() => log.info('main', 'otra'))
    assert.ok(log.fallo())
    assert.equal(log.recientes(5).length, 2)
  } finally {
    c.limpiar()
  }
})

test('soloMemoria no crea nada en disco', () => {
  const c = carpeta()
  try {
    const log = crearLogger({ ...opts(c.dir, c.raiz), soloMemoria: true })
    log.info('main', 'hola')
    assert.equal(readdirSync(c.raiz).length, 0)
    assert.equal(log.recientes(1)[0].msg, 'hola')
  } finally {
    c.limpiar()
  }
})

test('el buffer en memoria guarda las últimas 200', () => {
  const log = crearLogger({ dir: '', home: '', userData: '', soloMemoria: true })
  for (let i = 0; i < 250; i++) log.info('main', `n${i}`)
  const todas = log.recientes(1000)
  assert.equal(todas.length, 200)
  assert.equal(todas[0].msg, 'n50')
  assert.equal(todas[199].msg, 'n249')
  assert.deepEqual(log.recientes(0), [])
})
