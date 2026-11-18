import { openPermissionDecisions } from '../../permissions/store'
import { SoundTest } from '../../sound/SoundTest'
import { useSettings } from '../store'
import { type SoundName } from '../../../../../shared/settings-model'
import { Group, Row, ToggleRow, useSave, SectionHint } from '../ui'
import { Select } from '../../../ui'
import { goAfterClose } from './comunes'
/* ---------- Notificaciones y sonido ---------- */

const SOUND_OPTIONS: { value: SoundName | 'Sin sonido'; label: string }[] = [
  { value: 'Gota', label: 'Gota' },
  { value: 'Campana suave', label: 'Campana suave' },
  { value: 'Clic', label: 'Clic' },
  { value: 'Sin sonido', label: 'Sin sonido' }
]

export function NotificationsSection({ onClose }: { onClose(): void }): React.JSX.Element {
  const p = useSettings()
  const s = p.settings
  const save = useSave()
  const selected = s.sounds ? s.soundName : 'Sin sonido'
  return (
    <>
      <Group id="g-av" title="Avisarme cuando…">
        <ToggleRow title="Claude termina una tarea" hint="Aviso de Windows y el estado «Listo» en la barra." checked={s.notify.done} onChange={(done) => save({ notify: { done } })} />
        <ToggleRow title="Claude pide permiso" hint="Te recomendamos dejarlo prendido: si no, Claude queda esperando." checked={s.notify.perm} onChange={(perm) => save({ notify: { perm } })} />
        <ToggleRow title="Avisos del chat" hint="Un aviso cuando te escriben en el chat del equipo y no lo estás mirando." checked={s.notify.team} onChange={(team) => save({ notify: { team } })} />
        <ToggleRow title="No molestar" hint="Silencia todo hasta que lo apagues." checked={s.noMolestar} onChange={(noMolestar) => save({ noMolestar })} />
      </Group>
      {s.noMolestar && <SectionHint>«No molestar» está activo: no suena nada ni avisa.</SectionHint>}
      <p className="f-set-note">
        <button type="button" className="f-set-link" onClick={goAfterClose(onClose, () => openPermissionDecisions())}>
          Ver reglas de permisos y decisiones
        </button>
      </p>
      <Group id="g-so" title="Sonido">
        <Row title={<label htmlFor="f-set-sound">Sonido de aviso</label>} hint="Suena aunque la ventana esté en segundo plano.">
          <Select id="f-set-sound" value={selected} onChange={(e) => {
              const v = e.target.value
              save(v === 'Sin sonido' ? { sounds: false } : { sounds: true, soundName: v as SoundName })
            }}
          >
            {SOUND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <SoundTest name={s.soundName} disabled={!s.sounds} />
        </Row>
      </Group>
      <Group id="g-ch" title="Sonido del chat">
        <ToggleRow title="Sonido al recibir mensajes" hint="Suena una vez por cada mensaje de otra persona. Con «Sin sonido» no suena." checked={s.notify.soundIn} onChange={(soundIn) => save({ notify: { soundIn } })} />
        <ToggleRow title="Sonido al enviar mensajes" hint="Un toque más corto y suave cuando mandás el tuyo." checked={s.notify.soundOut} onChange={(soundOut) => save({ notify: { soundOut } })} />
      </Group>
    </>
  )
}
