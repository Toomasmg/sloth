import { test } from 'node:test'
import assert from 'node:assert/strict'
import { basename, join } from 'node:path'
import { crearAlmacen, type Almacen, type FsTickets } from './almacen'
import { conectorPorId } from './conectores'
import type { TicketsState } from './estado'

const CARPETA = join('C:', 'datos', 'features')
const TICKETS = join(CARPETA, 'tickets.json')
const GRUV = join(CARPETA, 'gruv.json')
const AHORA = 1_700_000_000_000

const GRUV_V1 = JSON.stringify({ version: 1, tickets: [{ id: 'TCK-1', titulo: 'De gruv.json' }], config: { model: 'sonnet' } })
const v2 = (gruvMtimeMs?: number): string =>
  JSON.stringify({
    version: 2,
    tickets: [{ id: 'TCK-9', titulo: 'De tickets.json' }],
    ...(gruvMtimeMs === undefined ? {} : { migradoDe: { archivo: 'gruv.json', en: 1, gruvMtimeMs } }),
    config: { conectorId: 'gruv', model: 'opus', assigneeId: '', projectRepos: {}, confirmRefresh: true }
  })

interface Archivo {
  texto: string
  mtimeMs: number
}

interface Falso {
  fs: FsTickets
  archivos: Map<string, Archivo>
  /** Lo que se hizo en disco, con nombres cortos. */
  ops: string[]
  logs: string[]
}

const error = (code: string): Error => Object.assign(new Error(`${code}: falló`), { code })

function fsFalso(inicial: Record<string, Archivo>, o: { leerFalla?: Record<string, string>; apartarFalla?: boolean; escribirFalla?: string } = {}): Falso {
  const archivos = new Map(Object.entries(inicial))
  const ops: string[] = []
  const fs: FsTickets = {
    leer(r) {
      const c = o.leerFalla?.[r]
      if (c) throw error(c)
      const a = archivos.get(r)
      if (!a) throw error('ENOENT')
      return a.texto
    },
    mtimeMs(r) {
      const a = archivos.get(r)
      if (!a) throw error('ENOENT')
      return a.mtimeMs
    },
    renombrar(de, a) {
      ops.push(`renombrar ${basename(de)} ${basename(a)}`)
      if (o.apartarFalla && de === TICKETS) throw error('EPERM')
      const x = archivos.get(de)
      if (!x) throw error('ENOENT')
      archivos.delete(de)
      archivos.set(a, x)
    },
    escribir(r, datos) {
      ops.push(`escribir ${basename(r)}`)
      if (o.escribirFalla) throw error(o.escribirFalla)
      archivos.set(r, { texto: datos, mtimeMs: AHORA })
    },
    crearCarpeta() {}
  }
  return { fs, archivos, ops, logs: [] }
}

function almacen(f: Falso, ahora = AHORA): Almacen {
  return crearAlmacen({ fs: f.fs, carpeta: CARPETA, buscar: conectorPorId, log: (m) => f.logs.push(m), ahora: () => ahora })
}

const GUARDAR = ['escribir tickets.json.tmp', 'renombrar tickets.json.tmp tickets.json']
const enDisco = (f: Falso): TicketsState => JSON.parse(f.archivos.get(TICKETS)?.texto ?? 'null') as TicketsState

/** gruv.json nunca se escribe ni se mueve. */
function gruvIntacto(f: Falso, texto: string | undefined): void {
  assert.equal(f.archivos.get(GRUV)?.texto, texto)
  assert.ok(!f.ops.some((op) => op.includes('gruv.json')), f.ops.join(' | '))
}

test('sin tickets.json ni gruv.json: vacío, no escribe nada al arrancar y guarda después', () => {
  const f = fsFalso({})
  const a = almacen(f)
  const s = a.cargar()
  assert.deepEqual(s.tickets, [])
  assert.deepEqual(f.ops, [])
  assert.equal(a.aviso(), undefined)
  assert.equal(a.guardar(s), true)
  assert.deepEqual(f.ops, GUARDAR)
  gruvIntacto(f, undefined)
})

test('migración inicial: guarda tickets.json con el mtime de gruv.json', () => {
  const f = fsFalso({ [GRUV]: { texto: GRUV_V1, mtimeMs: 500 } })
  const s = almacen(f).cargar()
  assert.equal(s.tickets[0].id, 'TCK-1')
  assert.deepEqual(f.ops, GUARDAR)
  assert.deepEqual(enDisco(f).migradoDe, { archivo: 'gruv.json', en: AHORA, gruvMtimeMs: 500 })
  gruvIntacto(f, GRUV_V1)
})

