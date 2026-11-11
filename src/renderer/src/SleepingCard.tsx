import { useState } from 'react'
import { MoonIcon } from '@phosphor-icons/react'
import { cleanError } from './format'

/**
 * Panel de un espacio dormido: Sloth cerró su Claude por inactividad para liberar memoria.
 * «Despertar» lo vuelve a abrir con `claude --continue` (misma conversación).
 */
export function SleepingCard({ paneId, name, onError }: { paneId: string; name: string; onError(message: string): void }): React.JSX.Element {
  const [waking, setWaking] = useState(false)
  const [err, setErr] = useState('')
  const wake = (): void => {
    if (waking) return
    setWaking(true)
    setErr('')
    window.sloth.feat.invoke('feat:sleep:wake', paneId).catch((e: unknown) => {
      setWaking(false)
      setErr(cleanError(e))
      onError(cleanError(e))
    })
  }
  return (
    <div className="sleeping-card" role="status">
      <MoonIcon size={28} weight="fill" className="sleeping-ico" aria-hidden="true" />
      <p className="sleeping-title">Dormido para ahorrar memoria</p>
      <p className="sleeping-lead">La conversación no se perdió: al despertarlo, Claude sigue donde quedó.</p>
      {err && (
        <p className="form-error" role="alert">
          No se pudo despertar a {name}: {err}
        </p>
      )}
      <button type="button" className="btn primary" onClick={wake} disabled={waking} aria-label={waking || err ? undefined : `Despertar ${name}`}>
        {waking ? 'Despertando…' : err ? 'Reintentar' : 'Despertar'}
      </button>
    </div>
  )
}
