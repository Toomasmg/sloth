import { app, net, powerMonitor } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppUpdater, CancellationToken, UpdateInfo } from 'electron-updater'
import type { Feature, FeatureContext } from './context'
import { groupNotes, type NoteGroup } from './updater-notes'
import { currentSettings } from './settings'

/**
 * Actualizaciones automáticas desde los releases de GitHub (Toomasmg/sloth).
 * Solo en la app instalada. Un solo timer (unref): 20 s después del arranque y después cada 6 h.
 * Nada se descarga solo: la descarga la pide el usuario («Actualizar y reiniciar» o «Al cerrar Sloth»).
 * Las terminales viven en el daemon (copiado en userData/daemon-bin/<versión>), así que instalar
 * no las corta: la app nueva se reconecta al daemon viejo mientras tenga terminales vivas.
 */

export type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
export type UpdateChannel = 'estable' | 'beta'
export interface UpdateStatus {
  state: UpdateState
  version?: string
  /** Fecha de publicación del release (ISO). */
  releaseDate?: string
  /** Notas del release, agrupadas en Nuevo / Mejoras / Arreglos. */
  notes?: NoteGroup[]
  percent?: number
  /** Bytes descargados y total (solo mientras se descarga). */
  transferred?: number
  total?: number
  error?: string
  /** Última vez que terminó un chequeo (ms). */
  checkedAt?: number
  /** El último chequeo no encontró nada nuevo. */
  upToDate?: boolean
  /** «Más tarde»: se oculta el aviso y queda un punto en el acceso a Configuración. */
  later?: boolean
  /** «Al cerrar Sloth»: la versión se instala al salir. */
  queued?: boolean
  /** Canal elegido en Configuración (`updateChannel`). */
  channel: UpdateChannel
  /** false en desarrollo: no se buscan actualizaciones. */
  enabled: boolean
  current: string
}

const FIRST_CHECK_MS = 20_000
const EVERY_MS = 6 * 60 * 60 * 1000
const HIDDEN_RETRY_MS = 5 * 60 * 1000
const REPO_API = 'https://api.github.com/repos/Toomasmg/sloth/releases/tags'

let timer: NodeJS.Timeout | null = null

/**
 * «Más tarde»: la versión pospuesta y el día (local, AAAA-MM-DD). Sobrevive a reiniciar Sloth: el
 * aviso no vuelve con esa misma versión hasta el día siguiente (al arrancar, o en un chequeo).
 */
