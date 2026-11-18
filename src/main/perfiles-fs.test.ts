import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import {
  borrarPerfilFs,
  cambiarActivoFs,
  crearPerfilFs,
  guardarFoto,
  guardarGhLogin,
  iniciarPerfilesFs,
  leerFotoDataUrl,
  leerIndiceVigente,
  leerMeta,
  MAX_BYTES_FOTO,
  prepararCambioFs,
  renombrarPerfilFs,
  rutasPerfiles,
  tieneFoto,
  type ResultadoArranque
} from './perfiles-fs'
import { validarIndice, type IndicePerfiles } from './perfiles-core'

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

const azarFijo = (...ids: string[]): (() => string) => {
  let i = 0
  return () => ids[i++] ?? `x${i++}`
}

function conPrincipal(): string {
  const d = raiz()
  escribir(d, 'sloth-state.json', JSON.stringify({ version: 1, accounts: [], workspaces: [], openPanes: [] }))
  escribir(d, 'features/settings.json', '{"version":1}')
  assert.equal(iniciarPerfilesFs(d, ahora).error, undefined)
  return d
}

const indiceDe = (d: string): IndicePerfiles => {
  const i = validarIndice(JSON.parse(readFileSync(join(d, 'perfiles.json'), 'utf8')))
  assert.ok(i)
  return i
}

const PNG_MIN = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)])

test('crear: carpeta con perfil.json y features vacío, índice actualizado, el activo no cambia', () => {
  const d = conPrincipal()
  const p = crearPerfilFs(d, '  Trabajo  ', AHORA + 5, azarFijo('abc123'))
  assert.deepEqual(p, { id: 'p-abc123', nombre: 'Trabajo', creado: AHORA + 5 })
  assert.deepEqual(leerMeta(join(d, 'perfiles', 'p-abc123')), p)
  assert.deepEqual(readdirSync(join(d, 'perfiles', 'p-abc123', 'features')), [])
  const i = indiceDe(d)
  assert.equal(i.activo, 'principal')
  assert.deepEqual(i.perfiles.map((x) => x.id), ['principal', 'p-abc123'])
  assert.deepEqual(readdirSync(join(d, 'perfiles')).filter((n) => n.startsWith('.')), [])
  rmSync(d, { recursive: true })
})

test('crear: nombre repetido con otras mayúsculas, vacío, largo o con control se rechaza sin tocar nada', () => {
  const d = conPrincipal()
  const antes = readFileSync(join(d, 'perfiles.json'), 'utf8')
  for (const n of ['MI PERFIL', 'mi perfil', '', '   ', 'x'.repeat(41), 'a\nb', 'a\u0000b', 'a\u202eb', 7, null]) {
    assert.throws(() => crearPerfilFs(d, n, AHORA, azarFijo('zzz')), Error, String(n))
  }
  assert.equal(readFileSync(join(d, 'perfiles.json'), 'utf8'), antes)
  assert.deepEqual(readdirSync(join(d, 'perfiles')), ['principal'])
  rmSync(d, { recursive: true })
})

test('crear: si el id al azar ya existe como carpeta usa otro', () => {
  const d = conPrincipal()
  mkdirSync(join(d, 'perfiles', 'p-uno'))
  const p = crearPerfilFs(d, 'Otro', AHORA, azarFijo('uno', 'dos'))
  assert.equal(p.id, 'p-dos')
  rmSync(d, { recursive: true })
})

