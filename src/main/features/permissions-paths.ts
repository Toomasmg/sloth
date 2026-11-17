import path from 'node:path'
import { dentroDelRepo } from './permissions-core'

type PathApi = Pick<typeof path, 'resolve' | 'dirname' | 'basename' | 'join'>

export interface PathFs {
  real: (p: string) => string
  lstat: (p: string) => { isSymbolicLink(): boolean }
}

const isMissing = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
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
        // lstat la vio y realpath no llega: es un enlace colgante o algo que no se puede leer. No se aprueba.
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

/**
 * dentroDelRepo con el disco a la vista: además de la ruta escrita, la ruta real tiene que caer
 * dentro del repo real, sin pasar por un enlace o junction del repo (un symlink colgante que apunta a
 * la carpeta Inicio se aprobaba como «notas.md»).
 */
export function dentroDelRepoReal(archivo: string, cwd: string, fs: PathFs, p: PathApi = path): boolean {
  if (!dentroDelRepo(archivo, cwd)) return false
  let realCwd: string
  try {
    realCwd = fs.real(p.resolve(cwd))
  } catch {
    return false
  }
  const realFile = realPathInside(p.resolve(cwd, archivo), realCwd, fs, p)
  return realFile !== undefined && dentroDelRepo(realFile, realCwd)
}
