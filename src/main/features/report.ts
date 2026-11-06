import { app, shell } from 'electron'
import os from 'node:os'
import type { Feature, FeatureContext } from './context'
import { logFileFor } from '../../daemon/paths'
import {
  buildIssueUrl,
  composeBody,
  fitBody,
  readLogTail,
  sanitize,
  BODY_MAX,
  TITLE_MAX,
  URL_MAX,
  type SanitizeContext
} from './report-core'

/**
 * Función «report» (lado main): «Reportar un problema». Arma un borrador (versión, sistema, cuentas
 * y espacios como números, últimas líneas del registro) y lo SANITIZA. La UI lo muestra y el usuario
 * lo revisa. Al abrir, vuelve a sanitizar en main y abre el issue en github.com (host fijo).
 * Canales: feat:report:preview(), feat:report:open(title, body).
 */

const TOO_LONG = `El texto es demasiado largo: recortalo (máximo ${BODY_MAX} caracteres).`

/** Datos de esta PC para sanitizar. Nada de esto sale a GitHub sin pasar por el filtro. */
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
    ctx.handle('preview', () => {
      const hc = hostContext(ctx)
      const logLines = readLogTail(logFileFor(app.getPath('userData')))
      const raw = composeBody(
        {
          sloth: app.getVersion(),
          windows: `${os.version()} · ${os.release()}`,
          arch: process.arch,
          electron: process.versions.electron ?? '',
          daemon: daemonLine(ctx),
          accounts: ctx.store.accounts.length,
          workspaces: ctx.store.workspaces.length
        },
        logLines
      )
      const body = fitBody(sanitize(raw, hc), BODY_MAX) ?? sanitize(raw, hc).slice(0, BODY_MAX)
      const title = sanitize(`Problema en Sloth ${app.getVersion()}`, hc)
      return { title, body, logLines: logLines.length }
    })

    ctx.handle('open', async (title: unknown, body: unknown) => {
      if (typeof title !== 'string' || typeof body !== 'string') throw new Error('Datos del reporte inválidos.')
      const t = title.trim()
      if (t.length === 0 || t.length > TITLE_MAX) throw new Error(`El título tiene que tener entre 1 y ${TITLE_MAX} caracteres.`)
      if (body.length > 50_000) throw new Error(TOO_LONG)

      // Se vuelve a filtrar acá: el texto llegó desde la UI y el usuario pudo editarlo.
      const hc = hostContext(ctx)
      const cleanTitle = sanitize(t, hc)
      if (cleanTitle.length > TITLE_MAX) throw new Error(`El título tiene que tener como máximo ${TITLE_MAX} caracteres.`)
      const cleanBody = fitBody(sanitize(body, hc), BODY_MAX)
      if (cleanBody === null) throw new Error(TOO_LONG)

      const url = buildIssueUrl(cleanTitle, cleanBody)
      if (url.length > URL_MAX) throw new Error('El texto es demasiado largo para abrirlo en GitHub: recortalo un poco.')
      // Host fijo: buildIssueUrl solo arma github.com/Toomasmg/sloth/issues/new. No hay parámetro de URL.
      await shell.openExternal(url)
    })
  }
}

export default feature
