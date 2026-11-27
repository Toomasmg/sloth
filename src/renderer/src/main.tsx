import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './fonts.css'
import './tokens.css'
import './styles.css'
import './themes.css'
import { iniciarPuenteTauri } from './tauri-bridge'
import { WindowControls } from './layout/WindowControls'

// En Tauri, window.sloth se arma acá y tiene que existir antes de que se evalúe cualquier módulo que lo use
// (api.ts lo lee al importarse): por eso la app se importa después. En Electron el preload ya lo puso.
await iniciarPuenteTauri()
const { initSettings } = await import('./features/settings/store')
const { App } = await import('./App')

// Tema, densidad y letra: lo último conocido (localStorage) se aplica al instante y main lo confirma
// después. No se espera a main ni a las fuentes: el texto cambia de letra cuando llega la webfont
// (font-display: swap). Las terminales miden la letra al abrir: ver TerminalView.
void initSettings()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <WindowControls />
  </StrictMode>
)

// Pantalla de carga (index.html): se va después del primer frame con la app.
requestAnimationFrame(() => {
  const s = document.getElementById('splash')
  s?.classList.add('out')
  setTimeout(() => s?.remove(), 200)
})
