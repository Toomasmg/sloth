import { useEffect, useRef, useState } from 'react'
import { ArrowCircleUp, ArrowsClockwise, CheckCircle, DownloadSimple, GithubLogo, Info, WarningCircle, X } from '@phosphor-icons/react'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
import { onOpenAbout, openAbout } from './bus'
import { useUpdateStatus, type UpdateStatus } from './useUpdateStatus'
import './updater.css'

const REPO_URL = 'https://github.com/Toomasmg/sloth'

const errText = (e: unknown): string =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Chip en la barra de título: solo aparece cuando hay algo para mostrar. */
function UpdateChip(): React.JSX.Element | null {
  const st = useUpdateStatus()
  if (!st) return null
  if (st.state === 'downloading') {
    const pct = st.percent ?? 0
    return (
      <button
        type="button"
        className="tb-chip f-updater-chip"
        onClick={openAbout}
        title={`Descargando Sloth ${st.version ?? ''}`}
        aria-label={`Descargando actualización ${pct} por ciento`}
      >
        <DownloadSimple size={12} weight="bold" aria-hidden="true" />
        Actualizando {pct} %
        <span className="f-updater-bar" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
      </button>
    )
  }
  if (st.state === 'ready') {
    return (
      <button
        type="button"
        className="tb-chip f-updater-chip ready"
        onClick={openAbout}
        title={`Sloth ${st.version} ya está descargado`}
      >
        <ArrowCircleUp size={13} weight="fill" aria-hidden="true" />
        Actualización lista · Reiniciar
      </button>
    )
  }
  return null
}

function statusLine(st: UpdateStatus): { icon: React.ReactNode; text: string; tone: string } {
  switch (st.state) {
    case 'checking':
      return { icon: <ArrowsClockwise size={14} className="f-updater-spin" aria-hidden="true" />, text: 'Buscando actualizaciones…', tone: '' }
    case 'available':
      return { icon: <DownloadSimple size={14} aria-hidden="true" />, text: `Hay una versión nueva (${st.version}); se está por descargar.`, tone: 'info' }
    case 'downloading':
      return { icon: <DownloadSimple size={14} aria-hidden="true" />, text: `Descargando ${st.version ?? ''}: ${st.percent ?? 0} %`, tone: 'info' }
    case 'ready':
      return { icon: <ArrowCircleUp size={14} weight="fill" aria-hidden="true" />, text: `Sloth ${st.version} está lista para instalar.`, tone: 'ready' }
    case 'error':
      return { icon: <WarningCircle size={14} aria-hidden="true" />, text: st.error ?? 'No se pudo buscar actualizaciones.', tone: 'error' }
    default:
      if (!st.enabled) return { icon: <Info size={14} aria-hidden="true" />, text: 'Versión de desarrollo: las actualizaciones automáticas solo corren en la app instalada.', tone: '' }
      if (st.upToDate)
        return {
          icon: <CheckCircle size={14} weight="fill" aria-hidden="true" />,
          text: `Tenés la última versión${st.checkedAt ? ` (revisado ${new Date(st.checkedAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })})` : ''}.`,
          tone: 'ok'
        }
      return { icon: <Info size={14} aria-hidden="true" />, text: 'Sloth busca actualizaciones solo, cada 6 horas.', tone: '' }
  }
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
        aria-labelledby="f-updater-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2 id="f-updater-title">Acerca de Sloth</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={16} aria-hidden="true" />
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

        {ready && (
          <p className="f-updater-note">
            Las terminales siguen corriendo; Sloth se reinicia en la versión {st?.version}.
          </p>
        )}

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
            <GithubLogo size={14} aria-hidden="true" /> Repositorio
          </a>
          <span className="f-updater-grow" />
          {ready ? (
            <button type="button" className="btn primary" onClick={() => void install()} disabled={busy} autoFocus>
              <ArrowCircleUp size={15} aria-hidden="true" />
              {busy ? 'Reiniciando…' : 'Reiniciar y actualizar'}
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => void check()} disabled={checking || st?.enabled === false}>
              <ArrowsClockwise size={14} aria-hidden="true" /> Buscar actualizaciones
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

function Global(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  useEffect(() => onOpenAbout(() => setOpen(true)), [])
  return open ? <AboutModal onClose={() => setOpen(false)} /> : null
}

const ui: FeatureUi = {
  name: 'updater',
  Titlebar: UpdateChip,
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
