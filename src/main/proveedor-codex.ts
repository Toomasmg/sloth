import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

// Sin confirmar con una cuenta real: si Codex no acepta las opciones después de `resume`, pasarlas antes.
const CONTINUAR = ['codex', 'resume', '--last', ...SEGURO]

const AGENTES_AJENOS = /^(OPENAI_|CODEX_|ANTHROPIC_|CLAUDE)/

const NUM = /^\d+$/

function hijos(dir: string, filtro: (n: string) => boolean): string[] {
  return readdirSync(dir).filter(filtro).sort().reverse()
}

/** Solo nombres de archivo: `sessions/AAAA/MM/DD/rollout-*.jsonl`. Nunca se abre una conversación. */
export function hayRollout(configDir: string): boolean {
  const raiz = join(configDir, 'sessions')
  try {
    if (!existsSync(raiz)) return false
    for (const a of hijos(raiz, (n) => NUM.test(n)).slice(0, 5)) {
      for (const m of hijos(join(raiz, a), (n) => NUM.test(n)).slice(0, 12)) {
        for (const d of hijos(join(raiz, a, m), (n) => NUM.test(n)).slice(0, 31)) {
          if (readdirSync(join(raiz, a, m, d)).some((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'))) return true
        }
      }
    }
    return false
  } catch (e) {
    logger.aviso('codex', `no pude revisar las sesiones de una cuenta: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

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
  argvInteractivo: (o) => {
    if (o.prompt) return ['codex', ...SEGURO, '--', promptLine(o.prompt)]
    if (o.continuar) return [...CONTINUAR]
    return ['codex', ...SEGURO]
  },
  argvLogin: () => ['codex', 'login'],
  // Solo la existencia del archivo: sus credenciales no se abren.
  estadoLogin: (configDir) => ({ loggedIn: existsSync(join(configDir, 'auth.json')) }),
  prepararCarpeta: prepararCarpetaCodex,
  hayConversacionPrevia: (configDir) => hayRollout(configDir)
}
