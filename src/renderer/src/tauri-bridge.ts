/**
 * Dentro de Tauri no hay preload: `window.sloth` se arma acá sobre los comandos `ipc_invoke` / `ipc_send`
 * y el evento `sloth://event` de la cáscara de Rust. Sin Tauri no hace nada (Electron lo trae del preload).
 */
import { crearApi } from '../../shared/api-bridge'
import { zoomFor } from '../../shared/zoom-keys'
import { activarArchivos, rutaDe } from './tauri-archivos'

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

/** Ctrl + / Ctrl - / Ctrl 0: el mismo atajo y los mismos niveles que tenía la ventana de Electron. */
function activarZoom(): void {
  let nivel = 0
  document.addEventListener('keydown', (e) => {
    const siguiente = zoomFor({ type: 'keyDown', key: e.key, code: e.code, control: e.ctrlKey, alt: e.altKey, meta: e.metaKey }, nivel)
    if (siguiente === null) return
    e.preventDefault()
    nivel = siguiente
    void import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => getCurrentWebview().setZoom(1.2 ** nivel))
  })
}

/**
 * En Electron, setWindowOpenHandler mandaba los enlaces al navegador del sistema. WebView2 abriría una ventana
 * propia: window.open y los enlaces con target=_blank se redirigen al main, que valida http(s) y los abre afuera.
 */
function activarEnlaces(enviar: (canal: string, url: string) => void): void {
  window.open = (url) => {
    if (url) enviar('tauri:open-external', String(url))
    return null
  }
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null
    if (!a || e.defaultPrevented) return
    const href = (a as HTMLAnchorElement).href
    if (/^https?:\/\//i.test(href) && new URL(href).origin !== location.origin) {
      e.preventDefault()
      enviar('tauri:open-external', href)
    }
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
  activarEnlaces((canal, url) => void invoke('ipc_send', { channel: canal, args: [url] }))
  activarZoom()
  await activarArchivos()
  window.sloth = crearApi({
    invoke: (canal, ...args) => invoke('ipc_invoke', { channel: canal, args }),
    send: (canal, ...args) => void invoke('ipc_send', { channel: canal, args }),
    listen: (canal, cb) => {
      const set = oyentes.get(canal) ?? new Set<Oyente>()
      set.add(cb)
      oyentes.set(canal, set)
      return () => set.delete(cb)
    },
    pathForFile: rutaDe
  })
}
