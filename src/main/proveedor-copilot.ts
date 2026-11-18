import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CAPACIDADES } from '../shared/proveedores'
import { resolverCopilotExe } from './copilot-exe'
import { logger } from './logger-global'
import { promptLine } from './shell-args'
import type { Proveedor } from './proveedores'

// Copilot guarda su login en el almacén del sistema, no en el entorno: ningún token se hereda ni se pasa. Las
// variables de GitHub se sacan para que la terminal no use otra identidad que la del login del sistema.
const QUITAR = /^(COPILOT_|GH_TOKEN$|GITHUB_TOKEN$|GH_ENTERPRISE_TOKEN$|GITHUB_ENTERPRISE_TOKEN$|ANTHROPIC_|CLAUDE|OPENAI_|CODEX_)/

// config.json de Copilot es chico; uno enorme o un link a otra cosa no se lee en el hilo main.
const MAX_BYTES_CONFIG = 1024 * 1024
const avisados = new Set<string>()

/**
 * Solo mira si hay algún usuario en `loggedInUsers`; nada más del archivo sale de acá. `lastLoggedInUser` no cuenta: si Copilot
 * lo conserva tras `/logout` la cuenta figuraría conectada. Los campos no están confirmados con una cuenta real.
 */
export function loginDeConfigCopilot(json: unknown): { loggedIn: boolean } {
  if (typeof json !== 'object' || json === null) return { loggedIn: false }
  const lista = (json as { loggedInUsers?: unknown }).loggedInUsers
  return { loggedIn: Array.isArray(lista) && lista.length > 0 }
}

function avisarUnaVez(configDir: string, e: unknown): void {
  const msg = `no pude leer el login de Copilot en ${configDir}: ${e instanceof Error ? e.message : String(e)}`
  if (avisados.has(msg)) return
  avisados.add(msg)
  logger.aviso('copilot', msg)
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
  // `-i` para el primer mensaje no está confirmado: el argv lo lleva tras `--` como el de claude, pero shellLaunch no se lo pasa a copilot
  // y sin hooks tampoco se pega: Sloth avisa que se escriba a mano (src/main/primer-mensaje.ts). Sin `continuar`: sesión nueva.
  argvInteractivo: (o) => (o.prompt ? ['copilot', '--', promptLine(o.prompt)] : ['copilot']),
  argvLogin: () => ['copilot', 'login', '--device-code'],
  estadoLogin: (configDir) => {
    const archivo = join(configDir, 'config.json')
    try {
      const st = lstatSync(archivo)
      if (!st.isFile() || st.size > MAX_BYTES_CONFIG) throw new Error('no es un archivo regular o es demasiado grande')
      return loginDeConfigCopilot(JSON.parse(readFileSync(archivo, 'utf8').replace(/^\uFEFF/, '')))
    } catch (e) {
      // Sin archivo o a medio escribir es \u00ABsin sesi\u00F3n\u00BB; un error de permisos o de disco queda en el log para no confundirlo con eso.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && !(e instanceof SyntaxError)) avisarUnaVez(configDir, e)
      return { loggedIn: false }
    }
  },
  prepararCarpeta: (configDir) => {
    mkdirSync(configDir, { recursive: true })
  },
  hayConversacionPrevia: () => false
}