test('crear: si no se puede escribir el índice la carpeta nueva se saca y el índice queda como estaba', () => {
  const d = conPrincipal()
  const antes = readFileSync(join(d, 'perfiles.json'), 'utf8')
  const real = fs.renameSync
  const m = mock.method(fs, 'renameSync', (de: string, a: string) => {
    if (String(a).endsWith('perfiles.json')) throw Object.assign(new Error('EROFS'), { code: 'EROFS' })
    return real(de, a)
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => crearPerfilFs(d, 'Nuevo', AHORA, azarFijo('nnn')))
  } finally {
    m.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(readFileSync(join(d, 'perfiles.json'), 'utf8'), antes)
  assert.equal(existsSync(join(d, 'perfiles', 'p-nnn')), false)
  rmSync(d, { recursive: true })
})

test('renombrar: actualiza perfil.json y el índice; rechaza repetido y nombres malos', () => {
  const d = conPrincipal()
  const p = crearPerfilFs(d, 'Trabajo', AHORA, azarFijo('t1'))
  const r = renombrarPerfilFs(d, p.id, 'Casa')
  assert.equal(r.nombre, 'Casa')
  assert.equal(leerMeta(join(d, 'perfiles', p.id))?.nombre, 'Casa')
  assert.equal(indiceDe(d).perfiles.find((x) => x.id === p.id)?.nombre, 'Casa')
  assert.throws(() => renombrarPerfilFs(d, p.id, 'mi PERFIL'), /Ya hay/)
  assert.throws(() => renombrarPerfilFs(d, p.id, 'a\u200bb'))
  assert.equal(renombrarPerfilFs(d, p.id, 'CASA').nombre, 'CASA')
  rmSync(d, { recursive: true })
})

test('cambiar activo: solo toca `activo` del índice y exige un perfil existente', () => {
  const d = conPrincipal()
  const p = crearPerfilFs(d, 'Trabajo', AHORA, azarFijo('t1'))
  const antes = indiceDe(d)
  cambiarActivoFs(d, p.id)
  assert.deepEqual(indiceDe(d), { ...antes, activo: p.id })
  assert.throws(() => cambiarActivoFs(d, 'p-fantasma'), /no existe/)
  assert.equal(indiceDe(d).activo, p.id)
  rmSync(d, { recursive: true })
})

test('borrar: mueve a respaldos con su contenido, saca el perfil del índice y no pisa un respaldo previo', () => {
  const d = conPrincipal()
  const p = crearPerfilFs(d, 'Trabajo', AHORA, azarFijo('t1'))
  escribir(d, `perfiles/${p.id}/features/notas.json`, '{"clave":"valor"}')
  escribir(d, `perfiles/${p.id}/sloth-state.json`, '{"version":1}')
  mkdirSync(join(d, 'respaldos', `perfil-${p.id}-${AHORA}`), { recursive: true })
  const destino = borrarPerfilFs(d, p.id, AHORA)
  assert.equal(destino, join(d, 'respaldos', `perfil-${p.id}-${AHORA}-1`))
  assert.equal(readFileSync(join(destino, 'features', 'notas.json'), 'utf8'), '{"clave":"valor"}')
  assert.deepEqual(leerMeta(destino), p)
  assert.equal(existsSync(join(d, 'perfiles', p.id)), false)
  assert.deepEqual(indiceDe(d).perfiles.map((x) => x.id), ['principal'])
  rmSync(d, { recursive: true })
})

test('borrar: no el activo, no el último, no uno que no existe', () => {
  const d = conPrincipal()
  assert.throws(() => borrarPerfilFs(d, 'principal', AHORA), /activo/)
  const p = crearPerfilFs(d, 'Trabajo', AHORA, azarFijo('t1'))
  cambiarActivoFs(d, p.id)
  assert.throws(() => borrarPerfilFs(d, p.id, AHORA), /activo/)
  assert.throws(() => borrarPerfilFs(d, 'p-fantasma', AHORA), /no existe/)
  assert.deepEqual(readdirSync(join(d, 'respaldos')).filter((n) => n.startsWith('perfil-')), [])
  assert.equal(existsSync(join(d, 'perfiles', p.id, 'perfil.json')), true)
  borrarPerfilFs(d, 'principal', AHORA)
  assert.throws(() => borrarPerfilFs(d, p.id, AHORA), /activo|último/)
  rmSync(d, { recursive: true })
})

test('borrar: si el índice no se puede escribir el perfil vuelve a su lugar', () => {
  const d = conPrincipal()
  const p = crearPerfilFs(d, 'Trabajo', AHORA, azarFijo('t1'))
  escribir(d, `perfiles/${p.id}/features/notas.json`, 'datos')
  const real = fs.renameSync
  const m = mock.method(fs, 'renameSync', (de: string, a: string) => {
    if (String(a).endsWith('perfiles.json')) throw Object.assign(new Error('EROFS'), { code: 'EROFS' })
    return real(de, a)
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => borrarPerfilFs(d, p.id, AHORA))
  } finally {
    m.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(readFileSync(join(d, 'perfiles', p.id, 'features', 'notas.json'), 'utf8'), 'datos')
  assert.deepEqual(indiceDe(d).perfiles.map((x) => x.id), ['principal', p.id])
  rmSync(d, { recursive: true })
})

test('borrar: si el rename cruza de disco (EXDEV) copia, verifica y recién ahí borra el origen', () => {
  const d = conPrincipal()
  const p = crearPerfilFs(d, 'Trabajo', AHORA, azarFijo('t1'))
  escribir(d, `perfiles/${p.id}/features/notas.json`, 'datos importantes')
  const real = fs.renameSync
  const m = mock.method(fs, 'renameSync', (de: string, a: string) => {
    if (String(de).endsWith(p.id) && String(a).includes('respaldos')) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' })
    return real(de, a)
  })
  syncBuiltinESMExports()
  let destino: string
  try {
    destino = borrarPerfilFs(d, p.id, AHORA)
  } finally {
    m.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(readFileSync(join(destino, 'features', 'notas.json'), 'utf8'), 'datos importantes')
  assert.equal(existsSync(join(d, 'perfiles', p.id)), false)
  rmSync(d, { recursive: true })
})

test('ids con ../, mayúsculas, rutas absolutas o nombres reservados se rechazan en todas las operaciones', () => {
  const d = conPrincipal()
  crearPerfilFs(d, 'Trabajo', AHORA, azarFijo('t1'))
  const sentinela = join(d, 'sentinela')
  mkdirSync(sentinela)
  for (const id of ['../sentinela', '..', '../..', 'principal/../../sentinela', 'Principal', 'con', 'nul', 'C:\\Windows', '/etc', '', 7, null, undefined, 'p-t1/../principal']) {
    assert.throws(() => renombrarPerfilFs(d, id, 'X'), Error, String(id))
    assert.throws(() => cambiarActivoFs(d, id), Error, String(id))
    assert.throws(() => borrarPerfilFs(d, id, AHORA), Error, String(id))
    assert.throws(() => guardarFoto(d, id, PNG_MIN), Error, String(id))
    assert.throws(() => leerFotoDataUrl(d, id), Error, String(id))
    assert.throws(() => guardarGhLogin(d, id, 'octo'), Error, String(id))
  }
  assert.equal(existsSync(sentinela), true)
  assert.deepEqual(readdirSync(join(d, 'respaldos')).filter((n) => n.startsWith('perfil-')), [])
  assert.equal(tieneFoto(d, '../sentinela'), false)
  rmSync(d, { recursive: true })
})

test('foto: guarda PNG, JPEG y WebP, devuelve data URL y rechaza lo que no es imagen o pesa de más', () => {
  const d = conPrincipal()
  assert.equal(tieneFoto(d, 'principal'), false)
  assert.equal(leerFotoDataUrl(d, 'principal'), null)
  guardarFoto(d, 'principal', PNG_MIN)
  assert.equal(tieneFoto(d, 'principal'), true)
  assert.equal(leerFotoDataUrl(d, 'principal'), `data:image/png;base64,${PNG_MIN.toString('base64')}`)
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)])
  guardarFoto(d, 'principal', jpeg)
  assert.match(leerFotoDataUrl(d, 'principal') ?? '', /^data:image\/jpeg;base64,/)
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)])
  guardarFoto(d, 'principal', webp)
  assert.match(leerFotoDataUrl(d, 'principal') ?? '', /^data:image\/webp;base64,/)
  const previa = leerFotoDataUrl(d, 'principal')
  assert.throws(() => guardarFoto(d, 'principal', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), /PNG, JPEG o WebP/)
  assert.throws(() => guardarFoto(d, 'principal', Buffer.from('MZ\u0090\u0000 no soy una imagen')), /PNG, JPEG o WebP/)
  assert.throws(() => guardarFoto(d, 'principal', Buffer.alloc(0)), /512 KB/)
  assert.throws(() => guardarFoto(d, 'principal', Buffer.concat([PNG_MIN, Buffer.alloc(MAX_BYTES_FOTO)])), /512 KB/)
  assert.equal(leerFotoDataUrl(d, 'principal'), previa)
  assert.deepEqual(readdirSync(join(d, 'perfiles', 'principal')).filter((n) => n.endsWith('.tmp')), [])
  rmSync(d, { recursive: true })
})

