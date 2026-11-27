/**
 * Dentro de Tauri no hay preload: `window.sloth` se arma acá sobre los comandos `ipc_invoke` / `ipc_send`
 * y el evento `sloth://event` de la cáscara de Rust. Sin Tauri no hace nada (Electron lo trae del preload).
 */
import { crearApi } from '../../shared/api-bridge'

type Oyente = (...args: unknown[]) => void

export async function iniciarPuenteTauri(): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window) || window.sloth) return
  const { invoke } = await import('@tauri-apps/api/core')
  const { listen } = await import('@tauri-apps/api/event')
  const oyentes = new Map<string, Set<Oyente>>()
  // Una sola suscripción de Tauri: acá se reparte por canal. Se espera antes de pintar para no perder eventos.
  await listen<{ channel: string; args: unknown[] }>('sloth://event', (e) => {
    for (const fn of oyentes.get(e.payload.channel) ?? []) fn(...e.payload.args)
  })
  window.sloth = crearApi({
    invoke: (canal, ...args) => invoke('ipc_invoke', { channel: canal, args }),
    send: (canal, ...args) => void invoke('ipc_send', { channel: canal, args }),
    listen: (canal, cb) => {
      const set = oyentes.get(canal) ?? new Set<Oyente>()
      set.add(cb)
      oyentes.set(canal, set)
      return () => set.delete(cb)
    },
    // WebView2 no entrega la ruta de un archivo soltado: se resuelve con el evento de arrastre de Tauri (pendiente).
    pathForFile: () => ''
  })
}