test('gruv.json cambió desde la migración: respalda tickets.json como .bak y vuelve a migrar', () => {
  const previo = v2(100)
  const f = fsFalso({ [TICKETS]: { texto: previo, mtimeMs: 900 }, [GRUV]: { texto: GRUV_V1, mtimeMs: 200 } })
  const a = almacen(f)
  const s = a.cargar()
  assert.equal(s.tickets[0].id, 'TCK-1')
  assert.deepEqual(f.ops, [`renombrar tickets.json tickets.json.bak-${AHORA}`, ...GUARDAR])
  assert.equal(f.archivos.get(`${TICKETS}.bak-${AHORA}`)?.texto, previo)
  assert.equal(enDisco(f).migradoDe?.gruvMtimeMs, 200)
  assert.match(a.aviso() ?? '', /Volví a cargar gruv\.json/)
  assert.ok(a.aviso()?.includes(`tickets.json.bak-${AHORA}`))
  gruvIntacto(f, GRUV_V1)
})

test('mismo mtime que el migrado: no vuelve a migrar ni escribe', () => {
  const f = fsFalso({ [TICKETS]: { texto: v2(200), mtimeMs: 100 }, [GRUV]: { texto: GRUV_V1, mtimeMs: 200 } })
  const s = almacen(f).cargar()
  assert.equal(s.tickets[0].id, 'TCK-9')
  assert.deepEqual(f.ops, [])
  gruvIntacto(f, GRUV_V1)
})

test('gruv.json con mtime en el futuro: migra una vez y en los arranques siguientes no', () => {
  const futuro = AHORA + 365 * 24 * 3600 * 1000
  const f = fsFalso({ [TICKETS]: { texto: v2(), mtimeMs: AHORA }, [GRUV]: { texto: GRUV_V1, mtimeMs: futuro } })
  almacen(f).cargar()
  assert.deepEqual(f.ops, [`renombrar tickets.json tickets.json.bak-${AHORA}`, ...GUARDAR])
  for (const ahora of [AHORA + 1, AHORA + 2]) {
    f.ops.length = 0
    assert.equal(almacen(f, ahora).cargar().tickets[0].id, 'TCK-1')
    assert.deepEqual(f.ops, [])
  }
  gruvIntacto(f, GRUV_V1)
})

test('tickets.json corrupto: queda como .corrupt y se migra gruv.json', () => {
  const f = fsFalso({ [TICKETS]: { texto: '{roto', mtimeMs: 1 }, [GRUV]: { texto: GRUV_V1, mtimeMs: 2 } })
  const a = almacen(f)
  assert.equal(a.cargar().tickets[0].id, 'TCK-1')
  assert.deepEqual(f.ops, [`renombrar tickets.json tickets.json.corrupt-${AHORA}`, ...GUARDAR])
  assert.equal(f.archivos.get(`${TICKETS}.corrupt-${AHORA}`)?.texto, '{roto')
  assert.equal(a.aviso(), undefined)
  gruvIntacto(f, GRUV_V1)
})

test('tickets.json corrupto sin gruv.json: se aparta y no se escribe uno vacío al arrancar', () => {
  const f = fsFalso({ [TICKETS]: { texto: '[]', mtimeMs: 1 } })
  almacen(f).cargar()
  assert.deepEqual(f.ops, [`renombrar tickets.json tickets.json.corrupt-${AHORA}`])
})

test('error de lectura (no ENOENT): no respalda ni escribe en toda la sesión', () => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    const f = fsFalso({ [TICKETS]: { texto: v2(), mtimeMs: 1 }, [GRUV]: { texto: GRUV_V1, mtimeMs: 2 } }, { leerFalla: { [TICKETS]: code } })
    const a = almacen(f)
    const s = a.cargar()
    assert.equal(s.tickets[0].id, 'TCK-1', 'trabaja en memoria con gruv.json')
    assert.match(a.aviso() ?? '', /No pude leer tickets\.json.*no se guarda/)
    assert.equal(a.guardar(s), false)
    assert.deepEqual(f.ops, [])
    assert.equal(f.archivos.get(TICKETS)?.texto, v2())
    assert.ok(f.logs.some((l) => l.includes(code)))
    gruvIntacto(f, GRUV_V1)
  }
})

