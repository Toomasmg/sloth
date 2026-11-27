import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { DAEMON_PROTOCOL_VERSION } from '../shared/daemon-protocol'

const pipeFor = (userDataDir: string, version: number): string => {
  const h = createHash('sha256').update(resolve(userDataDir).toLowerCase()).digest('hex').slice(0, 12)
  return `\\\\.\\pipe\\sloth-${h}-v${version}`
}

/** Nombre del pipe: único por carpeta userData (así dev y el instalado no se mezclan). */
export const pipeNameFor = (userDataDir: string): string => pipeFor(userDataDir, DAEMON_PROTOCOL_VERSION)

/** El pipe del protocolo 1, para encontrar y apagar un daemon viejo. */
export const legacyPipeNameFor = (userDataDir: string): string => pipeFor(userDataDir, 1)

export const daemonKeyFileFor = (userDataDir: string): string => join(userDataDir, 'daemon-key')
/** La clave del protocolo 1: solo se lee para apagar el daemon viejo y después se borra. */
export const tokenFileFor = (userDataDir: string): string => join(userDataDir, 'daemon-token')
export const logFileFor = (userDataDir: string): string => join(userDataDir, 'daemon.log')
export const DAEMON_SCRIPT_NAME = 'sloth-daemon.cjs'
export const DAEMON_EXE_NAME = 'sloth-daemon.exe'
