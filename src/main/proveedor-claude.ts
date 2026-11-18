import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CAPACIDADES } from '../shared/proveedores'
import { resolveClaudeExe } from './features/tickets/claude-run'
import { claudeWithPrompt } from './shell-args'
import type { Proveedor } from './proveedores'

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''))
  } catch {
    return undefined
  }
}

const ARCHIVO_META = '.claude.json'

export const claude: Proveedor = {
  id: 'claude',
  envConfigDir: 'CLAUDE_CONFIG_DIR',
  subcarpetaCuenta: 'claude',
  archivoMeta: ARCHIVO_META,
  carpetaHistorial: 'projects',
  capacidades: CAPACIDADES.claude,
  comoInstalar: 'https://docs.claude.com/en/docs/claude-code/setup',
  quitarDelEntorno: (k) =>
    k === 'CLAUDECODE' ||
    k.startsWith('CLAUDE_CODE_') ||
    k === 'CLAUDE_CONFIG_DIR' ||
    k === 'ANTHROPIC_API_KEY' ||
    k === 'ANTHROPIC_AUTH_TOKEN',
  envCuenta: (configDir) => ({ CLAUDE_CONFIG_DIR: configDir }),
  resolverExe: (env) => resolveClaudeExe(env),
  argvLogin: () => ['claude'],
  // Solo `.claude.json` (datos públicos de la cuenta: email). Sloth nunca abre `.credentials.json`: el login lo maneja Claude Code.
  estadoLogin: (configDir) => {
    const meta = readJson(join(configDir, ARCHIVO_META)) as { oauthAccount?: { emailAddress?: string; accountUuid?: string } } | undefined
    const email = meta?.oauthAccount?.emailAddress
    return { loggedIn: Boolean(email || meta?.oauthAccount?.accountUuid), email }
  },
  prepararCarpeta: () => {},
  // Claude guarda cada conversación en projects/<cwd con separadores como '-'>.
  hayConversacionPrevia: (configDir, cwd) => {
    const dir = join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
    try {
      return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.jsonl'))
    } catch {
      return false
    }
  },
  argvInteractivo: (o) => {
    if (o.prompt) return claudeWithPrompt(o.prompt)
    if (o.continuar) return ['claude', '--continue']
    return ['claude']
  }
}
