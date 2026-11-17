import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { AppState } from '../../../../shared/types'
import { InlineAlert, toast } from '../../ui'
import { useUi, type FeatureUi } from '../host'
import './avisos.css'

type SoloLectura = NonNullable<AppState['soloLectura']>

function Global(): React.JSX.Element | null {
  const ui = useUi()
  const [soloLectura, setSoloLectura] = useState<SoloLectura | undefined>()
  useEffect(() => {
    let vivo = true
    const mostrar = (): void => {
      ui.invoke<unknown>('feat:avisos:tomar')
        .then((lista) => {
          if (!Array.isArray(lista)) return
          for (const m of lista) if (typeof m === 'string') toast({ tone: 'warning', message: m, duration: 0 })
        })
        .catch((e: unknown) => toast({ tone: 'danger', message: `No pude leer los avisos del arranque: ${(e as Error).message}`, duration: 0 }))
      // Viene en el estado del núcleo (no en un aviso de una sola vez): sigue después de recargar la ventana.
      api
        .getState()
        .then((s) => {
          if (vivo) setSoloLectura(s.soloLectura)
        })
        .catch((e: unknown) => toast({ tone: 'danger', message: `No pude leer el estado de Sloth: ${(e as Error).message}`, duration: 0 }))
    }
    mostrar()
    const soltar = ui.on('feat:avisos:nuevos', mostrar)
    return () => {
      vivo = false
      soltar()
    }
  }, [ui])
  if (!soloLectura) return null
  return (
    <div className="f-avisos-solo-lectura">
      <InlineAlert tone="danger">
        <strong>Sloth no está guardando cambios.</strong> Motivo: {soloLectura.motivo}. El archivo quedó como estaba en{' '}
        <span className="f-avisos-ruta">{soloLectura.archivo}</span>. Las cuentas y espacios que crees ahora se perderían, así que
        no te dejo crearlos:{' '}
        {soloLectura.causa === 'version-futura'
          ? 'actualizá Sloth, esta versión es más vieja que tus datos.'
          : 'cerrá lo que esté usando ese archivo (antivirus, OneDrive) y reiniciá Sloth.'}
      </InlineAlert>
    </div>
  )
}

const ui: FeatureUi = { name: 'avisos', Global }

export default ui
