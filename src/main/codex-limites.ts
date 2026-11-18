import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { Account } from '../shared/types'
import type { LimitesCodex } from '../shared/celular'
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

// cmd lee estos caracteres como sintaxis aun entre comillas: una ruta así no se ejecuta.
const RUTA_CMD_RARA = /[%"&^!<>|\r\n]/

export interface DepsLimites {
  spawn: typeof spawn
  ahora(): number
  matar: KillDeps
  entorno(): NodeJS.ProcessEnv
}

interface CuentaLeible {
  id: string
  configDir: string
  proveedor?: unknown
}

function depsPorDefecto(): DepsLimites {
  return { spawn, ahora: () => Date.now(), matar: depsReales(), entorno: () => process.env }
}

/** Argv fijo: ningún dato de afuera llega a la línea de comandos. undefined si la ruta no se puede lanzar sin riesgo. */
function comandoDe(exe: string, plataforma: NodeJS.Platform): { file: string; args: string[]; verbatim: boolean } | undefined {
  if (plataforma !== 'win32' || !/\.(cmd|bat)$/i.test(exe)) return { file: exe, args: ['app-server'], verbatim: false }
  if (RUTA_CMD_RARA.test(exe)) return undefined
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `""${exe}" app-server"`], verbatim: true }
}

/**
 * Pregunta a `codex app-server` cuánto queda de cada ventana de uso. Experimental: Sloth no abre
 * auth.json ni nada de la carpeta de la cuenta, solo lo hace el proceso de Codex. Una sola lectura a la
 * vez en toda la app; cualquier falla da undefined y esa cuenta no se vuelve a probar por un rato.
 */
export class LectorLimitesCodex {
  readonly #deps: DepsLimites
  readonly #cache = new Map<string, { valor: LimitesCodex; hasta: number }>()
  readonly #noAntesDe = new Map<string, number>()
  readonly #enCurso = new Map<string, Promise<LimitesCodex | undefined>>()
  #cola: Promise<unknown> = Promise.resolve()

  constructor(deps?: Partial<DepsLimites>) {
    this.#deps = { ...depsPorDefecto(), ...deps }
  }

  /** Lo último que se leyó, sin lanzar nada. */
  cacheado(id: string): LimitesCodex | undefined {
    const c = this.#cache.get(id)
    return c && c.hasta > this.#deps.ahora() ? c.valor : undefined
  }

  leer(cuenta: CuentaLeible, exe: string): Promise<LimitesCodex | undefined> {
    const previo = this.#enCurso.get(cuenta.id)
    if (previo) return previo
    const hoy = this.cacheado(cuenta.id)
    if (hoy) return Promise.resolve(hoy)
    if ((this.#noAntesDe.get(cuenta.id) ?? 0) > this.#deps.ahora()) return Promise.resolve(undefined)
    const p = this.#cola.then(() => this.#leerYGuardar(cuenta, exe)).finally(() => this.#enCurso.delete(cuenta.id))
    this.#cola = p.then(
      () => undefined,
      () => undefined
    )
    this.#enCurso.set(cuenta.id, p)
    return p
  }

  async #leerYGuardar(cuenta: CuentaLeible, exe: string): Promise<LimitesCodex | undefined> {
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
          terminar(limitesDeResultado(r.result, this.#deps.ahora()))
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
 * Los límites de una cuenta de Codex con la lectura activada y la sesión iniciada. null es «sin dato»;
 * con `esperar: false` no se lanza nada en línea: devuelve lo último leído y deja la lectura corriendo aparte.
 */
export async function limitesDeCuenta(cuenta: Account, esperar: boolean): Promise<LimitesCodex | null> {
  if (capacidadesDe(cuenta)?.limitesExperimental !== true || cuenta.limitesExperimentales !== true) return null
  const p = proveedorExigido(cuenta)
  if (!p.estadoLogin(cuenta.configDir).loggedIn) return null
  const exe = p.resolverExe()
  if (!exe) return null
  const lectura = lectorLimites.leer(cuenta, exe)
  if (esperar) return (await lectura) ?? null
  lectura.catch((e: unknown) => logger.error('codex', e))
  return lectorLimites.cacheado(cuenta.id) ?? null
}
