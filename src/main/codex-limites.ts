import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { Account } from '../shared/types'
import type { LecturaLimitesCodex, LimitesCodex } from '../shared/celular'
import { capacidadesDe } from '../shared/proveedores'
import { entornoLimpio } from './env-limpio'
import { cortarArbol, spawnOptsArbol } from './kill-tree'
import type { KillDeps } from './kill-tree'
import { depsReales } from './kill-tree-real'
import { ID_INICIALIZAR, ID_LIMITES, leerRespuesta, limitesDeResultado, lineaInicializar, lineasTrasInicializar } from './codex-limites-core'
import { logger } from './logger-global'
import { proveedorDe, proveedorExigido } from './proveedores'

const TIMEOUT_MS = 10_000
const TOPE_SALIDA_BYTES = 256 * 1024
const CACHE_MS = 5 * 60_000
const REINTENTO_MS = 30 * 60_000
const PLAZO_MATAR_MS = 2000
// Cuentas distintas no comparten carpeta: dos lecturas a la vez no se pisan y Ajustes no espera una cola larga.
const MAX_PARALELO = 2

export const EN_USO = 'en-uso'
/** `en-uso`: la cuenta tiene una terminal abierta. `apagada`: el switch se apagó o la cuenta ya no existe. */
export type Permiso = 'ok' | 'en-uso' | 'apagada'
export type ResultadoLectura = LimitesCodex | typeof EN_USO | undefined

// cmd lee estos caracteres como sintaxis aun entre comillas: una ruta así no se ejecuta.
const RUTA_CMD_RARA = /[%"&^!<>|\r\n]/

export interface DepsLimites {
  spawn: typeof spawn
  ahora(): number
  matar: KillDeps
  entorno(): NodeJS.ProcessEnv
  /** Se pregunta recién cuando le toca el turno a la lectura: hasta entonces la cuenta pudo abrir una terminal o apagar el switch. */
  permiso(id: string): Permiso
}

interface CuentaLeible {
  id: string
  configDir: string
  proveedor?: unknown
}

function depsPorDefecto(): DepsLimites {
  return { spawn, ahora: () => Date.now(), matar: depsReales(), entorno: () => process.env, permiso: () => 'ok' }
}

/** Argv fijo: ningún dato de afuera llega a la línea de comandos. undefined si la ruta no se puede lanzar sin riesgo. */
function comandoDe(exe: string, plataforma: NodeJS.Platform): { file: string; args: string[]; verbatim: boolean } | undefined {
  if (plataforma !== 'win32' || !/\.(cmd|bat)$/i.test(exe)) return { file: exe, args: ['app-server'], verbatim: false }
  if (RUTA_CMD_RARA.test(exe)) return undefined
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `""${exe}" app-server"`], verbatim: true }
}

/**
 * Pregunta a `codex app-server` cuánto se usó de cada ventana. Experimental: Sloth no abre auth.json ni nada
 * de la carpeta de la cuenta, solo lo hace el proceso de Codex. Nunca se lanza con una terminal abierta de la
 * misma cuenta: app-server puede renovar el token y, como el refresh token es de un solo uso, dejaría al Codex
 * interactivo sin sesión. Cualquier falla da undefined y esa cuenta no se vuelve a probar por un rato.
 */
export class LectorLimitesCodex {
  readonly #deps: DepsLimites
  readonly #cache = new Map<string, { valor: LimitesCodex; hasta: number }>()
  readonly #noAntesDe = new Map<string, number>()
  readonly #enCurso = new Map<string, Promise<ResultadoLectura>>()
  readonly #espera: (() => void)[] = []
  #activas = 0

  constructor(deps?: Partial<DepsLimites>) {
    this.#deps = { ...depsPorDefecto(), ...deps }
  }

  /** Lo último que se leyó, sin lanzar nada. */
  cacheado(id: string): LimitesCodex | undefined {
    const c = this.#cache.get(id)
    return c && c.hasta > this.#deps.ahora() ? c.valor : undefined
  }

