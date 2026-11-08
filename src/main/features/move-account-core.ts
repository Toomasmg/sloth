/**
 * Lógica pura de «move-account» (sin Electron): copiar una conversación de una cuenta a otra.
 * Se prueba con scripts de Node sobre un árbol falso (ver scratchpad v5-t13).
 *
 * Claude guarda cada conversación en `<CLAUDE_CONFIG_DIR>/projects/<slug del cwd>/<uuid>.jsonl`,
 * y sus subagentes y resultados de herramientas en la carpeta homónima `<uuid>/`.
 */
import { constants as FS } from 'node:fs'
import { copyFile, cp, mkdir, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Claude guarda cada conversación en projects/<cwd con todo lo no alfanumérico como '-'>. */
export const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

/** La carpeta projects/<slug> de una cuenta para un cwd. */
export const projectDirOf = (configDir: string, cwd: string): string => join(configDir, 'projects', projectSlug(cwd))

export interface SessionRef {
  sessionId: string
  file: string
  mtimeMs: number
}

/** La conversación más reciente de una carpeta projects/<slug> (el nombre del .jsonl es el sessionId). */
export async function latestSession(projectDir: string): Promise<SessionRef | undefined> {
  let names: string[]
  try {
    names = await readdir(projectDir)
  } catch {
    return undefined
  }
  let best: SessionRef | undefined
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue
    const id = n.slice(0, -6)
    if (!UUID_RE.test(id)) continue
    try {
      const st = await stat(join(projectDir, n))
      if (!st.isFile() || st.size === 0) continue
      if (!best || st.mtimeMs > best.mtimeMs) best = { sessionId: id, file: join(projectDir, n), mtimeMs: st.mtimeMs }
    } catch {
      /* se borró mientras mirábamos */
    }
  }
  return best
}

export interface CopyReport {
  /** Se copió el .jsonl (false si el destino ya tenía la misma copia). */
  copied: boolean
  /** Si el destino tenía otro .jsonl con ese nombre, se renombró a esto (no se pisa nada). */
  backup?: string
  /** Hubo carpeta homónima en el origen (subagentes, resultados). */
  dirCopied: boolean
}

/**
 * Copia la conversación `sessionId` (y su carpeta homónima) de una cuenta a otra, en el mismo cwd.
 * Nunca pisa: si el destino ya tenía ese .jsonl y es distinto, lo guarda como
 * `<id>.jsonl.sloth-<fecha>.bak`; en la carpeta solo agrega lo que falta.
 */
export async function copyConversation(fromConfigDir: string, toConfigDir: string, cwd: string, sessionId: string): Promise<CopyReport> {
  if (!UUID_RE.test(sessionId)) throw new Error('Id de conversación inválido.')
  const srcDir = projectDirOf(fromConfigDir, cwd)
  const dstDir = projectDirOf(toConfigDir, cwd)
  const src = join(srcDir, `${sessionId}.jsonl`)
  const dst = join(dstDir, `${sessionId}.jsonl`)
  await mkdir(dstDir, { recursive: true })
  const report: CopyReport = { copied: false, dirCopied: false }
  const srcSt = await stat(src)
  const dstSt = await stat(dst).catch(() => undefined)
  const sameCopy = dstSt !== undefined && dstSt.size === srcSt.size && dstSt.mtimeMs >= srcSt.mtimeMs
  if (!sameCopy) {
    if (dstSt) {
      const backup = `${dst}.sloth-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
      await rename(dst, backup)
      report.backup = backup
    }
    await copyFile(src, dst, FS.COPYFILE_EXCL)
    report.copied = true
  }
  const srcFolder = join(srcDir, sessionId)
  const folderSt = await stat(srcFolder).catch(() => undefined)
  if (folderSt?.isDirectory()) {
    // force: false → lo que ya existe en el destino no se toca; solo se agrega lo que falta.
    await cp(srcFolder, join(dstDir, sessionId), { recursive: true, force: false, errorOnExist: false })
    report.dirCopied = true
  }
  return report
}

// ---------- Resumen opcional para Claude (texto que se escribe al arrancar en la cuenta nueva) ----------

export const SUMMARY_MAX = 4000

export interface SummaryInput {
  name: string
  cwd: string
  branch: string | null
  /** Archivos con cambios sin confirmar. -1 = no se pudo leer. */
  changes: number
}

/** Resumen inicial para el texto editable. */
export function buildSummary(s: SummaryInput): string {
  const where = s.branch ? `carpeta ${s.cwd}, rama ${s.branch}` : `carpeta ${s.cwd}`
  let changes: string
  if (s.changes < 0) changes = 'No pude leer los cambios sin confirmar'
  else if (s.changes === 0) changes = 'No hay cambios sin confirmar'
  else if (s.changes === 1) changes = 'Hay 1 archivo con cambios sin confirmar'
  else changes = `Hay ${s.changes} archivos con cambios sin confirmar`
  return `Estábamos trabajando en el espacio «${s.name}» (${where}). ${changes}. Antes de seguir, revisá el estado del repo con git status y retomá desde ahí.`
}

/** Texto que escribe el usuario: sin caracteres de control (salvo saltos de línea), con tope de largo. */
export function sanitizeSummary(v: unknown): string {
  if (typeof v !== 'string') throw new Error('El resumen tiene que ser texto.')
  // eslint-disable-next-line no-control-regex
  const clean = v.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim()
  if (clean.length > SUMMARY_MAX) throw new Error(`El resumen es demasiado largo (máximo ${SUMMARY_MAX} caracteres).`)
  return clean
}
