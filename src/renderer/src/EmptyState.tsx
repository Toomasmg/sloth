/**
 * Estado vacío del área de paneles (diseño Espacios): sin paneles abiertos, centrado sobre el fondo de la grilla.
 */
export function EmptyState({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  return (
    <div className="sl-empty">
      <h2 className="sl-empty-title">No hay espacios abiertos</h2>
      <button type="button" className="sl-empty-btn" onClick={onCreate}>
        Crear espacio
      </button>
      <p className="sl-empty-hint">O elegí uno de la barra lateral.</p>
    </div>
  )
}
