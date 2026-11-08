/** Tipos que devuelve main («feat:export-import:*»). Espejo de src/main/features/export-import*.ts. */
export interface Selection {
  espacios: string[]
  plantillas: boolean
  apariencia: boolean
  equipo: boolean
  permisos: boolean
}

export interface OverviewSpace {
  id: string
  nombre: string
  ruta: string
  cuenta: string
  color: string | null
  reglas: number
}
export interface Overview {
  espacios: OverviewSpace[]
  plantillas: number
  apariencia: { theme: string; density: string; uiFontSize: number }
  equipo: string | null
  reglasTotal: number
  sesiones: 'no se exportan'
}

export interface Preview {
  json: string
  kb: Record<'espacios' | 'plantillas' | 'apariencia' | 'equipo' | 'permisos', number>
  total: number
  totalTxt: string
}

export type SpaceStatus = 'ok' | 'conflicto' | 'faltante' | 'ya' | 'saltear'
export interface PlanSpace {
  index: number
  nombre: string
  ruta: string
  cuenta: string
  color?: string
  status: SpaceStatus
  motivo?: string
  existente?: string
}
export interface ImportPlan {
  version: string
  cuentas: { label: string; action: 'crear' | 'existe' }[]
  espacios: PlanSpace[]
  plantillas: { nuevas: string[]; existentes: string[]; salteadas: { name: string; reason: string }[] }
  apariencia: boolean
  equipo: string | null
  reglas: number
}

export interface ImportPreview {
  token: string
  file: string
  needsPassword?: boolean
  version?: string
  plan?: ImportPlan
}

export type Conflicto = 'reemplazar' | 'dos' | 'saltear'
export interface ImportGroups {
  espacios: boolean
  plantillas: boolean
  apariencia: boolean
  equipo: boolean
  permisos: boolean
}
export interface ImportChoices {
  grupos: ImportGroups
  espacios: Record<string, { conflicto?: Conflicto; carpeta?: string }>
}

export interface ImportResult {
  cuentas: number
  espacios: number
  permisos: number
  plantillas: Record<string, unknown>[]
  ajustes: { apariencia?: { theme?: string; density?: string; uiFontSize?: number }; accountColors?: Record<string, string> }
  saltados: { nombre: string; motivo: string }[]
  notas: string[]
  errores: string[]
}

export const errText = (e: unknown): string =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** «≈ 3 KB», como en el diseño. */
export const fmtKb = (kb: number): string => (kb <= 0 ? '0 KB' : kb < 1 ? '< 1 KB' : '≈ ' + Math.round(kb) + ' KB')
