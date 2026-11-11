import { readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { USERDATA_PREFIX } from './sloth'

/** Al terminar la corrida (ya sin ningún Sloth abierto): borra las carpetas de datos de prueba que hayan quedado. */
export default function globalTeardown(): void {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(USERDATA_PREFIX)) continue
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    } catch (e) {
      console.warn(`No se pudo borrar ${name}: ${(e as Error).message}`)
    }
  }
}
