import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { iniciarPerfilesFs, leerMeta, rutasPerfiles, type ResultadoArranque } from './perfiles-fs'
import { validarIndice } from './perfiles-core'

const AHORA = 1_700_000_000_000
const ahora = (): number => AHORA

function raiz(): string {
  return mkdtempSync(join(tmpdir(), 'sloth-perfiles-'))
}

function escribir(base: string, rel: string, contenido: string | Buffer): void {
  const f = join(base, rel)
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, contenido)
}

/** Ruta relativa -> contenido de cada archivo bajo `dir` (solo las entradas pedidas, si se pasan). */
function foto(dir: string, entradas?: readonly string[]): Map<string, string> {
  const r = new Map<string, string>()
  const andar = (d: string): void => {
    for (const n of readdirSync(d)) {
      const f = join(d, n)
      if (statSync(f).isDirectory()) andar(f)
      else r.set(relative(dir, f), readFileSync(f).toString('base64'))
    }
  }
  for (const e of entradas ?? readdirSync(dir)) {
    const f = join(dir, e)
    if (!existsSync(f)) continue
    if (statSync(f).isDirectory()) andar(f)
    else r.set(e, readFileSync(f).toString('base64'))
  }
  return r
}

/** Una raíz como la de un usuario real (datos inventados): cuentas, claves, estado, funciones y respaldos. */
function sembrar(d: string): void {
  escribir(d, 'sloth-state.json', JSON.stringify({ version: 1, accounts: [{ id: 'a1', label: 'Trabajo', configDir: join(d, 'accounts', 'a1') }], workspaces: [{ id: '3f2c1e8a-0000-4000-8000-000000000001', name: 'Ñandú 🦥' }], openPanes: [] }))
  escribir(d, 'sloth-state.json.bak-1699999999999', '{"version":1,"accounts":[],"workspaces":[],"openPanes":[]}')
  escribir(d, 'features/settings.json', '﻿{"version":1,"theme":"claro"}')
  escribir(d, 'features/tickets/uso.json', '{"dias":{}}')
  escribir(d, 'features/chat-session.bin', Buffer.from([0, 1, 2, 255, 254]))
  escribir(d, 'features/celular.json', '{"clave":"anónima"}')
  escribir(d, 'accounts/a1/.credentials.json', '{"token":"no-se-copia"}')
  escribir(d, 'daemon-key', 'clave')
  escribir(d, 'daemon-token', 'token')
  escribir(d, 'window-state.json', '{}')
  escribir(d, 'logs/sloth.log', 'línea')
}

const ORIGINALES = ['sloth-state.json', 'sloth-state.json.bak-1699999999999', 'features', 'accounts', 'daemon-key', 'daemon-token', 'window-state.json', 'logs']

function leerIndice(d: string): unknown {
  return JSON.parse(readFileSync(rutasPerfiles(d).indice, 'utf8'))
}

function respaldosPrevios(d: string): string[] {
  const dir = rutasPerfiles(d).respaldos
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith('pre-perfiles-')) : []
}

function conFsRoto<T>(metodos: readonly ('cpSync' | 'mkdirSync' | 'renameSync' | 'openSync')[], debeFallar: (ruta: string) => boolean, fn: () => T): T {
  const mocks = metodos.map((m) => {
    const original = fs[m] as (...a: unknown[]) => unknown
    return mock.method(fs, m, (...a: unknown[]) => {
      const destino = String(a[m === 'cpSync' || m === 'renameSync' ? 1 : 0])
      if (debeFallar(destino)) throw Object.assign(new Error(`EROFS: read-only file system, '${destino}'`), { code: 'EROFS' })
      return original.apply(fs, a)
    })
  })
  syncBuiltinESMExports()
  try {
    return fn()
  } finally {
    for (const m of mocks) m.mock.restore()
    syncBuiltinESMExports()
  }
}

