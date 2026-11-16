// Genera los PNG de la PWA del celu desde build/icon.svg. Se corre a mano: `npx electron scripts/celu-iconos.mjs`.
// Los PNG quedan versionados en src/celu-web/iconos/ porque no hay rasterizador entre las dependencias.
import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const salida = join(root, 'src', 'celu-web', 'iconos')
const FONDO = '#08090B'
const svg = readFileSync(join(root, 'build', 'icon.svg'), 'utf8')
const logo = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`

// `ancho` es la parte del lado que ocupa el logo; el resto es fondo (maskable usa 0.8: zona segura).
const ICONOS = [
  ['icono-192.png', 192, 1, false],
  ['icono-512.png', 512, 1, false],
  ['icono-maskable-512.png', 512, 0.8, true],
  ['apple-touch-icon.png', 180, 0.9, true],
  ['favicon-32.png', 32, 1, false]
]

const html = (lado, ancho, fondo) => `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:${lado}px;height:${lado}px;overflow:hidden;background:${fondo ? FONDO : 'transparent'}}
body{display:grid;place-items:center}img{width:${Math.round(lado * ancho)}px;height:${Math.round(lado * ancho)}px;display:block}</style><img src="${logo}">`

// Electron no emite `ready` mientras el módulo principal espera con top-level await: va dentro de una función.
async function generar() {
  mkdirSync(salida, { recursive: true })
  // Una sola ventana de 512: varias ventanas offscreen seguidas fallan con UnknownVizError.
  const win = new BrowserWindow({ show: false, width: 512, height: 512, useContentSize: true, frame: false, transparent: true, webPreferences: { offscreen: true } })
  for (const [nombre, lado, ancho, fondo] of ICONOS) {
    await win.loadURL(`data:text/html;base64,${Buffer.from(html(lado, ancho, fondo)).toString('base64')}`)
    await new Promise((r) => setTimeout(r, 400))
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: lado, height: lado })
    writeFileSync(join(salida, nombre), img.toPNG())
  }
  win.destroy()
}

app.disableHardwareAcceleration()
void app.whenReady().then(generar).then(
  () => app.quit(),
  (e) => {
    console.error(e)
    app.exit(1)
  }
)
