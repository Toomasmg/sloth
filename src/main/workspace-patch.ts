/**
 * Validación de los cambios a un espacio (renombrar, ícono) que llegan por IPC (`workspaces:update`).
 * Sin Electron: se prueba con Node. Tira Error con un mensaje para mostrar si algo no es válido.
 */

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const MAX_NAME = 80
const MAX_ICON_UNITS = 16
const MAX_ICON_GRAPHEMES = 2

const graphemes = (s: string): number => {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<unknown> } }).Segmenter
  if (!Seg) return [...s].length
  let n = 0
  for (const _ of new Seg(undefined, { granularity: 'grapheme' }).segment(s)) n++
  return n
}

/** Ver `WorkspacePatch` en shared/types.ts. `icon: null` = quitar el ícono. */
export function validateWorkspacePatch(raw: unknown): { name?: string; icon?: string | null } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Cambio inválido.')
  const patch = raw as Record<string, unknown>
  for (const k of Object.keys(patch)) if (k !== 'name' && k !== 'icon') throw new Error(`No se puede cambiar «${k}».`)
  const out: { name?: string; icon?: string | null } = {}
  if ('name' in patch) {
    if (typeof patch.name !== 'string') throw new Error('El nombre tiene que ser texto.')
    const name = patch.name.trim()
    if (!name) throw new Error('Poné un nombre.')
    if (name.length > MAX_NAME) throw new Error(`El nombre puede tener hasta ${MAX_NAME} caracteres.`)
    if (CONTROL.test(name)) throw new Error('El nombre tiene caracteres no válidos.')
    out.name = name
  }
  if ('icon' in patch) {
    const icon = patch.icon
    if (icon === null || icon === '') out.icon = null
    else {
      if (typeof icon !== 'string') throw new Error('El ícono tiene que ser un emoji.')
      const t = icon.trim()
      if (!t || t.length > MAX_ICON_UNITS || graphemes(t) > MAX_ICON_GRAPHEMES || CONTROL.test(t) || /[A-Za-z0-9<>&"'`\\/]/.test(t))
        throw new Error('El ícono tiene que ser un emoji (uno o dos).')
      out.icon = t
    }
  }
  return out
}

