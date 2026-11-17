/**
 * Datos de una función que dependen de cuentas o espacios (reglas de permisos, dormidos). La vista
 * muestra solo lo que sigue existiendo; el archivo se poda solo si el store cargó entero, porque con
 * el store vacío por un fallo de lectura se borrarían datos sanos.
 */
export function podarSegunStore<T>(items: readonly T[], existe: (x: T) => boolean, confiable: boolean): { vista: T[]; guardar: T[] } {
  const vista = items.filter(existe)
  return { vista, guardar: confiable ? vista : [...items] }
}
