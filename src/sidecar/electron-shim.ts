/**
 * Sustituto del módulo `electron` para correr el main de Sloth dentro del proceso de apoyo de Tauri
 * (se aplica con un alias en scripts/build-sidecar.mjs). Cada API pasa por el puente de rpc.ts a Rust.
 * Lo que todavía no tiene equivalente queda como no-op documentado en docs/migracion-tauri.md.
 */
import { EventEmitter } from 'node:events'
import { connect as netConnect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Rpc } from './rpc'

let rpc!: Rpc
let ventanaVisible = false

/** Lo primero que hace el punto de entrada: conectar el shim con el puente. */
export function iniciar(r: Rpc): void {
  rpc = r
  rpc.alEventoNativo('theme', (dark) => {
    nativeTheme.dark = dark === true
    nativeTheme.emit('updated')
  })
  rpc.alEventoNativo('power:battery', (enBateria) => {
    powerMonitor.bateria = enBateria === true
  })
  rpc.alEventoNativo('power', (nombre) => {
    if (typeof nombre === 'string') powerMonitor.emit(nombre)
  })
  rpc.alEventoNativo('screen:displays', (lista) => {
    if (Array.isArray(lista) && lista.length) screen.displays = lista as Display[]
  })
  rpc.alEventoNativo('window', (nombre, valor) => {
    const w = BrowserWindow.principal
    if (!w || typeof nombre !== 'string') return
    if (nombre === 'bounds' && valor) w.bounds = valor as Rectangle
    if (nombre === 'visible') ventanaVisible = valor === true
    if (nombre === 'focused') w.enfocada = valor === true
    if (nombre === 'maximized') w.maximizada = valor === true
    if (nombre === 'minimized') w.minimizada = valor === true
    w.emit(nombre, ...(valor === undefined ? [] : [valor]))
  })
  rpc.alEventoNativo('notification:click', (id) => Notification.clics.get(id as number)?.emit('click'))
  rpc.alEventoNativo('app', (nombre) => {
    if (typeof nombre === 'string') app.emit(nombre)
  })
}

interface Rectangle {
  x: number
  y: number
  width: number
  height: number
}
interface Display {
  workArea: Rectangle
  bounds: Rectangle
  scaleFactor: number
}

const nativo = <T = unknown>(op: string, ...args: unknown[]): Promise<T> => rpc.nativo<T>(op, ...args)
const ignorar = (p: Promise<unknown>): void => void p.catch(() => {})

// ---------------- app ----------------

const carpetaDatos = (): string => process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')

class App extends EventEmitter {
  isPackaged = process.env.SLOTH_PACKAGED === '1'
  private nombre = 'Sloth'
  private rutas = new Map<string, string>()
  commandLine = { appendSwitch: (): void => {}, hasSwitch: (): boolean => false }

  getName(): string {
    return this.nombre
  }
  setName(n: string): void {
    this.nombre = n
  }
  getVersion(): string {
    return process.env.SLOTH_VERSION ?? '0.0.0'
  }
  getAppPath(): string {
    return process.env.SLOTH_APP_PATH ?? process.cwd()
  }
  getLocale(): string {
    return process.env.LANG ?? 'es'
  }
  setPath(nombre: string, ruta: string): void {
    this.rutas.set(nombre, ruta)
  }
  getPath(nombre: string): string {
    const puesta = this.rutas.get(nombre)
    if (puesta) return puesta
    // Misma carpeta que usaba Electron (%APPDATA%\Sloth): los datos de las instalaciones actuales siguen ahí.
    const userData = process.env.SLOTH_USER_DATA || join(carpetaDatos(), this.nombre)
    switch (nombre) {
      case 'userData':
      case 'sessionData':
        return userData
      case 'appData':
        return carpetaDatos()
      case 'logs':
        return join(userData, 'logs')
      case 'crashDumps':
        return join(userData, 'Crashpad')
      case 'temp':
        return tmpdir()
      case 'home':
        return homedir()
      case 'desktop':
        return join(homedir(), 'Desktop')
      case 'documents':
        return join(homedir(), 'Documents')
      case 'downloads':
        return join(homedir(), 'Downloads')
      case 'exe':
        return process.execPath
      case 'module':
        return process.execPath
      default:
        throw new Error(`Failed to get '${nombre}' path`)
    }
  }
  whenReady(): Promise<void> {
    return Promise.resolve()
  }
  isReady(): boolean {
    return true
  }
  requestSingleInstanceLock(): boolean {
    // La instancia única la resuelve la cáscara de Tauri antes de lanzar el proceso de apoyo.
    return true
  }
  setAppUserModelId(): void {}
  disableHardwareAcceleration(): void {}
  quit(): void {
    ignorar(nativo('app.quit'))
  }
  exit(codigo = 0): void {
    ignorar(nativo('app.exit', codigo))
    setTimeout(() => process.exit(codigo), 300).unref()
  }
  relaunch(): void {
    ignorar(nativo('app.relaunch'))
  }
  setLoginItemSettings(opciones: { openAtLogin?: boolean }): void {
    ignorar(nativo('app.setLoginItem', opciones.openAtLogin === true))
  }
  getLoginItemSettings(): { openAtLogin: boolean } {
    return { openAtLogin: false }
  }
}
export const app = new App()

