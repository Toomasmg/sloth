import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Imports y reexports estáticos relativos. Los import() dinámicos no cuentan: cortan el ciclo en tiempo de carga.
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]/g

// Sacar de a poco: son los imports que el renderer todavía le hace a main. Un archivo que deja de
// importar de main tiene que salir de la lista (el test falla si no).
const PENDIENTES = new Set([
  // App.tsx es de otro dueño; hoy importa un tipo de main/features/settings-model, que es un stub hacia shared.
  'renderer/src/App.tsx',
  'renderer/src/NewWorkspaceDialog.tsx',
  // Los conectores de tickets arrastran varios módulos de main: se resuelven aparte.
  'renderer/src/features/tickets/Asistente.tsx',
  'renderer/src/features/tickets/AsistentePasos.tsx',
  'renderer/src/features/tickets/borrador.ts',
  'renderer/src/features/tickets/Propios.tsx'
])

function listar(dir: string): string[] {
  const salida: string[] = []
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre)
    if (statSync(ruta).isDirectory()) salida.push(...listar(ruta))
    else if (/\.tsx?$/.test(nombre) && !/\.test\.ts$/.test(nombre)) salida.push(ruta)
  }
  return salida
}

function resolverImport(desde: string, spec: string): string | undefined {
  const base = resolve(dirname(desde), spec)
  for (const candidato of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (/\.tsx?$/.test(candidato) && existsSync(candidato) && statSync(candidato).isFile()) return candidato
  }
  return undefined
}

const rel = (ruta: string): string => relative(SRC, ruta).split(sep).join('/')

const ARCHIVOS = listar(SRC)

const IMPORTA = new Map<string, string[]>()
for (const archivo of ARCHIVOS) {
  const texto = readFileSync(archivo, 'utf8')
  const destinos = new Set<string>()
  for (const m of texto.matchAll(IMPORT_RE)) {
    const destino = resolverImport(archivo, m[1] ?? m[2])
    if (destino && destino !== archivo) destinos.add(destino)
  }
  IMPORTA.set(archivo, [...destinos])
}

function componentesConexos(): string[][] {
  let indice = 0
  const idx = new Map<string, number>()
  const bajo = new Map<string, number>()
  const pila: string[] = []
  const enPila = new Set<string>()
  const salida: string[][] = []
  const visitar = (v: string): void => {
    idx.set(v, indice)
    bajo.set(v, indice)
    indice++
    pila.push(v)
    enPila.add(v)
    for (const w of IMPORTA.get(v) ?? []) {
      if (!idx.has(w)) {
        visitar(w)
        bajo.set(v, Math.min(bajo.get(v) as number, bajo.get(w) as number))
      } else if (enPila.has(w)) {
        bajo.set(v, Math.min(bajo.get(v) as number, idx.get(w) as number))
      }
    }
    if (bajo.get(v) === idx.get(v)) {
      const comp: string[] = []
      let w: string
      do {
        w = pila.pop() as string
        enPila.delete(w)
        comp.push(w)
      } while (w !== v)
      if (comp.length > 1) salida.push(comp)
    }
  }
  for (const v of IMPORTA.keys()) if (!idx.has(v)) visitar(v)
  return salida
}

function cadenaDelCiclo(comp: string[]): string {
  const dentro = new Set(comp)
  const inicio = [...comp].sort()[0]
  const camino: string[] = [inicio]
  const visto = new Set<string>([inicio])
  const buscar = (v: string): boolean => {
    for (const w of IMPORTA.get(v) ?? []) {
      if (!dentro.has(w)) continue
      if (w === inicio) return true
      if (visto.has(w)) continue
      visto.add(w)
      camino.push(w)
      if (buscar(w)) return true
      camino.pop()
    }
    return false
  }
  buscar(inicio)
  return [...camino, inicio].map(rel).join(' -> ')
}

test('no hay ciclos de imports entre los módulos de src', () => {
  const ciclos = componentesConexos().map(cadenaDelCiclo)
  assert.deepEqual(ciclos, [], `Hay ciclos de imports:\n${ciclos.join('\n')}`)
})

test('el renderer no importa de src/main salvo lo que está en PENDIENTES', () => {
  const dirMain = join(SRC, 'main') + sep
  const importanDeMain = (archivo: string): boolean => (IMPORTA.get(archivo) ?? []).some((d) => d.startsWith(dirMain))
  const delRenderer = ARCHIVOS.filter((a) => rel(a).startsWith('renderer/'))
  const nuevos = delRenderer.filter((a) => importanDeMain(a) && !PENDIENTES.has(rel(a))).map(rel)
  assert.deepEqual(nuevos, [], `El renderer no importa de src/main (movelo a src/shared):\n${nuevos.join('\n')}`)
  const resueltos = [...PENDIENTES].filter((p) => !importanDeMain(join(SRC, p)))
  assert.deepEqual(resueltos, [], `Ya no importan de src/main, sacalos de PENDIENTES:\n${resueltos.join('\n')}`)
})

test('shared no importa de main ni del renderer', () => {
  const prohibidos = [join(SRC, 'main') + sep, join(SRC, 'renderer') + sep]
  const malos: string[] = []
  for (const archivo of ARCHIVOS.filter((a) => rel(a).startsWith('shared/'))) {
    for (const d of IMPORTA.get(archivo) ?? []) if (prohibidos.some((p) => d.startsWith(p))) malos.push(`${rel(archivo)} -> ${rel(d)}`)
  }
  assert.deepEqual(malos, [], `shared lo usan main y renderer, no puede depender de ellos:\n${malos.join('\n')}`)
})

// Cortar un ciclo con inyección cambia quién arma la lista: sin esta llamada la lista queda vacía en silencio.
test('las listas que se inyectan para cortar ciclos siguen conectadas', () => {
  const leer = (p: string): string => readFileSync(join(SRC, p), 'utf8')
  const despues = (texto: string, ancla: string, llamada: string): boolean => {
    const a = texto.indexOf(ancla)
    return a >= 0 && texto.indexOf(llamada, a) > a
  }
  assert.ok(despues(leer('main/features/index.ts'), 'export const FEATURES', 'fijarNombresFeatures(FEATURES.map((f) => f.name))'), 'features/index.ts tiene que llamar fijarNombresFeatures tras armar FEATURES')
  assert.ok(despues(leer('renderer/src/features/registry.ts'), 'export const FEATURE_UIS', 'usarFeatureUis(FEATURE_UIS)'), 'registry.ts tiene que llamar usarFeatureUis tras armar FEATURE_UIS')
})
