/** electron-updater no corre sin Electron: la actualización pasa al updater de Tauri (docs/migracion-tauri.md, hito 3). */
import { EventEmitter } from 'node:events'

const pendiente = (): Promise<never> => Promise.reject(new Error('La actualización automática todavía no está disponible en esta versión.'))

class Actualizador extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  allowPrerelease = false
  checkForUpdates = pendiente
  downloadUpdate = pendiente
  quitAndInstall(): void {}
}

export const autoUpdater = new Actualizador()
export default { autoUpdater }
