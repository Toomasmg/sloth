import { app } from 'electron'
import { arch, homedir, platform, release } from 'node:os'
import type { Feature } from './context'
import { currentSettings } from './settings'
import { huboCrashPrevio, tomarCrashPrevio } from '../diag/estado'
import { textoDiagnostico, type DatosDiagnostico } from '../diag/diagnostico-texto'
import { crearLimite } from '../diag/limite'
import { leerErrorRenderer } from '../diag/error-renderer'
import { redactar } from '../diag/redactar'
import { logger } from '../logger-global'
import { raizDatos } from '../perfil'

// La lista la fija features/index.ts al armar FEATURES, para no importarlo en círculo.
let nombresFeatures: string[] = []

export function fijarNombresFeatures(n: string[]): void {
  nombresFeatures = n
}

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
        features: nombresFeatures,
        cuentas: ctx.store.accounts.length,
        espacios: ctx.store.workspaces.length,
        ajustes: ajustesBooleanos(),
        errores: entradas.filter((e) => e.nivel === 'error'),
        avisos: entradas.filter((e) => e.nivel === 'aviso').map((e) => `${e.origen}: ${e.msg}`),
        crashPrevio: huboCrashPrevio(),
        fallosLog: logger.fallo()
      }
      return redactar(textoDiagnostico(datos, Date.now()), { home: homedir(), userData: raizDatos() })
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
