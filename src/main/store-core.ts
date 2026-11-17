import type { Account, Workspace } from '../shared/types'

export const VERSION_ESTADO = 1

export interface PersistedState {
  version: typeof VERSION_ESTADO
  accounts: Account[]
  workspaces: Workspace[]
  openPanes: string[]
}

export interface EstadoValidado {
  estado: PersistedState
  cuentasDescartadas: number
  espaciosDescartados: number
  /** El archivo lo escribió una versión de Sloth más nueva (puede traer campos que esta no conoce). */
  versionFutura: boolean
}

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
  sacarSiNoEs(o, ['shareSetup'], 'boolean')
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

function filtrar<T extends { id: string }>(lista: unknown, validar: (v: unknown) => T | undefined): { ok: T[]; descartados: number } {
  if (!Array.isArray(lista)) return { ok: [], descartados: 0 }
  const ok: T[] = []
  const ids = new Set<string>()
  for (const v of lista) {
    const x = validar(v)
    if (x && !ids.has(x.id)) {
      ids.add(x.id)
      ok.push(x)
    }
  }
  return { ok, descartados: lista.length - ok.length }
}

/** Devuelve undefined si la raíz no es un objeto (el archivo entero no sirve). */
export function validarEstado(raw: unknown): EstadoValidado | undefined {
  if (!esObj(raw)) return undefined
  const cuentas = filtrar(raw.accounts, validarCuenta)
  const espacios = filtrar(raw.workspaces, validarEspacio)
  const openPanes = Array.isArray(raw.openPanes) ? raw.openPanes.filter((p): p is string => typeof p === 'string') : []
  return {
    estado: { version: VERSION_ESTADO, accounts: cuentas.ok, workspaces: espacios.ok, openPanes },
    cuentasDescartadas: cuentas.descartados,
    espaciosDescartados: espacios.descartados,
    versionFutura: typeof raw.version === 'number' && raw.version > VERSION_ESTADO
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
