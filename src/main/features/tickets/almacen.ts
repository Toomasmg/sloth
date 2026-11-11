/**
 * tickets.json en disco, con el fs inyectado (los tests usan uno en memoria). gruv.json solo se lee.
 * Si tickets.json no se pudo leer, es de una versión más nueva de Sloth o no se pudo apartar antes de
 * reemplazarlo, la sesión trabaja en memoria y no lo escribe nunca.
 * Módulo puro (lo corre `node --test` con type stripping): sin enums, namespaces ni parameter
 * properties, y los tipos se importan con `type`.
 */
import { join } from 'node:path'
import { parsearArchivo, resolverEstado, type Buscar, type Lectura, type TicketsState } from './estado'

export interface FsTickets {
  leer(ruta: string): string
  mtimeMs(ruta: string): number
  renombrar(de: string, a: string): void
  escribir(ruta: string, datos: string): void
  crearCarpeta(ruta: string): void
}

export interface OpcionesAlmacen {
  fs: FsTickets
  /** Donde están tickets.json y gruv.json. */
  carpeta: string
  buscar: Buscar
  log: (m: string) => void
  ahora: () => number
}

export interface Almacen {
  /** Lee tickets.json (o migra gruv.json) y deja en disco lo que haga falta, si se puede. */
  cargar(): TicketsState
  /** Escribe tickets.json. En solo lectura no hace nada. true si quedó guardado. */
  guardar(state: TicketsState): boolean
  /** Para mostrar: por qué esta sesión no guarda, si falló el último guardado o si se reemplazó tickets.json. */
  aviso(): string | undefined
  /** Los repos de tickets.json, sin escribir ni migrar nada: para buscar conectores del equipo antes de cargar. */
  configCruda(): ConfigCruda | undefined
}

export interface ConfigCruda {
  defaultRepo?: string
  projectRepos: Record<string, string>
}

const NO_SE_GUARDA = 'Lo que cambies en esta sesión no se guarda'
const AVISOS = {
  ilegible: `No pude leer tickets.json (puede estar abierto en otro programa). ${NO_SE_GUARDA}: cerrá Sloth y volvé a abrirlo.`,
  'version-futura': `El archivo tickets.json es de una versión más nueva de Sloth. ${NO_SE_GUARDA}, para no pisarlo: actualizá Sloth.`,
  'gruv-ilegible': `No pude leer gruv.json (puede estar abierto en otro programa). ${NO_SE_GUARDA}, para no perder los tickets de antes: cerrá Sloth y volvé a abrirlo.`,
  'sin-respaldo': `No pude apartar el tickets.json anterior antes de reemplazarlo. ${NO_SE_GUARDA}: cerrá Sloth y volvé a abrirlo.`
}

const esObjeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function reposDe(json: unknown): ConfigCruda | undefined {
  if (!esObjeto(json)) return undefined
  const c = esObjeto(json.config) ? json.config : {}
  const repos = esObjeto(c.projectRepos) ? c.projectRepos : {}
  const out: ConfigCruda = { projectRepos: Object.fromEntries(Object.entries(repos).filter((e): e is [string, string] => typeof e[1] === 'string')) }
  if (typeof c.defaultRepo === 'string' && c.defaultRepo) out.defaultRepo = c.defaultRepo
  return out
}

const codigo = (e: unknown): unknown => (e && typeof e === 'object' && 'code' in e ? e.code : undefined)
const mensaje = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function crearAlmacen(o: OpcionesAlmacen): Almacen {
  const archivo = join(o.carpeta, 'tickets.json')
  let soloLectura: string | undefined
  let fallo: string | undefined
  let remigrado: string | undefined

  function leer(ruta: string): Lectura {
    try {
      const texto = o.fs.leer(ruta)
      return parsearArchivo(texto, o.fs.mtimeMs(ruta))
    } catch (e) {
      if (codigo(e) === 'ENOENT') return { kind: 'falta' }
      o.log(`tickets: no pude leer ${ruta}: ${mensaje(e)}`)
      return { kind: 'error', mensaje: mensaje(e) }
    }
  }

  function apartar(destino: string, motivo: string): boolean {
    try {
      o.fs.renombrar(archivo, destino)
      o.log(`tickets: tickets.json ${motivo}, quedó en ${destino}`)
      return true
    } catch (e) {
      o.log(`tickets: no pude apartar tickets.json: ${mensaje(e)}`)
      return false
    }
  }

  /** Si falla, el estado queda en memoria (y gruv.json se vuelve a migrar en el próximo arranque). */
  function escribir(state: TicketsState): boolean {
    try {
      o.fs.crearCarpeta(o.carpeta)
      const tmp = `${archivo}.tmp`
      o.fs.escribir(tmp, JSON.stringify(state, null, 2))
      o.fs.renombrar(tmp, archivo)
      fallo = undefined
      return true
    } catch (e) {
      o.log(`tickets: no pude guardar tickets.json: ${mensaje(e)}`)
      fallo = `No pude guardar tickets.json (${mensaje(e)}). Si sigue pasando, lo que cambies se pierde al cerrar Sloth.`
      return false
    }
  }

  return {
    cargar() {
      const ahora = o.ahora()
      const r = resolverEstado({ tickets: leer(archivo), gruv: leer(join(o.carpeta, 'gruv.json')) }, o.buscar, ahora)
      const bak = `${archivo}.bak-${ahora}`
      if (r.soloLectura) soloLectura = AVISOS[r.soloLectura]
      else if (r.respaldar === 'corrupto' && !apartar(`${archivo}.corrupt-${ahora}`, 'ilegible')) soloLectura = AVISOS['sin-respaldo']
      else if (r.respaldar === 'previo') {
        if (apartar(bak, 'reemplazado por gruv.json, que cambió')) remigrado = `Volví a cargar gruv.json porque cambió desde la última vez. Tu tickets.json anterior quedó en ${bak}.`
        else soloLectura = AVISOS['sin-respaldo']
      }
      if (r.origen === 'gruv') o.log(`tickets: estado migrado desde gruv.json${soloLectura ? ' (solo en memoria)' : ''}`)
      if (soloLectura) o.log(`tickets: ${soloLectura}`)
      else if (r.guardar) escribir(r.state)
      return r.state
    },
    guardar(state) {
      if (soloLectura) {
        o.log('tickets: tickets.json no se guarda en esta sesión')
        return false
      }
      return escribir(state)
    },
    aviso: () => [soloLectura, fallo, remigrado].filter(Boolean).join(' ') || undefined,
    configCruda() {
      const l = leer(archivo)
      return l.kind === 'ok' ? reposDe(l.json) : undefined
    }
  }
}
