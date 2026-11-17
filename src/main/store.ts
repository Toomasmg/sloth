import { app } from 'electron'
import { copyFileSync, existsSync, renameSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Account, Workspace } from '../shared/types'
import { avisar } from './avisos'
import { escribirJsonAtomico, leerJson, rutaLibre } from './json-file'
import { corregirRutasViejas, validarEstado, VERSION_ESTADO, type EstadoValidado, type PersistedState } from './store-core'

const EMPTY: PersistedState = { version: VERSION_ESTADO, accounts: [], workspaces: [], openPanes: [] }

/**
 * La app antes se llamaba AntiRea: si existe %APPDATA%\AntiRea y todavía no hay %APPDATA%\Sloth,
 * se mueve la carpeta entera (logins de las cuentas incluidos).
 */
function migrateFromAntiRea(): void {
  // Instancia de prueba o tests (SLOTH_USER_DATA): nunca se traen datos reales a su carpeta.
  if (process.env.SLOTH_USER_DATA) return
  const oldDir = join(app.getPath('appData'), 'AntiRea')
  const newDir = app.getPath('userData')
  if (!existsSync(oldDir) || existsSync(join(newDir, 'sloth-state.json')) || existsSync(join(newDir, 'accounts'))) return
  try {
    if (!existsSync(newDir)) {
      renameSync(oldDir, newDir)
    } else {
      // Chromium ya creó la carpeta nueva (cachés): movemos solo lo nuestro.
      for (const name of ['accounts', 'antirea-state.json']) {
        const from = join(oldDir, name)
        if (existsSync(from)) renameSync(from, join(newDir, name))
      }
    }
  } catch (e) {
    console.warn('[migración] no se pudo mover %APPDATA%\\AntiRea:', (e as Error).message)
  }
}

export class Store {
  private state: PersistedState = structuredClone(EMPTY)
  private readonly file: string
  private soloLectura = false

  constructor() {
    migrateFromAntiRea()
    mkdirSync(app.getPath('userData'), { recursive: true })
    this.file = join(app.getPath('userData'), 'sloth-state.json')
    const legacy = join(app.getPath('userData'), 'antirea-state.json')
    if (!existsSync(this.file) && existsSync(legacy)) renameSync(legacy, this.file)
    this.state = this.load()
  }

  /** Sin respaldo no se reescribe: si la copia falla, el store queda en solo lectura. */
  private respaldar(): string | undefined {
    const bak = rutaLibre(`${this.file}.bak-${Date.now()}`)
    try {
      copyFileSync(this.file, bak)
      return bak
    } catch (e) {
      console.warn('[store] no se pudo respaldar sloth-state.json:', (e as Error).message)
      this.soloLectura = true
      return undefined
    }
  }

  private respaldoTexto(bak: string | undefined): string {
    return bak ? `guardé el original como ${basename(bak)}` : 'no pude respaldarlo, así que no voy a guardar cambios hasta que reinicies'
  }

  private load(): PersistedState {
    let v: EstadoValidado
    try {
      v = leerJson(this.file, {
        validar: validarEstado,
        porDefecto: () => ({ estado: structuredClone(EMPTY), cuentasDescartadas: 0, espaciosDescartados: 0, versionFutura: false })
      }).valor
    } catch (e) {
      // Puede estar sano (permisos, antivirus): arrancar vacío y sin guardar, para no pisarlo.
      this.soloLectura = true
      avisar(`No pude leer sloth-state.json (${(e as Error).message}). Arranqué sin cuentas ni espacios y no voy a guardar cambios hasta que reinicies.`)
      return structuredClone(EMPTY)
    }
    const estado = v.estado
    const rutasCorregidas = corregirRutasViejas(estado.accounts, join(app.getPath('appData'), 'AntiRea'), app.getPath('userData'))
    if (v.versionFutura) {
      const bak = this.respaldar()
      avisar(`sloth-state.json lo guardó una versión más nueva de Sloth: ${this.respaldoTexto(bak)}. Si guardás cambios, lo que esta versión no conoce puede perderse.`)
      return estado
    }
    const descartados = v.cuentasDescartadas + v.espaciosDescartados
    if (descartados === 0 && !rutasCorregidas) return estado
    const bak = this.respaldar()
    this.state = estado
    this.save()
    if (descartados > 0)
      avisar(
        `sloth-state.json tenía ${v.cuentasDescartadas} cuenta(s) y ${v.espaciosDescartados} espacio(s) dañados. Los saqué y ${this.respaldoTexto(bak)}.`
      )
    return estado
  }

  private save(): void {
    if (this.soloLectura) return
    escribirJsonAtomico(this.file, this.state)
  }

  get accounts(): Account[] {
    return this.state.accounts
  }
  get workspaces(): Workspace[] {
    return this.state.workspaces
  }
  get openPanes(): string[] {
    return this.state.openPanes
  }

  account(id: string): Account | undefined {
    return this.state.accounts.find((a) => a.id === id)
  }
  workspace(id: string): Workspace | undefined {
    return this.state.workspaces.find((w) => w.id === id)
  }

  addAccount(account: Account): void {
    this.state.accounts.push(account)
    this.save()
  }
  updateAccount(id: string, patch: Partial<Omit<Account, 'id' | 'configDir'>>): Account | undefined {
    const acc = this.account(id)
    if (!acc) return undefined
    Object.assign(acc, patch)
    this.save()
    return acc
  }
  updateWorkspace(id: string, patch: Partial<Omit<Workspace, 'id'>>): Workspace | undefined {
    const ws = this.workspace(id)
    if (!ws) return undefined
    Object.assign(ws, patch)
    this.save()
    return ws
  }
  removeAccount(id: string): void {
    this.state.accounts = this.state.accounts.filter((a) => a.id !== id)
    this.save()
  }
  addWorkspace(ws: Workspace): void {
    this.state.workspaces.push(ws)
    this.save()
  }
  removeWorkspace(id: string): void {
    this.state.workspaces = this.state.workspaces.filter((w) => w.id !== id)
    this.state.openPanes = this.state.openPanes.filter((p) => p !== id)
    this.save()
  }
  setOpenPanes(ids: string[]): void {
    this.state.openPanes = ids
    this.save()
  }
}
