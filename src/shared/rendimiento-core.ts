import type { PerfilRendimiento, RendimientoSettings } from './settings-model'

/** Límites efectivos para el Job Object de las terminales. */
export interface Limites {
  /** 0 = sin límite. */
  ramMB: number
  /** Núcleos que quedan habilitados (siempre al menos 1). */
  nucleos: number
  /** Máscara de afinidad en decimal: los primeros `nucleos` procesadores lógicos. */
  afinidad: string
}

/** Windows asigna afinidad por grupos de 64 procesadores: más allá no se puede elegir desde un Job. */
const MAX_AFINIDAD = 64

export const perfilVigente = (r: RendimientoSettings, enBateria: boolean): PerfilRendimiento =>
  enBateria && r.bateriaDistinta ? r.bateria : r.enchufada

/**
 * Pasa el perfil a límites que la PC puede cumplir. Un tope igual o mayor a lo que hay es «sin límite»;
 * los núcleos vuelven siempre como máscara completa, porque al sacar el límite del Job Windows no
 * devuelve sola la afinidad que ya les aplicó a los procesos.
 */
export function limitesDe(perfil: PerfilRendimiento, ramTotalMB: number, nucleosTotales: number): Limites {
  const total = Math.max(1, Math.min(MAX_AFINIDAD, Math.floor(nucleosTotales)))
  const nucleos = perfil.nucleos > 0 ? Math.min(perfil.nucleos, total) : total
  const ramMB = perfil.ramMB > 0 && perfil.ramMB < ramTotalMB ? perfil.ramMB : 0
  return { ramMB, nucleos, afinidad: ((1n << BigInt(nucleos)) - 1n).toString() }
}

export const sinLimites = (l: Limites, nucleosTotales: number): boolean =>
  l.ramMB === 0 && l.nucleos >= Math.min(MAX_AFINIDAD, nucleosTotales)

/** Nombre del Job Object: uno por proceso dueño (el daemon, o Sloth sin daemon). */
export const nombreJob = (duenoPid: number): string => `Local\\Sloth-Rendimiento-${duenoPid}`

export interface PedidoJob {
  nombre: string
  /** Proceso desde el que se recorre el árbol. */
  raiz: number
  /** El daemon entra al Job con sus terminales; Sloth (sin daemon) no, solo sus terminales. */
  incluirRaiz: boolean
  /** Ejecutable que nunca entra (Electron, en modo sin daemon). Vacío = ninguno. */
  excluir: string
  limites: Limites
  /** Proceso que se queda con un handle del Job: mientras viva, el nombre sigue y los límites se pueden cambiar. */
  dueno: number
}

/** Variables de entorno para el script (main/rendimiento-script.ts): solo números validados y una ruta, nada se interpola en el código. */
export function entornoJob(p: PedidoJob): Record<string, string> {
  for (const n of [p.raiz, p.dueno]) if (!Number.isInteger(n) || n <= 0) throw new Error(`PID inválido: ${n}`)
  return {
    SLOTH_JOB_NOMBRE: p.nombre,
    SLOTH_JOB_RAIZ: String(p.raiz),
    SLOTH_JOB_INCLUIR_RAIZ: p.incluirRaiz ? '1' : '0',
    SLOTH_JOB_EXCLUIR: p.excluir,
    SLOTH_JOB_RAM_BYTES: String(p.limites.ramMB * 1024 * 1024),
    SLOTH_JOB_AFINIDAD: p.limites.afinidad,
    SLOTH_JOB_DUENO: String(p.dueno)
  }
}

/** Lee la línea JSON que imprime el script. */
export function leerSalidaJob(stdout: string): { procesos: number; vistos: number } {
  const linea = stdout.trim().split(/\r?\n/).pop() ?? ''
  const v: unknown = JSON.parse(linea)
  if (!v || typeof v !== 'object') throw new Error('Salida inesperada del script de rendimiento.')
  const { procesos, vistos } = v as Record<string, unknown>
  if (typeof procesos !== 'number' || typeof vistos !== 'number') throw new Error('Salida inesperada del script de rendimiento.')
  return { procesos, vistos }
}

/** Lo que ve la sección «Rendimiento» de la Configuración. */
export interface EstadoRendimiento {
  /** Solo Windows tiene Job Objects. */
  soportado: boolean
  enBateria: boolean
  ramTotalMB: number
  nucleosTotales: number
  /** Lo último que quedó aplicado; null si todavía no se aplicó nada en esta sesión. */
  aplicado: (Limites & { procesos: number; en: number }) | null
  error: string | null
  aplicando: boolean
}