test('migra por copia: la raíz queda byte a byte igual, el perfil idéntico, respaldo e índice válidos', () => {
  const d = raiz()
  sembrar(d)
  const antes = foto(d, ORIGINALES)
  const r = iniciarPerfilesFs(d, ahora)
  assert.equal(r.error, undefined)
  assert.equal(r.migrado, true)
  assert.deepEqual(foto(d, ORIGINALES), antes)
  const perfil = join(d, 'perfiles', 'principal')
  assert.deepEqual(foto(perfil, ['sloth-state.json', 'features']), foto(d, ['sloth-state.json', 'features']))
  assert.deepEqual(leerMeta(perfil), { id: 'principal', nombre: 'Mi perfil', creado: AHORA })
  assert.deepEqual(respaldosPrevios(d), [`pre-perfiles-${AHORA}`])
  assert.deepEqual(foto(join(d, 'respaldos', `pre-perfiles-${AHORA}`)), foto(d, ['sloth-state.json', 'features']))
  assert.deepEqual(validarIndice(leerIndice(d)), r.indice)
  assert.equal(r.indice.activo, 'principal')
  rmSync(d, { recursive: true })
})

test('logins, claves, logs, ventana y .bak de la raíz no pasan al perfil', () => {
  const d = raiz()
  sembrar(d)
  iniciarPerfilesFs(d, ahora)
  assert.deepEqual(readdirSync(join(d, 'perfiles', 'principal')).sort(), ['features', 'perfil.json', 'sloth-state.json'])
  assert.deepEqual(readdirSync(join(d, 'respaldos', `pre-perfiles-${AHORA}`)).sort(), ['features', 'sloth-state.json'])
  rmSync(d, { recursive: true })
})

test('archivos de una versión futura se copian sin tocarlos', () => {
  const d = raiz()
  const futuro = '{"version":99,"accounts":[],"workspaces":[],"openPanes":[],"campoNuevo":{"x":1}}'
  escribir(d, 'sloth-state.json', futuro)
  escribir(d, 'features/settings.json', '{"version":42,"algo":"que esta versión no conoce"}')
  iniciarPerfilesFs(d, ahora)
  assert.equal(readFileSync(join(d, 'perfiles', 'principal', 'sloth-state.json'), 'utf8'), futuro)
  assert.equal(readFileSync(join(d, 'perfiles', 'principal', 'features', 'settings.json'), 'utf8'), '{"version":42,"algo":"que esta versión no conoce"}')
  assert.equal(readFileSync(join(d, 'sloth-state.json'), 'utf8'), futuro)
  rmSync(d, { recursive: true })
})

test('la segunda vez no copia ni reescribe nada', () => {
  const d = raiz()
  sembrar(d)
  iniciarPerfilesFs(d, ahora)
  const mtime = statSync(rutasPerfiles(d).indice).mtimeMs
  escribir(d, 'features/settings.json', '{"cambio":"en la raíz después de migrar"}')
  const r = iniciarPerfilesFs(d, () => AHORA + 1000)
  assert.equal(r.migrado, false)
  assert.equal(r.reconstruido, false)
  assert.equal(r.error, undefined)
  assert.equal(statSync(rutasPerfiles(d).indice).mtimeMs, mtime)
  assert.notEqual(readFileSync(join(d, 'perfiles', 'principal', 'features', 'settings.json'), 'utf8'), '{"cambio":"en la raíz después de migrar"}')
  assert.deepEqual(respaldosPrevios(d), [`pre-perfiles-${AHORA}`])
  rmSync(d, { recursive: true })
})

test('corte de luz con la copia a medias: se descarta el tmp y se rearma bien', () => {
  const d = raiz()
  sembrar(d)
  escribir(d, 'perfiles/.principal.tmp/features/settings.json', 'basura a medio copiar')
  escribir(d, 'respaldos/.pre-perfiles-1.tmp/sloth-state.json', 'respaldo a medias')
  const r = iniciarPerfilesFs(d, ahora)
  assert.equal(r.error, undefined)
  assert.equal(r.migrado, true)
  assert.equal(existsSync(join(d, 'perfiles', '.principal.tmp')), false)
  assert.equal(existsSync(join(d, 'respaldos', '.pre-perfiles-1.tmp')), false)
  assert.deepEqual(foto(join(d, 'perfiles', 'principal'), ['features']), foto(d, ['features']))
  rmSync(d, { recursive: true })
})

