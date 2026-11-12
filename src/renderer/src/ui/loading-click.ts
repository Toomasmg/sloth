interface Cancelable {
  preventDefault(): void
}

/**
 * Mientras un botón carga, el clic se cancela: no corre el onClick y, si es el submit de un form,
 * tampoco se envía (Enter en un campo dispara un clic en el botón submit, que se cancela igual).
 */
export function loadingClick<E extends Cancelable>(loading: boolean | undefined, onClick: ((e: E) => void) | undefined): ((e: E) => void) | undefined {
  if (!loading) return onClick
  return (e) => e.preventDefault()
}
