/** Lleva la ventana de otra función: cierra la Configuración y, después, abre la otra (para que tome el foco). */
export function goAfterClose(onClose: () => void, fn: () => void): () => void {
  return () => {
    onClose()
    requestAnimationFrame(fn)
  }
}

export function ToggleLikeButton({ title, hint, onClick }: { title: string; hint: string; onClick(): void }): React.JSX.Element {
  return (
    <button type="button" className="f-set-row f-set-toggle" onClick={onClick}>
      <span className="f-set-row-text">
        <span className="f-set-row-title">{title}</span>
        <span className="f-set-hint">{hint}</span>
      </span>
    </button>
  )
}
