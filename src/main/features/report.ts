import { app, shell } from 'electron'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { basename, join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import { logFileFor } from '../../daemon/paths'
import {
  buildIssueUrl,
  composeBody,
  EXPECT_MAX,
  fitBody,
  isIssueUrl,
  readLogTail,
  recentLines,
  REPORT_TYPES,
  sanitize,
  systemLines,
  BODY_MAX,
  STEP_MAX,
  STEPS_MAX,
  TITLE_MAX,
  TITLE_MIN,
  URL_MAX,
  WHAT_MAX,
  type ReportForm,
  type ReportType,
  type SanitizeContext
} from './report-core'

/**
 * Función «report» (lado main): «Reportar un problema».
 * - preview(): líneas de sistema y de registro YA sanitizadas, para que el usuario las revise.
 * - capture(): captura SOLO de la ventana de Sloth (la pide la UI cuando el usuario la marca).
 * - submit(form): arma el cuerpo, lo vuelve a sanitizar y abre el «nuevo issue» prellenado en
 *   github.com (host fijo) y devuelve esa URL. La captura no entra en el link: se guarda y se muestra su carpeta.
 * - open(url): vuelve a abrir ese issue prellenado («Ver en GitHub»); solo acepta URLs de buildIssueUrl.
 */

const TYPES: ReportType[] = ['error', 'idea', 'otra']
/** La captura vale para un envío dentro de este tiempo. */
const SHOT_TTL_MS = 15 * 60_000

function hostContext(ctx: FeatureContext): SanitizeContext {
  let username = ''
  try {
    username = os.userInfo().username
  } catch {
    /* sin usuario resoluble: se filtra el resto igual */
  }
  return {
    home: os.homedir(),
    username,
    hostname: os.hostname(),
    accountIds: ctx.store.accounts.map((a) => a.id)
  }
}

function daemonLine(ctx: FeatureContext): string {
  const info = ctx.terminal()?.info()
  if (!info) return 'sin iniciar'
  if (info.mode === 'daemon') return `daemon ${info.version ?? ''}`.trim()
  return `en proceso${info.reason ? ` (${info.reason})` : ''}`
}

const feature: Feature = {
  name: 'report',
  register(ctx) {
    let lastShot: { file: string; at: number } | null = null

    const sysAndLogs = (): { sys: string[]; logs: string[] } => {
      const hc = hostContext(ctx)
      const sys = systemLines({
        sloth: app.getVersion(),
        windows: `${os.version()} · ${os.release()}`,
        arch: process.arch,
        electron: process.versions.electron ?? '',
        daemon: daemonLine(ctx),
        accounts: ctx.store.accounts.length,
        workspaces: ctx.store.workspaces.length
      }).map((l) => sanitize(l, hc))
      const logs = recentLines(readLogTail(logFileFor(app.getPath('userData'))), Date.now()).map((l) => sanitize(l, hc))
      return { sys, logs }
    }

    ctx.handle('preview', () => sysAndLogs())

    ctx.handle('capture', async () => {
      const win = ctx.window()
      if (!win || win.isDestroyed()) throw new Error('No hay ventana de Sloth para capturar.')
      const img = await win.webContents.capturePage()
      const small = img.getSize().width > 1280 ? img.resize({ width: 1280 }) : img
      const png = small.toPNG()
      const dir = join(app.getPath('userData'), 'reports')
      mkdirSync(dir, { recursive: true })
      // Solo se guarda una captura: la nueva reemplaza a la anterior.
      if (lastShot && existsSync(lastShot.file)) {
        try {
          unlinkSync(lastShot.file)
        } catch {
          /* ya no está */
        }
      }
      const file = join(dir, `captura-${Date.now()}.png`)
      writeFileSync(file, png)
      lastShot = { file, at: Date.now() }
      return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, name: basename(file) }
    })

    ctx.handle('submit', async (raw: unknown) => {
      const r = (raw ?? {}) as Record<string, unknown>
      const str = (v: unknown, max: number, what: string): string => {
        if (typeof v !== 'string') throw new Error(`Dato inválido: ${what}.`)
        if (v.length > max) throw new Error(`«${what}» es demasiado largo (máximo ${max} caracteres).`)
        return v
      }
      if (!TYPES.includes(r.type as ReportType)) throw new Error('Elegí el tipo de reporte.')
      const title = str(r.title, TITLE_MAX, 'Título').trim()
      if (title.length < TITLE_MIN) throw new Error(`El título tiene que tener al menos ${TITLE_MIN} caracteres.`)
      if (!Array.isArray(r.steps) || r.steps.length > STEPS_MAX) throw new Error('Pasos inválidos.')
      const steps = r.steps.map((s) => str(s, STEP_MAX, 'Paso'))
      const form: ReportForm = {
        type: r.type as ReportType,
        title,
        what: str(r.what ?? '', WHAT_MAX, '¿Qué pasó?'),
        expect: str(r.expect ?? '', EXPECT_MAX, '¿Qué esperabas?'),
        steps
      }
      const withSys = r.sys === true
      const withLogs = r.logs === true
      const withShot = r.shot === true
      if (withShot && (!lastShot || Date.now() - lastShot.at > SHOT_TTL_MS || !existsSync(lastShot.file)))
        throw new Error('La captura ya no está disponible: tomala de nuevo.')

      // Se sanitiza otra vez acá: lo que llegó desde la UI pudo editarse.
      const hc = hostContext(ctx)
      const fresh = sysAndLogs()
      const cleanTitle = sanitize(`[${REPORT_TYPES[form.type]}] ${title}`, hc)
      if (cleanTitle.length > TITLE_MAX) throw new Error(`El título tiene que tener como máximo ${TITLE_MAX} caracteres.`)
      const body = fitBody(
        sanitize(composeBody(form, withSys ? fresh.sys : null, withLogs ? fresh.logs : null), hc),
        BODY_MAX
      )
      if (body === null) throw new Error(`El texto es demasiado largo: recortalo (máximo ${BODY_MAX} caracteres).`)
      const url = buildIssueUrl(cleanTitle, body)
      if (url.length > URL_MAX) throw new Error('El texto es demasiado largo para abrirlo en GitHub: recortalo un poco.')

      // Host fijo: buildIssueUrl solo arma github.com/Toomasmg/sloth/issues/new.
      await shell.openExternal(url)
      // La captura no va en el link: se muestra la carpeta para arrastrarla al issue.
      if (withShot && lastShot) shell.showItemInFolder(lastShot.file)
      // La URL que se abrió: la pantalla de gracias la vuelve a abrir con «Ver en GitHub».
      return { shot: withShot && lastShot ? basename(lastShot.file) : null, url }
    })

    // Vuelve a abrir el issue prellenado. Solo acepta la URL que arma buildIssueUrl (nada de otros hosts).
    ctx.handle('open', async (url: unknown) => {
      if (!isIssueUrl(url)) throw new Error('Ese enlace no es del reporte de Sloth.')
      await shell.openExternal(url)
    })
  }
}

export default feature
