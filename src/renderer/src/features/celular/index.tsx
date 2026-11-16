import { lazy, Suspense, useEffect, useState } from 'react'
import { DeviceMobileIcon } from '@phosphor-icons/react'
import { toast } from '../../ui'
import { useUi, type FeatureUi } from '../host'
import { onOpenCelular, openCelular } from './bus'
import './celular.css'
const CelularPanel = lazy(() => import('./CelularPanel').then((m) => ({ default: m.CelularPanel })))

/** Global de «celular»: el panel se abre desde la paleta; si la PC cambia de IP, avisa (el QR viejo deja de servir). */
function Global(): React.JSX.Element | null {
  const ui = useUi()
  const [open, setOpen] = useState(false)
  useEffect(() => onOpenCelular(() => setOpen(true)), [])
  useEffect(
    () =>
      ui.on('feat:celular:ip-cambio', () => {
        toast({ tone: 'warning', message: 'Cambió la IP de la PC: el celu necesita el QR nuevo.', actionLabel: 'Ver QR', onAction: openCelular, duration: 0 })
      }),
    [ui]
  )
  return open ? (
    <Suspense fallback={null}>
      <CelularPanel onClose={() => setOpen(false)} />
    </Suspense>
  ) : null
}

const ui: FeatureUi = {
  name: 'celular',
  Global,
  commands: () => [
    {
      id: 'celular:open',
      title: 'Ver Sloth en el celular',
      subtitle: 'QR para mirar tus sesiones y límites desde el celu',
      group: 'Sloth',
      keywords: 'celular celu teléfono móvil qr wifi visor límites uso ntfy avisos',
      icon: <DeviceMobileIcon size={16} aria-hidden="true" />,
      run: () => openCelular()
    }
  ]
}

export default ui
