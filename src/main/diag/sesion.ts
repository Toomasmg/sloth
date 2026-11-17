export interface Sesion {
  inicio: number
  limpia: boolean
}

export function leerSesion(raw: string | undefined): Sesion | undefined {
  if (raw === undefined) return undefined
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!v || typeof v !== 'object') return undefined
  const { inicio, limpia } = v as { inicio?: unknown; limpia?: unknown }
  if (typeof inicio !== 'number' || !Number.isFinite(inicio) || typeof limpia !== 'boolean') return undefined
  return { inicio, limpia }
}

export function huboCierreInesperado(prev: Sesion | undefined): boolean {
  return prev !== undefined && !prev.limpia
}
