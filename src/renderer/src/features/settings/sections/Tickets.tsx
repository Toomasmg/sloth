import { SectionHint } from '../ui'
import { Ajustes as TicketsAjustes } from '../../tickets/Ajustes'
import { setBoardOpen, useSnapshot } from '../../tickets/model'
/* ---------- Tickets ---------- */

export function TicketsSection({ onClose }: { onClose(): void }): React.JSX.Element {
  const snap = useSnapshot()
  if (!snap) return <SectionHint>Cargando…</SectionHint>
  return (
    <>
      <TicketsAjustes snap={snap} />
      <SectionHint>
        Los tickets se leen, no se cambian solos.{' '}
        <button type="button" className="f-set-link" onClick={() => {
            onClose()
            setBoardOpen(true)
          }}>
          Ir a Tickets
        </button>
      </SectionHint>
    </>
  )
}
