import { fileURLToPath } from 'node:url'

/** Rutas de una lista text/uri-list (una por línea; las que empiezan con # son comentarios). */
export function pathsFromUriList(list: string): string[] {
  const out: string[] = []
  for (const line of list.split(/\r?\n/)) {
    const u = line.trim()
    if (!u.startsWith('file:')) continue
    try {
      out.push(fileURLToPath(u))
    } catch {
      // Una URI de archivo mal formada no se puede pegar: se saltea y siguen las demás.
    }
  }
  return out
}
