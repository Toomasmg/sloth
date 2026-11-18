import type { Account, Workspace } from '../shared/types'
import { migrar, type Migraciones } from './versionado'

export const VERSION_ESTADO = 1
export const MIGRACIONES_ESTADO: Migraciones = {}

export interface PersistedState {
  version: typeof VERSION_ESTADO
  accounts: Account[]
  workspaces: Workspace[]
  openPanes: string[]
}

export interface EstadoValidado {
  estado: PersistedState
  /** Dañadas más repetidas. */
  cuentasDescartadas: number
  espaciosDescartados: number
  cuentasRepetidas: number
  espaciosRepetidos: number
  /** El archivo lo escribió una versión de Sloth más nueva (puede traer campos que esta no conoce). */
  versionFutura: boolean
  /** Venía sin `version` o de una versión vieja: hay que reescribirlo con la actual (con respaldo). */
  migrado: boolean
}

export const estadoVacio = (): EstadoValidado => ({
  estado: { version: VERSION_ESTADO, accounts: [], workspaces: [], openPanes: [] },
  cuentasDescartadas: 0,
  espaciosDescartados: 0,
  cuentasRepetidas: 0,
  espaciosRepetidos: 0,
  versionFutura: false,
  migrado: false
})

type Obj = Record<string, unknown>
const esObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const texto = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

function sacarSiNoEs(o: Obj, campos: string[], tipo: 'string' | 'boolean'): void {
  for (const c of campos) if (c in o && typeof o[c] !== tipo) delete o[c]
}

/** Se conservan los campos desconocidos: si el archivo viene de una versión más nueva, no se pierden al guardar. */
export function validarCuenta(v: unknown): Account | undefined {
  if (!esObj(v) || !texto(v.id) || !texto(v.configDir)) return undefined
  const o: Obj = { ...v }
  if (typeof o.label !== 'string') o.label = v.id
  if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt)) o.createdAt = 0
  sacarSiNoEs(o, ['shareSetup', 'limitesExperimentales'], 'boolean')
  sacarSiNoEs(o, ['proveedor'], 'string')
  return o as unknown as Account
}

export function validarEspacio(v: unknown): Workspace | undefined {
  if (!esObj(v) || !texto(v.id) || !texto(v.repoPath) || !texto(v.accountId)) return undefined
  const o: Obj = { ...v }
  if (!texto(o.cwd)) o.cwd = v.repoPath
  if (typeof o.name !== 'string') o.name = v.id
  if (typeof o.autoStartClaude !== 'boolean') o.autoStartClaude = true
  if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt)) o.createdAt = 0
  sacarSiNoEs(o, ['branch', 'initialPrompt', 'ticket', 'icon', 'color'], 'string')
  sacarSiNoEs(o, ['initialPromptUsed', 'resume'], 'boolean')
  return o as unknown as Workspace
}

function filtrar<T extends { id: string }>(
  lista: unknown,
  validar: (v: unknown) => T | undefined
): { ok: T[]; descartados: number; repetidos: number } {
  if (!Array.isArray(lista)) return { ok: [], descartados: 0, repetidos: 0 }
  const ok: T[] = []
  const ids = new Set<string>()
  let repetidos = 0
  for (const v of lista) {
    const x = validar(v)
    if (x && ids.has(x.id)) repetidos++
    else if (x) {
      ids.add(x.id)
      ok.push(x)
    }
  }
  return { ok, descartados: lista.length - ok.length, repetidos }
}

/** Devuelve undefined si la raíz no es un objeto o su `version` no se entiende (el archivo entero no sirve). */
export function validarEstado(raw: unknown): EstadoValidado | undefined {
  const r = migrar(raw, MIGRACIONES_ESTADO, VERSION_ESTADO)
  if (r.estado === 'invalida') return undefined
  const datos = r.datos
  const cuentas = filtrar(datos.accounts, validarCuenta)
  const espacios = filtrar(datos.workspaces, validarEspacio)
  const openPanes = Array.isArray(datos.openPanes) ? datos.openPanes.filter((p): p is string => typeof p === 'string') : []
  return {
    estado: { ...datos, version: VERSION_ESTADO, accounts: cuentas.ok, workspaces: espacios.ok, openPanes },
    cuentasDescartadas: cuentas.descartados,
    espaciosDescartados: espacios.descartados,
    cuentasRepetidas: cuentas.repetidos,
    espaciosRepetidos: espacios.repetidos,
    versionFutura: r.estado === 'futura',
    migrado: r.estado === 'migrado'
  }
}

