import { ChatCircleDots, CheckCircle, CircleDashed, CircleNotch, GitMerge, PencilSimpleLine, XCircle } from '@phosphor-icons/react'
import { checkQueFalla, chipsDePr, type EstadoPr, type IconoChip } from './pr-chips'
import './pr-chips.css'

const ICONO: Record<IconoChip, typeof CheckCircle> = {
  ok: CheckCircle,
  fail: XCircle,
  run: CircleNotch,
  none: CircleDashed,
  review: CircleDashed,
  changes: ChatCircleDots,
  conflict: GitMerge,
  draft: PencilSimpleLine
}

/** Los mismos chips con texto para un PR en Equipo y en PRs. El color acompaña, no es lo único que dice. */
export function PrChips({ estado }: { estado: EstadoPr }): React.JSX.Element {
  const falla = estado.ci === 'fail' ? checkQueFalla(estado.failing) : null
  return (
    <>
      {chipsDePr(estado).map((c) => {
        const Icon = ICONO[c.icono]
        return (
          <span key={c.id} className={`pr-chip ${c.tono}`}>
            <Icon size={11} weight="bold" aria-hidden="true" className={c.icono === 'run' ? 'spin' : undefined} />
            {c.texto}
          </span>
        )
      })}
      {falla && (
        <span className="pr-chip-check" title={`Check que falla: ${estado.failing.join(', ')}`}>
          falla: <span className="mono">{falla}</span>
        </span>
      )}
    </>
  )
}