test('una copia que se corta a mitad de camino no deja índice ni perfil, y el reintento sale bien', () => {
  const d = raiz()
  sembrar(d)
  const antes = foto(d, ORIGINALES)
  const r = conFsRoto(['cpSync'], (destino) => destino.includes('.principal.tmp') && destino.endsWith('features'), () => iniciarPerfilesFs(d, ahora))
  assert.match(r.error ?? '', /EROFS/)
  assert.equal(existsSync(rutasPerfiles(d).indice), false)
  assert.equal(existsSync(join(d, 'perfiles', 'principal')), false)
  assert.equal(existsSync(join(d, 'perfiles', '.principal.tmp')), false)
  assert.deepEqual(foto(d, ORIGINALES), antes)
  assert.equal(r.indice.activo, 'principal')
  const otra = iniciarPerfilesFs(d, () => AHORA + 5)
  assert.equal(otra.error, undefined)
  assert.equal(otra.migrado, true)
  assert.deepEqual(respaldosPrevios(d), [`pre-perfiles-${AHORA}`])
  rmSync(d, { recursive: true })
})

test('perfil ya migrado pero sin índice (corte antes de escribirlo): solo escribe el índice', () => {
  const d = raiz()
  sembrar(d)
  iniciarPerfilesFs(d, ahora)
  rmSync(rutasPerfiles(d).indice)
  escribir(d, 'features/settings.json', '{"cambio":"no tiene que copiarse"}')
  const r = iniciarPerfilesFs(d, () => AHORA + 1000)
  assert.equal(r.reconstruido, true)
  assert.equal(r.migrado, false)
  assert.deepEqual(validarIndice(leerIndice(d)), r.indice)
  assert.deepEqual(respaldosPrevios(d), [`pre-perfiles-${AHORA}`])
  assert.notEqual(readFileSync(join(d, 'perfiles', 'principal', 'features', 'settings.json'), 'utf8'), '{"cambio":"no tiene que copiarse"}')
  rmSync(d, { recursive: true })
})

test('índice corrupto con carpetas válidas: se aparta y se rearma', () => {
  const d = raiz()
  sembrar(d)
  iniciarPerfilesFs(d, ahora)
  escribir(d, 'perfiles/p-otro/perfil.json', JSON.stringify({ id: 'p-otro', nombre: 'Otro', creado: AHORA + 10 }))
  writeFileSync(rutasPerfiles(d).indice, '{ roto')
  const r = iniciarPerfilesFs(d, ahora)
  assert.equal(r.reconstruido, true)
  assert.equal(r.error, undefined)
  assert.deepEqual(r.indice.perfiles.map((p) => p.id), ['principal', 'p-otro'])
  assert.equal(r.indice.activo, 'principal')
  assert.ok(readdirSync(d).some((n) => n.startsWith('perfiles.json.corrupt-')))
  assert.deepEqual(validarIndice(leerIndice(d)), r.indice)
  rmSync(d, { recursive: true })
})

test('índice sano que apunta a un perfil que ya no está: se respalda y se rearma con los que quedan', () => {
  const d = raiz()
  iniciarPerfilesFs(d, ahora)
  escribir(d, 'perfiles/p-otro/perfil.json', JSON.stringify({ id: 'p-otro', nombre: 'Otro', creado: AHORA + 10 }))
  writeFileSync(rutasPerfiles(d).indice, JSON.stringify({ version: 1, activo: 'p-borrado', perfiles: [{ id: 'p-borrado', nombre: 'X', creado: 1 }] }))
  const r = iniciarPerfilesFs(d, ahora)
  assert.equal(r.reconstruido, true)
  assert.equal(r.indice.activo, 'principal')
  assert.ok(readdirSync(d).some((n) => n.startsWith('perfiles.json.bak-')))
  rmSync(d, { recursive: true })
})

test('arranque limpio: perfil vacío con su perfil.json, sin respaldo', () => {
  const d = raiz()
  const r = iniciarPerfilesFs(d, ahora)
  assert.equal(r.error, undefined)
  assert.equal(r.migrado, true)
  assert.deepEqual(readdirSync(join(d, 'perfiles', 'principal')), ['perfil.json'])
  assert.deepEqual(respaldosPrevios(d), [])
  assert.deepEqual(validarIndice(leerIndice(d)), r.indice)
  rmSync(d, { recursive: true })
})

