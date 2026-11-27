import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { crearApi } from '../shared/api-bridge'

contextBridge.exposeInMainWorld(
  'sloth',
  crearApi({
    invoke: (canal, ...args) => ipcRenderer.invoke(canal, ...args),
    send: (canal, ...args) => ipcRenderer.send(canal, ...args),
    listen: (canal, cb) => {
      const handler = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...args)
      ipcRenderer.on(canal, handler)
      return () => ipcRenderer.removeListener(canal, handler)
    },
    // Electron ≥ 32 ya no expone File.path: la ruta de lo que se suelta sale de webUtils.
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    }
  })
)
