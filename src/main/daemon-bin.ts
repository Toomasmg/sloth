import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SKIP_DIRS = new Set(['src', 'deps', 'third_party', 'scripts', 'typings', 'node-addon-api'])

/** Qué parte de node-pty hace falta para el daemon: sin fuentes, símbolos ni prebuilds de otra plataforma. */
export function copiaPty(rel: readonly string[], name: string, keepPrebuild: string): boolean {
  if (rel.length === 0) return true
  if (rel.length === 1 && SKIP_DIRS.has(rel[0])) return false
  if (rel[0] === 'prebuilds' && rel.length >= 2 && rel[1] !== keepPrebuild) return false
  return !/\.(pdb|map)$/i.test(name) && !/\.test\.js$/i.test(name)
}

export function hashArchivo(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function hashesDe(raiz: string, incluir?: (rel: string[], name: string) => boolean): Map<string, string> {
  const out = new Map<string, string>()
  const recorrer = (rel: string[]): void => {
    for (const e of readdirSync(join(raiz, ...rel), { withFileTypes: true })) {
      const sub = [...rel, e.name]
      if (incluir && !incluir(sub, e.name)) continue
      if (e.isDirectory()) recorrer(sub)
      else if (e.isFile()) out.set(sub.join('/'), hashArchivo(join(raiz, ...sub)))
    }
  }
  recorrer([])
  return out
}

export function mismosHashes(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}
