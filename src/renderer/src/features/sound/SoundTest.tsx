import { playChime } from './audio'
import './sound.css'

/** Botón «Probar» de Configuración → Comportamiento. Suena el de «terminó». Apagado si el ajuste está apagado. */
export function SoundTest({ disabled }: { disabled: boolean }): React.JSX.Element {
  return (
    <div className="f-sound-test">
      <button type="button" className="btn sm" disabled={disabled} onClick={() => playChime('done')}>
        Probar
      </button>
      {disabled && <span className="hint">Activá el sonido para probarlo.</span>}
    </div>
  )
}
