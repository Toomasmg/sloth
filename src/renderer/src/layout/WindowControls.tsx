import { useEffect, useState } from 'react'
import './window-controls.css'

const enTauri = (): boolean => '__TAURI_INTERNALS__' in window

/**
 * Minimizar, maximizar y cerrar de la ventana sin marco de Tauri. En Electron Windows los dibuja
 * (titleBarOverlay) y esto no pinta nada.
 */
export function WindowControls(): React.JSX.Element | null {
  const [maximizada, setMaximizada] = useState(false)
  const tauri = enTauri()

  useEffect(() => {
    if (!tauri) return
    let baja: (() => void) | undefined
    let vivo = true
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow()
      const leer = (): void => void w.isMaximized().then((m) => vivo && setMaximizada(m))
      leer()
      const off = await w.onResized(leer)
      if (vivo) baja = off
      else off()
    })
    return () => {
      vivo = false
      baja?.()
    }
  }, [tauri])

  if (!tauri) return null
  const accion = (fn: 'minimize' | 'toggleMaximize' | 'close') => (): void => {
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow()[fn]())
  }
  return (
    <div className="wc" role="group" aria-label="Controles de la ventana">
      <button type="button" className="wc-btn" aria-label="Minimizar" onClick={accion('minimize')}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </button>
      <button type="button" className="wc-btn" aria-label={maximizada ? 'Restaurar' : 'Maximizar'} onClick={accion('toggleMaximize')}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          {maximizada ? (
            <path d="M2.5 2.5V0.5h7v7h-2M0.5 2.5h7v7h-7z" stroke="currentColor" strokeWidth="1" fill="none" />
          ) : (
            <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" />
          )}
        </svg>
      </button>
      <button type="button" className="wc-btn wc-close" aria-label="Cerrar" onClick={accion('close')}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </button>
    </div>
  )
}
