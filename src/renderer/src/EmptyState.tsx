import { Button, EmptyState as EmptyStateBase } from './ui'

/** Estado vacío del área de paneles: sin paneles abiertos, centrado sobre el fondo de la grilla. */
export function EmptyState({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  return (
    <div className="sl-empty">
      <EmptyStateBase
        size="lg"
        title="No hay espacios abiertos"
        description="O elegí uno de la barra lateral."
        action={
          <Button variant="primary" onClick={onCreate}>
            Nuevo espacio
          </Button>
        }
      />
    </div>
  )
}
