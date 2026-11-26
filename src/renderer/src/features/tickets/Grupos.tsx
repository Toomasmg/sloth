import { CircleNotch, WarningCircle } from '@phosphor-icons/react'
import { GRUPO_TODOS, type Grupo } from './filtro-vista'

interface Props {
  grupos: Grupo[]
  /** Cuántos tickets hay en total entre todos los grupos. */
  total: number
  sel: string
  onSel: (clave: string) => void
  /** Se están trayendo tickets: los grupos sin traer lo muestran. */
  trayendo: boolean
  errPorPersona: Record<string, string>
}

/** El panel general: «Todos», «Míos» siempre primero y después cada persona elegida, con cuántos tickets tiene cada una. */
export function Grupos({ grupos, total, sel, onSel, trayendo, errPorPersona }: Props): React.JSX.Element {
  return (
    <div role="group" aria-label="Ver tickets de" className="f-tickets-grupos">
      <button type="button" className={`f-tickets-grupo ${sel === GRUPO_TODOS ? 'on' : ''}`} aria-pressed={sel === GRUPO_TODOS} onClick={() => onSel(GRUPO_TODOS)}>
        <span className="f-tickets-grupo-n">Todos</span>
        <span className="f-tickets-badge">{total}</span>
      </button>
      {grupos.map((g) => {
        const on = sel === g.clave
        const err = errPorPersona[g.clave]
        return (
          <button
            key={g.clave}
            type="button"
            className={`f-tickets-grupo ${on ? 'on' : ''} ${g.sinTraer ? 'sin-traer' : ''} ${err ? 'con-error' : ''}`}
            aria-pressed={on}
            onClick={() => onSel(g.clave)}
            title={err ? `No se pudo traer: ${err}` : g.sinTraer ? 'Todavía no se trajeron sus tickets' : undefined}
          >
            <span className="f-tickets-grupo-n">{g.nombre}</span>
            {err ? (
              <WarningCircle size={14} weight="fill" aria-hidden="true" />
            ) : g.sinTraer && trayendo ? (
              <CircleNotch size={14} className="spin" aria-hidden="true" />
            ) : g.sinTraer ? (
              <span className="f-tickets-grupo-sin" aria-hidden="true">
                sin traer
              </span>
            ) : (
              <span className="f-tickets-badge">{g.n}</span>
            )}
            {err ? <span className="sr-only">, falló al traerlo</span> : g.sinTraer ? <span className="sr-only">, {trayendo ? 'trayendo sus tickets' : 'todavía sin traer'}</span> : null}
          </button>
        )
      })}
    </div>
  )
}
