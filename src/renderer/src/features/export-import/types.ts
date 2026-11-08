/** Tipos que devuelve main («feat:export-import:*»). Espejo de src/main/features/export-import*.ts. */
export interface Selection {
  espacios: string[]
  plantillas: boolean
  apariencia: boolean
  atajos: boolean
  equipo: boolean
  permisos: boolean
}

export interface OverviewSpace {
  id: string
  nombre: string
  ruta: string
  cuenta: string
  color: string | null
  colorEspacio: string | null
  reglas: number
}
export interface Overview {
  espacios: OverviewSpace[]
  plantillas: number
  apariencia: { theme: string; density: string; uiFontSize: number; accent: string }
  atajos: number
  equipo: string | null
  reglasTotal: number
  sesiones: 'no se exportan'
}

export interface Preview {
  json: string
  kb: Record<'espacios' | 'plantillas' | 'apariencia' | 'atajos' | 'equipo' | 'permisos', number>
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

/** Regla lista para guardar (la valida main otra vez en feat:permissions:addRules). */
export interface RuleDraft {
  kind: 'cmd' | 'edit' | 'net' | 'other'
  tool: string
  match: string
  label: string
}
export interface PlanRule {
  id: string
  texto: string
  valida: boolean
  motivo?: string
  draft?: RuleDraft
}
export interface PlanPermiso {
  espacioIndex: number
  espacio: string
  ruta: string
  reglas: PlanRule[]
}

export interface ImportPlan {
  version: string
  cuentas: { label: string; action: 'crear' | 'existe' }[]
  espacios: PlanSpace[]
  plantillas: { nuevas: string[]; existentes: string[]; salteadas: { name: string; reason: string }[] }
  apariencia: boolean
  atajos: number
  equipo: string | null
  permisos: PlanPermiso[]
  reglas: number
  reglasValidas: number
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
  atajos: boolean
  equipo: boolean
}
export interface ImportChoices {
  grupos: ImportGroups
  espacios: Record<string, { conflicto?: Conflicto; carpeta?: string }>
}

export interface ImportResult {
  cuentas: number
  espacios: number
  espaciosWs: Record<string, string>
  plantillas: Record<string, unknown>[]
  ajustes: {
    apariencia?: { theme?: string; density?: string; uiFontSize?: number; accent?: string }
    accountColors?: Record<string, string>
    accountPlans?: Record<string, string>
    atajos?: Record<string, string>
  }
  saltados: { nombre: string; motivo: string }[]
  notas: string[]
  errores: string[]
}

/** Resultado de «feat:permissions:addRules». */
export interface AddRulesResult {
  agregadas: number
  omitidas: number
}

export const errText = (e: unknown): string =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** «≈ 3 KB», como en el diseño. */
export const fmtKb = (kb: number): string => (kb <= 0 ? '0 KB' : kb < 1 ? '< 1 KB' : '≈ ' + Math.round(kb) + ' KB')
