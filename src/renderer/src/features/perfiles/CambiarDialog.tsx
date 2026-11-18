import { useState } from 'react'
import { Modal } from '../../Modal'
import { cleanError } from '../../format'
import { Button } from '../../ui'
import { useUi } from '../host'
import type { PerfilesPayload, PerfilVista } from '../../../../shared/perfiles'
import { textoConfirmarCambio } from './view'

/** Confirma el cambio de perfil: Sloth se reinicia, así que nada queda a medias en pantalla. */
export function CambiarDialog({ payload, destino, onClose }: { payload: PerfilesPayload; destino: PerfilVista; onClose: () => void }): React.JSX.Element {
  const ui = useUi()
  const [reiniciando, setReiniciando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const vivas = payload.terminalesVivas
  const puede = payload.puedeConservarTerminales

  const cambiar = async (cerrarTerminales: boolean): Promise<void> => {
    setError(null)
    setReiniciando(true)
    try {
      await ui.invoke('feat:perfiles:cambiar', destino.id, cerrarTerminales ? { cerrarTerminales: true } : {})
    } catch (e) {
      setReiniciando(false)
      setError(cleanError(e))
    }
  }

  const footer = reiniciando ? (
    <span role="status">Reiniciando Sloth…</span>
  ) : (
    <>
      <Button variant="ghost" onClick={onClose}>
        Cancelar
      </Button>
      {vivas > 0 && puede && (
        <Button variant="secondary" onClick={() => void cambiar(true)}>
          Cerrarlas y cambiar
        </Button>
      )}
      <Button variant="primary" autoFocus onClick={() => void cambiar(false)}>
        Cambiar
      </Button>
    </>
  )

  return (
    <Modal title={`Cambiar a «${destino.nombre}»`} size="sm" onClose={onClose} locked={reiniciando} footer={footer} backdropClose>
      <p className="f-perfil-texto">{textoConfirmarCambio(destino.nombre, puede, vivas)}</p>
      {error && (
        <p role="alert" className="f-perfil-error">
          {error}
        </p>
      )}
    </Modal>
  )
}
