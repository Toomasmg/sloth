/**
 * Contrato de «Celular»: lo que devuelve GET /api/estado (la página del celu) y lo que ve el panel de
 * Sloth. Cualquier FuenteDeEstado (hoy el Wi-Fi; más adelante la nube) entrega este mismo JSON, así
 * la página del celu no cambia.
 */

export type EstadoSesion = 'waiting' | 'done' | 'working' | 'idle' | 'sleeping' | 'exited'

/** Una ventana de límite (5 h o semanal), tal como la manda Claude Code en la statusline. */
export interface VentanaLimite {
  /** 0 a 100. */
  pct: number
  /** Cuándo se reinicia (ms), si se sabe. */
  reiniciaEn: number | null
}

export interface CuentaCelular {
  id: string
  nombre: string
  /** null: Claude todavía no mandó el dato para esta cuenta («sin datos», nunca 0 %). */
  cincoHoras: VentanaLimite | null
  semana: VentanaLimite | null
  /** Cuándo llegó el último dato de límites (ms). */
  limitesLeidosEn: number | null
  hoy: { tokens: number; mensajes: number } | null
}

export interface SesionCelular {
  id: string
  nombre: string
  cuentaId: string
  estado: EstadoSesion
  detalle?: string
  /** Desde cuándo está en ese estado (ms, reloj de la PC). */
  desde: number
}

export interface PedidoCelular {
  id: string
  sesionId: string
  sesion: string
  /** Qué pide, en una línea («Bash: npm test»). */
  texto: string
  desde: number
  vence: number
}

export interface EstadoCelular {
  /** Reloj de la PC (ms): el celu calcula «hace cuánto» contra esto, no contra su propio reloj. */
  ahora: number
  /** Si se puede aprobar o rechazar desde el celu. */
  aprobar: boolean
  cuentas: CuentaCelular[]
  sesiones: SesionCelular[]
  pedidos: PedidoCelular[]
}

/** Lo que el panel «Celular» de Sloth necesita mostrar. */
export interface CelularVista {
  encendido: boolean
  /** Escuchando de verdad (se pudo abrir el puerto). */
  escuchando: boolean
  ip: string | null
  puerto: number
  /** http://<ip>:<puerto>/?t=<token>, o null si no hay IP o está apagado. */
  enlace: string | null
  aprobar: boolean
  ntfy: { encendido: boolean; tema: string; servidor: string; conToken: boolean; temaRenovado?: boolean }
  error: string | null
  /** La IP cambió desde que se abrió el servidor: el QR viejo ya no sirve. */
  ipCambio: boolean
  /** «Desde cualquier red»: el canal remoto por el Supabase del chat. */
  remoto?: RemotoVista
}

export interface RemotoVista {
  encendido: boolean
  /** Segunda llave para aprobar desde afuera; solo vale con `aprobar` prendido. */
  aprobar: boolean
  estado: 'apagado' | 'sin-chat' | 'conectando' | 'listo' | 'error'
  /** Enlace del QR (con el secreto en el #), o null si no hay sesión de chat o está apagado. */
  enlace: string | null
  /** Hubo un `hola` del celu en los últimos 75 s. */
  celuActivo: boolean
  error: string | null
}

export const PUERTO_POR_DEFECTO = 47321
