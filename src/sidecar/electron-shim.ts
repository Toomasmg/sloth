/**
 * Sustituto del módulo `electron` para correr el main de Sloth dentro del proceso de apoyo de Tauri
 * (se aplica con un alias en scripts/build-sidecar.mjs). Cada API pasa por el puente de rpc.ts a Rust.
 * Lo que todavía no tiene equivalente queda como no-op documentado en docs/migracion-tauri.md.
 */
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { connect as netConnect } from 'node:net'
import { pathToFileURL } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Rpc } from './rpc'
import { cifrar, claveDeUserData, descifrar } from './safe-storage'

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
    if (nombre === 'close') w.pedirCierre()
    else if (nombre === 'bounds' && valor) w.cambiarBounds(valor as Rectangle)
    else if (nombre === 'focused') {
      w.enfocada = valor === true
      w.emit(w.enfocada ? 'focus' : 'blur')
    } else if (nombre === 'maximized' && w.maximizada !== (valor === true)) {
      w.maximizada = valor === true
      w.emit(w.maximizada ? 'maximize' : 'unmaximize')
    } else if (nombre === 'minimized' && w.minimizada !== (valor === true)) {
      w.minimizada = valor === true
      w.emit(w.minimizada ? 'minimize' : 'restore')
    } else if (nombre === 'visible' && ventanaVisible !== (valor === true)) {
      ventanaVisible = valor === true
      w.emit(ventanaVisible ? 'show' : 'hide')
    }
  })
  rpc.alEventoNativo('notification:click', (id) => Notification.clics.get(id as number)?.emit('click'))
  // La interfaz pide abrir un enlace con window.open (links de la terminal); antes lo hacía setWindowOpenHandler.
  rpc.on('tauri:open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) ignorar(shell.openExternal(url))
  })
  rpc.alEventoNativo('login-item', (activo) => {
    app.inicioConWindows = activo === true
  })
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
  inicioConWindows = false
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
  /** Como en Electron: antes de salir se avisa con `before-quit`, y quien lo frena sale después con otro quit(). */
  quit(): void {
    let frenado = false
    this.emit('before-quit', { preventDefault: () => (frenado = true) })
    if (!frenado) this.exit(0)
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
    return { openAtLogin: this.inicioConWindows }
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
  /** Último rectángulo con la ventana normal (ni maximizada ni minimizada): lo que se guarda al cerrar. */
  normal: Rectangle = { x: 0, y: 0, width: 1500, height: 920 }
  enfocada = false
  maximizada = false
  minimizada = false
  private destruida = false

  private readonly secundaria: boolean
  private readonly tamano: [number, number]

  constructor(opciones: { width?: number; height?: number; x?: number; y?: number; show?: boolean } = {}) {
    super()
    this.secundaria = BrowserWindow.principal !== null
    this.tamano = [opciones.width ?? 390, opciones.height ?? 780]
    if (!this.secundaria) BrowserWindow.principal = this
    this.bounds = { x: opciones.x ?? 0, y: opciones.y ?? 0, width: opciones.width ?? 1500, height: opciones.height ?? 920 }
    this.normal = this.bounds
    ventanaVisible = false
  }
  static getAllWindows(): BrowserWindow[] {
    return BrowserWindow.principal && !BrowserWindow.principal.destruida ? [BrowserWindow.principal] : []
  }
  loadURL(url?: string): Promise<void> {
    // Una segunda ventana con una página web solo existe en las pruebas e2e (el celu simulado).
    if (this.secundaria && typeof url === 'string' && /^https?:/.test(url)) return nativo('window.open', url, ...this.tamano).then(() => undefined)
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
    return this.normal
  }
  cambiarBounds(b: Rectangle): void {
    const movida = b.x !== this.bounds.x || b.y !== this.bounds.y
    const redimensionada = b.width !== this.bounds.width || b.height !== this.bounds.height
    this.bounds = b
    if (!this.maximizada && !this.minimizada) this.normal = b
    if (redimensionada) this.emit('resize')
    if (movida) this.emit('move')
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
  unmaximize(): void {
    ignorar(nativo('window.unmaximize'))
  }
  setSize(ancho: number, alto: number): void {
    ignorar(nativo('window.setSize', ancho, alto))
  }
  /** Sin marco propio de Windows, el tamaño de la ventana y el del contenido son el mismo. */
  setContentSize(ancho: number, alto: number): void {
    this.setSize(ancho, alto)
  }
  getSize(): [number, number] {
    return [this.bounds.width, this.bounds.height]
  }
  /** Como tocar la X: decide la bandeja de Rust (ocultar, preguntar o cerrar) y, si cierra, llega `pedirCierre`. */
  close(): void {
    ignorar(nativo('window.close'))
  }
  pedirCierre(): void {
    let frenado = false
    this.emit('close', { preventDefault: () => (frenado = true) })
    if (frenado || this.destruida) return
    this.destruida = true
    ventanaVisible = false
    ignorar(nativo('window.hide'))
    this.emit('closed')
    app.emit('window-all-closed')
  }
  flashFrame(flash: boolean): void {
    ignorar(nativo('window.flash', flash))
  }
  setBackgroundColor(color: string): void {
    ignorar(nativo('window.setBackgroundColor', color))
  }
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
  /** Como el Clipboard API: una lista de items con sus tipos. Hoy solo la imagen (captura de pantalla). */
  read: async (): Promise<{ types: string[]; getType: (tipo: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer>; text: () => Promise<string> }> }[]> => {
    const items: { types: string[]; getType: (tipo: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer>; text: () => Promise<string> }> }[] = []
    const archivos = await nativo<string[]>('clipboard.readFiles').catch(() => [] as string[])
    if (archivos.length) {
      const lista = archivos.map((a) => pathToFileURL(a).href).join('\r\n')
      items.push({ types: ['text/uri-list'], getType: () => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)), text: () => Promise.resolve(lista) }) })
    }
    const b64 = await nativo<string>('clipboard.readImage').catch(() => '')
    if (!b64) return items
    const png = Buffer.from(b64, 'base64')
    const ab = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer
    items.push({ types: ['image/png'], getType: () => Promise.resolve({ arrayBuffer: () => Promise.resolve(ab), text: () => Promise.resolve('') }) })
    return items
  }
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