test('foto: un archivo foto.png alterado a mano (no es imagen o es enorme) no se devuelve', () => {
  const d = conPrincipal()
  escribir(d, 'perfiles/principal/foto.png', 'texto plano')
  assert.equal(leerFotoDataUrl(d, 'principal'), null)
  escribir(d, 'perfiles/principal/foto.png', Buffer.concat([PNG_MIN, Buffer.alloc(MAX_BYTES_FOTO)]))
  assert.equal(leerFotoDataUrl(d, 'principal'), null)
  rmSync(d, { recursive: true })
})

test('guardarGhLogin valida el login y lo deja en perfil.json y en el índice', () => {
  const d = conPrincipal()
  assert.throws(() => guardarGhLogin(d, 'principal', 'con espacio'), /inválido/)
  assert.throws(() => guardarGhLogin(d, 'principal', '../x'), /inválido/)
  guardarGhLogin(d, 'principal', 'octo-cat')
  assert.equal(leerMeta(join(d, 'perfiles', 'principal'))?.ghLogin, 'octo-cat')
  assert.equal(indiceDe(d).perfiles[0]?.ghLogin, 'octo-cat')
  rmSync(d, { recursive: true })
})

/** Un archivo que el antivirus o el indexador de Windows tiene tomado: existe pero no se puede leer. */
function conArchivoTomado<T>(ruta: (r: string) => boolean, fn: () => T): T {
  const original = fs.readFileSync as (...a: unknown[]) => unknown
  const m = mock.method(fs, 'readFileSync', (...a: unknown[]) => {
    if (ruta(String(a[0]).replaceAll('\\', '/'))) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    return original.apply(fs, a)
  })
  syncBuiltinESMExports()
  try {
    return fn()
  } finally {
    m.mock.restore()
    syncBuiltinESMExports()
  }
}

