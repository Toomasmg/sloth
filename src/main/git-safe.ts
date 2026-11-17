/**
 * Config que se fuerza en todo git que Sloth corre sobre repos del usuario. Un `.git/config` de un
 * repo bajado como zip o de una carpeta compartida puede traer `core.fsmonitor = <comando>`, y git lo
 * ejecuta con un simple `git status`.
 */
export const SAFE_GIT_CONFIG: readonly (readonly [string, string])[] = [
  ['core.fsmonitor', 'false'],
  ['core.untrackedCache', 'false'],
  ['protocol.ext.allow', 'never'],
  // Con un commit firmado, `git log` correría el gpg.program del repo.
  ['log.showSignature', 'false']
]

// Solo estos firman o verifican firmas (con la config del usuario). El resto nunca llama a gpg: un
// programa vacío no rompe nada y uno puesto por el repo no se ejecuta.
const SIGNS = new Set(['commit', 'pull', 'merge', 'rebase', 'cherry-pick', 'revert', 'tag', 'am'])
const NO_GPG = ['gpg.program', 'gpg.ssh.program', 'gpg.x509.program'].flatMap((k) => ['-c', `${k}=`])

/**
 * Argumentos de git con -C, la config segura y sin locks opcionales (status no reescribe el índice).
 * `extra` son más `-c` (p. ej. los de filterOverrides).
 */
export function safeGitArgs(cwd: string, args: readonly string[], extra: readonly string[] = []): string[] {
  const gpg = SIGNS.has(args[0] ?? '') ? [] : NO_GPG
  return ['--no-optional-locks', '-C', cwd, ...SAFE_GIT_CONFIG.flatMap(([k, v]) => ['-c', `${k}=${v}`]), ...gpg, ...extra, '-c', 'core.quotepath=false', ...args]
}

/** status y diff contra el árbol de trabajo pasan cada archivo cambiado por el filtro clean del repo. */
export const RUNS_FILTERS: ReadonlySet<string> = new Set(['status', 'diff'])

// Lo que instala `git lfs install`: con estos comandos exactos el filtro «lfs» se respeta.
const LFS: Readonly<Record<string, string>> = {
  'filter.lfs.clean': 'git-lfs clean -- %f',
  'filter.lfs.smudge': 'git-lfs smudge -- %f',
  'filter.lfs.process': 'git-lfs filter-process',
  'filter.lfs.required': 'true'
}

/**
 * `-c` que apagan los filtros de la config (salida de `git config -z --get-regexp ^filter\.`): un
 * `.git/config` puede traer `filter.x.clean = <comando>` y un `.gitattributes` que lo use, y git lo
 * correría en un `status`. Se deja el de git-lfs si es el estándar. Null si algún nombre no se puede
 * pisar con `-c` (trae «=»): ese repo no se lee.
 */
export function filterOverrides(configZ: string): string[] | null {
  const last = new Map<string, string>()
  for (const entry of configZ.split('\0')) {
    if (!entry) continue
    const nl = entry.indexOf('\n')
    last.set(nl < 0 ? entry : entry.slice(0, nl), nl < 0 ? '' : entry.slice(nl + 1))
  }
  const drivers = new Map<string, boolean>()
  for (const [key, value] of last) {
    const m = /^filter\.(.+)\.([^.]+)$/i.exec(key)
    if (!m) continue
    const name = m[1]
    const standard = key.toLowerCase() in LFS && LFS[key.toLowerCase()] === value.trim()
    drivers.set(name, (drivers.get(name) ?? true) && standard)
  }
  const out: string[] = []
  for (const [name, standard] of drivers) {
    if (standard) continue
    if (name.includes('=')) return null
    for (const k of ['clean', 'smudge', 'process']) out.push('-c', `filter.${name}.${k}=`)
    out.push('-c', `filter.${name}.required=false`)
  }
  return out
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