/** DPAPI de Windows a través de PowerShell: se usa una vez por arranque (para la clave) y no hay API síncrona en Node. */
function dpapiConPowerShell(operacion: 'Protect' | 'Unprotect'): (datos: Buffer) => Buffer {
  const script =
    'Add-Type -AssemblyName System.Security; ' +
    '$b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ' +
    `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${operacion}($b, $null, 'CurrentUser'))`
  return (datos) => {
    const salida = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: datos.toString('base64'),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000
    })
    return Buffer.from(salida.trim(), 'base64')
  }
}

let claveCifrado: Buffer | null | undefined
function clave(): Buffer | null {
  if (claveCifrado !== undefined) return claveCifrado
  try {
    claveCifrado = claveDeUserData(app.getPath('userData'), { protect: dpapiConPowerShell('Protect'), unprotect: dpapiConPowerShell('Unprotect') })
  } catch (e) {
    console.warn('cifrado del sistema no disponible:', e instanceof Error ? e.message : String(e))
    claveCifrado = null
  }
  return claveCifrado
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => process.platform === 'win32' && clave() !== null,
  encryptString: (texto: string): Buffer => {
    const k = clave()
    if (!k) throw new Error('El cifrado del sistema no está disponible.')
    return cifrar(k, texto)
  },
  decryptString: (datos: Buffer): string => {
    const k = clave()
    if (!k) throw new Error('El cifrado del sistema no está disponible.')
    return descifrar(k, datos)
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

// En Tauri la bandeja, su menú y el punto de la barra de tareas son de Rust (src-tauri/src/handlers/tray.rs): tray.ts y
// tray-dot.ts no se registran y esto solo deja compilar sus imports.
const imagenVacia = { isEmpty: (): boolean => true, toPNG: (): Buffer => Buffer.alloc(0) }
export const nativeImage = { createEmpty: () => imagenVacia, createFromPath: () => imagenVacia, createFromBitmap: () => imagenVacia }
export const Menu = { buildFromTemplate: (): null => null, setApplicationMenu: (): void => {} }
export class Tray extends EventEmitter {
  isDestroyed(): boolean {
    return true
  }
  setToolTip(): void {}
  setContextMenu(): void {}
  destroy(): void {}
}

export default { app, ipcMain, BrowserWindow, shell, dialog, clipboard, nativeTheme, powerMonitor, screen, net, Notification, safeStorage, protocol, session, nativeImage, Menu, Tray }
