/**
 * WebView2 no le da a la página la ruta de lo que se suelta (en Electron salía de webUtils). Tauri sí la
 * entrega en su propio evento de arrastre. Acá ese evento se convierte en eventos DOM comunes (dragenter,
 * dragover, drop, dragleave) con objetos File que recuerdan su ruta, así los componentes no cambian:
 * siguen leyendo dataTransfer y pidiendo la ruta con api.pathForFile(file).
 */
const rutas = new WeakMap<File, string>()

export const rutaDe = (file: File): string => rutas.get(file) ?? ''

const nombreDe = (ruta: string): string => ruta.split(/[\/]/).filter(Boolean).pop() ?? ruta

function transferencia(paths: string[]): DataTransfer {
  const dt = new DataTransfer()
  for (const ruta of paths) {
    const f = new File([], nombreDe(ruta))
    rutas.set(f, ruta)
    dt.items.add(f)
  }
  return dt
}

export async function activarArchivos(): Promise<void> {
  const { getCurrentWebview } = await import('@tauri-apps/api/webview')
  let ultimo: Element | null = null
  const disparar = (tipo: string, destino: Element | null, dt: DataTransfer): void => {
    destino?.dispatchEvent(new DragEvent(tipo, { bubbles: true, cancelable: true, dataTransfer: dt }))
  }
  await getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload
    if (p.type === 'leave') {
      disparar('dragleave', ultimo, new DataTransfer())
      ultimo = null
      return
    }
    const ratio = window.devicePixelRatio || 1
    const destino = document.elementFromPoint(p.position.x / ratio, p.position.y / ratio)
    const dt = p.type === 'drop' || p.type === 'enter' ? transferencia(p.paths) : (ultimoDt ?? transferencia([]))
    if (p.type === 'enter') ultimoDt = dt
    if (ultimo && destino !== ultimo) disparar('dragleave', ultimo, dt)
    if (p.type === 'enter') disparar('dragenter', destino, dt)
    else if (p.type === 'over') disparar('dragover', destino, dt)
    else {
      disparar('drop', destino, dt)
      ultimoDt = null
    }
    ultimo = p.type === 'drop' ? null : destino
  })
}

let ultimoDt: DataTransfer | null = null
