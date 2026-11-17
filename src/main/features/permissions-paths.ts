import path from 'node:path'

type PathApi = Pick<typeof path, 'resolve' | 'dirname' | 'basename' | 'join' | 'relative' | 'isAbsolute' | 'sep'>

/**
 * Carpetas donde una edición puede terminar ejecutando algo (hooks de git, configuración de Claude
 * o del editor, tareas, contenedores): «Permitir siempre ediciones» nunca las cubre.
 */
export const PROTECTED_DIRS: ReadonlySet<string> = new Set(['.git', '.claude', '.vscode', '.husky', '.githooks', '.idea', '.devcontainer', '.github', '.sloth'])

const isMissing = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Ruta real de `target`, aunque todavía no exista (un Write de un archivo nuevo): se resuelve el
 * ancestro más cercano que existe (junctions y enlaces incluidos) y se le suma el resto.
 */
export function realPathOf(target: string, real: (p: string) => string, p: PathApi = path): string | undefined {
  let cur = p.resolve(target)
  const tail: string[] = []
  for (;;) {
    try {
      return p.join(real(cur), ...tail)
    } catch (e) {
      if (!isMissing(e)) return undefined
    }
    const parent = p.dirname(cur)
    if (parent === cur) return undefined
    tail.unshift(p.basename(cur))
    cur = parent
  }
}

/** Windows ignora los puntos y espacios del final: «.git.» es «.git». */
const segName = (s: string): string => s.replace(/[. ]+$/, '').toLowerCase()

/**
 * ¿La edición de `file` cae dentro del repo `cwd` y fuera de las carpetas protegidas? Compara rutas
 * reales, así un junction del repo que apunta afuera (o a .git) no cuenta como adentro.
 */
export function editInsideRepo(file: string, cwd: string, real: (p: string) => string, p: PathApi = path): boolean {
  if (!p.isAbsolute(file) || !p.isAbsolute(cwd)) return false
  const realCwd = realPathOf(cwd, real, p)
  const realFile = realPathOf(file, real, p)
  if (!realCwd || !realFile) return false
  const rel = p.relative(realCwd, realFile)
  if (!rel || p.isAbsolute(rel)) return false
  const segs = rel.split(/[\\/]+/)
  if (segs[0] === '..') return false
  // «:» abre un stream alternativo de NTFS y «~1» puede ser el nombre corto de una carpeta protegida.
  return segs.every((s) => !s.includes(':') && !/~\d/.test(s) && !PROTECTED_DIRS.has(segName(s)))
}
