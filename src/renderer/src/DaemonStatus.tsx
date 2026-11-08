import { useCallback, useEffect, useRef, useState } from 'react'
import type { DaemonInfo } from '../../shared/types'
import { api } from './api'
import { cleanError } from './format'
import { useVisiblePolling } from './visibility'
import { ChevronDownIcon, PowerIcon, ServerIcon, TerminalIcon } from './icons/SlothIcons'

/** Chip de la barra de título: dónde corren las terminales, y botón para apagarlas todas. */
export function DaemonStatus(): React.JSX.Element | null {
  const [info, setInfo] = useState<DaemonInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const chip = useRef<HTMLButtonElement>(null)

  const refresh = useCallback(() => {
    void api
      .daemonInfo()
      .then((i) => setInfo(i))
      .catch(() => undefined)
  }, [])
  useVisiblePolling(refresh, 15_000)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        chip.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!info) return null
  const daemon = info.mode === 'daemon'

  const shutdown = async (): Promise<void> => {
    if (!window.confirm('¿Apagar todas las terminales?\n\nSe cierran todas las PowerShell y los Claude que estén corriendo.')) return
    setBusy(true)
    setError(null)
    try {
      await api.shutdownTerminals()
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
      refresh()
    }
  }

  return (
    <div className="daemon" ref={wrap}>
      <button
        ref={chip}
        type="button"
        className={`tb-chip tb-daemon ${daemon ? '' : 'simple'}`}
        onClick={() => {
          setOpen((o) => !o)
          refresh()
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={daemon ? 'Terminales persistentes' : 'Modo simple'}
        title={daemon ? 'Las terminales siguen corriendo aunque cierres Sloth' : info.reason ?? 'Las terminales viven dentro de la app'}
      >
        {daemon ? <ServerIcon size={12} /> : <TerminalIcon size={12} />}
        <span className="tb-daemon-label">{daemon ? 'Terminales persistentes' : 'Modo simple'}</span>
        <ChevronDownIcon size={10} />
      </button>
      {open && (
        <div className="daemon-pop" role="dialog" aria-label="Estado de las terminales">
          <p className="daemon-lead">
            {daemon
              ? 'Las PowerShell corren en un proceso aparte: sobreviven si cerrás o reiniciás Sloth.'
              : 'Las PowerShell corren dentro de Sloth: se cierran con la app.'}
          </p>
          {!daemon && info.reason && <p className="daemon-reason">{info.reason}</p>}
          <dl className="daemon-info">
            <div>
              <dt>Modo</dt>
              <dd>{daemon ? 'Persistente' : 'Simple'}</dd>
            </div>
            <div>
              <dt>Sesiones</dt>
              <dd className="mono">{info.sessions}</dd>
            </div>
            {info.pid !== undefined && (
              <div>
                <dt>PID</dt>
                <dd className="mono">{info.pid}</dd>
              </div>
            )}
            {info.version && (
              <div>
                <dt>Versión</dt>
                <dd className="mono">{info.version}</dd>
              </div>
            )}
          </dl>
          <button type="button" className="btn sm danger daemon-off" disabled={busy} onClick={() => void shutdown()}>
            <PowerIcon size={14} />
            {busy ? 'Apagando…' : 'Apagar todas las terminales'}
          </button>
          {error && (
            <p className="perm-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
