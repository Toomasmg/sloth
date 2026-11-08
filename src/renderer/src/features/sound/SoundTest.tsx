import { playChime } from './audio'
import type { SoundName } from './logic'
import './sound.css'

/** Botón «Probar» de Configuración → Notificaciones y sonido. Suena el de «terminó» con el sonido elegido. */
export function SoundTest({ name, disabled }: { name: SoundName; disabled: boolean }): React.JSX.Element {
  return (
    <button type="button" className="f-sound-test" disabled={disabled} onClick={() => playChime('done', name)}>
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 9.5h3l4-3.5v12l-4-3.5H4zM15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11" />
      </svg>
      Probar
    </button>
  )
}
