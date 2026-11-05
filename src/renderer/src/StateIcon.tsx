import { BellRinging, CheckCircle, Circle, CircleNotch, MinusCircle } from '@phosphor-icons/react'
import type { AgentState } from '../../shared/types'
import { STATE_LABEL } from './format'

/** Estado con ícono + color (nunca solo color). */
export function StateIcon({ state, size = 14 }: { state?: AgentState; size?: number }): React.JSX.Element {
  const common = { size, 'aria-hidden': true as const }
  switch (state) {
    case 'working':
      return <CircleNotch {...common} weight="bold" className="ic ic-working spin" />
    case 'waiting':
      return <BellRinging {...common} weight="fill" className="ic ic-waiting ring" />
    case 'done':
      return <CheckCircle {...common} weight="fill" className="ic ic-done" />
    case 'exited':
      return <MinusCircle {...common} weight="fill" className="ic ic-exited" />
    case 'idle':
      return <Circle {...common} weight="bold" className="ic ic-idle" />
    default:
      return <Circle {...common} weight="regular" className="ic ic-none" />
  }
}

export function StatePill({ state, detail }: { state: AgentState; detail?: string }): React.JSX.Element {
  return (
    <span className={`pill pill-${state}`} title={detail} role="status">
      <StateIcon state={state} size={12} />
      {STATE_LABEL[state]}
      {state === 'working' && detail ? <span className="pill-detail">· {detail}</span> : null}
    </span>
  )
}
