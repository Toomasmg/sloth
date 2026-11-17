export type Migracion = (datos: Record<string, unknown>) => Record<string, unknown>
/** migraciones[n] lleva de la versión n a la n+1. */
export type Migraciones = Readonly<Record<number, Migracion>>
export type EstadoVersion = 'actual' | 'migrado' | 'futura' | 'invalida'

export interface ResultadoMigrar {
  datos: Record<string, unknown>
  desde: number
  hasta: number
  estado: EstadoVersion
  motivo?: string
}

const esObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const invalida = (desde: number, motivo: string): ResultadoMigrar => ({ datos: {}, desde, hasta: desde, estado: 'invalida', motivo })

/**
 * Sin `version` el archivo es de la v1 (el formato de antes de numerar). Nunca tira ni muta la entrada:
 * una versión más nueva vuelve con la misma referencia, sin tocar, para que quien llama no la reescriba.
 */
export function migrar(datos: unknown, migraciones: Migraciones, versionActual: number): ResultadoMigrar {
  if (!esObj(datos)) return invalida(0, 'no es un objeto')
  const explicita = datos.version !== undefined
  const version = explicita ? datos.version : 1
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return invalida(0, `tiene una versión que no entiendo (${JSON.stringify(version)})`)
  }
  if (version > versionActual) return { datos, desde: version, hasta: version, estado: 'futura' }
  if (version === versionActual && explicita) return { datos, desde: version, hasta: version, estado: 'actual' }

  let copia: Record<string, unknown>
  try {
    copia = structuredClone(datos)
  } catch (e) {
    return invalida(version, `no se pudo copiar para migrarlo (${e instanceof Error ? e.message : String(e)})`)
  }
  for (let v = version; v < versionActual; v++) {
    const paso = migraciones[v]
    if (!paso) return invalida(version, `falta la migración de la versión ${v} a la ${v + 1}`)
    try {
      const salida = paso(copia)
      if (!esObj(salida)) return invalida(version, `la migración de la versión ${v} no devolvió un objeto`)
      copia = salida
    } catch (e) {
      return invalida(version, `falló la migración de la versión ${v} a la ${v + 1} (${e instanceof Error ? e.message : String(e)})`)
    }
  }
  return { datos: { ...copia, version: versionActual }, desde: version, hasta: versionActual, estado: 'migrado' }
}