function sinListarPerfiles<T>(fn: () => T): T {
  const original = fs.readdirSync as (...a: unknown[]) => unknown
  const m = mock.method(fs, 'readdirSync', (...a: unknown[]) => {
    if (String(a[0]).replaceAll('\\', '/').endsWith('/perfiles')) throw Object.assign(new Error('EPERM: operation not permitted, scandir'), { code: 'EPERM' })
    return original.apply(fs, a)
  })
  syncBuiltinESMExports()
  try {
    return fn()
  } finally {
    m.mock.restore()
    syncBuiltinESMExports()
  }
}

const sinTmpNiCorrupt = (d: string): void => {
  assert.deepEqual(readdirSync(d).filter((n) => n.includes('.corrupt-')), [])
  assert.deepEqual(readdirSync(join(d, 'perfiles')).filter((n) => n.startsWith('.') || n.includes('.corrupt-')), [])
}

test('perfil.json de principal ilegible con el índice sano: no migra de nuevo, no cae a la raíz y no toca nada', () => {
  const d = raiz()
  sembrar(d)
  assert.equal(iniciarPerfilesFs(d, ahora).error, undefined)
  escribir(d, 'sloth-state.json', '{"cambio":"en la raíz congelada"}')
  escribir(d, 'perfiles/principal/features/nuevo.json', 'lo que se hizo con perfiles')
  const antes = foto(d)
  const r = conArchivoTomado((f) => f.endsWith('perfiles/principal/perfil.json'), () => iniciarPerfilesFs(d, () => AHORA + 99))
  assert.match(r.bloqueado ?? '', /perfiles\/principal.*EBUSY/)
  assert.equal(r.error, undefined)
  assert.equal(r.migrado, false)
  assert.deepEqual(foto(d), antes)
  assert.deepEqual(respaldosPrevios(d), [`pre-perfiles-${AHORA}`])
  sinTmpNiCorrupt(d)
  const despues = iniciarPerfilesFs(d, () => AHORA + 100)
  assert.equal(despues.bloqueado, undefined)
  assert.equal(despues.indice.activo, 'principal')
  assert.equal(readFileSync(join(d, 'perfiles', 'principal', 'features', 'nuevo.json'), 'utf8'), 'lo que se hizo con perfiles')
  rmSync(d, { recursive: true })
})

