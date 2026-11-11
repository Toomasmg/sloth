import { useState } from 'react'
import { MoonIcon } from '@phosphor-icons/react'
import { cleanError } from './format'

/**
 * Panel de un espacio dormido: Sloth cerró su Claude por inactividad para liberar memoria.
 * «Despertar» lo vuelve a abrir con `claude --continue` (misma conversación).
 */
export function SleepingCard({ paneId, name, onError }: { paneId: string; name: string; onError(message: string): void }): React.JSX.Element {
  const [waking, setWaking] = useState(false)
  const wake = (): void => {
    if (waking) return
    setWaking(true)
    window.sloth.feat.invoke('feat:sleep:wake', paneId).catch((e: unknown) => {
      setWaking(false)
      onError(cleanError(e))
    })
  }
  return (
    <div className="sleeping-card" role="status">
      <MoonIcon size={28} weight="fill" className="sleeping-ico" aria-hidden="true" />
      <p className="sleeping-title">Dormido para ahorrar memoria</p>
      <p className="sleeping-lead">La conversación no se perdió: al despertarlo, Claude sigue donde quedó.</p>
      <button type="button" className="btn primary" onClick={wake} disabled={waking} aria-label={`Despertar ${name}`}>
        {waking ? 'Despertando…' : 'Despertar'}
      </button>
    </div>
  )
}