test('raíz que todavía no existe: se crea y queda el perfil vacío', () => {
  const d = join(raiz(), 'no-existe')
  const r = iniciarPerfilesFs(d, ahora)
  assert.equal(r.error, undefined)
  assert.equal(existsSync(join(d, 'perfiles', 'principal', 'perfil.json')), true)
  rmSync(join(d, '..'), { recursive: true })
})

test('si "perfiles" es un archivo la copia falla: error, sin índice y raíz intacta', () => {
  const d = raiz()
  sembrar(d)
  writeFileSync(join(d, 'perfiles'), 'no soy una carpeta')
  const antes = foto(d, [...ORIGINALES, 'perfiles'])
  const r = iniciarPerfilesFs(d, ahora)
  assert.ok(r.error)
  assert.equal(existsSync(rutasPerfiles(d).indice), false)
  assert.deepEqual(foto(d, [...ORIGINALES, 'perfiles']), antes)
  rmSync(d, { recursive: true })
})

test('disco de solo lectura: error, nada escrito y raíz intacta', () => {
  const d = raiz()
  sembrar(d)
  const antes = foto(d, ORIGINALES)
  const dentro = (p: string): boolean => resolve(p).toLowerCase().startsWith(resolve(d).toLowerCase())
  const r = conFsRoto(['cpSync', 'mkdirSync', 'renameSync', 'openSync'], dentro, () => iniciarPerfilesFs(d, ahora))
  assert.match(r.error ?? '', /EROFS/)
  assert.deepEqual(readdirSync(d).sort(), [...ORIGINALES].sort())
  assert.deepEqual(foto(d, ORIGINALES), antes)
  rmSync(d, { recursive: true })
})

test('una carpeta ajena con el nombre del perfil inicial no se pisa', () => {
  const d = raiz()
  sembrar(d)
  escribir(d, 'perfiles/principal/mio.txt', 'algo que puso el usuario')
  const r = iniciarPerfilesFs(d, ahora)
  assert.ok(r.error)
  assert.equal(readFileSync(join(d, 'perfiles', 'principal', 'mio.txt'), 'utf8'), 'algo que puso el usuario')
  assert.equal(existsSync(rutasPerfiles(d).indice), false)
  rmSync(d, { recursive: true })
})

test('carpetas con nombres peligrosos o con perfil.json que dice ser otra no cuentan como perfiles', () => {
  const d = raiz()
  iniciarPerfilesFs(d, ahora)
  rmSync(rutasPerfiles(d).indice)
  escribir(d, 'perfiles/Mayus/perfil.json', JSON.stringify({ id: 'Mayus', nombre: 'X', creado: 1 }))
  escribir(d, 'perfiles/con/perfil.json', JSON.stringify({ id: 'con', nombre: 'X', creado: 1 }))
  escribir(d, 'perfiles/p-a/perfil.json', JSON.stringify({ id: '../../accounts', nombre: 'X', creado: 1 }))
  escribir(d, 'perfiles/p-b/perfil.json', JSON.stringify({ id: 'principal', nombre: 'Copia', creado: 1 }))
  escribir(d, 'perfiles/p-c/perfil.json', JSON.stringify({ id: 'p-c', nombre: 'mal‮nombre', creado: 1 }))
  escribir(d, 'perfiles/p-d/perfil.json', JSON.stringify({ id: 'p-d', nombre: 'Ñandú 🦥', creado: AHORA + 1 }))
  const r = iniciarPerfilesFs(d, ahora)
  assert.equal(r.error, undefined)
  assert.deepEqual(r.indice.perfiles.map((p) => p.id), ['principal', 'p-d'])
  assert.equal(r.indice.perfiles[1]?.nombre, 'Ñandú 🦥')
  rmSync(d, { recursive: true })
})

test('restos que no se pueden borrar no frenan el arranque: van como aviso', () => {
  const d = raiz()
  iniciarPerfilesFs(d, ahora)
  escribir(d, 'perfiles/.principal.tmp/x', 'resto')
  const m = mock.method(fs, 'rmSync', () => {
    throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
  })
  syncBuiltinESMExports()
  let r: ResultadoArranque
  try {
    r = iniciarPerfilesFs(d, ahora)
  } finally {
    m.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(r.error, undefined)
  assert.match(r.aviso ?? '', /EBUSY/)
  rmSync(d, { recursive: true })
})
