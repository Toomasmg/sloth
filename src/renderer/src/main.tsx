import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/jetbrains-mono'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import './theme-a.css'
import './themes.css'
import { initSettings } from './features/settings/store'
import { App } from './App'

// xterm mide el ancho de los caracteres al abrir: la fuente tiene que estar cargada antes.
const fontsReady = Promise.all([
  document.fonts.load('13px "JetBrains Mono Variable"'),
  document.fonts.load('bold 13px "JetBrains Mono Variable"')
]).catch(() => undefined)

// Tema, densidad y letra antes del primer render (lo último conocido ya mismo; main lo confirma).
const settingsReady = initSettings().catch(() => undefined)

void Promise.all([fontsReady, settingsReady]).then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
  // Pantalla de carga (index.html): se va después del primer frame con la app.
  requestAnimationFrame(() => {
    const s = document.getElementById('splash')
    s?.classList.add('out')
    setTimeout(() => s?.remove(), 200)
  })
})
