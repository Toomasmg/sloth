import { useEffect, useState } from 'react'
import { useUi } from '../host'
import { DoneIcon, ErrorIcon, UpdateIcon } from '../../icons/SlothIcons'
import { Modal } from '../../Modal'
import logo from '../../assets/sloth-logo.png'
import { setPhase, setRestarting, usePhase } from './phase'
import { showUpdateToast } from './bus'
import { useUpdateStatus, type NoteGroup, type UpdateStatus } from './useUpdateStatus'

const REPO_URL = 'https://github.com/Toomasmg/sloth'

const errText = (e: unknown): string =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const mb = (bytes: number | undefined): string => ((bytes ?? 0) / 1_000_000).toFixed(1).replace('.', ',')

/** Ícono de trazo con el path del artboard (los diálogos de actualización usan estos, no los de SlothIcons). */
function Ico({ d, size, sw = 2, className }: { d: string; size: number; sw?: number; className?: string }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d={d} />
    </svg>
  )
}

const ICON_UPDATE = 'M12 4l1.8 4.7 4.7 1.8-4.7 1.8L12 17l-1.8-4.7-4.7-1.8 4.7-1.8z'

/** Color, fondo y ícono por grupo de novedades: Nuevo / Mejoras / Arreglos (artboard: los tonos «-fg» claros). */
const GROUP_TONE: Record<string, { fg: string; bg: string; icon: string }> = {
  nuevo: { fg: 'var(--info)', bg: 'var(--info-soft)', icon: ICON_UPDATE },
  mejoras: { fg: 'var(--success-fg)', bg: 'var(--done-soft)', icon: 'M5 16l4.5-4.5 3 3L19 7.5M14.5 7.5H19v4.5' },
  arreglos: { fg: 'var(--warn-fg)', bg: 'var(--waiting-soft)', icon: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17zM8.5 12.5l2.5 2.5 4.5-5' }
}
const toneOf = (g: NoteGroup): { fg: string; bg: string; icon: string } => GROUP_TONE[g.id] ?? { fg: 'var(--text-2)', bg: 'var(--raised)', icon: ICON_UPDATE }

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
export function UpdateDialogs(): React.JSX.Element | null {
  const ui = useUi()
  const st = useUpdateStatus()
  const { phase, restarting } = usePhase()
  const [err, setErr] = useState<string | null>(null)

  const close = (): void => {
    if (restarting) return
    setPhase(null)
    setErr(null)
  }

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
  const queue = (): void =>
    void call('feat:updater:queue', () => {
      setPhase(null)
      showUpdateToast(`La ${v} se instala cuando cierres Sloth`)
    })
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
  let subtitle: React.ReactNode = null
  let icon: React.ReactNode = null
  let stage = ''

  if (restarting) {
    stage = 'restarting'
    title = 'Reiniciando Sloth…'
    subtitle = `Ya vuelve con la ${v}.`
    icon = (
      <span className="f-updater-ico round">
        <Ico d="M12 4a8 8 0 1 1-8 8" size={18} className="f-updater-spin" />
      </span>
    )
    body = null
  } else if (phase === 'notes' && st.state !== 'error') {
    stage = 'notes'
    title = `Sloth ${v}`
    subtitle = `${st.releaseDate ? `Publicada el ${fmtDate(st.releaseDate)} · ` : ''}Tenés la ${cur}`
    icon = <img src={logo} alt="" className="f-updater-logo" />
    const groups = st.notes ?? []
    body = (
      <>
        <div className="f-updater-notes">
          {groups.length === 0 && <p className="f-updater-muted">Esta versión no trae notas de cambios.</p>}
          {groups.map((g) => {
            const t = toneOf(g)
            return (
              <section key={g.id} aria-labelledby={`f-up-${g.id}`} className="f-updater-group">
                <h3 id={`f-up-${g.id}`} style={{ color: t.fg }}>
                  <span className="f-updater-gdot" style={{ background: t.bg, color: t.fg }} aria-hidden="true">
                    <Ico d={t.icon} size={13} />
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
            Más tarde
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
    stage = 'error'
    title = 'No se pudo descargar. Revisá tu conexión.'
    subtitle = `Sloth ${v} no se instaló. La ${cur} sigue funcionando.${st.error ? ` (${st.error})` : ''}`
    icon = (
      <span className="f-updater-ico danger">
        <Ico d="M12 3.5l7 3v5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9v-5zM12 8.5v4M12 15.5h.01" size={18} sw={1.8} />
      </span>
    )
    body = (
      <>
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
    stage = 'ready'
    title = 'Listo para reiniciar'
    subtitle = `Sloth ${v} ya está descargada.`
    icon = (
      <span className="f-updater-ico ok">
        <Ico d="M5 12.5l4.5 4.5L19 7.5" size={18} sw={2.2} />
      </span>
    )
    body = (
      <>
        <p className="f-updater-box">
          Al reiniciar, Sloth se cierra y se vuelve a abrir. Los espacios y las terminales vuelven solos después, con la misma distribución y la misma cuenta.
        </p>
        <footer className="f-updater-actions">
          <button type="button" className="btn ghost" onClick={close}>
            Más tarde
          </button>
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
    stage = 'dl'
    title = `Descargando Sloth ${v}`
    subtitle = 'Se instala cuando reinicie Sloth.'
    icon = (
      <span className="f-updater-ico">
        <Ico d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14" size={18} sw={1.8} />
      </span>
    )
    const pct = st.percent ?? 0
    const haveTotal = (st.total ?? 0) > 0
    body = (
      <>
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
          <button type="button" className="btn ghost" onClick={close} data-autofocus>
            Más tarde
          </button>
          <span className="f-updater-grow" />
          <button
            type="button"
            className="btn"
            onClick={() =>
              void call('feat:updater:cancel', () => {
                setPhase(null)
                showUpdateToast(`Descarga cancelada. La ${v} sigue disponible.`)
              })
            }
          >
            Cancelar descarga
          </button>
        </footer>
      </>
    )
  } else {
    return null
  }

  return (
    <Modal
      key={stage}
      bare
      backdropClassName="modal-backdrop f-updater-backdrop"
      className={`f-updater-dialog${stage === 'error' ? ' is-err' : ''}`}
      headClassName="f-updater-head"
      titlesClassName="f-updater-titles"
      icon={icon}
      title={title}
      subtitle={subtitle}
      backdropClose
      locked={restarting}
      onClose={close}
    >
      {body}
      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}
    </Modal>
  )
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' })
}

export function AboutModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const ui = useUi()
  const st = useUpdateStatus()
  const [closeToTray, setCloseToTray] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    ui.invoke<{ closeToTray: boolean }>('feat:tray:get').then((s) => setCloseToTray(s.closeToTray), () => setCloseToTray(null))
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
    <Modal className="f-updater-modal" title="Acerca de Sloth" backdropClose onClose={onClose}>
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
    </Modal>
  )
}

