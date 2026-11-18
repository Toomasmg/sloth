export interface PerfilVista {
  id: string
  nombre: string
  creado: number
  ghLogin?: string
  tieneFoto: boolean
  activo: boolean
}

export interface TerminalesAjenasInfo {
  cantidad: number
}

export interface PerfilesPayload {
  perfiles: PerfilVista[]
  activo: string
  ajenas: TerminalesAjenasInfo
  modoRaiz: boolean
  terminalesVivas: number
  puedeConservarTerminales: boolean
}

export type TipoActividad = 'espacio' | 'ticket' | 'pr'

export interface EntradaActividad {
  t: number
  tipo: TipoActividad
  espacio?: string
  ticket?: string
  pr?: string
}

export const MAX_NOMBRE_PERFIL = 40
