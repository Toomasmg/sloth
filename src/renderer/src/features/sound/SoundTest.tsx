import { playChime } from './audio'
import type { SoundName } from './logic'
import './sound.css'

/** Botón «Probar» de Configuración → Notificaciones y sonido. Suena el de «terminó» con el sonido elegido. */
export function SoundTest({ name, disabled }: { name: SoundName; disabled: boolean }): React.JSX.Element {
  return (
    <button type="button" className="f-sound-test" disabled={disabled} onClick={() => playChime('done', name)}>
      Probar
    </button>
  )
}
