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

export interface PathFs {
  real: (p: string) => string
  lstat: (p: string) => { isSymbolicLink(): boolean }
}

/**
 * Ruta real de `target` dentro del repo cuya ruta real es `realCwd`, aunque todavía no exista (un
 * Write de un archivo nuevo): el resto se suma al realpath del ancestro más cercano que existe.
 * Undefined si algún componente entre el repo y el archivo es un enlace o un junction (aunque esté
 * colgante: escribir a través de él crearía el archivo en su destino) o si nunca se llega al repo.
 */
export function realPathInside(target: string, realCwd: string, fs: PathFs, p: PathApi = path): string | undefined {
  let cur = p.resolve(target)
  const tail: string[] = []
  let found: string | undefined
  for (;;) {
    let link: boolean | undefined
    try {
      link = fs.lstat(cur).isSymbolicLink()
    } catch (e) {
      if (!isMissing(e)) return undefined
    }
    if (link !== undefined) {
      let r: string
      try {
        r = fs.real(cur)
      } catch {
        return undefined
      }
      // El repo mismo puede estar abierto a través de un junction; uno adentro del repo, no.
      if (r === realCwd) return found ?? p.join(r, ...tail)
      if (link) return undefined
      found ??= p.join(r, ...tail)
    }
    const parent = p.dirname(cur)
    if (parent === cur) return undefined
    if (link === undefined) tail.unshift(p.basename(cur))
    cur = parent
  }
}

/** Windows ignora los puntos y espacios del final: «.git.» es «.git». */
const segName = (s: string): string => s.replace(/[. ]+$/, '').toLowerCase()

// Forma de un nombre corto 8.3 («GIT~1», «VSCODE~1.JSO»); «informe~2.docx» o «notas-viejas~1.md» no.
const SHORT_NAME = /^[^.]{1,6}~\d+(\.[^.]{0,3})?$/

/**
 * ¿La edición de `file` cae dentro del repo `cwd` y fuera de las carpetas protegidas? Compara rutas
 * reales, así un junction del repo que apunta afuera (o a .git) no cuenta como adentro.
 */
export function editInsideRepo(file: string, cwd: string, fs: PathFs, p: PathApi = path): boolean {
  if (!p.isAbsolute(file) || !p.isAbsolute(cwd)) return false
  let realCwd: string
  try {
    realCwd = fs.real(p.resolve(cwd))
  } catch {
    return false
  }
  const realFile = realPathInside(file, realCwd, fs, p)
  if (!realFile) return false
  const rel = p.relative(realCwd, realFile)
  if (!rel || p.isAbsolute(rel)) return false
  const segs = rel.split(/[\\/]+/)
  if (segs[0] === '..') return false
  // «:» abre un stream alternativo de NTFS y «~1» puede ser el nombre corto de una carpeta protegida.
  return segs.every((s) => !s.includes(':') && !SHORT_NAME.test(segName(s)) && !PROTECTED_DIRS.has(segName(s)))
}