test('perfil.json ilegible sin perfiles.json: tampoco migra de nuevo sobre el perfil que ya está', () => {
  const d = raiz()
  sembrar(d)
  iniciarPerfilesFs(d, ahora)
  rmSync(rutasPerfiles(d).indice)
  const antes = foto(d)
  const r = conArchivoTomado((f) => f.endsWith('perfiles/principal/perfil.json'), () => iniciarPerfilesFs(d, () => AHORA + 99))
  assert.match(r.bloqueado ?? '', /perfiles\/principal/)
  assert.deepEqual(foto(d), antes)
  assert.equal(existsSync(rutasPerfiles(d).indice), false)
  rmSync(d, { recursive: true })
})

test('perfil.json roto en el único perfil: se avisa y queda donde estaba, sin apartarlo como .corrupt ni migrar', () => {
  const d = raiz()
  sembrar(d)
  iniciarPerfilesFs(d, ahora)
  writeFileSync(join(d, 'perfiles', 'principal', 'perfil.json'), '{ roto')
  const antes = foto(d)
  const r = iniciarPerfilesFs(d, () => AHORA + 99)
  assert.match(r.bloqueado ?? '', /perfiles\/principal/)
  assert.equal(r.migrado, false)
  assert.deepEqual(foto(d), antes)
  sinTmpNiCorrupt(d)
  rmSync(d, { recursive: true })
})

test('el perfil activo ilegible con otro sano: no se cambia de perfil a escondidas ni se reescribe el índice', () => {
  const d = conPrincipal()
  const p = crearPerfilFs(d, 'Trabajo', AHORA + 1, azarFijo('t1'))
  cambiarActivoFs(d, p.id)
  const antes = foto(d)
  const r = conArchivoTomado((f) => f.endsWith(`perfiles/${p.id}/perfil.json`), () => iniciarPerfilesFs(d, () => AHORA + 99))
  assert.match(r.bloqueado ?? '', new RegExp(p.id))
  assert.deepEqual(foto(d), antes)
  rmSync(d, { recursive: true })
})

test('un perfil que hoy no se puede leer no se saca del índice: se usa el rearmado en memoria sin guardarlo', () => {
  const d = conPrincipal()
  const p = crearPerfilFs(d, 'Trabajo', AHORA + 1, azarFijo('t1'))
  rmSync(rutasPerfiles(d).indice)
  const r = conArchivoTomado((f) => f.endsWith(`perfiles/${p.id}/perfil.json`), () => iniciarPerfilesFs(d, () => AHORA + 99))
  assert.equal(r.bloqueado, undefined)
  assert.equal(r.reconstruido, true)
  assert.deepEqual(r.indice.perfiles.map((x) => x.id), ['principal'])
  assert.match(r.avisoUsuario ?? '', new RegExp(p.id))
  assert.equal(existsSync(rutasPerfiles(d).indice), false)
  const sano = iniciarPerfilesFs(d, () => AHORA + 100)
  assert.deepEqual(sano.indice.perfiles.map((x) => x.id), ['principal', p.id])
  rmSync(d, { recursive: true })
})

