/**
 * Dentro de Tauri no hay preload: `window.sloth` se arma acá sobre los comandos `ipc_invoke` / `ipc_send`
 * y el evento `sloth://event` de la cáscara de Rust. Sin Tauri no hace nada (Electron lo trae del preload).
 */
import { crearApi } from '../../shared/api-bridge'

type Oyente = (...args: unknown[]) => void

/**
 * La barra superior se arrastra con `-webkit-app-region: drag` (CSS de Electron). Tauri no lo interpreta:
 * se lee el mismo estilo al apretar el mouse y se pide el arrastre a la ventana. Doble clic maximiza.
 */
function activarArrastre(): void {
  const regionDe = (inicio: EventTarget | null): string => {
    for (let el = inicio instanceof Element ? inicio : null; el; el = el.parentElement) {
      const r = getComputedStyle(el).getPropertyValue('-webkit-app-region').trim()
      if (r === 'drag' || r === 'no-drag') return r
    }
    return ''
  }
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || regionDe(e.target) !== 'drag') return
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const w = getCurrentWindow()
      return e.detail === 2 ? w.toggleMaximize() : w.startDragging()
    })
  })
}

export async function iniciarPuenteTauri(): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window) || window.sloth) return
  const { invoke } = await import('@tauri-apps/api/core')
  const { listen } = await import('@tauri-apps/api/event')
  const oyentes = new Map<string, Set<Oyente>>()
  // Una sola suscripción de Tauri: acá se reparte por canal. Se espera antes de pintar para no perder eventos.
  await listen<{ channel: string; args: unknown[] }>('sloth://event', (e) => {
    for (const fn of oyentes.get(e.payload.channel) ?? []) fn(...e.payload.args)
  })
  activarArrastre()
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
