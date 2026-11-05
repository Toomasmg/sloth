import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/jetbrains-mono'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'

// xterm mide el ancho de los caracteres al abrir: la fuente tiene que estar cargada antes.
const fontsReady = Promise.all([
  document.fonts.load('13px "JetBrains Mono Variable"'),
  document.fonts.load('bold 13px "JetBrains Mono Variable"')
]).catch(() => undefined)

void fontsReady.then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