  /** Conecta el permiso que sabe qué terminales hay abiertas (lo conoce index.ts). */
  conectarPermiso(permiso: (id: string) => Permiso): void {
    this.#deps.permiso = permiso
  }

  enUso(id: string): boolean {
    return this.#deps.permiso(id) === 'en-uso'
  }

  /** Minutos que faltan para que se vuelva a probar una cuenta cuya última lectura falló. */
  reintentoEnMin(id: string): number | undefined {
    const falta = (this.#noAntesDe.get(id) ?? 0) - this.#deps.ahora()
    return falta > 0 ? Math.ceil(falta / 60_000) : undefined
  }

  /** Borra lo guardado de una cuenta (caché y espera tras un fallo): al apagar y prender el switch o al iniciar sesión se prueba de nuevo. */
  olvidar(id: string): void {
    this.#cache.delete(id)
    this.#noAntesDe.delete(id)
  }

  leer(cuenta: CuentaLeible, exe: string): Promise<ResultadoLectura> {
    const previo = this.#enCurso.get(cuenta.id)
    if (previo) return previo
    const hoy = this.cacheado(cuenta.id)
    if (hoy) return Promise.resolve(hoy)
    const permiso = this.#deps.permiso(cuenta.id)
    if (permiso !== 'ok') return Promise.resolve(permiso === 'en-uso' ? EN_USO : undefined)
    if ((this.#noAntesDe.get(cuenta.id) ?? 0) > this.#deps.ahora()) return Promise.resolve(undefined)
    const p = this.#conCupo(() => this.#leerYGuardar(cuenta, exe)).finally(() => this.#enCurso.delete(cuenta.id))
    this.#enCurso.set(cuenta.id, p)
    return p
  }

  async #conCupo<T>(fn: () => Promise<T>): Promise<T> {
    while (this.#activas >= MAX_PARALELO) await new Promise<void>((r) => this.#espera.push(r))
    this.#activas++
    try {
      return await fn()
    } finally {
      this.#activas--
      this.#espera.shift()?.()
    }
  }

  async #leerYGuardar(cuenta: CuentaLeible, exe: string): Promise<ResultadoLectura> {
    // Con la cola, lo que valía al pedir la lectura puede haber cambiado: se mira otra vez justo antes de lanzar.
    const permiso = this.#deps.permiso(cuenta.id)
    if (permiso !== 'ok') return permiso === 'en-uso' ? EN_USO : undefined
    const valor = await this.#ejecutar(cuenta, exe)
    const ahora = this.#deps.ahora()
    if (valor) {
      this.#cache.set(cuenta.id, { valor, hasta: ahora + CACHE_MS })
      this.#noAntesDe.delete(cuenta.id)
    } else {
      this.#noAntesDe.set(cuenta.id, ahora + REINTENTO_MS)
    }
    return valor
  }

  async #ejecutar(cuenta: CuentaLeible, exe: string): Promise<LimitesCodex | undefined> {
    const p = proveedorDe(cuenta)
    if (!p) return undefined
    const cmd = comandoDe(exe, this.#deps.matar.platform)
    if (!cmd) {
      logger.aviso('codex', 'límites: la ruta de Codex tiene caracteres que cmd.exe no acepta; no se lee.')
      return undefined
    }
    const env = { ...entornoLimpio(this.#deps.entorno(), p.quitarDelEntorno), ...p.envCuenta(cuenta.configDir) }
    const opts: SpawnOptions = { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, windowsVerbatimArguments: cmd.verbatim, ...spawnOptsArbol(this.#deps.matar.platform) }
    let child: ChildProcess
    try {
      child = this.#deps.spawn(cmd.file, cmd.args, opts)
    } catch (e) {
      logger.aviso('codex', `límites: no se pudo lanzar Codex (${(e as NodeJS.ErrnoException).code ?? 'error'}).`)
      return undefined
    }
    try {
      return await this.#conversar(child)
    } finally {
      child.stdin?.end()
      await cortarArbol(child, this.#deps.matar, PLAZO_MATAR_MS)
    }
  }

  #conversar(child: ChildProcess): Promise<LimitesCodex | undefined> {
    return new Promise((resolver) => {
      let terminado = false
      let bytes = 0
      let resto = ''
      const terminar = (v: LimitesCodex | undefined, motivo?: string): void => {
        if (terminado) return
        terminado = true
        clearTimeout(plazo)
        if (!v && motivo) logger.aviso('codex', `límites: ${motivo}.`)
        resolver(v)
      }
      const plazo = setTimeout(() => terminar(undefined, 'Codex no respondió a tiempo'), TIMEOUT_MS)
      const escribir = (lineas: string[]): void => {
        child.stdin?.write(lineas.map((l) => `${l}\n`).join(''))
      }
      const alLinea = (linea: string): void => {
        const r = leerRespuesta(linea)
        if (!r) return
        if (r.error) {
          // Cuenta con API key, versión vieja sin el método o sin sesión: no hay dato que mostrar.
          terminar(undefined, 'Codex contestó con un error')
        } else if (r.id === ID_INICIALIZAR) {
          escribir(lineasTrasInicializar())
        } else if (r.id === ID_LIMITES) {
          const v = limitesDeResultado(r.result, this.#deps.ahora())
          if (!v.cincoHoras && !v.semana) logger.aviso('codex', 'límites: la respuesta no trae ninguna ventana usable (otra forma, unidad o duración).')
          terminar(v)
        }
      }

      child.once('error', (e: NodeJS.ErrnoException) => terminar(undefined, `no se pudo correr Codex (${e.code ?? 'error'})`))
      child.once('close', () => terminar(undefined, 'Codex se cerró antes de responder'))
      child.stdin?.on('error', () => terminar(undefined, 'Codex cerró la entrada'))
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (trozo: string) => {
        if (terminado) return
        bytes += Buffer.byteLength(trozo)
        if (bytes > TOPE_SALIDA_BYTES) {
          terminar(undefined, 'Codex mandó demasiada salida')
          return
        }
        resto += trozo
        const lineas = resto.split('\n')
        resto = lineas.pop() ?? ''
        for (const l of lineas) {
          alLinea(l)
          if (terminado) return
        }
      })
      escribir([lineaInicializar()])
    })
  }
}

export const lectorLimites = new LectorLimitesCodex()

/**
 * Qué mostrar de los límites de una cuenta de Codex con la lectura activada y la sesión iniciada. Con `esperar: false`
 * no se lanza nada en línea: devuelve lo último leído y deja la lectura corriendo aparte.
 */
export async function limitesDeCuenta(cuenta: Account, esperar: boolean): Promise<LecturaLimitesCodex> {
  const sinDato = (): LecturaLimitesCodex => ({ tipo: 'sin-dato', reintentaEnMin: lectorLimites.reintentoEnMin(cuenta.id) })
  if (capacidadesDe(cuenta)?.limitesExperimental !== true || cuenta.limitesExperimentales !== true) return { tipo: 'sin-dato' }
  const p = proveedorExigido(cuenta)
  if (!p.estadoLogin(cuenta.configDir).loggedIn) {
    // Sin sesión no se lee; al iniciarla no tiene que quedar una espera vieja de un fallo anterior.
    lectorLimites.olvidar(cuenta.id)
    return { tipo: 'sin-dato' }
  }
  const exe = p.resolverExe()
  if (!exe) return { tipo: 'sin-dato' }
  const lectura = lectorLimites.leer(cuenta, exe)
  if (esperar) {
    const r = await lectura
    if (r === EN_USO) return { tipo: 'en-uso' }
    return r ? { tipo: 'datos', limites: r } : sinDato()
  }
  lectura.catch((e: unknown) => logger.error('codex', e))
  const cacheado = lectorLimites.cacheado(cuenta.id)
  if (cacheado) return { tipo: 'datos', limites: cacheado }
  return lectorLimites.enUso(cuenta.id) ? { tipo: 'en-uso' } : sinDato()
}
