import { CircleIcon, DoneIcon, MinusCircleIcon, WaitingIcon, WorkingIcon } from './icons/SlothIcons'
import { MoonIcon } from '@phosphor-icons/react'
import type { AgentState } from '../../shared/types'
import { STATE_LABEL } from './format'

/** Estado con ícono + color (nunca solo color). Los íconos son los del diseño (SlothIcons). */
export function StateIcon({ state, size = 14 }: { state?: AgentState; size?: number }): React.JSX.Element {
  switch (state) {
    case 'working':
      return <WorkingIcon size={size} className="ic ic-working spin" />
    case 'waiting':
      return <WaitingIcon size={size} className="ic ic-waiting ring" />
    case 'done':
      return <DoneIcon size={size} className="ic ic-done" />
    case 'exited':
      return <MinusCircleIcon size={size} className="ic ic-exited" />
    case 'sleeping':
      return <MoonIcon size={size} weight="fill" className="ic ic-sleeping" />
    case 'idle':
      return <CircleIcon size={size} className="ic ic-idle" />
    default:
      return <CircleIcon size={size} className="ic ic-none" />
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
