import { useEffect, useRef, useState } from 'react'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
import { DoneIcon, ErrorIcon, UpdateIcon, CloseIcon } from '../../icons/SlothIcons'
import logo from '../../assets/sloth-logo.png'
import { onOpenAbout, openAbout } from './bus'
import { setPhase, setRestarting, usePhase } from './phase'
import { useUpdateDot, useUpdateStatus, type NoteGroup, type UpdateStatus } from './useUpdateStatus'
import './updater.css'

const REPO_URL = 'https://github.com/Toomasmg/sloth'

/**
 * Punto del acceso a Configuración (el engranaje lo muestra): hay una versión que quedó para después
 * con «Más tarde». Lo pinta el engranaje de features/settings; no hace nada más.
 */
export function UpdateDot(): React.JSX.Element | null {
  return useUpdateDot() ? <span className="f-updater-dot" role="img" aria-label="Hay una versión pendiente" title="Hay una versión pendiente" /> : null
}

const errText = (e: unknown): string =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const mb = (bytes: number | undefined): string => ((bytes ?? 0) / 1_000_000).toFixed(1).replace('.', ',')

/** Color y fondo por grupo de novedades: Nuevo / Mejoras / Arreglos (tokens del tema). */
const GROUP_TONE: Record<string, { fg: string; bg: string }> = {
  nuevo: { fg: 'var(--info)', bg: 'var(--info-soft)' },
  mejoras: { fg: 'var(--success)', bg: 'var(--success-soft)' },
  arreglos: { fg: 'var(--warn)', bg: 'var(--warn-soft)' }
}
const toneOf = (g: NoteGroup): { fg: string; bg: string } => GROUP_TONE[g.id] ?? { fg: 'var(--fg-2)', bg: 'var(--card)' }

/**
 * Aviso discreto en la barra superior: «Hay una versión nueva» con «Ver novedades» y «Más tarde».
 * «Más tarde» lo oculta y deja un punto en el acceso a Configuración (ver useUpdateDot).
 */
function UpdateBanner(): React.JSX.Element | null {
  const ui = useUi()
  const st = useUpdateStatus()
  const { phase } = usePhase()
  if (!st || !st.version || st.later) return null
  const v = st.version
  const queued = !!st.queued

  let text: string | null = null
  let actions: React.ReactNode = null
  if (st.state === 'available') {
    if (queued) text = `La ${v} se instala al cerrar Sloth`
    else {
      text = `Hay una versión nueva (${v})`
      actions = (
        <>
          <button type="button" className="btn primary sm" onClick={() => setPhase('notes')}>
            Ver novedades
          </button>
          <button type="button" className="btn ghost sm" onClick={() => void ui.invoke('feat:updater:later').catch(() => {})}>
            Más tarde
          </button>
        </>
      )
    }
  } else if (st.state === 'downloading') {
    text = queued ? `La ${v} se instala al cerrar Sloth` : `Descargando ${v}: ${st.percent ?? 0} %`
  } else if (st.state === 'ready') {
    if (queued) text = `La ${v} se instala al cerrar Sloth`
    else {
      text = `Sloth ${v} ya está descargada`
      actions = (
        <button type="button" className="btn primary sm" onClick={() => setPhase('dl')}>
          Reiniciar
        </button>
      )
    }
  }
  if (!text || (phase === 'dl' && st.state === 'downloading')) return null

  return (
    <div role="status" className="f-updater-banner">
      <UpdateIcon size={14} />
      <span className="f-updater-banner-text">{text}</span>
      {actions}
    </div>
  )
}

