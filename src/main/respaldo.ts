import { copyFileSync, existsSync, constants } from 'node:fs'

// Se guarda una sola vez: la primera copia es la del usuario, antes de que Sloth la toque.
export function respaldarUnaVez(file: string): boolean {
  const bak = `${file}.sloth-bak`
  if (!existsSync(file) || existsSync(bak)) return false
  copyFileSync(file, bak, constants.COPYFILE_EXCL)
  return true
}
