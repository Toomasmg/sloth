import { useEffect, useState } from 'react'
import { useUi } from '../../host'
import { UpdateIcon } from '../../../icons/SlothIcons'
import { setPhase } from '../../updater/phase'
import { useUpdateDot } from '../../updater/useUpdateStatus'
import { useSettings } from '../store'
import { UPDATE_CHANNELS, type UpdateChannel } from '../../../../../shared/settings-model'
import { errText, Group, useSave } from '../ui'
import { Button } from '../../../ui'
/* ---------- Actualizaciones ---------- */

interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  error?: string
  upToDate?: boolean
  enabled: boolean
  current: string
}

export function UpdatesSection(): React.JSX.Element {
  const ui = useUi()
  const p = useSettings()
  const save = useSave()
  const [st, setSt] = useState<UpdateStatus | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** «Más tarde» dejó una versión pendiente: mismo dato que el punto del engranaje. */
  const pendiente = useUpdateDot()

  useEffect(() => {
    ui.invoke<UpdateStatus>('feat:updater:status').then(setSt, () => undefined)
    return ui.on('feat:updater:status', (s: UpdateStatus) => setSt(s))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const check = (): void => {
    setBusy(true)
    setMsg(null)
    ui.invoke<UpdateStatus>('feat:updater:check').then(
      (s) => {
        setSt(s)
        setMsg(s.state === 'available' ? `Hay una versión nueva: ${s.version ?? ''}.` : s.upToDate ? 'Tenés la última versión.' : null)
      },
      (e) => setMsg(errText(e))
    ).finally(() => setBusy(false))
  }

  const busyNow = st?.state === 'checking' || st?.state === 'downloading'
  const title = !st
    ? 'Cargando…'
    : !st.enabled
      ? 'Las actualizaciones están apagadas en desarrollo'
      : st.state === 'checking'
        ? 'Buscando una versión nueva…'
        : st.state === 'available'
          ? `Hay una versión nueva: ${st.version ?? ''}`
          : st.state === 'downloading'
            ? `Descargando ${st.version ?? ''} · ${st.percent ?? 0}%`
            : st.state === 'ready'
              ? `Versión ${st.version ?? ''} lista para instalar`
              : st.state === 'error'
                ? (st.error ?? 'No se pudo buscar actualizaciones')
                : 'Sloth está al día'

  return (
    <>
      <div className="f-set-card f-set-status">
        <span className="f-set-status-ico lg" style={{ background: 'var(--done-soft)', color: 'var(--ok-fg)' }} aria-hidden="true">
          <UpdateIcon size={18} />
        </span>
        <div className="grow">
          <div className="f-set-row-title">{title}</div>
          <div className="f-set-hint">Versión instalada: {st?.current ?? '…'}</div>
        </div>
        {st?.state === 'ready' ? (
          <Button variant="primary" size="sm" onClick={() => void ui.invoke('feat:updater:install')}>
            Reiniciar e instalar
          </Button>
        ) : (
          <Button variant="primary" size="sm" disabled={busy || busyNow || st?.enabled === false} onClick={check}>
            Buscar ahora
          </Button>
        )}
      </div>
      {msg && (
        <p role="status" className="f-set-ok">
          {msg}
        </p>
      )}
      {pendiente && st?.version && (
        <div role="status" className="f-set-card f-set-status">
          <div className="grow">
            <div className="f-set-row-title">Dejaste para después la versión {st.version}</div>
            <div className="f-set-hint">No te vuelve a avisar hasta mañana. Podés verla cuando quieras.</div>
          </div>
          <Button size="sm" onClick={() => setPhase('notes')}>
            Ver novedades
          </Button>
        </div>
      )}
      <Group id="g-canal" label="Canal de actualizaciones">
        {UPDATE_CHANNELS.map((c: UpdateChannel) => {
          const on = p.settings.updateChannel === c
          const hint = c === 'estable' ? 'Recomendado. Recibís las versiones probadas.' : 'Recibís las novedades antes, pueden tener errores.'
          return (
            <button key={c} type="button" role="radio" aria-checked={on} className="f-set-row f-set-toggle" onClick={() => save({ updateChannel: c })}>
              <span className={`f-set-radio ${on ? 'on' : ''}`} aria-hidden="true" />
              <span className="f-set-row-text">
                <span className="f-set-row-title">{c === 'estable' ? 'Estable' : 'Beta'}</span>
                <span className="f-set-hint">{hint}</span>
              </span>
            </button>
          )
        })}
      </Group>
    </>
  )
}