test('si listar perfiles/ falla con perfiles creados no se cae a la raíz ni se migra', () => {
  const d = conPrincipal()
  rmSync(rutasPerfiles(d).indice)
  const antes = foto(d)
  const r = sinListarPerfiles(() => iniciarPerfilesFs(d, () => AHORA + 99))
  assert.match(r.bloqueado ?? '', /EPERM/)
  assert.equal(r.error, undefined)
  assert.deepEqual(foto(d), antes)
  rmSync(d, { recursive: true })
})

test('con el índice sano y principal sano un fallo al listar perfiles/ ni se nota', () => {
  const d = conPrincipal()
  const r = sinListarPerfiles(() => iniciarPerfilesFs(d, () => AHORA + 99))
  assert.equal(r.bloqueado, undefined)
  assert.equal(r.error, undefined)
  assert.equal(r.indice.activo, 'principal')
  rmSync(d, { recursive: true })
})

test('el índice apunta a perfiles pero perfiles/ no tiene ninguno: se avisa, no se vuelve a migrar la raíz congelada', () => {
  const d = conPrincipal()
  rmSync(join(d, 'perfiles'), { recursive: true })
  const antes = foto(d)
  const r = iniciarPerfilesFs(d, () => AHORA + 99)
  assert.match(r.bloqueado ?? '', /sus carpetas/)
  assert.deepEqual(foto(d), antes)
  assert.equal(existsSync(join(d, 'perfiles')), false)
  rmSync(d, { recursive: true })
})

test('si falla guardar el índice justo después de migrar se sigue con el perfil principal, no con la raíz', () => {
  const d = raiz()
  sembrar(d)
  const r = conFsRoto(['openSync'], (destino) => destino.includes('perfiles.json'), () => iniciarPerfilesFs(d, ahora))
  assert.equal(r.error, undefined)
  assert.equal(r.bloqueado, undefined)
  assert.equal(r.migrado, true)
  assert.equal(r.indice.activo, 'principal')
  assert.match(r.avisoUsuario ?? '', /perfiles\.json/)
  assert.equal(existsSync(join(d, 'perfiles', 'principal', 'perfil.json')), true)
  const otra = iniciarPerfilesFs(d, () => AHORA + 5)
  assert.equal(otra.reconstruido, true)
  assert.equal(otra.migrado, false)
  assert.deepEqual(respaldosPrevios(d), [`pre-perfiles-${AHORA}`])
  rmSync(d, { recursive: true })
})

test('perfiles.json de una versión futura: no se aparta ni se reescribe y se sigue con los perfiles en memoria', () => {
  const d = conPrincipal()
  const futuro = JSON.stringify({ version: 2, activo: 'principal', perfiles: [{ id: 'principal', nombre: { es: 'Mi perfil' }, creado: 1 }], extra: true })
  writeFileSync(rutasPerfiles(d).indice, futuro)
  const r = iniciarPerfilesFs(d, () => AHORA + 99)
  assert.equal(r.bloqueado, undefined)
  assert.equal(r.reconstruido, true)
  assert.equal(r.indice.activo, 'principal')
  assert.match(r.avisoUsuario ?? '', /más nueva/)
  assert.equal(readFileSync(rutasPerfiles(d).indice, 'utf8'), futuro)
  assert.deepEqual(readdirSync(d).filter((n) => n.startsWith('perfiles.json.')), [])
  assert.throws(() => crearPerfilFs(d, 'Trabajo', AHORA, azarFijo('t1')), /más nueva/)
  assert.throws(() => cambiarActivoFs(d, 'principal'), /más nueva/)
  rmSync(d, { recursive: true })
})

