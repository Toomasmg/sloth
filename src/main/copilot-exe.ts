import { posix, win32 } from 'node:path'

export const VERSION_MINIMA_COPILOT: readonly [number, number, number] = [1, 0, 100]

const PWSH7_INSTALADO = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

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

/** Copilot en Windows exige PowerShell 6+: el `powershell.exe` 5.1 que trae el sistema no cuenta. Fuera de Windows no usa PowerShell. */
export function hayPowerShell7(env: NodeJS.ProcessEnv, existe: (p: string) => boolean, plataforma: NodeJS.Platform): boolean {
  if (plataforma !== 'win32') return true
  if (existe(PWSH7_INSTALADO)) return true
  return carpetasDelPath(env, plataforma).some((d) => existe(win32.join(d, 'pwsh.exe')))
}
