import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { DAEMON_PROTOCOL_VERSION } from '../shared/daemon-protocol'

/** Nombre del pipe: único por carpeta userData (así dev y el instalado no se mezclan). */
export function pipeNameFor(userDataDir: string): string {
  const h = createHash('sha256').update(resolve(userDataDir).toLowerCase()).digest('hex').slice(0, 12)
  return `\\\\.\\pipe\\sloth-${h}-v${DAEMON_PROTOCOL_VERSION}`
}

export const tokenFileFor = (userDataDir: string): string => join(userDataDir, 'daemon-token')
export const logFileFor = (userDataDir: string): string => join(userDataDir, 'daemon.log')
export const DAEMON_SCRIPT_NAME = 'sloth-daemon.cjs'
