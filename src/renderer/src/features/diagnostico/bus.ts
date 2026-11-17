const listeners = new Set<() => void>()
export const onCopiarDiagnostico = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export const pedirCopiarDiagnostico = (): void => listeners.forEach((l) => l())
