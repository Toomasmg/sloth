function urlDe(s: string | undefined): URL | null {
  if (!s) return null
  try {
    return new URL(s)
  } catch {
    return null
  }
}

export function origenConfiable(url: string | undefined, devUrl: string | undefined): boolean {
  const u = urlDe(url)
  if (!u) return false
  if (u.protocol === 'app:' && u.host === 'ui') return true
  const dev = urlDe(devUrl)
  return dev !== null && dev.origin !== 'null' && u.origin === dev.origin
}

// Solo lo que la UI usa de verdad: el dictado pide el micrófono y los botones de copiar escriben el portapapeles.
export function permisoChromium(permiso: string, origenOk: boolean, medios: readonly string[] | undefined): boolean {
  if (!origenOk) return false
  if (permiso === 'media') return medios !== undefined && medios.length > 0 && medios.every((m) => m === 'audio')
  return permiso === 'clipboard-sanitized-write'
}

export const idValido = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200

export const dimValida = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 2000
