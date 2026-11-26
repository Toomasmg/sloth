import { derivarClaves } from './celular-sello'
import type { AccountUsage, AgentStatus } from '../../shared/types'
import { destructivoDe, kindOf, labelOf, titleOf } from '../../shared/permissions-core'
import type { CuentaCelular, EstadoCelular, EstadoSesion, PedidoCelular, SesionCelular, VentanaLimite } from '../../shared/celular'

/** Lo que importa de una interfaz de red (la forma de os.networkInterfaces()). */
export interface InterfazRed {
  address: string
  family: string | number
  internal: boolean
}

const VIRTUAL = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|tailscale|zerotier|hamachi|vpn|bluetooth/i
const WIFI = /wi-?fi|wlan|wireless|inal[aá]mbrica/i

const esPrivada = (ip: string): boolean => {
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

/**
 * La IP de la PC en la red de casa: IPv4 privada, de una interfaz que no sea virtual. Prefiere la
 * del Wi-Fi; si no hay, la primera cableada. null si no hay red.
 */
export function elegirIp(redes: Record<string, InterfazRed[] | undefined>): string | null {
  const candidatas: { nombre: string; ip: string }[] = []
  for (const [nombre, lista] of Object.entries(redes)) {
    if (VIRTUAL.test(nombre)) continue
    for (const r of lista ?? []) {
      const v4 = r.family === 'IPv4' || r.family === 4
      if (v4 && !r.internal && esPrivada(r.address)) candidatas.push({ nombre, ip: r.address })
    }
  }
  return (candidatas.find((c) => WIFI.test(c.nombre)) ?? candidatas[0])?.ip ?? null
}

/** La clave del QR: 32 bytes en base64url canónico (43 caracteres). */
export const claveValida = (v: unknown): v is string => typeof v === 'string' && derivarClaves(v) !== null

export const puertoValido = (p: unknown): p is number => typeof p === 'number' && Number.isInteger(p) && p >= 1024 && p <= 65535

export const TEMA_MIN = 20
export const NTFY_POR_DEFECTO = 'https://ntfy.sh/'

/** Tema de ntfy: lo que acepta su URL, sin barras ni espacios. El largo mínimo es lo único que lo protege: cualquiera que lo sepa lee los avisos. */
export const temaValido = (t: unknown): t is string => typeof t === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(t)

export function servidorNtfy(u: unknown): string | null {
  if (u === undefined || u === '') return NTFY_POR_DEFECTO
  if (typeof u !== 'string') return null
  let url: URL
  try {
    url = new URL(u)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
  return `${url.origin}${url.pathname.replace(/\/*$/, '/')}`
}

export const tokenNtfyValido = (t: unknown): t is string => typeof t === 'string' && /^[A-Za-z0-9_.-]{1,200}$/.test(t)

/** El token es de un servidor: si cambia el servidor y no llega uno nuevo, el guardado no viaja al otro. */
export function tokenNtfyTras(actual: { servidor: string; token?: string }, servidor: string, token: string | null | undefined): string | undefined {
  if (token !== undefined) return token ?? undefined
  return servidor === actual.servidor ? actual.token : undefined
}

/** `resets_at` llega como segundos o milisegundos desde 1970, o como fecha ISO. */
export function aMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') {
    const n = Number(v)
    if (v.trim() && Number.isFinite(n)) return aMs(n)
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

function ventana(raw: unknown, ahora: number): VentanaLimite | null {
  if (!raw || typeof raw !== 'object') return null
  const { pct, resetsAt } = raw as { pct?: unknown; resetsAt?: unknown }
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null
  const reiniciaEn = aMs(resetsAt)
  // Si ya pasó el reinicio, el porcentaje guardado es de la ventana anterior: mejor «sin datos» que un número viejo.
  if (reiniciaEn !== null && reiniciaEn <= ahora) return null
  return { pct: Math.max(0, Math.min(100, pct)), reiniciaEn }
}

/**
 * Lee lo que dejó el envoltorio de la statusline en la carpeta de la cuenta (sloth-limites.json).
 * Tolerante: lo que no se entiende queda como «sin datos».
 */
export function leerLimites(texto: string | null, ahora: number): { cincoHoras: VentanaLimite | null; semana: VentanaLimite | null; at: number | null } {
  const vacio = { cincoHoras: null, semana: null, at: null }
  if (!texto) return vacio
  let j: unknown
  try {
    j = JSON.parse(texto.replace(/^﻿/, ''))
  } catch {
    return vacio
  }
  if (!j || typeof j !== 'object') return vacio
  const o = j as { fiveHour?: unknown; sevenDay?: unknown; at?: unknown }
  return { cincoHoras: ventana(o.fiveHour, ahora), semana: ventana(o.sevenDay, ahora), at: typeof o.at === 'number' ? o.at : null }
}

const ESTADOS: readonly EstadoSesion[] = ['waiting', 'done', 'working', 'idle', 'sleeping', 'exited']
const ORDEN: Record<EstadoSesion, number> = { waiting: 0, done: 1, working: 2, idle: 3, sleeping: 4, exited: 5 }
const MAX_TEXTO = 160

const corto = (s: string, n = MAX_TEXTO): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export interface Entrada {
  ahora: number
  aprobar: boolean
  terminal: boolean
  cuentas: { id: string; label: string }[]
  espacios: { id: string; name: string; accountId: string }[]
  agentes: ReadonlyMap<string, AgentStatus> | Record<string, AgentStatus>
  uso: Record<string, AccountUsage>
  limites: Record<string, ReturnType<typeof leerLimites>>
  pedidos: { id: string; ws: string; tool: string; input: Record<string, unknown>; at: number; expiresAt: number }[]
}

/** Lo que se aprueba desde el celu se tiene que ver entero: el corte es solo un tope de tamaño. */
export const MAX_PEDIDO = 4000

// Controles (salvo salto y tabulación), bidi y ancho cero: harían que el celu muestre algo distinto de lo que corre.
const INVISIBLES = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/gu

/** Qué pide un permiso, como lo ve el celu. */
export function pedidoParaCelu(tool: string, input: Record<string, unknown>): { texto: string; titulo: string; destructivo: string | null } {
  const kind = kindOf(tool)
  return { texto: corto(labelOf(kind, tool, input).replace(INVISIBLES, '\uFFFD'), MAX_PEDIDO), titulo: titleOf(kind, tool, input), destructivo: destructivoDe(kind, input) }
}

const agenteDe = (a: Entrada['agentes'], id: string): AgentStatus | undefined =>
  a instanceof Map ? a.get(id) : (a as Record<string, AgentStatus>)[id]

/** Arma el JSON de /api/estado. Solo lo que el celu muestra: nada de carpetas ni rutas. */
export function armarEstado(e: Entrada): EstadoCelular {
  const cuentas: CuentaCelular[] = e.cuentas.map((c) => {
    const l = e.limites[c.id]
    const u = e.uso[c.id]?.today
    return {
      id: c.id,
      nombre: corto(c.label, 40),
      cincoHoras: l?.cincoHoras ?? null,
      semana: l?.semana ?? null,
      limitesLeidosEn: l?.at ?? null,
      hoy: u ? { tokens: u.input + u.output + u.cacheWrite + u.cacheRead, mensajes: u.messages } : null
    }
  })
  const conPedido = new Set(e.pedidos.map((p) => p.ws))
  const sesiones: SesionCelular[] = e.espacios
    .map((w): SesionCelular | null => {
      const a = agenteDe(e.agentes, w.id)
      if (!a) return null
      // Un pedido de permiso pendiente es «te necesita», aunque el último hook diga otra cosa.
      const estado: EstadoSesion = conPedido.has(w.id) ? 'waiting' : ESTADOS.includes(a.state) ? a.state : 'idle'
      const s: SesionCelular = { id: w.id, nombre: corto(w.name, 60), cuentaId: w.accountId, estado, desde: a.at }
      if (a.detail) s.detalle = corto(a.detail)
      return s
    })
    .filter((s): s is SesionCelular => s !== null)
    .sort((a, b) => ORDEN[a.estado] - ORDEN[b.estado] || b.desde - a.desde)
  const nombres = new Map(e.espacios.map((w) => [w.id, w.name]))
  const pedidos: PedidoCelular[] = e.pedidos
    .filter((p) => nombres.has(p.ws))
    .sort((a, b) => a.at - b.at)
    .map((p) => ({ id: p.id, sesionId: p.ws, sesion: corto(nombres.get(p.ws) as string, 60), ...pedidoParaCelu(p.tool, p.input), desde: p.at, vence: p.expiresAt }))
  return { ahora: e.ahora, aprobar: e.aprobar, terminal: e.terminal, cuentas, sesiones, pedidos }
}

export type TipoAviso = 'termino' | 'teNecesita' | 'permiso'

const PERMISO_POR_CLASE: Record<string, string> = {
  cmd: 'Claude quiere correr un comando.',
  edit: 'Claude quiere editar archivos.',
  net: 'Claude quiere acceder a internet.'
}

/** Qué pide Claude, sin el comando ni la ruta: ese texto sale a los servidores de ntfy. */
export const resumenPermiso = (clase: string): string => PERMISO_POR_CLASE[clase] ?? 'Claude quiere usar una herramienta.'

/** Título y cuerpo del aviso por ntfy. Pasa por los servidores de ntfy: solo el nombre del espacio y qué pasó. */
export function textoAviso(tipo: TipoAviso, espacio: string, detalle?: string, agente = 'Claude'): { titulo: string; cuerpo: string } {
  const nombre = corto(espacio.replace(/[\r\n]+/g, ' '), 60)
  if (tipo === 'termino') return { titulo: `${nombre} terminó`, cuerpo: `${agente} terminó. Revisá los cambios antes de seguir.` }
  if (tipo === 'permiso') return { titulo: `${nombre} pide permiso`, cuerpo: corto((detalle ?? `${agente} necesita tu permiso.`).replace(/[\r\n]+/g, ' ')) }
  return { titulo: `${nombre} te necesita`, cuerpo: corto((detalle || `${agente} necesita tu atención.`).replace(/[\r\n]+/g, ' ')) }
}

const PRIVADO: Record<TipoAviso, string> = { termino: 'Una sesión terminó.', teNecesita: 'Una sesión te necesita.', permiso: 'Una sesión pide permiso.' }

/** «Sin nombres»: el servidor de ntfy no se entera de cómo se llaman tus espacios ni de qué dijo Claude. */
export const textoAvisoPrivado = (tipo: TipoAviso): { titulo: string; cuerpo: string } => ({ titulo: 'Sloth', cuerpo: PRIVADO[tipo] })

/**
 * El JSON que se publica en ntfy. Con `abrir`, tocar el aviso (o «Abrir Sloth») abre la página del celu: la
 * dirección va sin la clave, que el celu ya tiene guardada desde que escaneó el QR.
 */
export function cuerpoNtfy(tema: string, tipo: TipoAviso, texto: { titulo: string; cuerpo: string }, abrir: string | null): Record<string, unknown> {
  return {
    topic: tema,
    title: texto.titulo,
    message: texto.cuerpo,
    priority: tipo === 'termino' ? 3 : 4,
    tags: [tipo === 'termino' ? 'white_check_mark' : 'warning'],
    ...(abrir && { click: abrir, actions: [{ action: 'view', label: 'Abrir Sloth', url: abrir, clear: true }] })
  }
}

/** Adónde lleva el aviso: la página del Wi-Fi si está abierta; si no, la de «desde cualquier red». Nunca con el `#`. */
export function enlaceAviso(wifi: { ip: string; puerto: number } | null, remoto: string | null): string | null {
  if (wifi) return `http://${wifi.ip}:${wifi.puerto}/`
  if (!remoto) return null
  const u = new URL(remoto)
  u.hash = ''
  u.search = ''
  return u.toString()
}

/**
 * Evita mandar el mismo aviso dos veces seguidas (Claude a veces repite el hook). Devuelve true si
 * hay que mandarlo y anota el envío.
 */
export function debeAvisar(ultimos: Map<string, number>, clave: string, ahora: number, ventanaMs = 10_000): boolean {
  const antes = ultimos.get(clave)
  if (antes !== undefined && ahora - antes < ventanaMs) return false
  ultimos.set(clave, ahora)
  return true
}