interface Postponed {
  version: string
  day: string
}
const laterFile = (): string => join(app.getPath('userData'), 'features', 'updater-later.json')
const dayNow = (): string => {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function readPostponed(): Postponed | null {
  try {
    const raw = JSON.parse(readFileSync(laterFile(), 'utf8').replace(/^﻿/, '')) as Partial<Postponed>
    return typeof raw.version === 'string' && typeof raw.day === 'string' ? { version: raw.version, day: raw.day } : null
  } catch {
    return null
  }
}
function writePostponed(p: Postponed): void {
  try {
    mkdirSync(dirname(laterFile()), { recursive: true })
    const tmp = `${laterFile()}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(p), 'utf8')
    renameSync(tmp, laterFile())
  } catch {
    /* sin disco: el aviso vuelve en el próximo arranque, nada más */
  }
}
/** ¿Esta versión quedó para después hoy? Otra versión, o el día siguiente, vuelve a avisar. */
const isPostponed = (version: string): boolean => {
  const p = readPostponed()
  return !!p && p.version === version && p.day === dayNow()
}

/** Canal de actualizaciones: se lee del archivo de Configuración (default «estable»). */
export function readChannel(): UpdateChannel {
  try {
    const raw = JSON.parse(readFileSync(join(app.getPath('userData'), 'features', 'settings.json'), 'utf8').replace(/^﻿/, '')) as Record<string, unknown>
    return raw?.updateChannel === 'beta' ? 'beta' : 'estable'
  } catch {
    return 'estable'
  }
}

/** Mensajes de error más cortos y en castellano para la UI. */
function friendly(e: unknown): string {
  const msg = String((e as Error)?.message ?? e ?? '')
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|net::/i.test(msg)) return 'No hay conexión con GitHub.'
  if (/404|No published versions|Cannot find latest/i.test(msg)) return 'Todavía no hay versiones publicadas.'
  if (/sha512 checksum mismatch/i.test(msg)) return 'La descarga llegó dañada; se reintenta en el próximo chequeo.'
  return msg.split('\n')[0].slice(0, 200) || 'Error desconocido.'
}

/** Las notas que trae el propio update, o si no, el cuerpo del release en GitHub (sin autenticación). */
async function fetchReleaseBody(version: string): Promise<{ body?: string; date?: string }> {
  for (const tag of [`v${version}`, version]) {
    try {
      const r = await withTimeout(net.fetch(`${REPO_API}/${tag}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Sloth' } }), 8000)
      if (!r.ok) continue
      const j = (await r.json()) as { body?: unknown; published_at?: unknown }
      return {
        body: typeof j.body === 'string' ? j.body : undefined,
        date: typeof j.published_at === 'string' ? j.published_at : undefined
      }
    } catch {
      /* sin red o sin release con ese tag: se prueba el siguiente */
    }
  }
  return {}
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

const notesText = (info: UpdateInfo): string => {
  const rn = info.releaseNotes
  if (typeof rn === 'string') return rn
  if (Array.isArray(rn)) return rn.map((x) => x.note ?? '').filter(Boolean).join('\n\n')
  return ''
}

const feature: Feature = {
  name: 'updater',
  register(ctx: FeatureContext) {
    let status: UpdateStatus = { state: 'idle', enabled: app.isPackaged, current: app.getVersion(), channel: readChannel() }
    const set = (patch: Partial<UpdateStatus>): void => {
      status = { ...status, ...patch }
      if (status.state !== 'downloading') {
        delete status.percent
        delete status.transferred
        delete status.total
      }
      ctx.emit('status', status)
    }

    let updater: AppUpdater | null = null
    let loading: Promise<AppUpdater> | null = null
    let waitingAc = false
    // Descarga en curso: `dlId` identifica la última; una cancelada o vieja no cambia el estado.
    let dlId = 0
    let dlActive = false
    let token: CancellationToken | null = null
    let Token: (new () => CancellationToken) | null = null

    async function load(): Promise<AppUpdater> {
      if (updater) return updater
      if (!loading) {
        loading = import('electron-updater').then((m) => {
          // Es CJS con `autoUpdater` como getter: desde import() puede venir solo en `default`.
          const mod = m as unknown as {
            autoUpdater?: AppUpdater
            default?: { autoUpdater: AppUpdater; CancellationToken?: new () => CancellationToken }
            CancellationToken?: new () => CancellationToken
          }
          const u: AppUpdater = mod.autoUpdater ?? mod.default!.autoUpdater
          Token = mod.CancellationToken ?? mod.default?.CancellationToken ?? null
          // Nunca se baja sola: la descarga la pide el usuario desde el aviso.
          u.autoDownload = false
          u.autoInstallOnAppQuit = true
          u.allowPrerelease = false
          u.logger = {
            info: (m2: unknown) => ctx.log(String(m2)),
            warn: (m2: unknown) => ctx.log('aviso:', String(m2)),
            error: (m2: unknown) => ctx.log('error:', String(m2)),
            debug: () => {}
          }
          u.on('checking-for-update', () => set({ state: 'checking', error: undefined }))
          u.on('update-available', (info) => {
            const same = status.version === info.version
            set({ state: 'available', version: info.version, upToDate: false, later: isPostponed(info.version), queued: same ? status.queued : false, releaseDate: info.releaseDate, error: undefined })
            void loadNotes(info)
          })
          u.on('update-not-available', () => {
            if (status.state !== 'ready') set({ state: 'idle', checkedAt: Date.now(), upToDate: true, version: undefined, notes: undefined, later: false, queued: false })
          })
          u.on('download-progress', (p) => {
            if (!dlActive) return
            const percent = Math.max(0, Math.min(100, Math.round(p.percent)))
            if (status.state !== 'downloading' || status.percent !== percent) set({ state: 'downloading', percent, transferred: p.transferred, total: p.total })
          })
          u.on('update-downloaded', (info) => {
            ctx.log(`lista la versión ${info.version}`)
            dlActive = false
            set({ state: 'ready', version: info.version, checkedAt: Date.now(), error: undefined })
          })
          u.on('error', (e) => {
            ctx.log('error al actualizar:', (e as Error)?.message ?? e)
            // Si ya hay una descargada (o una disponible tras cancelar), se mantiene: el error fue de otro paso.
            if (status.state !== 'ready' && status.state !== 'available') {
              dlActive = false
              set({ state: 'error', error: friendly(e), checkedAt: Date.now() })
            }
          })
          updater = u
          return u
        })
      }
      return loading
    }

    async function loadNotes(info: UpdateInfo): Promise<void> {
      let raw = notesText(info)
      let date = info.releaseDate
      if (!raw.trim()) {
        const r = await fetchReleaseBody(info.version)
        raw = r.body ?? ''
        date = date ?? r.date
      }
      // Si mientras tanto llegó otra versión, estas notas ya no sirven.
      if (status.version !== info.version) return
      set({ notes: groupNotes(raw), releaseDate: date })
    }

    async function check(manual: boolean): Promise<UpdateStatus> {
      if (!app.isPackaged) {
        if (manual) set({ state: 'error', error: 'En desarrollo no se buscan actualizaciones: solo en la app instalada.' })
        return status
      }
      if (status.state === 'checking' || status.state === 'downloading' || status.state === 'ready') return status
      if (!net.isOnline()) {
        if (manual) set({ state: 'error', error: 'No hay conexión a internet.' })
        else ctx.log('sin red: se saltea el chequeo')
        return status
      }
      if (!manual && powerMonitor.isOnBatteryPower()) {
        ctx.log('con batería: se saltea el chequeo automático hasta enchufar')
        if (!waitingAc) {
          waitingAc = true
          powerMonitor.once('on-ac', () => {
            waitingAc = false
            void check(false)
          })
        }
        return status
      }
      try {
        const u = await load()
        const channel = readChannel()
        // Beta: también cuenta como nueva versión un prerelease. Se aplica en cada chequeo.
        u.allowPrerelease = channel === 'beta'
        set({ channel })
        await u.checkForUpdates()
      } catch (e) {
        if ((status.state as UpdateState) !== 'ready') set({ state: 'error', error: friendly(e), checkedAt: Date.now() })
      }
      return status
    }

    async function download(): Promise<UpdateStatus> {
      if (!app.isPackaged) throw new Error('En desarrollo no hay actualizaciones que descargar.')
      if (status.state === 'ready' || status.state === 'downloading') return status
      if (!status.version) throw new Error('Primero buscá una actualización.')
      const u = await load()
      const id = ++dlId
      token = new Token!()
      dlActive = true
      set({ state: 'downloading', percent: 0, error: undefined })
      u.downloadUpdate(token).catch((e: unknown) => {
        // Cancelada o reemplazada por otra descarga: no es un error para mostrar.
        if (id !== dlId) return
        dlActive = false
        if (status.state !== 'ready') set({ state: 'error', error: friendly(e), checkedAt: Date.now() })
      })
      return status
    }

    function cancel(): UpdateStatus {
      if (status.state !== 'downloading') return status
      dlId++
      dlActive = false
      token?.cancel()
      token = null
      set({ state: 'available', queued: false })
      return status
    }

    function schedule(ms: number): void {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        // Ventana oculta o minimizada (bandeja): no se busca. Se reintenta en 5 min.
        const w = ctx.window()
        if (!w || w.isDestroyed() || !w.isVisible() || w.isMinimized()) return schedule(HIDDEN_RETRY_MS)
        void check(false).finally(() => schedule(currentSettings().lightMode ? EVERY_MS * 2 : EVERY_MS))
      }, ms)
      timer.unref()
    }
    if (app.isPackaged) schedule(FIRST_CHECK_MS)

    ctx.handle('status', () => status)
    ctx.handle('check', () => check(true))
    ctx.handle('download', () => download())
    ctx.handle('cancel', () => cancel())
    // «Más tarde»: oculta el aviso; el punto del acceso a Configuración queda hasta actualizar.
    ctx.handle('later', () => {
      if ((status.state === 'available' || status.state === 'ready' || status.state === 'downloading') && status.version) {
        writePostponed({ version: status.version, day: dayNow() })
        set({ later: true })
      }
      return status
    })
    // «Al cerrar Sloth»: se descarga (si hace falta) y se instala al salir (autoInstallOnAppQuit).
    ctx.handle('queue', async () => {
      if (status.state !== 'ready' && status.state !== 'downloading') {
        await download()
      }
      set({ queued: true, later: false })
      return status
    })
    ctx.handle('install', async () => {
      if (status.state !== 'ready' || !updater) throw new Error('Todavía no hay una actualización descargada.')
      ctx.log(`instalando ${status.version}; las terminales siguen en el daemon`)
      // Silencioso y vuelve a abrir Sloth al terminar. before-quit deja cerrar aunque esté la bandeja.
      setImmediate(() => updater!.quitAndInstall(true, true))
      return true
    })
  },
  dispose() {
    if (timer) clearTimeout(timer)
    timer = null
  }
}

export default feature
