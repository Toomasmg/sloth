import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { AgentStatus, SlothApi, PermissionPrompt, PtyChunk } from '../shared/types'
import { isFeatChannel, type UiCommand } from '../shared/features'

function listen<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: SlothApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  addAccount: (label) => ipcRenderer.invoke('accounts:add', label),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  accountStatuses: () => ipcRenderer.invoke('accounts:statuses'),
  accountUsage: () => ipcRenderer.invoke('accounts:usage'),
  setShareSetup: (id, share) => ipcRenderer.invoke('accounts:setShareSetup', id, share),
  addWorkspace: (input) => ipcRenderer.invoke('workspaces:add', input),
  removeWorkspace: (id) => ipcRenderer.invoke('workspaces:remove', id),
  updateWorkspace: (id, patch) => ipcRenderer.invoke('workspaces:update', id, patch),
  revealWorkspace: (id, target) => ipcRenderer.invoke('workspaces:reveal', id, target),
  // Electron ≥ 32 ya no expone File.path: la ruta de lo que se suelta sale de webUtils.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  setOpenPanes: (ids) => ipcRenderer.invoke('ui:openPanes', ids),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  ptyStart: (id, cols, rows) => ipcRenderer.invoke('pty:start', id, cols, rows),
  ptyWrite: (id, data) => ipcRenderer.send('pty:write', id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  ptyKill: (id) => ipcRenderer.invoke('pty:kill', id),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),
  // main puede agrupar varios chunks en un solo mensaje IPC (menos overhead); acepta también uno suelto.
  onPtyData: (cb) =>
    listen<[string, PtyChunk | PtyChunk[]]>('pty:data', (id, chunks) => {
      if (Array.isArray(chunks)) for (const c of chunks) cb(id, c)
      else cb(id, chunks)
    }),
  onPtyExit: (cb) => listen<[string, number]>('pty:exit', cb),
  onAgentStatus: (cb) => listen<[string, AgentStatus]>('agent:status', cb),
  pendingPermissions: () => ipcRenderer.invoke('permission:pending'),
  answerPermission: (id, answer, message) => ipcRenderer.invoke('permission:answer', id, answer, message),
  onPermission: (cb) => listen<[PermissionPrompt]>('permission:new', cb),
  onPermissionResolved: (cb) => listen<[string]>('permission:resolved', cb),
  daemonInfo: () => ipcRenderer.invoke('daemon:info'),
  shutdownTerminals: () => ipcRenderer.invoke('daemon:shutdown'),
  onUi: (cb) => listen<[UiCommand]>('ui:command', cb),
  // Lista blanca: la UI solo puede hablar con canales feat:<función>:<op>.
  feat: {
    invoke: (channel, ...args) =>
      isFeatChannel(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error(`Canal inválido: ${channel}`)),
    on: (channel, cb) => {
      if (!isFeatChannel(channel)) throw new Error(`Canal inválido: ${channel}`)
      return listen(channel, cb)
    }
  }
}

contextBridge.exposeInMainWorld('sloth', api)