/** Las cuentas guardan rutas absolutas: si venían de %APPDATA%\AntiRea, apuntarlas a la carpeta nueva. */
export function corregirRutasViejas(accounts: Account[], oldRoot: string, newRoot: string): boolean {
  let changed = false
  const prefijo = oldRoot.toLowerCase() + '\\'
  for (const acc of accounts) {
    if (acc.configDir.toLowerCase().startsWith(prefijo)) {
      acc.configDir = newRoot + acc.configDir.slice(oldRoot.length)
      changed = true
    }
  }
  return changed
}

export interface LecturaEstado {
  v: EstadoValidado
  /** Ruta del archivo roto que se apartó (arranca vacío). */
  apartado?: string
  /** No se pudo leer ni apartar: puede estar sano. */
  soloLectura?: boolean
  motivo?: string
}

export interface DecisionCarga {
  /** No escribir sobre el archivo en esta sesión. */
  soloLectura: boolean
  respaldar: boolean
  guardar: boolean
  /**
   * Cuentas y espacios cargaron enteros: recién ahí otras funciones pueden podar lo suyo según el
   * store (reglas de permisos, dormidos). Con el store vacío por un fallo, podar borraría datos sanos.
   */
  confiable: boolean
  /** Recibe la ruta del respaldo, o undefined si no se pudo respaldar. */
  aviso?: (respaldo: string | undefined) => string
}

const plural = (n: number, uno: string, varios: string): string => `${n} ${n === 1 ? uno : varios}`

function describirDescartes(v: EstadoValidado): string {
  const partes: string[] = []
  const cuentasDanadas = v.cuentasDescartadas - v.cuentasRepetidas
  const espaciosDanados = v.espaciosDescartados - v.espaciosRepetidos
  if (cuentasDanadas) partes.push(plural(cuentasDanadas, 'cuenta dañada', 'cuentas dañadas'))
  if (v.cuentasRepetidas) partes.push(plural(v.cuentasRepetidas, 'cuenta repetida', 'cuentas repetidas'))
  if (espaciosDanados) partes.push(plural(espaciosDanados, 'espacio dañado', 'espacios dañados'))
  if (v.espaciosRepetidos) partes.push(plural(v.espaciosRepetidos, 'espacio repetido', 'espacios repetidos'))
  return partes.join(', ')
}

export function textoRespaldo(respaldo: string | undefined): string {
  return respaldo
    ? `guardé el original como ${respaldo}`
    : 'no pude respaldarlo, así que no voy a guardar cambios hasta que se pueda (reiniciá Sloth para reintentar)'
}

/** Qué hacer con sloth-state.json según cómo se leyó: respaldar, reescribir, quedar en solo lectura y qué avisar. */
export function decidirCarga(l: LecturaEstado, rutasCorregidas: boolean): DecisionCarga {
  if (l.soloLectura) {
    return {
      soloLectura: true,
      respaldar: false,
      guardar: false,
      confiable: false,
      aviso: () =>
        `sloth-state.json ${l.motivo ?? 'no se pudo leer'}. Arranqué sin cuentas ni espacios y no voy a guardar cambios hasta que reinicies Sloth; el archivo quedó como estaba.`
    }
  }
  if (l.apartado) {
    const apartado = l.apartado
    return {
      soloLectura: false,
      respaldar: false,
      guardar: false,
      confiable: false,
      aviso: () => `sloth-state.json estaba dañado: lo guardé como ${apartado} y arranqué sin cuentas ni espacios.`
    }
  }
  const v = l.v
  const descartes = v.cuentasDescartadas + v.espaciosDescartados
  if (v.versionFutura) {
    return {
      soloLectura: true,
      respaldar: true,
      guardar: false,
      confiable: false,
      aviso: (bak) =>
        `sloth-state.json lo guardó una versión más nueva de Sloth (${textoRespaldo(bak)}). Lo abrí en solo lectura: no voy a guardar cambios para no pisarlo. Actualizá Sloth para seguir.`
    }
  }
  if (descartes === 0 && !rutasCorregidas && !v.migrado) return { soloLectura: false, respaldar: false, guardar: false, confiable: true }
  return {
    soloLectura: false,
    respaldar: true,
    guardar: true,
    confiable: descartes === 0,
    aviso: descartes > 0 ? (bak) => `sloth-state.json tenía ${describirDescartes(v)}. Los saqué y ${textoRespaldo(bak)}.` : undefined
  }
}
