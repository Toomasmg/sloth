import { app } from 'electron'
import { arch, homedir, platform, release } from 'node:os'
import type { Feature } from './context'
// Import circular a propósito: FEATURES se lee recién cuando se pide el texto, con todo ya cargado.
import { FEATURES } from './index'
import { currentSettings } from './settings'
import { huboCrashPrevio, tomarCrashPrevio } from '../diag/estado'
import { textoDiagnostico, type DatosDiagnostico } from '../diag/diagnostico-texto'
import { crearLimite } from '../diag/limite'
import { acotar, redactar } from '../diag/redactar'
import { logger } from '../logger-global'

const MAX_MENSAJE = 1000
const MAX_STACK = 4000

function ajustesBooleanos(): Record<string, boolean> {
  const salida: Record<string, boolean> = {}
  const recorrer = (obj: object, prefijo: string, nivel: number): void => {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'boolean') salida[`${prefijo}${k}`] = v
      else if (nivel < 1 && v && typeof v === 'object' && !Array.isArray(v) && (k === 'notify' || k === 'terminal')) recorrer(v, `${k}.`, nivel + 1)
    }
  }
  recorrer(currentSettings(), '', 0)
  return salida
}

/** Lo que manda la UI desde window.onerror / unhandledrejection; llega sin validar. */
function leerErrorRenderer(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const { mensaje, stack } = payload as { mensaje?: unknown; stack?: unknown }
  if (typeof mensaje !== 'string' || mensaje.length === 0) return undefined
  const cabeza = acotar(mensaje, MAX_MENSAJE)
  return typeof stack === 'string' && stack.length > 0 ? `${cabeza}\n${acotar(stack, MAX_STACK)}` : cabeza
}

/**
 * Diagnóstico para pegar en un reporte: versiones, funciones activas y últimos errores, todo redactado.
 * Ops: texto() devuelve el texto (la UI lo copia al portapapeles; no sale de la máquina), crashPrevio()
 * dice una sola vez si la sesión anterior no cerró limpia y errorRenderer({ mensaje, stack }) registra un
 * error de la interfaz.
 */
const feature: Feature = {
  name: 'diagnostico',
  register(ctx) {
    const pasa = crearLimite(20, 60_000, Date.now)

    ctx.handle('texto', () => {
      const entradas = logger.recientes(200)
      const datos: DatosDiagnostico = {
        sloth: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
        so: `${platform()} ${release()} ${arch()}`,
        features: FEATURES.map((f) => f.name),
        cuentas: ctx.store.accounts.length,
        espacios: ctx.store.workspaces.length,
        ajustes: ajustesBooleanos(),
        errores: entradas.filter((e) => e.nivel === 'error'),
        avisos: entradas.filter((e) => e.nivel === 'aviso').map((e) => `${e.origen}: ${e.msg}`),
        crashPrevio: huboCrashPrevio(),
        fallosLog: logger.fallo()
      }
      return redactar(textoDiagnostico(datos, Date.now()), { home: homedir(), userData: app.getPath('userData') })
    })

    ctx.handle('crashPrevio', () => tomarCrashPrevio())

    ctx.handle('errorRenderer', (payload: unknown) => {
      const texto = leerErrorRenderer(payload)
      if (texto === undefined || !pasa()) return
      logger.error('renderer', texto)
    })
  }
}

export default feature
