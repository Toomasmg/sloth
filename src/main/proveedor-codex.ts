import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CAPACIDADES } from '../shared/proveedores'
import { promptLine } from './shell-args'
import { resolverCodexExe } from './codex-exe'
import { logger } from './logger-global'
import type { Proveedor } from './proveedores'

// Sin esto Codex puede guardar el login en el almacén del sistema y dos cuentas se pisarían entre sí.
export const CLAVE_ALMACEN = 'cli_auth_credentials_store'
export const CONFIG_INICIAL = `${CLAVE_ALMACEN} = "file"\n`

// Valores fijos y conservadores. `--no-daemon`: el daemon compartido de Codex podría atender a dos cuentas con un solo CODEX_HOME.
const SEGURO = ['-s', 'workspace-write', '-a', 'on-request', '--no-daemon']

const AGENTES_AJENOS = /^(OPENAI_|CODEX_|ANTHROPIC_|CLAUDE)/

/** Crea config.toml solo si no existe (tmp más rename); uno existente no se toca. */
export function prepararCarpetaCodex(configDir: string): void {
  mkdirSync(configDir, { recursive: true })
  const destino = join(configDir, 'config.toml')
  if (existsSync(destino)) {
    try {
      if (!readFileSync(destino, 'utf8').includes(CLAVE_ALMACEN)) {
        logger.aviso('codex', `el config.toml de una cuenta no fija ${CLAVE_ALMACEN}: el login podría no quedar aislado por cuenta.`)
      }
    } catch (e) {
      logger.aviso('codex', `no pude leer el config.toml de una cuenta: ${e instanceof Error ? e.message : String(e)}`)
    }
    return
  }
  const tmp = join(configDir, `config.toml.tmp-${process.pid}`)
  writeFileSync(tmp, CONFIG_INICIAL, { encoding: 'utf8', flag: 'wx' })
  if (existsSync(destino)) {
    rmSync(tmp, { force: true })
    return
  }
  renameSync(tmp, destino)
}

export const codex: Proveedor = {
  id: 'codex',
  envConfigDir: 'CODEX_HOME',
  subcarpetaCuenta: 'codex',
  archivoMeta: 'config.toml',
  carpetaHistorial: 'sessions',
  capacidades: CAPACIDADES.codex,
  comoInstalar: 'npm install -g @openai/codex',
  quitarDelEntorno: (k) => AGENTES_AJENOS.test(k) || k === 'AZURE_OPENAI_API_KEY' || k === 'MISTRAL_API_KEY',
  envCuenta: (configDir) => ({ CODEX_HOME: configDir }),
  resolverExe: (env) => resolverCodexExe(env ?? process.env, existsSync, process.platform),
  // Sin `continuar`: `codex resume --last` filtra por carpeta y no está confirmado que acepte -s/-a/--no-daemon
  // después del subcomando. Hasta probarlo con una cuenta real, un espacio de Codex siempre abre una sesión nueva.
  argvInteractivo: (o) => (o.prompt ? ['codex', ...SEGURO, '--', promptLine(o.prompt)] : ['codex', ...SEGURO]),
  argvLogin: () => ['codex', 'login'],
  // Solo la existencia del archivo: sus credenciales no se abren.
  estadoLogin: (configDir) => ({ loggedIn: existsSync(join(configDir, 'auth.json')) }),
  prepararCarpeta: prepararCarpetaCodex,
  // Los rollouts de la cuenta no dicen de qué repo son: no se puede saber con certeza si hay algo que retomar en este.
  hayConversacionPrevia: () => false
}
