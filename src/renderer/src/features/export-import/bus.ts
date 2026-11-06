/** Lo que abre la paleta: el modal vive en Global y escucha acá. */
export type EiRequest = { kind: 'export' } | { kind: 'import' }
const listeners = new Set<(r: EiRequest) => void>()
export const onRequest = (cb: (r: EiRequest) => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export const request = (r: EiRequest): void => listeners.forEach((l) => l(r))