// ---------------- ipcMain ----------------

export const ipcMain = {
  handle: (canal: string, fn: Parameters<Rpc['handle']>[1]): void => rpc.handle(canal, fn),
  removeHandler: (canal: string): void => rpc.removeHandler(canal),
  on: (canal: string, fn: Parameters<Rpc['on']>[1]): void => rpc.on(canal, fn)
}

// ---------------- ventana ----------------

class WebContents extends EventEmitter {
  private zoom = 0
  send(canal: string, ...args: unknown[]): void {
    rpc.emitir(canal, ...args)
  }
  setWindowOpenHandler(): void {}
  getZoomLevel(): number {
    return this.zoom
  }
  setZoomLevel(n: number): void {
    this.zoom = n
    ignorar(nativo('window.setZoom', n))
  }
  async capturePage(): Promise<{ toPNG: () => Buffer; isEmpty: () => boolean }> {
    const b64 = await nativo<string>('window.capturePage')
    const png = Buffer.from(b64, 'base64')
    return { toPNG: () => png, isEmpty: () => png.length === 0 }
  }
}

export class BrowserWindow extends EventEmitter {
  static principal: BrowserWindow | null = null
  readonly webContents = new WebContents()
  bounds: Rectangle = { x: 0, y: 0, width: 1500, height: 920 }
  enfocada = false
  maximizada = false
  minimizada = false
  private destruida = false

  constructor(opciones: { width?: number; height?: number; x?: number; y?: number; show?: boolean } = {}) {
    super()
    BrowserWindow.principal = this
    this.bounds = { x: opciones.x ?? 0, y: opciones.y ?? 0, width: opciones.width ?? 1500, height: opciones.height ?? 920 }
    ventanaVisible = false
  }
  static getAllWindows(): BrowserWindow[] {
    return BrowserWindow.principal && !BrowserWindow.principal.destruida ? [BrowserWindow.principal] : []
  }
  loadURL(): Promise<void> {
    // La ventana de Tauri ya carga la interfaz sola.
    queueMicrotask(() => {
      this.emit('ready-to-show')
      this.webContents.emit('did-finish-load')
    })
    return Promise.resolve()
  }
  isDestroyed(): boolean {
    return this.destruida
  }
  isFocused(): boolean {
    return this.enfocada
  }
  isVisible(): boolean {
    return ventanaVisible
  }
  isMinimized(): boolean {
    return this.minimizada
  }
  isMaximized(): boolean {
    return this.maximizada
  }
  getBounds(): Rectangle {
    return this.bounds
  }
  getNormalBounds(): Rectangle {
    return this.bounds
  }
  setBounds(b: Partial<Rectangle>): void {
    this.bounds = { ...this.bounds, ...b }
    ignorar(nativo('window.setBounds', this.bounds))
  }
  show(): void {
    ventanaVisible = true
    ignorar(nativo('window.show'))
  }
  hide(): void {
    ventanaVisible = false
    ignorar(nativo('window.hide'))
  }
  focus(): void {
    ignorar(nativo('window.focus'))
  }
  restore(): void {
    this.minimizada = false
    ignorar(nativo('window.restore'))
  }
  maximize(): void {
    ignorar(nativo('window.maximize'))
  }
  close(): void {
    ignorar(nativo('window.close'))
  }
  flashFrame(flash: boolean): void {
    ignorar(nativo('window.flash', flash))
  }
  setBackgroundColor(): void {}
  setTitleBarOverlay(): void {}
  setOverlayIcon(): void {}
  destroy(): void {
    this.destruida = true
  }
}

// ---------------- shell, diálogos, portapapeles ----------------

