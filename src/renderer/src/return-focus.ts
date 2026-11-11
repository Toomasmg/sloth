/**
 * Guarda quién tenía el foco y devuelve la función que lo restaura al cerrar. Si quien abrió ya no
 * está (la paleta suelta el foco al elegir un comando), el foco va a la terminal visible en vez de
 * quedar en el body, donde el teclado deja de servir.
 */
export function captureOpener(): () => void {
  const a = document.activeElement
  const opener = a instanceof HTMLElement && a !== document.body ? a : null
  const target = (): HTMLElement | null => {
    if (opener?.isConnected) return opener
    return (
      document.querySelector<HTMLElement>('.pane.focused .xterm-helper-textarea') ??
      document.querySelector<HTMLElement>('.pane:not(.hidden) .xterm-helper-textarea')
    )
  }
  return () => {
    target()?.focus()
    // Al desmontar el diálogo el navegador puede soltar el foco al body: se reintenta una vez ya desmontado.
    setTimeout(() => {
      if (document.activeElement === document.body || !document.activeElement) target()?.focus()
    }, 0)
  }
}
