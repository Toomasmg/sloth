import { useEffect, useState } from 'react'
import { DoneIcon, IdleIcon } from '../../icons/SlothIcons'
import { loginPaneId } from '../../../../shared/types'
import { useUi, type Command, type FeatureUi } from '../host'
import { LogoMark } from '../../Logo'
import { View } from '../../ui/View'
import { Button } from '../../ui'
import { FirstRun } from './FirstRun'
import { onOpen, requestOpen, setDocked, useDocked } from './bus'
import './onboarding.css'

/** Mientras se inicia sesión se deja ver la terminal: la guía se achica a una tarjeta flotante. */
function LoginDock({ accountId }: { accountId: string }): React.JSX.Element {
  const ui = useUi()
  const acc = ui.accounts.find((a) => a.id === accountId)
  const st = ui.statuses[accountId]
  const second = ui.accounts.length > 1
  useEffect(() => {
    if (!st?.loggedIn) return
    const t = setTimeout(() => setDocked(null), 1400)
    return () => clearTimeout(t)
  }, [st?.loggedIn])
  return (
    <aside className="fr-dock" aria-label="Inicio de sesión de la cuenta" aria-live="polite">
      <div className="fr-dock-head">
        <LogoMark size={20} />
        <strong className="fr-grow">Iniciá sesión en «{acc?.label ?? 'la cuenta'}»</strong>
      </div>
      {st?.loggedIn ? (
        <p className="fr-dock-ok">
          <DoneIcon size={16} /> Sesión iniciada{st.email ? ` como ${st.email}` : ''}.
        </p>
      ) : (
        <ol className="fr-dock-steps">
          <li>En la terminal, elegí el método de inicio de sesión y apretá Enter.</li>
          <li>{second ? 'Copiá el link que aparece y abrilo en una ventana de incógnito (Ctrl+Shift+N).' : 'Se abre el navegador: autorizá a Claude Code.'}</li>
          <li>Cuando termine, esta tarjeta se marca sola.</li>
        </ol>
      )}
      <div className="fr-dock-foot">
        {!st?.loggedIn && (
          <span className="fr-wait">
            <IdleIcon size={10} className="fr-pulse" /> Esperando…
          </span>
        )}
        <Button size="sm" onClick={() => setDocked(null)}>
          Listo
        </Button>
      </div>
      <span className="sr-only">{ui.openPanes.includes(loginPaneId(accountId)) ? '' : 'La terminal de la cuenta está cerrada.'}</span>
    </aside>
  )
}

function Global(): React.JSX.Element | null {
  const docked = useDocked()
  const [open, setOpen] = useState(false)
  useEffect(() => onOpen(() => setOpen(true)), [])
  return (
    <>
      {docked && <LoginDock accountId={docked} />}
      {open && (
        <View labelId="fr-view-title" title="Primeros pasos" onClose={() => setOpen(false)}>
          <FirstRun embedded />
        </View>
      )}
    </>
  )
}

const ui: FeatureUi = {
  name: 'onboarding',
  Global,
  commands: (): Command[] => [
    {
      id: 'onboarding:open',
      title: 'Primeros pasos',
      subtitle: 'Revisar el entorno, agregar cuentas y crear un espacio',
      group: 'Ayuda',
      keywords: 'bienvenida onboarding asistente configurar inicio primeros pasos empecemos',
      run: requestOpen
    }
  ]
}

export default ui
