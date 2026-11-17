/** Familia de sintaxis de la shell: cambia cómo se pasa el comando inicial. */
export type ShellFamily = 'ps' | 'cmd' | 'posix'

export interface ClaudeLaunch {
  /** argv de Claude (p. ej. ['claude', '--continue']). */
  argv: string[]
  /** Primer mensaje: nunca va escrito en la línea de comandos de la shell. */
  prompt?: string
  /** Ruta absoluta de claude.exe, si se encontró. */
  exe?: string
}

export interface ShellLaunch {
  args: string[]
  /** Variables que se suman al entorno de la terminal. */
  env: Record<string, string>
  /** Texto que hay que pegar en Claude cuando arranque (cuando no se pudo pasar como argumento). */
  paste?: string
}

export const PROMPT_VAR = 'SLOTH_PROMPT'
export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'

// Argumentos que no necesitan comillas en ninguna de las shells.
const PLAIN = /^[A-Za-z0-9_\-./:=\\]+$/
// En cmd la ruta de claude.exe va sin comillas: node-pty escapa las comillas con \" y cmd no lo entiende.
const CMD_PLAIN = /^[A-Za-z0-9_\-.:\\@]+$/
// PowerShell cierra un string simple con cualquiera de estas cinco comillas, no solo con la ASCII.
const PS_QUOTES = /['\u2018\u2019\u201A\u201B]/g

export const psArg = (s: string): string => (PLAIN.test(s) ? s : `'${s.replace(PS_QUOTES, (q) => q + q)}'`)
// En bash la barra invertida sin comillas es un escape: una ruta de Windows va siempre entre comillas.
export const posixArg = (s: string): string => (PLAIN.test(s) && !s.includes('\\') ? s : `'${s.replace(/'/g, `'\\''`)}'`)
// cmd no tiene escape confiable: se quitan las comillas y los caracteres especiales.
export const cmdArg = (s: string): string => (PLAIN.test(s) ? s : `"${s.replace(/["&|<>^%!()]/g, '')}"`)

/** Contenido de un argumento entre comillas según las reglas de CommandLineToArgvW (las comillas de afuera las pone quien lo usa). */
export function windowsArgBody(s: string): string {
  return s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')
}

/** El primer mensaje en una sola línea y sin caracteres de control (un ESC cortaría el pegado). */
export function promptLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
}

export function pastePayload(text: string): string {
  return PASTE_START + promptLine(text) + PASTE_END
}

function shellOnly(family: ShellFamily): string[] {
  return family === 'ps' ? ['-NoLogo'] : family === 'posix' ? ['--login', '-i'] : []
}

/**
 * Argumentos de la shell que corre Claude y se queda abierta. El primer mensaje va por la variable
 * SLOTH_PROMPT, que la shell expande como un solo argumento después de `--`. Eso solo es seguro si
 * se lanza claude.exe directo: un claude.cmd pasaría otra vez por cmd. En cmd, o sin claude.exe,
 * el mensaje se pega en Claude cuando arranca.
 */
export function shellLaunch(family: ShellFamily, launch?: ClaudeLaunch): ShellLaunch {
  if (!launch?.argv.length) return { args: shellOnly(family), env: {} }
  let exe = launch.exe && /\.exe$/i.test(launch.exe) ? launch.exe : undefined
  if (family === 'cmd' && exe && !CMD_PLAIN.test(exe)) exe = undefined
  const argv = exe && launch.argv[0] === 'claude' ? [exe, ...launch.argv.slice(1)] : launch.argv
  const prompt = launch.prompt ? promptLine(launch.prompt) : undefined
  const viaEnv = prompt !== undefined && exe !== undefined && family !== 'cmd'
  const paste = prompt !== undefined && !viaEnv ? prompt : undefined
  switch (family) {
    case 'ps': {
      const head = `& ${argv.map(psArg).join(' ')}`
      if (!viaEnv) return { args: ['-NoLogo', '-NoExit', '-Command', head], env: {}, paste }
      // Con --% PowerShell pasa el resto de la línea tal cual (solo expande %VAR%): las comillas las arma windowsArgBody.
      const cmd = `${head} --% -- "%${PROMPT_VAR}%"\nRemove-Item Env:${PROMPT_VAR} -ErrorAction Ignore`
      return { args: ['-NoLogo', '-NoExit', '-Command', cmd], env: { [PROMPT_VAR]: windowsArgBody(prompt) } }
    }
    case 'cmd':
      return { args: ['/k', argv.map((a, i) => (i === 0 && a === exe ? a : cmdArg(a))).join(' ')], env: {}, paste }
    case 'posix': {
      const head = argv.map(posixArg).join(' ')
      if (!viaEnv) return { args: ['--login', '-i', '-c', `${head}; exec bash --login -i`], env: {}, paste }
      const cmd = `p=$${PROMPT_VAR}; unset ${PROMPT_VAR}; ${head} -- "$p"; unset p; exec bash --login -i`
      return { args: ['--login', '-i', '-c', cmd], env: { [PROMPT_VAR]: prompt } }
    }
  }
}

/**
 * Entorno limpio para cada terminal: se quitan las variables que harían que Claude use otra
 * cuenta (API keys) o crea que corre anidado dentro de otra sesión de Claude Code.
 */
export function baseEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue
    const key = k.toUpperCase()
    if (
      key === 'CLAUDECODE' ||
      key.startsWith('CLAUDE_CODE_') ||
      key === 'CLAUDE_CONFIG_DIR' ||
      key === 'ANTHROPIC_API_KEY' ||
      key === 'ANTHROPIC_AUTH_TOKEN' ||
      key === 'NODEFAULTCURRENTDIRECTORYINEXEPATH' ||
      key.startsWith('ELECTRON_') ||
      key.startsWith('ANTIREA_') ||
      key.startsWith('SLOTH_')
    )
      continue
    env[k] = v
  }
  env.TERM_PROGRAM = 'Sloth'
  // Sin esto, cmd busca `claude` primero en la carpeta del repo: un claude.cmd del repo se ejecutaría solo.
  env.NoDefaultCurrentDirectoryInExePath = '1'
  return env
}
