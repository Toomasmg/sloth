import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentStatus, AntiReaApi, PtyChunk } from '../shared/types'

function listen<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: AntiReaApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  addAccount: (label) => ipcRenderer.invoke('accounts:add', label),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  accountStatuses: () => ipcRenderer.invoke('accounts:statuses'),
  accountUsage: () => ipcRenderer.invoke('accounts:usage'),
  setShareSetup: (id, share) => ipcRenderer.invoke('accounts:setShareSetup', id, share),
  addWorkspace: (input) => ipcRenderer.invoke('workspaces:add', input),
  removeWorkspace: (id) => ipcRenderer.invoke('workspaces:remove', id),
  setOpenPanes: (ids) => ipcRenderer.invoke('ui:openPanes', ids),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  ptyStart: (id, cols, rows) => ipcRenderer.invoke('pty:start', id, cols, rows),
  ptyWrite: (id, data) => ipcRenderer.send('pty:write', id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  ptyKill: (id) => ipcRenderer.invoke('pty:kill', id),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),
  onPtyData: (cb) => listen<[string, PtyChunk]>('pty:data', cb),
  onPtyExit: (cb) => listen<[string, number]>('pty:exit', cb),
  onAgentStatus: (cb) => listen<[string, AgentStatus]>('agent:status', cb)
}

contextBridge.exposeInMainWorld('antirea', api)