test('perfil.json de una versión futura: no se aparta como .corrupt; si es el único perfil se avisa', () => {
  const d = conPrincipal()
  const futuro = JSON.stringify({ version: 2, id: 'principal', nombre: 'Mi perfil', creado: 1, campoNuevo: [1, 2] })
  writeFileSync(join(d, 'perfiles', 'principal', 'perfil.json'), futuro)
  const r = iniciarPerfilesFs(d, () => AHORA + 99)
  assert.match(r.bloqueado ?? '', /más nueva/)
  assert.equal(readFileSync(join(d, 'perfiles', 'principal', 'perfil.json'), 'utf8'), futuro)
  sinTmpNiCorrupt(d)
  rmSync(d, { recursive: true })
})

test('perfil.json futuro de un perfil que no es el activo: queda como está y el índice guardado no lo deja afuera', () => {
  const d = conPrincipal()
  const p = crearPerfilFs(d, 'Trabajo', AHORA + 1, azarFijo('t1'))
  const futuro = JSON.stringify({ version: 2, id: p.id, nombre: 'Trabajo', creado: AHORA + 1 })
  writeFileSync(join(d, 'perfiles', p.id, 'perfil.json'), futuro)
  const indiceAntes = readFileSync(rutasPerfiles(d).indice, 'utf8')
  const r = iniciarPerfilesFs(d, () => AHORA + 99)
  assert.equal(r.bloqueado, undefined)
  assert.equal(r.indice.activo, 'principal')
  assert.equal(readFileSync(join(d, 'perfiles', p.id, 'perfil.json'), 'utf8'), futuro)
  assert.equal(readFileSync(rutasPerfiles(d).indice, 'utf8'), indiceAntes)
  sinTmpNiCorrupt(d)
  rmSync(d, { recursive: true })
})

test('candado: con otra copia migrando no se migra ni se toca nada', () => {
  const d = raiz()
  sembrar(d)
  writeFileSync(rutasPerfiles(d).candado, JSON.stringify({ pid: process.pid, desde: Date.now() }))
  const antes = foto(d)
  const r = iniciarPerfilesFs(d, ahora)
  assert.match(r.bloqueado ?? '', /Otra copia de Sloth/)
  assert.equal(r.error, undefined)
  assert.deepEqual(foto(d), antes)
  assert.equal(existsSync(join(d, 'perfiles')), false)
  assert.equal(existsSync(join(d, 'respaldos')), false)
  rmSync(d, { recursive: true })
})

test('candado: uno abandonado (vencido) no frena la migración y no queda ninguno al terminar', () => {
  const d = raiz()
  sembrar(d)
  writeFileSync(rutasPerfiles(d).candado, JSON.stringify({ pid: process.pid, desde: 1000 }))
  const r = iniciarPerfilesFs(d, ahora)
  assert.equal(r.migrado, true)
  assert.equal(r.bloqueado, undefined)
  assert.equal(existsSync(rutasPerfiles(d).candado), false)
  iniciarPerfilesFs(d, () => AHORA + 1)
  assert.equal(existsSync(rutasPerfiles(d).candado), false)
  rmSync(d, { recursive: true })
})

test('candado: con el arranque normal otra copia migrando no impide arrancar, pero no se barren sus tmp', () => {
  const d = conPrincipal()
  escribir(d, 'perfiles/.tmp-p-otra/x', 'crear de otra copia en curso')
  writeFileSync(rutasPerfiles(d).candado, JSON.stringify({ pid: process.pid, desde: Date.now() }))
  const r = iniciarPerfilesFs(d, () => AHORA + 99)
  assert.equal(r.bloqueado, undefined)
  assert.equal(existsSync(join(d, 'perfiles', '.tmp-p-otra', 'x')), true)
  rmSync(d, { recursive: true })
})

