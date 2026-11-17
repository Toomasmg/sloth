import { app } from 'electron'
import { existsSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Account, Workspace } from '../shared/types'
import { avisar } from './avisos'
import { escribirJsonAtomico, leerJson, respaldar } from './json-file'
import { corregirRutasViejas, decidirCarga, estadoVacio, validarEstado, type PersistedState } from './store-core'


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

export interface SoloLecturaStore {
  motivo: string
  archivo: string
  /** Con 'version-futura' reiniciar no arregla nada: hay que actualizar Sloth. */
  causa: 'version-futura' | 'io'
}

const mensaje = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class Store {
  private state: PersistedState = estadoVacio().estado
  private readonly file: string
  private soloLecturaMotivo: string | undefined
  private soloLecturaCausa: SoloLecturaStore['causa'] = 'io'
  private cargaConfiable = false

  constructor() {
    migrateFromAntiRea()
    mkdirSync(app.getPath('userData'), { recursive: true })
    this.file = join(app.getPath('userData'), 'sloth-state.json')
    const legacy = join(app.getPath('userData'), 'antirea-state.json')
    try {
      if (!existsSync(this.file) && existsSync(legacy)) renameSync(legacy, this.file)
    } catch (e) {
      console.warn('[store] no se pudo renombrar antirea-state.json:', mensaje(e))
    }
    this.state = this.load()
  }

  /** Si no se pudo leer, respaldar o guardar sloth-state.json: los cambios de esta sesión no se guardan. */
  get soloLectura(): SoloLecturaStore | undefined {
    return this.soloLecturaMotivo ? { motivo: this.soloLecturaMotivo, archivo: this.file, causa: this.soloLecturaCausa } : undefined
  }

  /** Cuentas y espacios cargaron enteros: solo entonces se poda lo de otras funciones según el store. */
  get confiable(): boolean {
    return this.cargaConfiable && !this.soloLecturaMotivo
  }

  /** Para crear cuentas o espacios: en solo lectura se perderían al cerrar, mejor no dejar crearlos. */
  exigirEscritura(): void {
    if (!this.soloLecturaMotivo) return
    const consejo =
      this.soloLecturaCausa === 'version-futura'
        ? 'Actualizá Sloth: esta versión es más vieja que tus datos.'
        : 'Reiniciá Sloth cuando sloth-state.json se pueda leer.'
    throw new Error(`No se va a guardar: ${this.soloLecturaMotivo}. ${consejo}`)
  }

  private load(): PersistedState {
    const r = leerJson(this.file, { validar: validarEstado, porDefecto: estadoVacio, silencioso: true })
    const v = r.valor
    const rutasCorregidas =
      !r.soloLectura && corregirRutasViejas(v.estado.accounts, join(app.getPath('appData'), 'AntiRea'), app.getPath('userData'))
    const d = decidirCarga({ v, apartado: r.apartado, soloLectura: r.soloLectura, motivo: r.motivo }, rutasCorregidas)
    this.cargaConfiable = d.confiable
    if (d.soloLectura) {
      this.soloLecturaMotivo = r.motivo ? `sloth-state.json ${r.motivo}` : 'sloth-state.json es de una versión más nueva de Sloth'
      this.soloLecturaCausa = r.motivo ? 'io' : 'version-futura'
    }
    let bak: string | undefined
    if (d.respaldar) {
      try {
        bak = respaldar(this.file)
      } catch (e) {
        console.warn('[store] no se pudo respaldar sloth-state.json:', mensaje(e))
        this.soloLecturaMotivo = `no se pudo respaldar sloth-state.json (${mensaje(e)})`
        this.soloLecturaCausa = 'io'
        avisar(`No pude respaldar sloth-state.json antes de actualizarlo (${mensaje(e)}). No voy a guardar cambios hasta que reinicies Sloth.`)
      }
    }
    if (d.guardar && bak) {
      this.state = v.estado
      try {
        escribirJsonAtomico(this.file, this.state)
      } catch (e) {
        this.soloLecturaMotivo = `no se pudo guardar sloth-state.json (${mensaje(e)})`
        this.soloLecturaCausa = 'io'
        avisar(`No pude guardar sloth-state.json (${mensaje(e)}). No voy a guardar cambios hasta que reinicies Sloth.`)
      }
    }
    if (d.aviso) avisar(d.aviso(bak))
    return v.estado
  }

  private save(): void {
    if (this.soloLecturaMotivo) return
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
    this.exigirEscritura()
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
    this.exigirEscritura()
    this.state.accounts = this.state.accounts.filter((a) => a.id !== id)
    this.save()
  }
  addWorkspace(ws: Workspace): void {
    this.exigirEscritura()
    this.state.workspaces.push(ws)
    this.save()
  }
  removeWorkspace(id: string): void {
    this.exigirEscritura()
    this.state.workspaces = this.state.workspaces.filter((w) => w.id !== id)
    this.state.openPanes = this.state.openPanes.filter((p) => p !== id)
    this.save()
  }
  setOpenPanes(ids: string[]): void {
    this.state.openPanes = ids
    this.save()
  }
}
