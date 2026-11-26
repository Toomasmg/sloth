import { lazy, Suspense, useEffect, useState } from 'react'
import { DeviceMobileIcon } from '@phosphor-icons/react'
import { toast } from '../../ui'
import { useUi, type FeatureUi } from '../host'
import { onOpenCelular, openCelular } from './bus'
import { useVistaCelular } from './vista'
import './celular.css'
const CelularPanel = lazy(() => import('./CelularPanel').then((m) => ({ default: m.CelularPanel })))

/** Global de «celular»: el panel se abre desde la paleta; avisa si la PC cambió de IP (el QR viejo deja de servir) o si entró un celu. */
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
  useEffect(
    () =>
      ui.on('feat:celular:celu-nuevo', (c: { dispositivo: string; ip: string }) => {
        toast({ tone: 'info', message: `Se conectó un celu (${c.dispositivo}, ${c.ip}). Si no fuiste vos, regenerá el código.`, actionLabel: 'Ver', onAction: openCelular, duration: 10_000 })
      }),
    [ui]
  )
  return open ? (
    <Suspense fallback={null}>
      <CelularPanel onClose={() => setOpen(false)} />
    </Suspense>
  ) : null
}

/** Mientras el servidor del celu está abierto, la barra de título lo dice, y cuántos celus hay adentro. */
function Chip(): React.JSX.Element | null {
  const v = useVistaCelular()
  if (!v || !(v.escuchando || v.remoto?.encendido)) return null
  const n = v.celus.length + (v.remoto?.celuActivo ? 1 : 0)
  const donde = v.escuchando ? (v.remoto?.encendido ? 'en el Wi-Fi y desde cualquier red' : 'en el Wi-Fi') : 'desde cualquier red'
  const quien = n === 0 ? 'ningún celu conectado' : n === 1 ? '1 celu conectado' : `${n} celus conectados`
  return (
    <button type="button" className="f-cel-chip" onClick={openCelular} aria-haspopup="dialog" aria-label={`Celular: abierto ${donde}, ${quien}`} title={`Celular abierto ${donde} · ${quien}`}>
      <DeviceMobileIcon size={17} aria-hidden="true" />
      {n > 0 && (
        <span className="f-cel-chip-n" aria-hidden="true">
          {n}
        </span>
      )}
    </button>
  )
}

const ui: FeatureUi = {
  name: 'celular',
  Titlebar: Chip,
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
