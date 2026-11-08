import { WorktreeIcon } from '../../icons/SlothIcons'
import { openRamas, useRamas } from './store'

/**
 * Fila «Limpiar ramas que ya no se usan» de la barra lateral (encima de «Nuevo espacio»).
 * Abre la misma limpieza que el comando de la paleta. El badge muestra las candidatas del último escaneo.
 */
export function LimpiarRamasRow(): React.JSX.Element {
  const { candidates } = useRamas()
  const n = candidates ?? 0
  return (
    <button
      type="button"
      className="sl-row f-wt-clean"
      onClick={() => openRamas('limpiar')}
      aria-label={n > 0 ? `Limpiar ramas que ya no se usan, ${n} candidatas` : 'Limpiar ramas que ya no se usan'}
      title="Quitar las ramas aparte mergeadas o borradas en origin, sin espacio ni cambios"
    >
      <span className="f-wt-clean-ico" aria-hidden="true">
        <WorktreeIcon size={15} />
      </span>
      <span className="f-wt-clean-text">Limpiar ramas que ya no se usan</span>
      {n > 0 && (
        <span className="f-wt-clean-badge" aria-hidden="true">
          {n}
        </span>
      )}
    </button>
  )
}
