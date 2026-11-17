/**
 * Config que se fuerza en todo git que Sloth corre sobre repos del usuario. Un `.git/config` de un
 * repo bajado como zip o de una carpeta compartida puede traer `core.fsmonitor = <comando>`, y git lo
 * ejecuta con un simple `git status`.
 */
export const SAFE_GIT_CONFIG: readonly (readonly [string, string])[] = [
  ['core.fsmonitor', 'false'],
  ['core.untrackedCache', 'false'],
  ['protocol.ext.allow', 'never']
]

/** Argumentos de git con -C, la config segura y sin locks opcionales (status no reescribe el índice). */
export function safeGitArgs(cwd: string, args: readonly string[]): string[] {
  return ['--no-optional-locks', '-C', cwd, ...SAFE_GIT_CONFIG.flatMap(([k, v]) => ['-c', `${k}=${v}`]), '-c', 'core.quotepath=false', ...args]
}

/**
 * La misma config por variables de entorno (git ≥ 2.31), para el git que corre gh por su cuenta.
 * Se suma a la que ya traiga el entorno sin pisarla.
 */
export function safeGitEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const prev = Number.parseInt(env.GIT_CONFIG_COUNT ?? '', 10)
  const start = Number.isInteger(prev) && prev > 0 ? prev : 0
  const out: Record<string, string | undefined> = { ...env, GIT_OPTIONAL_LOCKS: '0' }
  SAFE_GIT_CONFIG.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${start + i}`] = k
    out[`GIT_CONFIG_VALUE_${start + i}`] = v
  })
  out.GIT_CONFIG_COUNT = String(start + SAFE_GIT_CONFIG.length)
  return out
}
