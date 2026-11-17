import type { SpawnOptions } from 'node:child_process'

export interface KillDeps {
  platform: NodeJS.Platform
  /** true si taskkill salió bien; false si falló o venció. */
  taskkill(pid: number): Promise<boolean>
  killGroup(pid: number): void
  killOne(pid: number): void
}

// pid 0 y 1 son el grupo propio y init: matarlos se llevaría puesto a Sloth.
export function pidValido(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1
}

// Fuera de Windows el hijo tiene que ser líder de su grupo para poder matar el grupo entero.
export function spawnOptsArbol(platform: NodeJS.Platform): Pick<SpawnOptions, 'detached'> {
  return { detached: platform !== 'win32' }
}

function esEsrch(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === 'ESRCH'
}

// Nunca tira: si el proceso ya no existe o no se pudo matar, a quien cancela le da igual.
export async function matarArbol(pid: number | undefined, deps: KillDeps): Promise<void> {
  if (!pidValido(pid)) return
  if (deps.platform === 'win32') {
    let ok = false
    try {
      ok = await deps.taskkill(pid)
    } catch {
      ok = false
    }
    if (ok) return
    // taskkill puede no estar en el PATH, vencer o negar el acceso: al menos se mata el proceso directo.
    try {
      deps.killOne(pid)
    } catch {
      return
    }
    return
  }
  try {
    deps.killGroup(pid)
    return
  } catch (e) {
    if (esEsrch(e)) return
  }
  try {
    deps.killOne(pid)
  } catch {
    return
  }
}

export interface Cerrable {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  once(evento: 'exit' | 'close', fn: () => void): unknown
  off(evento: 'exit' | 'close', fn: () => void): unknown
}

// Un único plazo para matar y esperar el cierre: quien cancela nunca espera más de `ms`.
export async function cortarArbol(child: Cerrable & { pid?: number }, deps: KillDeps, ms: number): Promise<void> {
  const cierre = esperarCierre(child, ms)
  await Promise.race([matarArbol(child.pid, deps), cierre])
  await cierre
}

export function esperarCierre(child: Cerrable, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const fin = (): void => {
      clearTimeout(tope)
      child.off('exit', fin)
      child.off('close', fin)
      resolve()
    }
    const tope = setTimeout(fin, ms)
    child.once('exit', fin)
    child.once('close', fin)
  })
}
