import { posix, win32 } from 'node:path'

export const VERSION_MINIMA: readonly [number, number, number] = [0, 164, 0]

/**
 * Ejecutable de Codex en el PATH (las entradas relativas se ignoran: se resolverían contra el cwd de Sloth). En Windows npm deja `codex.cmd` y un shim sin extensión (un script de sh
 * que cmd no corre): solo cuentan `codex.exe` y `codex.cmd`, con el .exe primero dentro de cada carpeta.
 */
export function resolverCodexExe(env: NodeJS.ProcessEnv, existe: (p: string) => boolean, plataforma: NodeJS.Platform): string | undefined {
  const win = plataforma === 'win32'
  const ruta = win ? win32 : posix
  const dirs = (env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter((d) => d && ruta.isAbsolute(d))
  const nombres = win ? ['codex.exe', 'codex.cmd'] : ['codex']
  for (const d of dirs) {
    for (const n of nombres) {
      const c = ruta.join(d, n)
      if (existe(c)) return c
    }
  }
  return undefined
}

/** Lee la salida de `codex --version` («codex-cli 0.164.0»). Sin versión reconocible: ok falso. */
export function versionCodexOk(salida: string): { version?: string; ok: boolean } {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(salida)
  if (!m) return { ok: false }
  const v = [Number(m[1]), Number(m[2]), Number(m[3])]
  for (let i = 0; i < 3; i++) {
    if (v[i] !== VERSION_MINIMA[i]) return { version: `${v[0]}.${v[1]}.${v[2]}`, ok: v[i] > VERSION_MINIMA[i] }
  }
  return { version: `${v[0]}.${v[1]}.${v[2]}`, ok: true }
}
