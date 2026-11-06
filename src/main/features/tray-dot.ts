import { nativeImage, type NativeImage } from 'electron'

let cached: NativeImage | null = null

/** Bitmap BGRA de un punto ámbar con borde oscuro, con antialias (sin archivos en disco). */
function dot(size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4)
  const c = size / 2
  const rOuter = size / 2 - size / 16
  const rInner = rOuter - size / 8
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c)
      const aOuter = Math.max(0, Math.min(1, rOuter - d + 0.5))
      if (aOuter <= 0) continue
      const aInner = Math.max(0, Math.min(1, rInner - d + 0.5))
      // ámbar #f5b041 por dentro, borde #16181f (el fondo de la app) para que se lea sobre el ícono.
      const r = Math.round(0x16 + (0xf5 - 0x16) * aInner)
      const g = Math.round(0x18 + (0xb0 - 0x18) * aInner)
      const b = Math.round(0x1f + (0x41 - 0x1f) * aInner)
      const a = Math.round(255 * aOuter)
      const i = (y * size + x) * 4
      // BGRA premultiplicado.
      buf[i] = Math.round((b * a) / 255)
      buf[i + 1] = Math.round((g * a) / 255)
      buf[i + 2] = Math.round((r * a) / 255)
      buf[i + 3] = a
    }
  }
  return buf
}

export function amberDot(): NativeImage {
  if (cached) return cached
  const img = nativeImage.createFromBitmap(dot(16), { width: 16, height: 16, scaleFactor: 1 })
  img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: dot(32) })
  cached = img
  return img
}
