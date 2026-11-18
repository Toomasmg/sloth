import { useEffect, useState } from 'react'
import { useUi } from '../../host'
import { pickProjectsDir, projectsDirOf, useSettings } from '../store'
import { EDITORS, SLEEP_MINUTES, type EditorChoice, type SleepMinutes } from '../../../../../shared/settings-model'
import { Group, Row, ToggleRow, useSave } from '../ui'
import { Button, Select } from '../../../ui'
/* ---------- General ---------- */

interface TrayState {
  closeToTray: boolean
}

export function GeneralSection(): React.JSX.Element {
  const ui = useUi()
  const p = useSettings()
  const s = p.settings
  const save = useSave()
  const [tray, setTray] = useState<boolean | null>(null)
  useEffect(() => {
    ui.invoke<TrayState>('feat:tray:get').then(
      (t) => setTray(t.closeToTray),
      () => setTray(null)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const toggleTray = (v: boolean): void => {
    save(async () => {
      const r = await ui.invoke<TrayState>('feat:tray:set', { closeToTray: v })
      setTray(r.closeToTray)
    })
  }
  return (
    <>
      <Group id="g-al" title="Al abrir y cerrar Sloth">
        <ToggleRow
          title="Reabrir los espacios de la última vez"
          hint="Vuelven con la misma distribución y la misma cuenta."
          checked={s.reopenSpaces}
          onChange={(reopenSpaces) => save({ reopenSpaces })}
        />
        <ToggleRow
          title="Dejar las terminales vivas al cerrar la ventana"
          hint="Claude sigue trabajando en segundo plano; usa muy poca memoria."
          checked={s.keepTerminalsAlive}
          onChange={(keepTerminalsAlive) => save({ keepTerminalsAlive })}
        />
        <ToggleRow
          title="Preguntar antes de cerrar Sloth"
          hint="Al tocar la X con terminales abiertas, avisa qué pasa con ellas antes de cerrar."
          checked={s.confirmQuit}
          onChange={(confirmQuit) => save({ confirmQuit })}
        />
        <Row
          title="Dormir espacios inactivos"
          hint="Cierra el Claude de un espacio sin uso para liberar memoria. Al volver, retoma la misma conversación. Nunca duerme uno que está trabajando, esperando un permiso o con texto sin enviar."
          htmlFor="f-set-sleep"
        >
          <Select id="f-set-sleep" value={s.sleepAfterMin} onChange={(e) => save({ sleepAfterMin: Number(e.target.value) as SleepMinutes })}
          >
            {SLEEP_MINUTES.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? 'Nunca' : m < 60 ? `Tras ${m} minutos` : `Tras ${m / 60} ${m === 60 ? 'hora' : 'horas'}`}
              </option>
            ))}
          </Select>
        </Row>
        <ToggleRow
          title="Abrir Sloth al iniciar Windows"
          hint={p.loginItemSupported ? 'Arranca minimizado en la bandeja del sistema.' : 'Solo en la app instalada (esta es una versión de desarrollo).'}
          checked={s.openAtLogin}
          disabled={!p.loginItemSupported}
          onChange={(openAtLogin) => save({ openAtLogin })}
        />
        <ToggleRow
          title="Al cerrar, seguir en la bandeja"
          hint={tray === null ? 'No disponible.' : 'La ventana se oculta y Sloth sigue avisándote desde la bandeja.'}
          checked={tray === true}
          disabled={tray === null}
          onChange={toggleTray}
        />
        <ToggleRow
          title="Confirmar al cerrar paneles con Claude trabajando"
          hint="Pregunta antes de ocultar o reiniciar un panel mientras Claude está trabajando."
          checked={s.confirmClosePanes}
          onChange={(confirmClosePanes) => save({ confirmClosePanes })}
        />
      </Group>
      <Group id="g-ed" title="Carpetas y editor">
        <Row title={<>Editor para «Abrir en editor»</>} hint="Se usa desde el menú de cada espacio." htmlFor="f-set-editor">
          <Select id="f-set-editor" value={s.editor} onChange={(e) => save({ editor: e.target.value as EditorChoice })}>
            {EDITORS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </Row>
        <Row title="Carpeta de proyectos" hint={<span className="mono">{projectsDirOf(p)}</span>}>
          <Button size="sm" onClick={() => save(() => pickProjectsDir())}>
            Cambiar…
          </Button>
        </Row>
      </Group>
    </>
  )
}
