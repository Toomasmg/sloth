/** Ruta lista para la línea de comandos: entre comillas si tiene espacios (como Windows Terminal). */
export const quotePath = (p: string): string => (/\s/.test(p) ? `"${p}"` : p)

/** Varias rutas para pegar en la terminal, separadas por espacios. Pegar y soltar usan esta misma regla. */
export const joinPaths = (paths: string[]): string => paths.filter(Boolean).map(quotePath).join(' ')
