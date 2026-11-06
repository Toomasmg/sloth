import { CHAT_LIMITS } from '../../../../../shared/chat'

/**
 * Foto del equipo: recorte cuadrado en el renderer, export webp ≤ 512 KB. Main vuelve a validar
 * (bytes mágicos y tamaño). Sin dependencias: canvas y createImageBitmap.
 */

export const PHOTO_SIDE = CHAT_LIMITS.photoSide
/** Tope del archivo ya recortado (igual al bucket). */
export const PHOTO_MAX_BYTES = CHAT_LIMITS.photoBytes
/** Tope de lo que se acepta del disco, antes de leerlo. */
export const PHOTO_INPUT_MAX_BYTES = 10 * 1024 * 1024
export const PHOTO_ACCEPT = ['image/png', 'image/jpeg', 'image/webp'] as const
export const PHOTO_ACCEPT_ATTR = PHOTO_ACCEPT.join(',')
export const ZOOM_MIN = 1
export const ZOOM_MAX = 4
/** Calidades que se prueban en orden hasta que el webp entra en PHOTO_MAX_BYTES. */
const QUALITIES = [0.85, 0.7] as const

export interface CropGeom {
  /** Escala aplicada a la imagen original. */
  scale: number
  /** Tamaño dibujado de la imagen, en px del canvas. */
  w: number
  h: number
  /** Esquina superior izquierda donde se dibuja la imagen. */
  x: number
  y: number
  /** Desplazamiento (ya acotado) respecto del centro. */
  ox: number
  oy: number
  maxX: number
  maxY: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * Geometría pura del recorte: la imagen siempre cubre el cuadrado (la lado menor llena `side` con zoom 1).
 * `ox`/`oy` se acotan para que no quede aire. Testeable sin DOM.
 */
export function cropGeometry(iw: number, ih: number, side: number, zoom: number, ox: number, oy: number): CropGeom {
  if (!(iw > 0 && ih > 0) || !Number.isFinite(iw) || !Number.isFinite(ih)) throw new Error('La imagen no tiene un tamaño válido.')
  const z = Number.isFinite(zoom) ? clamp(zoom, ZOOM_MIN, ZOOM_MAX) : ZOOM_MIN
  const scale = (side / Math.min(iw, ih)) * z
  const w = iw * scale
  const h = ih * scale
  const maxX = Math.max(0, (w - side) / 2)
  const maxY = Math.max(0, (h - side) / 2)
  const cox = clamp(Number.isFinite(ox) ? ox : 0, -maxX, maxX)
  const coy = clamp(Number.isFinite(oy) ? oy : 0, -maxY, maxY)
  return { scale, w, h, x: (side - w) / 2 + cox, y: (side - h) / 2 + coy, ox: cox, oy: coy, maxX, maxY }
}

/** Dibuja el recorte en el canvas (lado PHOTO_SIDE). Devuelve la geometría usada. */
export function drawCrop(
  canvas: HTMLCanvasElement,
  src: CanvasImageSource,
  iw: number,
  ih: number,
  zoom: number,
  ox: number,
  oy: number
): CropGeom {
  canvas.width = PHOTO_SIDE
  canvas.height = PHOTO_SIDE
  const g = cropGeometry(iw, ih, PHOTO_SIDE, zoom, ox, oy)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No se pudo dibujar la foto.')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, PHOTO_SIDE, PHOTO_SIDE)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, g.x, g.y, g.w, g.h)
  return g
}

/** Chequeo rápido antes de leer el archivo. Devuelve el mensaje de error o null. */
export function checkPhotoFile(file: File): string | null {
  if (!(PHOTO_ACCEPT as readonly string[]).includes(file.type)) return 'Elegí una imagen PNG, JPG o WebP.'
  if (file.size > PHOTO_INPUT_MAX_BYTES) return 'La imagen pesa más de 10 MB. Elegí una más chica.'
  return null
}

function toWebp(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('No se pudo exportar la foto.'))),
      'image/webp',
      quality
    )
  })
}

/**
 * Exporta el canvas como webp: calidad 0.85 y, si pesa más de 512 KB, 0.7.
 * Si todavía no entra, falla con un mensaje claro (no se manda nada).
 */
export async function encodeSquarePhoto(canvas: HTMLCanvasElement): Promise<{ blob: Blob; quality: number }> {
  for (const quality of QUALITIES) {
    const blob = await toWebp(canvas, quality)
    // Algunos motores no soportan webp en toBlob y devuelven png: no sirve, se corta acá.
    if (blob.type !== 'image/webp') throw new Error('No se pudo exportar la foto en webp.')
    if (blob.size <= PHOTO_MAX_BYTES) return { blob, quality }
  }
  throw new Error('La foto sigue pesando más de 512 KB. Probá con una imagen más simple.')
}

/** Blob → base64 SIN prefijo data:, en bloques (sin spread de arrays grandes). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** Canvas recortado → base64 webp listo para `createTeam`/`updateTeam`. */
export async function canvasToPhotoBase64(canvas: HTMLCanvasElement): Promise<{ base64: string; bytes: number; quality: number }> {
  const { blob, quality } = await encodeSquarePhoto(canvas)
  return { base64: await blobToBase64(blob), bytes: blob.size, quality }
}
