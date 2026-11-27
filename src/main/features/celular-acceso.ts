import { randomBytes, randomInt } from 'node:crypto'
import type { Migraciones } from '../versionado'
import type { CeluConAcceso, NivelCelu, PedidoEntrada } from '../../shared/celular'
import { claveValida } from './celular-core'
import { dispositivoDe, type Quien } from './celular-actividad'

/** v2: cada celu tiene su clave; la del QR solo sirve para pedir entrar. */
export const VERSION_CELULAR = 2
export const VENCE_SIN_USO_MS = 30 * 24 * 3600_000
/** `ultimo` se guarda redondeado: no hace falta escribir el archivo en cada pedido. */
export const ANOTAR_USO_MS = 3600_000
export const ENTRADA_MS = 5 * 60_000
export const MAX_ENTRADAS = 5
export const MAX_CELUS = 20

export interface CeluGuardado extends CeluConAcceso {
  clave: string
}

export type EstadoEntrada = 'esperando' | 'listo' | 'rechazado' | 'vencido'

export const nivelValido = (v: unknown): v is NivelCelu => v === 'ver' || v === 'aprobar' || v === 'controlar'

/** Lo que el celu puede hacer: lo que deja su nivel y, encima, lo que prenden los interruptores del panel. */
export function permisosDe(nivel: NivelCelu, cfg: { aprobar: boolean; terminal: boolean }): { aprobar: boolean; terminal: boolean } {
  return { aprobar: cfg.aprobar && nivel !== 'ver', terminal: cfg.terminal && nivel === 'controlar' }
}

/**
 * v1 tenía una sola clave, la del QR, que daba acceso a cualquiera que la tuviera. Los celus que ya la usaban siguen
 * entrando como «Celus emparejados antes» (se pueden sacar desde el panel); el QR pasa a tener una clave nueva, que
 * genera quien carga al no encontrarla.
 */
export function migracionesCelular(ahora: number): Migraciones {
  return {
    1: (d) => {
      const { clave, ...resto } = d
      const celus: CeluGuardado[] = claveValida(clave) ? [{ id: 'antes', nombre: 'Celus emparejados antes', clave, nivel: 'controlar', creado: ahora, ultimo: ahora }] : []
      return { ...resto, celus }
    }
  }
}

const esCelu = (v: unknown): v is CeluGuardado => {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  return (
    typeof c.id === 'string' &&
    /^[\w-]{1,40}$/.test(c.id) &&
    typeof c.nombre === 'string' &&
    c.nombre.length <= 80 &&
    claveValida(c.clave) &&
    nivelValido(c.nivel) &&
    Number.isFinite(c.creado) &&
    Number.isFinite(c.ultimo)
  )
}

/** Los celus de un archivo ya migrado: sin los rotos, los vencidos ni claves repetidas (o iguales a la del QR). */
export function leerCelus(v: unknown, ahora: number, claveQr?: string): CeluGuardado[] {
  if (!Array.isArray(v)) return []
  const vistas = new Set<string>(claveQr ? [claveQr] : [])
  const ids = new Set<string>()
  const out: CeluGuardado[] = []
  for (const c of v) {
    if (!esCelu(c) || vistas.has(c.clave) || ids.has(c.id) || ahora - c.ultimo > VENCE_SIN_USO_MS) continue
    vistas.add(c.clave)
    ids.add(c.id)
    out.push({ id: c.id, nombre: c.nombre, clave: c.clave, nivel: c.nivel, creado: c.creado, ultimo: c.ultimo })
  }
  return out.slice(-MAX_CELUS)
}

export const sinVencidos = (celus: CeluGuardado[], ahora: number): CeluGuardado[] => celus.filter((c) => ahora - c.ultimo <= VENCE_SIN_USO_MS)

/** Para el panel: nunca la clave. */
export const paraVista = (celus: CeluGuardado[]): CeluConAcceso[] => celus.map(({ clave: _c, ...resto }) => resto)

/** true si hay que anotar el uso (y guardar): pasó más de una hora desde lo anotado. */
export function usar(c: CeluGuardado, ahora: number): boolean {
  if (ahora - c.ultimo < ANOTAR_USO_MS) return false
  c.ultimo = ahora
  return true
}

interface Entrada {
  id: string
  clave: string
  codigo: string
  nombre: string
  ip: string
  ua: string
  en: number
  estado: Exclude<EstadoEntrada, 'vencido'>
}

/**
 * Los celus que escanearon el QR y esperan. Cada uno manda la clave que generó; la PC muestra el código que le
 * devolvió, y recién cuando alguien toca «Dejar entrar» esa clave sirve. En memoria: al cerrar Sloth, se pierden.
 */
export function crearEntradas() {
  const entradas = new Map<string, Entrada>()
  const podar = (ahora: number): void => {
    for (const [k, e] of entradas) if (ahora - e.en > ENTRADA_MS) entradas.delete(k)
  }
  const esperando = (): Entrada[] => [...entradas.values()].filter((e) => e.estado === 'esperando')

  return {
    /** Un pedido repetido (la respuesta se perdió) devuelve el mismo código. */
    pedir(clave: string, q: Quien, ahora: number): { codigo: string } | { error: string } {
      podar(ahora)
      const previa = entradas.get(clave)
      if (previa) return previa.estado === 'esperando' ? { codigo: previa.codigo } : { error: 'Ese pedido ya se respondió. Escaneá el QR de nuevo.' }
      if (esperando().length >= MAX_ENTRADAS) return { error: 'Hay demasiados celus esperando. Respondelos en la PC y probá de nuevo.' }
      const usados = new Set(esperando().map((e) => e.codigo))
      let codigo = ''
      do codigo = String(randomInt(0, 10_000)).padStart(4, '0')
      while (usados.has(codigo))
      entradas.set(clave, { id: randomBytes(8).toString('hex'), clave, codigo, nombre: dispositivoDe(q.ua), ip: q.ip, ua: q.ua, en: ahora, estado: 'esperando' })
      return { codigo }
    },
    estado(clave: string, ahora: number): EstadoEntrada {
      podar(ahora)
      return entradas.get(clave)?.estado ?? 'vencido'
    },
    /** Devuelve el pedido si estaba esperando; si no (ya respondido, vencido, otro id), null. */
    responder(id: string, si: boolean, ahora: number): { clave: string; nombre: string; ip: string; ua: string } | null {
      podar(ahora)
      const e = [...entradas.values()].find((x) => x.id === id)
      if (!e || e.estado !== 'esperando') return null
      e.estado = si ? 'listo' : 'rechazado'
      return { clave: e.clave, nombre: e.nombre, ip: e.ip, ua: e.ua }
    },
    pendientes(ahora: number): PedidoEntrada[] {
      podar(ahora)
      return esperando().map((e) => ({ id: e.id, nombre: e.nombre, ip: e.ip, codigo: e.codigo, en: e.en }))
    },
    /** El próximo vencimiento, para repintar el panel cuando un pedido caduca. */
    proximoVence(ahora: number): number | null {
      const ts = esperando().map((e) => e.en + ENTRADA_MS - ahora)
      return ts.length ? Math.max(0, Math.min(...ts)) : null
    },
    olvidar(): void {
      entradas.clear()
    }
  }
}

export type Entradas = ReturnType<typeof crearEntradas>
