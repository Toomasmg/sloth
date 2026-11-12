/**
 * Cierre ordenado de las terminales. node-pty 1.1 en Windows guarda sus ptys en un vector global sin
 * mutex que tocan los hilos de salida de cada una: matarlas todas juntas lo corrompe y salta la
 * aserción `remove_pty_baton` de conpty.cc. Por eso se cierran de a una y se espera su salida, que
 * llega a JS recién después de que el hilo nativo terminó de tocar el vector.
 */

export interface ClosingPty {
  isRunning(): boolean
  kill(): void
  /** Se resuelve cuando node-pty avisó la salida. */
  exited: Promise<void>
}

export interface CloseLimits {
  /** Lo máximo que se espera a cada una. */
  perPtyMs: number
  /** Lo máximo para todas: lo que pase de ahí no se espera (main corta a los 5 s). */
  totalMs: number
}

function waitOrTimeout(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(ms, 0))
    void p.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

export async function closeSerially(ptys: Iterable<ClosingPty>, limits: CloseLimits, onKillError: (e: unknown) => void = () => {}): Promise<{ timedOut: number }> {
  const deadline = Date.now() + limits.totalMs
  let timedOut = 0
  for (const p of ptys) {
    if (!p.isRunning()) continue
    const left = deadline - Date.now()
    if (left <= 0) {
      timedOut++
      continue
    }
    try {
      p.kill()
    } catch (e) {
      // Puede haber terminado entre isRunning() y kill(): igual se espera su salida.
      onKillError(e)
    }
    if (!(await waitOrTimeout(p.exited, Math.min(limits.perPtyMs, left)))) timedOut++
  }
  return { timedOut }
}