test('error al leer gruv.json: tickets.json manda y no se toca', () => {
  const f = fsFalso({ [TICKETS]: { texto: v2(5), mtimeMs: 1 }, [GRUV]: { texto: GRUV_V1, mtimeMs: 9 } }, { leerFalla: { [GRUV]: 'EBUSY' } })
  const a = almacen(f)
  assert.equal(a.cargar().tickets[0].id, 'TCK-9')
  assert.deepEqual(f.ops, [])
  assert.equal(a.aviso(), undefined)
})

test('sin tickets.json válido y gruv.json ilegible: no guarda en la sesión y migra en el próximo arranque', () => {
  for (const tickets of [{}, { [TICKETS]: { texto: '{roto', mtimeMs: 1 } }]) {
    const f = fsFalso({ ...tickets, [GRUV]: { texto: GRUV_V1, mtimeMs: 500 } }, { leerFalla: { [GRUV]: 'EBUSY' } })
    const a = almacen(f)
    const s = a.cargar()
    assert.equal(s.tickets.length, 0)
    assert.match(a.aviso() ?? '', /No pude leer gruv\.json.*no se guarda/)
    s.tickets.push({ id: 'TCK-77', titulo: 'De esta sesión' })
    assert.equal(a.guardar(s), false)
    assert.deepEqual(f.ops, [])
    const f2 = fsFalso(Object.fromEntries(f.archivos))
    const b = almacen(f2, AHORA + 1)
    assert.equal(b.cargar().tickets[0].id, 'TCK-1')
    assert.equal(enDisco(f2).migradoDe?.gruvMtimeMs, 500)
    assert.ok(!f2.ops.some((op) => op.includes('.bak')), f2.ops.join(' | '))
    gruvIntacto(f2, GRUV_V1)
  }
})

test('versión futura: no renombra ni escribe en toda la sesión y avisa', () => {
  const futuro = JSON.stringify({ version: 3, cosas: 'nuevas' })
  for (const gruv of [{ [GRUV]: { texto: GRUV_V1, mtimeMs: 2 } }, {}]) {
    const f = fsFalso({ [TICKETS]: { texto: futuro, mtimeMs: 1 }, ...gruv })
    const a = almacen(f)
    const s = a.cargar()
    assert.equal(s.tickets.length, GRUV in gruv ? 1 : 0)
    assert.match(a.aviso() ?? '', /versión más nueva de Sloth/)
    s.tickets.push({ id: 'TCK-5', titulo: 'Cambio' })
    assert.equal(a.guardar(s), false)
    assert.deepEqual(f.ops, [])
    assert.equal(f.archivos.get(TICKETS)?.texto, futuro)
    gruvIntacto(f, GRUV in gruv ? GRUV_V1 : undefined)
  }
})

test('si falla guardar: avisa con el motivo y el aviso se va cuando vuelve a guardar', () => {
  const fallas: { escribirFalla?: string } = { escribirFalla: 'ENOSPC' }
  const f = fsFalso({}, fallas)
  const a = almacen(f)
  const s = a.cargar()
  assert.equal(a.aviso(), undefined)
  assert.equal(a.guardar(s), false)
  assert.match(a.aviso() ?? '', /No pude guardar tickets\.json \(ENOSPC/)
  assert.ok(f.logs.some((l) => l.includes('ENOSPC')))
  delete fallas.escribirFalla
  assert.equal(a.guardar(s), true)
  assert.equal(a.aviso(), undefined)
})

test('si no se puede apartar tickets.json, no se guarda en toda la sesión', () => {
  for (const [texto, motivo] of [
    ['{roto', 'corrupt'],
    [v2(1), 'bak']
  ]) {
    const f = fsFalso({ [TICKETS]: { texto, mtimeMs: 1 }, [GRUV]: { texto: GRUV_V1, mtimeMs: 2 } }, { apartarFalla: true })
    const a = almacen(f)
    const s = a.cargar()
    assert.deepEqual(f.ops, [`renombrar tickets.json tickets.json.${motivo}-${AHORA}`])
    assert.match(a.aviso() ?? '', /No pude apartar/)
    assert.equal(a.guardar(s), false)
    assert.deepEqual(f.ops, [`renombrar tickets.json tickets.json.${motivo}-${AHORA}`])
    assert.equal(f.archivos.get(TICKETS)?.texto, texto)
    gruvIntacto(f, GRUV_V1)
  }
})