export const shell = {
  openExternal: (url: string): Promise<void> => nativo('shell.openExternal', url),
  openPath: async (ruta: string): Promise<string> => {
    try {
      await nativo('shell.openPath', ruta)
      return ''
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  },
  showItemInFolder: (ruta: string): void => ignorar(nativo('shell.showItemInFolder', ruta)),
  trashItem: (ruta: string): Promise<void> => nativo('shell.trashItem', ruta)
}

// Electron acepta (ventana, opciones) u (opciones).
const opcionesDe = <T>(a: unknown, b: unknown): T => (b !== undefined ? b : a) as T

export const dialog = {
  showOpenDialog: (a: unknown, b?: unknown): Promise<{ canceled: boolean; filePaths: string[] }> =>
    nativo('dialog.open', opcionesDe(a, b)),
  showSaveDialog: (a: unknown, b?: unknown): Promise<{ canceled: boolean; filePath?: string }> =>
    nativo('dialog.save', opcionesDe(a, b)),
  showMessageBox: (a: unknown, b?: unknown): Promise<{ response: number; checkboxChecked: boolean }> =>
    nativo('dialog.message', opcionesDe(a, b)),
  showErrorBox: (titulo: string, contenido: string): void => ignorar(nativo('dialog.error', titulo, contenido))
}

export const clipboard = {
  readText: (): Promise<string> => nativo<string>('clipboard.readText'),
  writeText: (texto: string): Promise<void> => nativo('clipboard.writeText', texto),
  read: (): Promise<string[]> => Promise.resolve([])
}

// ---------------- sistema ----------------

class NativeTheme extends EventEmitter {
  dark = true
  themeSource: 'system' | 'light' | 'dark' = 'system'
  get shouldUseDarkColors(): boolean {
    return this.themeSource === 'system' ? this.dark : this.themeSource === 'dark'
  }
}
export const nativeTheme = new NativeTheme()

class PowerMonitor extends EventEmitter {
  bateria = false
  isOnBatteryPower(): boolean {
    return this.bateria
  }
}
export const powerMonitor = new PowerMonitor()

export const screen = {
  displays: [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }
  ] as Display[],
  getAllDisplays(): Display[] {
    return this.displays
  }
}

export const net = {
  fetch: (url: string | URL | Request, init?: RequestInit): Promise<Response> => fetch(url, init),
  isOnline: (): boolean => true,
  connect: netConnect
}

export class Notification extends EventEmitter {
  static clics = new Map<number, Notification>()
  private static siguiente = 1
  private readonly datos: { title?: string; body?: string; silent?: boolean }
  constructor(datos: { title?: string; body?: string; silent?: boolean } = {}) {
    super()
    this.datos = datos
  }
  static isSupported(): boolean {
    return true
  }
  show(): void {
    const id = Notification.siguiente++
    Notification.clics.set(id, this)
    ignorar(nativo('notification.show', id, this.datos))
  }
  close(): void {}
}

export const safeStorage = {
  // Pendiente: leer el formato de os_crypt de Electron (clave en Local State protegida con DPAPI).
  isEncryptionAvailable: (): boolean => false,
  encryptString: (): Buffer => {
    throw new Error('El cifrado del sistema todavía no está disponible en esta versión.')
  },
  decryptString: (): string => {
    throw new Error('El cifrado del sistema todavía no está disponible en esta versión.')
  }
}

// ---------------- sin equivalente todavía (la cáscara los resuelve o se retiran) ----------------

export const protocol = { registerSchemesAsPrivileged: (): void => {}, handle: (): void => {} }

export const session = {
  defaultSession: {
    setPermissionRequestHandler: (): void => {},
    setPermissionCheckHandler: (): void => {},
    clearStorageData: (): Promise<void> => Promise.resolve(),
    clearCache: (): Promise<void> => Promise.resolve(),
    webRequest: { onHeadersReceived: (): void => {} }
  }
}

class NativeImage {
  constructor(private readonly vacia: boolean) {}
  isEmpty(): boolean {
    return this.vacia
  }
  resize(): NativeImage {
    return this
  }
  addRepresentation(): void {}
  setTemplateImage(): void {}
  getSize(): { width: number; height: number } {
    return { width: 0, height: 0 }
  }
  toDataURL(): string {
    return ''
  }
  toPNG(): Buffer {
    return Buffer.alloc(0)
  }
}
export const nativeImage = {
  createEmpty: (): NativeImage => new NativeImage(true),
  createFromPath: (): NativeImage => new NativeImage(false),
  createFromBitmap: (): NativeImage => new NativeImage(false)
}

export class Menu {
  static buildFromTemplate(): Menu {
    return new Menu()
  }
  static setApplicationMenu(): void {}
}

export class Tray extends EventEmitter {
  setToolTip(): void {}
  setContextMenu(): void {}
  setImage(): void {}
  destroy(): void {}
}

export default { app, ipcMain, BrowserWindow, shell, dialog, clipboard, nativeTheme, powerMonitor, screen, net, Notification, safeStorage, protocol, session, nativeImage, Menu, Tray }
