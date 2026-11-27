/**
 * Reemplaza a electron-updater con el updater de Tauri (firmado, con latest.json en las releases de GitHub).
 * Expone lo que usa features/updater.ts: eventos, checkForUpdates, downloadUpdate, quitAndInstall y CancellationToken.
 */
import { EventEmitter } from 'node:events'
import { puente } from './electron-shim'

interface Aviso {
  version: string
  date?: string | null
  notes?: string | null
}

export class CancellationToken {
  cancelled = false
  cancel(): void {
    this.cancelled = true
  }
}

class Actualizador extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  allowPrerelease = false
  logger: unknown = null
  private escuchando = false
  private version = ''

  private escuchar(): void {
    if (this.escuchando) return
    this.escuchando = true
    let total = 0
    puente.alEvento('updater', (que, datos) => {
      if (que !== 'progress') return
      const p = datos as { transferred: number; total?: number | null }
      total = p.total ?? total
      this.emit('download-progress', { percent: total ? (p.transferred / total) * 100 : 0, transferred: p.transferred, total })
    })
  }

  async checkForUpdates(): Promise<void> {
    this.escuchar()
    this.emit('checking-for-update')
    try {
      const a = await puente.nativo<Aviso | null>('updater.check')
      if (!a) {
        this.emit('update-not-available', {})
        return
      }
      this.version = a.version
      this.emit('update-available', { version: a.version, releaseDate: a.date ?? undefined, releaseNotes: a.notes ?? '' })
    } catch (e) {
      this.emit('error', e)
      throw e
    }
  }

  async downloadUpdate(token?: CancellationToken): Promise<void> {
    this.escuchar()
    try {
      await puente.nativo('updater.download')
      // Tauri no corta una descarga en curso: si se canceló, termina pero no se avisa como lista.
      if (token?.cancelled) return
      this.emit('update-downloaded', { version: this.version })
    } catch (e) {
      this.emit('error', e)
      throw e
    }
  }

  quitAndInstall(): void {
    void puente.nativo('updater.install').catch((e) => this.emit('error', e))
  }
}

export const autoUpdater = new Actualizador()
export default { autoUpdater, CancellationToken }
