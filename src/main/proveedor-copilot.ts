import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CAPACIDADES } from '../shared/proveedores'
import { resolverCopilotExe } from './copilot-exe'
import { promptLine } from './shell-args'
import type { Proveedor } from './proveedores'

// Copilot guarda su login en el almacén del sistema, no en el entorno: ningún token se hereda ni se pasa. Las
// variables de GitHub se sacan para que la terminal no use otra identidad que la del login del sistema.
const QUITAR = /^(COPILOT_|GH_TOKEN$|GITHUB_TOKEN$|GH_ENTERPRISE_TOKEN$|GITHUB_ENTERPRISE_TOKEN$|ANTHROPIC_|CLAUDE|OPENAI_|CODEX_)/

/** Solo mira si hay algún usuario registrado; nada más del archivo sale de acá. Los campos no están confirmados con una cuenta real. */
export function loginDeConfigCopilot(json: unknown): { loggedIn: boolean } {
  if (typeof json !== 'object' || json === null) return { loggedIn: false }
  const c = json as { loggedInUsers?: unknown; lastLoggedInUser?: unknown }
  const hayLista = Array.isArray(c.loggedInUsers) && c.loggedInUsers.length > 0
  const hayUltimo = typeof c.lastLoggedInUser === 'object' && c.lastLoggedInUser !== null
  return { loggedIn: hayLista || hayUltimo }
}

export const copilot: Proveedor = {
  id: 'copilot',
  envConfigDir: 'COPILOT_HOME',
  subcarpetaCuenta: 'copilot',
  archivoMeta: 'config.json',
  carpetaHistorial: 'session-state',
  capacidades: CAPACIDADES.copilot,
  comoInstalar: 'npm install -g @github/copilot (necesita Node 22) o winget install GitHub.Copilot',
  quitarDelEntorno: (k) => QUITAR.test(k),
  envCuenta: (configDir) => ({ COPILOT_HOME: configDir, COPILOT_AUTO_UPDATE: 'false' }),
  resolverExe: (env) => resolverCopilotExe(env ?? process.env, existsSync, process.platform),
  // `-i` para el primer mensaje no está confirmado: shellLaunch lo pega siempre y no llega a argv. Sin `continuar`: sesión nueva.
  argvInteractivo: (o) => (o.prompt ? ['copilot', '--', promptLine(o.prompt)] : ['copilot']),
  argvLogin: () => ['copilot', 'login', '--device-code'],
  estadoLogin: (configDir) => {
    try {
      return loginDeConfigCopilot(JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8').replace(/^\uFEFF/, '')))
    } catch {
      return { loggedIn: false }
    }
  },
  prepararCarpeta: (configDir) => {
    mkdirSync(configDir, { recursive: true })
  },
  hayConversacionPrevia: () => false
}
