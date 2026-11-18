import { useEffect, useState } from 'react'
import { useUi } from '../../host'
import { LogoMark } from '../../../Logo'
import { openReport } from '../../report/bus'
import { openHelp } from '../../help/bus'
import { runFeatureCommand } from '../../palette'
import { Group } from '../ui'
import { Button } from '../../../ui'
import { goAfterClose, ToggleLikeButton } from './comunes'
/* ---------- Acerca de ---------- */

export function AboutSection({ onClose }: { onClose(): void }): React.JSX.Element {
  const ui = useUi()
  const [version, setVersion] = useState<string>('…')
  useEffect(() => {
    ui.invoke<{ current: string }>('feat:updater:status').then((s) => setVersion(s.current), () => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Las otras ventanas se abren después de cerrar la Configuración, para que tomen el foco.
  const go = (fn: () => void) => goAfterClose(onClose, fn)
  return (
    <>
      <div className="f-set-card f-set-about">
        <LogoMark size={110} />
        <div className="f-set-about-name">Sloth {version}</div>
        <div className="f-set-hint">Varias cuentas de Claude, sin apuro.</div>
        <div className="f-set-actions center">
          <a className="btn sm" href="https://github.com/Toomasmg/sloth" target="_blank" rel="noreferrer">
            Repositorio
          </a>
          <a className="btn sm" href="https://github.com/Toomasmg/sloth/blob/main/PRIVACY.md" target="_blank" rel="noreferrer">
            Privacidad
          </a>
          <Button size="sm" onClick={go(() => openReport())}>
            Reportar un problema
          </Button>
        </div>
        <div className="f-set-hint">Sin telemetría. Sloth busca actualizaciones en GitHub por su cuenta; el resto (chat, celu, ntfy) sale solo si lo activás.</div>
      </div>
      <Group id="g-mas" title="Más">
        <ToggleLikeButton title="Novedades" hint="Qué cambió en la última versión de Sloth." onClick={go(() => openHelp('whatsnew'))} />
        <ToggleLikeButton title="Buscar actualizaciones" hint="Mira si hay una versión nueva y la baja sola." onClick={go(() => runFeatureCommand('updater:check', ui))} />
      </Group>
    </>
  )
}