test('enlaces (junction o symlink) dentro de features no se siguen: ni la copia ni el respaldo apuntan a la raíz', () => {
  const d = raiz()
  const afuera = raiz()
  escribir(d, 'sloth-state.json', '{"version":1,"accounts":[],"workspaces":[],"openPanes":[]}')
  escribir(d, 'features/settings.json', '{"version":1}')
  escribir(afuera, 'secreto.txt', 'no es de features')
  symlinkSync(afuera, join(d, 'features', 'enlace'), 'junction')
  const r = iniciarPerfilesFs(d, ahora)
  assert.equal(r.error, undefined)
  assert.equal(r.migrado, true)
  assert.match(r.avisoUsuario ?? '', /enlace/)
  for (const base of [join(d, 'perfiles', 'principal'), join(d, 'respaldos', `pre-perfiles-${AHORA}`)]) {
    assert.equal(readFileSync(join(base, 'features', 'settings.json'), 'utf8'), '{"version":1}')
    assert.equal(existsSync(join(base, 'features', 'enlace')), false)
  }
  assert.equal(readFileSync(join(afuera, 'secreto.txt'), 'utf8'), 'no es de features')
  assert.equal(lstatSync(join(d, 'features', 'enlace')).isSymbolicLink(), true)
  rmSync(d, { recursive: true })
  rmSync(afuera, { recursive: true })
})

test('features entera como enlace a otra carpeta: no se copia ni se respalda como enlace', () => {
  const d = raiz()
  const otra = raiz()
  escribir(d, 'sloth-state.json', '{"version":1,"accounts":[],"workspaces":[],"openPanes":[]}')
  escribir(otra, 'settings.json', '{"version":1,"de":"otra carpeta"}')
  symlinkSync(otra, join(d, 'features'), 'junction')
  const r = iniciarPerfilesFs(d, ahora)
  assert.equal(r.error, undefined)
  assert.match(r.avisoUsuario ?? '', /enlace/)
  for (const base of [join(d, 'perfiles', 'principal'), join(d, 'respaldos', `pre-perfiles-${AHORA}`)]) {
    assert.equal(existsSync(join(base, 'sloth-state.json')), true)
    assert.equal(existsSync(join(base, 'features')) && lstatSync(join(base, 'features')).isSymbolicLink(), false)
  }
  assert.equal(readFileSync(join(otra, 'settings.json'), 'utf8'), '{"version":1,"de":"otra carpeta"}')
  rmSync(d, { recursive: true })
  rmSync(otra, { recursive: true })
})

test('cambiar: un destino dañado o inexistente se rechaza antes de escribir nada; el cambio solo se aplica al confirmar', () => {
  const d = conPrincipal()
  const p = crearPerfilFs(d, 'Trabajo', AHORA + 1, azarFijo('t1'))
  const antes = readFileSync(rutasPerfiles(d).indice, 'utf8')
  const meta = join(d, 'perfiles', p.id, 'perfil.json')
  const guardado = readFileSync(meta, 'utf8')
  rmSync(meta)
  assert.throws(() => prepararCambioFs(d, p.id), /no está o está dañada/)
  assert.throws(() => prepararCambioFs(d, 'p-fantasma'), /no existe/)
  assert.equal(readFileSync(rutasPerfiles(d).indice, 'utf8'), antes)
  writeFileSync(meta, guardado)
  const aplicar = prepararCambioFs(d, p.id)
  assert.equal(indiceDe(d).activo, 'principal')
  aplicar()
  assert.equal(indiceDe(d).activo, p.id)
  rmSync(d, { recursive: true })
})

test('leerIndiceVigente: null si el índice no se puede leer, para que recargar conserve el anterior', () => {
  const d = conPrincipal()
  assert.equal(leerIndiceVigente(d)?.activo, 'principal')
  writeFileSync(rutasPerfiles(d).indice, '{ roto')
  assert.equal(leerIndiceVigente(d), null)
  assert.equal(readFileSync(rutasPerfiles(d).indice, 'utf8'), '{ roto')
  assert.deepEqual(readdirSync(d).filter((n) => n.includes('.corrupt-')), [])
  rmSync(d, { recursive: true })
})
