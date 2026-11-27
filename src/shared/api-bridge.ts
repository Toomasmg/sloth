import type { PermissionPrompt, PtyChunk, AgentStatus, SlothApi } from './types'
import { isFeatChannel, type UiCommand } from './features'

/** Lo único que cambia entre la ventana de Electron y la de Tauri: cómo viajan los mensajes. */
export interface Transporte {
  invoke<T>(canal: string, ...args: unknown[]): Promise<T>
  send(canal: string, ...args: unknown[]): void
  /** Se suscribe a un canal; devuelve la baja. */
  listen(canal: string, cb: (...args: unknown[]) => void): () => void
  pathForFile(file: File): string
}

export function crearApi(t: Transporte): SlothApi {
  const listen = <A extends unknown[]>(canal: string, cb: (...args: A) => void): (() => void) =>
    t.listen(canal, (...args) => cb(...(args as A)))
  return {
    getState: () => t.invoke('state:get'),
    addAccount: (label, proveedor) => t.invoke('accounts:add', label, proveedor),
    agentes: () => t.invoke('accounts:agentes'),
    removeAccount: (id) => t.invoke('accounts:remove', id),
    accountStatuses: () => t.invoke('accounts:statuses'),
    accountUsage: () => t.invoke('accounts:usage'),
    setShareSetup: (id, share) => t.invoke('accounts:setShareSetup', id, share),
    setLimitesExperimentales: (id, activo) => t.invoke('accounts:setLimitesExperimentales', id, activo),
    setAvisoDeTurno: (id, activo) => t.invoke('accounts:setAvisoDeTurno', id, activo),
    limitesCodex: (id) => t.invoke('accounts:limitesCodex', id),
    addWorkspace: (input) => t.invoke('workspaces:add', input),
    removeWorkspace: (id) => t.invoke('workspaces:remove', id),
    updateWorkspace: (id, patch) => t.invoke('workspaces:update', id, patch),
    revealWorkspace: (id, target) => t.invoke('workspaces:reveal', id, target),
    pathForFile: (file) => t.pathForFile(file),
    setOpenPanes: (ids) => t.invoke('ui:openPanes', ids),
    pickFolder: () => t.invoke('dialog:pickFolder'),
    ptyStart: (id, cols, rows) => t.invoke('pty:start', id, cols, rows),
    ptyWrite: (id, data) => t.send('pty:write', id, data),
    ptyResize: (id, cols, rows) => t.send('pty:resize', id, cols, rows),
    ptyKill: (id) => t.invoke('pty:kill', id),
    clipboardRead: () => t.invoke('clipboard:read'),
    clipboardWrite: (text) => t.invoke('clipboard:write', text),
    // main puede agrupar varios chunks en un solo mensaje IPC (menos overhead); acepta también uno suelto.
    onPtyData: (cb) =>
      listen<[string, PtyChunk | PtyChunk[]]>('pty:data', (id, chunks) => {
        if (Array.isArray(chunks)) for (const c of chunks) cb(id, c)
        else cb(id, chunks)
      }),
    onPtyExit: (cb) => listen<[string, number]>('pty:exit', cb),
    onAgentStatus: (cb) => listen<[string, AgentStatus]>('agent:status', cb),
    pendingPermissions: () => t.invoke('permission:pending'),
    onPermission: (cb) => listen<[PermissionPrompt]>('permission:new', cb),
    onPermissionResolved: (cb) => listen<[string]>('permission:resolved', cb),
    daemonInfo: () => t.invoke('daemon:info'),
    shutdownTerminals: () => t.invoke('daemon:shutdown'),
    onUi: (cb) => listen<[UiCommand]>('ui:command', cb),
    // Lista blanca: la UI solo puede hablar con canales feat:<función>:<op>.
    feat: {
      invoke: (channel, ...args) =>
        isFeatChannel(channel) ? t.invoke(channel, ...args) : Promise.reject(new Error(`Canal inválido: ${channel}`)),
      on: (channel, cb) => {
        if (!isFeatChannel(channel)) throw new Error(`Canal inválido: ${channel}`)
        return listen(channel, cb)
      }
    }
  }
}
