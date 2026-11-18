import { posix, win32 } from 'node:path'

export const VERSION_MINIMA_COPILOT: readonly [number, number, number] = [1, 0, 100]

function carpetasDelPath(env: NodeJS.ProcessEnv, plataforma: NodeJS.Platform): string[] {
  const win = plataforma === 'win32'
  const ruta = win ? win32 : posix
  return (env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter((d) => d && ruta.isAbsolute(d))
}

/** Ejecutable de Copilot en el PATH. Mismas reglas que Codex: entradas relativas ignoradas, y en Windows solo `copilot.exe` y `copilot.cmd` (el shim sin extensión no lo corre cmd). */
export function resolverCopilotExe(env: NodeJS.ProcessEnv, existe: (p: string) => boolean, plataforma: NodeJS.Platform): string | undefined {
  const win = plataforma === 'win32'
  const ruta = win ? win32 : posix
  const nombres = win ? ['copilot.exe', 'copilot.cmd'] : ['copilot']
  for (const d of carpetasDelPath(env, plataforma)) {
    for (const n of nombres) {
      const c = ruta.join(d, n)
      if (existe(c)) return c
    }
  }
  return undefined
}

/** Lee la salida de `copilot --version`. Sin versión reconocible: ok falso. */
export function versionCopilotOk(salida: string): { version?: string; ok: boolean } {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(salida)
  if (!m) return { ok: false }
  const v = [Number(m[1]), Number(m[2]), Number(m[3])]
  for (let i = 0; i < 3; i++) {
    if (v[i] !== VERSION_MINIMA_COPILOT[i]) return { version: `${v[0]}.${v[1]}.${v[2]}`, ok: v[i] > VERSION_MINIMA_COPILOT[i] }
  }
  return { version: `${v[0]}.${v[1]}.${v[2]}`, ok: true }
}

export const AVISO_POWERSHELL_7 = 'Copilot necesita PowerShell 7 en Windows: instalalo con «winget install Microsoft.PowerShell».'

export interface DepsPowerShell {
  existe: (p: string) => boolean
  /** Corre `pwsh` con esa ruta y devuelve lo que imprime la versión mayor; undefined si no arrancó. */
  mayor: (exe: string) => Promise<string | undefined>
}

// El pwsh de Microsoft Store es un alias de ejecución: existsSync da false aunque ande, así que esa carpeta se prueba corriendo.
const CARPETA_ALIAS = /[\\/]Microsoft[\\/]WindowsApps[\\/]?$/i

function candidatosPwsh(env: NodeJS.ProcessEnv, existe: (p: string) => boolean): string[] {
  const candidatos: string[] = []
  const programas = [env.ProgramW6432, env.ProgramFiles, 'C:\\Program Files'].filter((d): d is string => !!d && win32.isAbsolute(d))
  for (const d of programas) {
    for (const v of ['7', '7-preview']) {
      const c = win32.join(d, 'PowerShell', v, 'pwsh.exe')
      if (existe(c)) candidatos.push(c)
    }
  }
  for (const d of carpetasDelPath(env, 'win32')) {
    const c = win32.join(d, 'pwsh.exe')
    if (existe(c) || CARPETA_ALIAS.test(d)) candidatos.push(c)
  }
  if (env.LOCALAPPDATA && win32.isAbsolute(env.LOCALAPPDATA)) candidatos.push(win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'))
  const vistos = new Set<string>()
  return candidatos.filter((c) => !vistos.has(c.toLowerCase()) && vistos.add(c.toLowerCase()))
}

/** Copilot en Windows exige PowerShell 6+: el `powershell.exe` 5.1 que trae el sistema no cuenta (solo se prueban ejecutables llamados pwsh.exe y se mira la versión). Fuera de Windows no usa PowerShell. */
export async function hayPowerShell7(env: NodeJS.ProcessEnv, plataforma: NodeJS.Platform, deps: DepsPowerShell): Promise<boolean> {
  if (plataforma !== 'win32') return true
  for (const c of candidatosPwsh(env, deps.existe)) {
    const salida = await deps.mayor(c)
    const m = salida === undefined ? null : /^\s*(\d+)\s*$/.exec(salida)
    if (m && Number(m[1]) >= 6) return true
  }
  return false
}
