import { copyFileSync, existsSync, readFileSync, renameSync, constants } from 'node:fs'

// Se guarda una sola vez: la primera copia es la del usuario, antes de que Sloth la toque.
export function respaldarUnaVez(file: string): boolean {
  const bak = `${file}.sloth-bak`
  if (!existsSync(file) || existsSync(bak)) return false
  copyFileSync(file, bak, constants.COPYFILE_EXCL)
  return true
}

// Antes de reemplazar un archivo sin mezclarlo: si lo que hay no es lo que se va a escribir, alguien lo
// cambió desde la última vez (a mano o con /config) y esa versión va a `.sloth-prev`.
export function respaldarAntesDeReemplazar(file: string, nuevo: string): boolean {
  if (!existsSync(file)) return false
  if (readFileSync(file, 'utf8') === nuevo) return false
  const prev = `${file}.sloth-prev`
  const tmp = `${prev}.${process.pid}.tmp`
  copyFileSync(file, tmp)
  renameSync(tmp, prev)
  return true
}
