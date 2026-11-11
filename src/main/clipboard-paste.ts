import { app, clipboard } from 'electron'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Ruta lista para la línea de comandos: entre comillas si tiene espacios (como Windows Terminal). */
export const quotePath = (p: string): string => (/\s/.test(p) ? `"${p}"` : p)

/** Rutas de una lista text/uri-list (una por línea; las que empiezan con # son comentarios). */
export function pathsFromUriList(list: string): string[] {
  const out: string[] = []
  for (const line of list.split(/\r?\n/)) {
    const u = line.trim()
    if (!u || u.startsWith('#') || !u.startsWith('file:')) continue
    try {
      out.push(fileURLToPath(u))
    } catch {
      /* URI inválida: se saltea */
    }
  }
  return out
}

const PASTED_DIR = (): string => join(app.getPath('temp'), 'Sloth', 'pegados')
const KEEP_MS = 7 * 24 * 60 * 60 * 1000

/** Borra imágenes pegadas de hace más de una semana (Claude ya las leyó). */
async function sweep(dir: string): Promise<void> {
  const now = Date.now()
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    const p = join(dir, f)
    const s = await stat(p).catch(() => null)
    if (s && now - s.mtimeMs > KEEP_MS) await unlink(p).catch(() => undefined)
  }
}

/**
 * Lo que se pega en la terminal con Ctrl+V o clic derecho:
 * - texto, tal cual;
 * - archivos o carpetas copiados (Explorador, Finder): sus rutas, separadas por espacios;
 * - una imagen (captura de pantalla): se guarda como PNG y se pega su ruta, que Claude Code adjunta.
 */
export async function clipboardForPaste(): Promise<string> {
  const text = await clipboard.readText()
  if (text) return text
  for (const item of await clipboard.read()) {
    if (item.types.includes('text/uri-list')) {
      const paths = pathsFromUriList(await (await item.getType('text/uri-list')).text())
      if (paths.length) return paths.map(quotePath).join(' ')
    }
    if (item.types.includes('image/png')) {
      const png = Buffer.from(await (await item.getType('image/png')).arrayBuffer())
      if (!png.length) continue
      const dir = PASTED_DIR()
      await mkdir(dir, { recursive: true })
      void sweep(dir)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const file = join(dir, `imagen-${stamp}.png`)
      await writeFile(file, png)
      return quotePath(file)
    }
  }
  return ''
}