function statusLine(st: UpdateStatus): { icon: React.ReactNode; text: string; tone: string } {
  switch (st.state) {
    case 'checking':
      return { icon: <UpdateIcon size={14} className="f-updater-spin" />, text: 'Buscando actualizaciones…', tone: '' }
    case 'available':
      return { icon: <UpdateIcon size={14} />, text: `Hay una versión nueva (${st.version}).`, tone: 'info' }
    case 'downloading':
      return { icon: <UpdateIcon size={14} />, text: `Descargando ${st.version ?? ''}: ${st.percent ?? 0} %`, tone: 'info' }
    case 'ready':
      return { icon: <DoneIcon size={14} />, text: `Sloth ${st.version} está lista para instalar.`, tone: 'ready' }
    case 'error':
      return { icon: <ErrorIcon size={14} />, text: st.error ?? 'No se pudo buscar actualizaciones.', tone: 'error' }
    default:
      if (!st.enabled) return { icon: null, text: 'Versión de desarrollo: las actualizaciones automáticas solo corren en la app instalada.', tone: '' }
      if (st.upToDate)
        return {
          icon: <DoneIcon size={14} />,
          text: `Tenés la última versión${st.checkedAt ? ` (revisado ${new Date(st.checkedAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })})` : ''}.`,
          tone: 'ok'
        }
      return { icon: null, text: 'Sloth busca actualizaciones solo, cada 6 horas.', tone: '' }
  }
}

