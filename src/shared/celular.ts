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

/** Lo que Codex dice que queda de cada ventana, leído al momento. null: la ventana no vino o no pasó la validación. */
export interface LimitesCodex {
  cincoHoras: VentanaLimite | null
  semana: VentanaLimite | null
  at: number
}

/** Lo que Ajustes muestra de una cuenta de Codex: datos, sin dato (con cuánto falta para reintentar) o sin leer porque hay una terminal abierta de esa cuenta. */
export type LecturaLimitesCodex = { tipo: 'datos'; limites: LimitesCodex } | { tipo: 'sin-dato'; reintentaEnMin?: number } | { tipo: 'en-uso' }

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
  /** Qué pide: el comando entero, el archivo o el host (hasta MAX_PEDIDO caracteres, sin caracteres invisibles). */
  texto: string
  /** «Claude quiere ejecutar un comando»… (falta en una PC vieja). */
  titulo?: string
  /** Por qué se marca «Destructivo» («borra archivos sin papelera»…), o null. */
  destructivo?: string | null
  desde: number
  vence: number
}

export interface EstadoCelular {
  /** Reloj de la PC (ms): el celu calcula «hace cuánto» contra esto, no contra su propio reloj. */
  ahora: number
  /** Si se puede aprobar o rechazar desde el celu. */
  aprobar: boolean
  /** Si se pueden abrir las terminales desde el celu (solo en el Wi-Fi). */
  terminal: boolean
  /** Solo en «desde cualquier red»: la terminal está prendida, pero se abre con el QR del Wi-Fi. */
  terminalEnWifi?: boolean
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
  /** http://<ip>:<puerto>/#k=<clave>, o null si no hay IP o está apagado. */
  enlace: string | null
  aprobar: boolean
  terminal: boolean
  ntfy: { encendido: boolean; tema: string; servidor: string; conToken: boolean; temaRenovado?: boolean; privado: boolean }
  error: string | null
  /** La IP cambió desde que se abrió el servidor: el QR viejo ya no sirve. */
  ipCambio: boolean
  /** «Desde cualquier red»: el canal remoto por el Supabase del chat. */
  remoto?: RemotoVista
  /** Celus que consultaron por el Wi-Fi en los últimos segundos. */
  celus: CeluConectado[]
  /** Lo que hicieron los celus desde que se abrió Sloth, lo más nuevo primero (sin contenidos). */
  actividad: EventoCelu[]
  /** Los celus que la PC dejó entrar por el Wi-Fi, cada uno con su clave (que no viaja al panel). */
  conAcceso: CeluConAcceso[]
  /** Celus que escanearon el QR y esperan que en la PC los dejen entrar. */
  entradas: PedidoEntrada[]
  tailscale: TailscaleVista
}

/** La misma página, también por Tailscale: fuera de casa y, con `tailscale serve`, por HTTPS (se puede instalar como app). */
export interface TailscaleVista {
  encendido: boolean
  /** La IP de Tailscale de la PC (100.x), o null si Tailscale no está conectado. */
  ip: string | null
  /** http://<ip de Tailscale>:<puerto>/#k=<clave del QR>, o null si no está escuchando ahí. */
  enlace: string | null
  /** La dirección de `tailscale serve` que cargó el usuario (https://<pc>.<tailnet>.ts.net). */
  https: string | null
  /** <https>/#k=<clave del QR>, si está escuchando en 127.0.0.1 (de donde lee `tailscale serve`). */
  enlaceHttps: string | null
  error: string | null
}

/** Ver: solo mira. Aprobar: también responde permisos. Controlar: también abre las terminales. Siempre dentro de lo que prenden los interruptores del panel. */
export type NivelCelu = 'ver' | 'aprobar' | 'controlar'

export interface CeluConAcceso {
  id: string
  /** «Android · Chrome» del día que entró: sale del user-agent, que se puede falsear. */
  nombre: string
  nivel: NivelCelu
  creado: number
  /** Último pedido (redondeado a la hora): a los 30 días sin uso, la PC lo saca sola. */
  ultimo: number
}

export interface PedidoEntrada {
  id: string
  nombre: string
  ip: string
  /** El mismo código que muestra el celu: así se sabe que es ese y no otro. */
  codigo: string
  en: number
}

export interface CeluConectado {
  /** «Android · Chrome»: sale del user-agent, que se puede falsear. */
  dispositivo: string
  ip: string
  desde: number
  ultimo: number
}

export type TipoEventoCelu = 'conecto' | 'aprobo' | 'rechazo' | 'abrio' | 'escribio' | 'entro'

export interface EventoCelu {
  at: number
  tipo: TipoEventoCelu
  celu: string
  ip: string
  /** Nombre del espacio (no en «conecto»). */
  espacio?: string
  /** Escrituras o aperturas seguidas juntadas en un solo evento. */
  veces?: number
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

/** Cómo se lee un evento en el panel: «Aprobó un permiso en api», «Escribió en la terminal de web (12 veces)». */
export function textoEvento(e: EventoCelu): string {
  const donde = e.espacio ?? 'un espacio'
  if (e.tipo === 'conecto') return 'Se conectó'
  if (e.tipo === 'entro') return 'Lo dejaste entrar'
  if (e.tipo === 'aprobo') return `Aprobó un permiso en ${donde}`
  if (e.tipo === 'rechazo') return `Rechazó un permiso en ${donde}`
  if (e.tipo === 'abrio') return `Abrió la terminal de ${donde}`
  return `Escribió en la terminal de ${donde}${e.veces && e.veces > 1 ? ` (${e.veces} veces)` : ''}`
}