/** Diálogos de la actualización: novedades, descarga, listo para reiniciar, error y reiniciando. */
function UpdateDialogs(): React.JSX.Element | null {
  const ui = useUi()
  const st = useUpdateStatus()
  const { phase, restarting } = usePhase()
  const [err, setErr] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const close = (): void => {
    if (restarting) return
    setPhase(null)
    setErr(null)
  }

  useEffect(() => {
    if (!phase) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    ref.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, restarting])

  if (!st || !st.version || !phase) return null
  const v = st.version
  const cur = st.current
  const call = async (channel: string, after?: () => void): Promise<void> => {
    setErr(null)
    try {
      await ui.invoke(channel)
      after?.()
    } catch (e) {
      setErr(errText(e))
    }
  }
  const startDownload = (): void => {
    setPhase('dl')
    void call('feat:updater:download')
  }
  const queue = (): void => void call('feat:updater:queue', () => setPhase(null))
  const restartNow = async (): Promise<void> => {
    setRestarting(true)
    setErr(null)
    try {
      await ui.invoke('feat:updater:install')
    } catch (e) {
      setRestarting(false)
      setErr(errText(e))
    }
  }

  let body: React.ReactNode
  let title = ''

  if (restarting) {
    title = 'Reiniciando Sloth…'
    body = (
      <>
        <div className="f-updater-head" role="status">
          <span className="f-updater-ico round">
            <UpdateIcon size={18} className="f-updater-spin" />
          </span>
          <div className="f-updater-titles">
            <h2 id="f-updater-title">{title}</h2>
            <p>Ya vuelve con la {v}.</p>
          </div>
        </div>
      </>
    )
  } else if (phase === 'notes' && st.state !== 'error') {
    title = `Sloth ${v}`
    const groups = st.notes ?? []
    body = (
      <>
        <div className="f-updater-head">
          <img src={logo} alt="" className="f-updater-logo" />
          <div className="f-updater-titles">
            <h2 id="f-updater-title">Sloth {v}</h2>
            <p>
              {st.releaseDate ? `Publicada el ${fmtDate(st.releaseDate)} · ` : ''}Tenés la {cur}
            </p>
          </div>
        </div>
        <div className="f-updater-notes">
          {groups.length === 0 && <p className="f-updater-muted">Esta versión no trae notas de cambios.</p>}
          {groups.map((g) => {
            const t = toneOf(g)
            return (
              <section key={g.id} aria-labelledby={`f-up-${g.id}`} className="f-updater-group">
                <h3 id={`f-up-${g.id}`} style={{ color: t.fg }}>
                  <span className="f-updater-gdot" style={{ background: t.bg, color: t.fg }} aria-hidden="true">
                    {g.id === 'arreglos' ? <DoneIcon size={12} /> : <UpdateIcon size={12} />}
                  </span>
                  {g.label}
                </h3>
                <ul>
                  {g.items.map((it, i) => (
                    <li key={i}>
                      <span className="f-updater-bullet" style={{ background: t.fg }} aria-hidden="true" />
                      <span>{it}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
        <footer className="f-updater-actions">
          <button type="button" className="btn ghost" onClick={close}>
            Ahora no
          </button>
          <span className="f-updater-grow" />
          <button type="button" className="btn" onClick={queue}>
            Al cerrar Sloth
          </button>
          <button type="button" className="btn primary" onClick={startDownload} autoFocus>
            Actualizar y reiniciar
          </button>
        </footer>
      </>
    )
  } else if (st.state === 'error') {
    title = 'No se pudo descargar. Revisá tu conexión.'
    body = (
      <>
        <div className="f-updater-head" role="alert">
          <span className="f-updater-ico danger">
            <ErrorIcon size={18} />
          </span>
          <div className="f-updater-titles">
            <h2 id="f-updater-title">{title}</h2>
            <p>
              Sloth {v} no se instaló. La {cur} sigue funcionando.
              {st.error ? ` (${st.error})` : ''}
            </p>
          </div>
        </div>
        <footer className="f-updater-actions">
          <button type="button" className="btn ghost" onClick={close}>
            Cerrar
          </button>
          <span className="f-updater-grow" />
          <button type="button" className="btn primary" onClick={() => (st.version ? void call('feat:updater:download') : void call('feat:updater:check'))} autoFocus>
            Reintentar
          </button>
        </footer>
      </>
    )
  } else if (st.state === 'ready') {
    title = 'Listo para reiniciar'
    body = (
      <>
        <div className="f-updater-head">
          <span className="f-updater-ico ok">
            <DoneIcon size={18} />
          </span>
          <div className="f-updater-titles">
            <h2 id="f-updater-title">{title}</h2>
            <p>Sloth {v} ya está descargada.</p>
          </div>
        </div>
        <p className="f-updater-box">
          Al reiniciar, Sloth se cierra y se vuelve a abrir. Los espacios y las terminales vuelven solos después, con la misma distribución y la misma cuenta.
        </p>
        <footer className="f-updater-actions">
          <span className="f-updater-grow" />
          <button type="button" className="btn" onClick={queue}>
            Al cerrar Sloth
          </button>
          <button type="button" className="btn primary" onClick={() => void restartNow()} autoFocus>
            Reiniciar ahora
          </button>
        </footer>
      </>
    )
  } else if (st.state === 'downloading' || st.state === 'available') {
    // Descargando (o volvió a «disponible» tras cancelar): progreso real.
    title = `Descargando Sloth ${v}`
    const pct = st.percent ?? 0
    const haveTotal = (st.total ?? 0) > 0
    body = (
      <>
        <div className="f-updater-head">
          <span className="f-updater-ico">
            <UpdateIcon size={18} />
          </span>
          <div className="f-updater-titles">
            <h2 id="f-updater-title">{title}</h2>
            <p>Se instala cuando reinicie Sloth.</p>
          </div>
        </div>
        <div className="f-updater-progress">
          <div className="f-updater-track" role="progressbar" aria-label="Progreso de la descarga" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div style={{ width: `${pct}%` }} />
          </div>
          <div className="f-updater-nums mono">
            <span>{pct} %</span>
            <span>{haveTotal ? `${mb(st.transferred)} de ${mb(st.total)} MB` : 'Conectando…'}</span>
          </div>
        </div>
        <footer className="f-updater-actions">
          <span className="f-updater-grow" />
          <button type="button" className="btn" onClick={() => void call('feat:updater:cancel', () => setPhase(null))}>
            Cancelar
          </button>
        </footer>
      </>
    )
  } else {
    return null
  }

  return (
    <div className="modal-backdrop f-updater-backdrop" onMouseDown={close}>
      <section
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="f-updater-title"
        className="f-updater-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {body}
        {err && (
          <p className="form-error" role="alert">
            {err}
          </p>
        )}
        {!restarting && (
          <button type="button" className="icon-btn f-updater-x" onClick={close} aria-label="Cerrar">
            <CloseIcon size={14} />
          </button>
        )}
      </section>
    </div>
  )
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' })
}

function AboutModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const ui = useUi()
  const st = useUpdateStatus()
  const [closeToTray, setCloseToTray] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ui.invoke<{ closeToTray: boolean }>('feat:tray:get').then((s) => setCloseToTray(s.closeToTray), () => setCloseToTray(null))
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    dialogRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const check = async (): Promise<void> => {
    setErr(null)
    try {
      await ui.invoke('feat:updater:check')
    } catch (e) {
      setErr(errText(e))
    }
  }
  const install = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      await ui.invoke('feat:updater:install')
    } catch (e) {
      setErr(errText(e))
      setBusy(false)
    }
  }
  const toggleTray = async (v: boolean): Promise<void> => {
    setCloseToTray(v)
    try {
      const s = await ui.invoke<{ closeToTray: boolean }>('feat:tray:set', { closeToTray: v })
      setCloseToTray(s.closeToTray)
    } catch (e) {
      setCloseToTray(!v)
      setErr(errText(e))
    }
  }

  const line = st ? statusLine(st) : null
  const ready = st?.state === 'ready'
  const checking = st?.state === 'checking' || st?.state === 'downloading' || st?.state === 'available'

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="modal f-updater-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="f-updater-about-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2 id="f-updater-about-title">Acerca de Sloth</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <CloseIcon size={16} />
          </button>
        </header>

        <div className="f-updater-id">
          <div>
            <div className="f-updater-name">Sloth</div>
            <div className="hint">Varias cuentas de Claude Code, cada una en su PowerShell y su repo.</div>
          </div>
          <span className="tag mono">v{st?.current ?? '…'}</span>
        </div>

        {line && (
          <p className={`f-updater-status ${line.tone}`} role="status" aria-live="polite">
            {line.icon}
            <span>{line.text}</span>
          </p>
        )}

        {ready && <p className="f-updater-note">Las terminales siguen corriendo; Sloth se reinicia en la versión {st?.version}.</p>}

        <label className="switch">
          <span className="switch-text">
            Al cerrar, seguir en la bandeja
            <span className="hint f-updater-sub">La ventana se oculta y Sloth sigue avisándote desde la bandeja.</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={closeToTray === true}
            disabled={closeToTray === null}
            onChange={(e) => void toggleTray(e.target.checked)}
          />
          <span className="switch-track" aria-hidden="true" />
        </label>

        {err && (
          <p className="form-error" role="alert">
            {err}
          </p>
        )}

        <footer className="modal-actions f-updater-actions">
          <a className="btn ghost sm" href={REPO_URL} target="_blank" rel="noreferrer">
            Repositorio
          </a>
          <span className="f-updater-grow" />
          {ready ? (
            <button type="button" className="btn primary" onClick={() => void install()} disabled={busy} autoFocus>
              {busy ? 'Reiniciando…' : 'Reiniciar y actualizar'}
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => void check()} disabled={checking || st?.enabled === false}>
              Buscar actualizaciones
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

function Global(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  useEffect(() => onOpenAbout(() => setOpen(true)), [])
  return (
    <>
      <UpdateDialogs />
      {open && <AboutModal onClose={() => setOpen(false)} />}
    </>
  )
}

const ui: FeatureUi = {
  name: 'updater',
  Titlebar: UpdateBanner,
  Global,
  commands: (ctx) => [
    {
      id: 'updater:check',
      title: 'Buscar actualizaciones',
      group: 'Sloth',
      keywords: 'update actualizar version nueva',
      run: () => {
        openAbout()
        void ctx.invoke('feat:updater:check').catch(() => {})
      }
    },
    {
      id: 'updater:notes',
      title: 'Ver novedades de la versión',
      group: 'Sloth',
      keywords: 'novedades cambios release notas actualizacion',
      run: () => setPhase('notes')
    },
    {
      id: 'updater:about',
      title: 'Acerca de Sloth',
      subtitle: 'Versión, repositorio y bandeja',
      group: 'Sloth',
      keywords: 'about version bandeja tray cerrar',
      run: openAbout
    }
  ]
}

export default ui
