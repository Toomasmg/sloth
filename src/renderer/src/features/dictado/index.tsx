import { useEffect, useRef } from 'react'
import { MicrophoneIcon, XIcon } from '@phosphor-icons/react'
import type { FeatureUi, UiCtx } from '../host'
import { useUi } from '../host'
import { IconButton } from '../../ui'
import { comboLabel, isCapturingShortcut, matchShortcut } from '../../shortcuts'
import { abrirAjustes, alternar, cerrarAviso, marcarConocido, useDictado, useDictadoDisponible, useMostrarNovedad } from './store'
import './dictado.css'

function BotonDictado({ paneId }: { paneId: string }): React.JSX.Element | null {
  const disponible = useDictadoDisponible(paneId)
  const { estado, error, vacio } = useDictado(paneId)
  const novedad = useMostrarNovedad(paneId)
  if (!disponible) return null
  const label = estado === 'escuchando' ? 'Detener dictado' : estado === 'transcribiendo' ? 'Transcribiendo…' : 'Dictar'
  return (
    <>
      {novedad && estado === 'inactivo' && !error && !vacio && (
        <button type="button" className="dictado-nuevo" title="Dictá con tu voz. Tocá para ocultar este aviso." onMouseDown={(e) => e.preventDefault()} onClick={marcarConocido}>
          Nuevo
        </button>
      )}
      {estado !== 'inactivo' && (
        <span className="dictado-estado" data-estado={estado} role="status">
          <span className="dictado-dot" aria-hidden="true" />
          <span className="dictado-estado-texto">{estado === 'escuchando' ? 'Escuchando…' : 'Transcribiendo…'}</span>
        </span>
      )}
      <IconButton
        className="dictado-btn"
        data-estado={estado}
        label={label}
        shortcut={comboLabel('dictado')}
        icon={<MicrophoneIcon size={16} weight={estado === 'inactivo' ? 'regular' : 'fill'} aria-hidden="true" />}
        loading={estado === 'transcribiendo'}
        // Sin robarle el foco a la terminal: se puede seguir escribiendo mientras se dicta.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          marcarConocido()
          alternar(paneId)
        }}
      />
    </>
  )
}

/** Avisos en el flujo del panel (no flotan sobre la terminal): novedad, error y «no se escuchó nada». */
function AvisosDictado({ paneId }: { paneId: string }): React.JSX.Element | null {
  const disponible = useDictadoDisponible(paneId)
  const { error, vacio } = useDictado(paneId)
  if (!disponible) return null
  if (error) {
    return (
      <div className="dictado-banner">
        <div className="dictado-pill is-error" role="alert">
          <span className="dictado-msg">{error.mensaje}</span>
          {error.ajustes && (
            <button type="button" className="dictado-link" onClick={() => void abrirAjustes(error.tipo)}>
              Abrir Configuración
            </button>
          )}
          <button type="button" className="dictado-x" aria-label="Cerrar aviso" onClick={() => cerrarAviso(paneId)}>
            <XIcon size={12} aria-hidden="true" />
          </button>
        </div>
      </div>
    )
  }
  if (vacio) {
    return (
      <div className="dictado-banner">
        <div className="dictado-pill" role="status">
          No se escuchó nada
        </div>
      </div>
    )
  }
  return null
}

/** Atajo para alternar el dictado del panel enfocado. En captura para que xterm no se lo coma. */
function AtajoDictado(): null {
  const ctx = useUi()
  const ref = useRef<UiCtx>(ctx)
  ref.current = ctx
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isCapturingShortcut() || !matchShortcut('dictado', e)) return
      const id = ref.current.focused
      if (!id) return
      e.preventDefault()
      e.stopPropagation()
      alternar(id)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return null
}

const ui: FeatureUi = {
  name: 'dictado',
  PaneHeader: BotonDictado,
  PaneBanner: AvisosDictado,
  Global: AtajoDictado,
  paneActions: (_ctx, paneId) => [
    {
      id: 'dictado',
      label: 'Dictar con la voz',
      group: 'editar',
      order: 90,
      icon: <MicrophoneIcon size={15} aria-hidden="true" />,
      shortcut: comboLabel('dictado'),
      run: () => alternar(paneId)
    }
  ],
  commands: (ctx) => [
    {
      id: 'dictado:alternar',
      title: 'Dictar con la voz (empezar o terminar)',
      subtitle: 'En el panel enfocado',
      group: 'Terminal',
      keywords: 'dictado voz microfono hablar whisper',
      shortcut: comboLabel('dictado'),
      icon: <MicrophoneIcon size={16} aria-hidden="true" />,
      run() {
        if (ctx.focused) alternar(ctx.focused)
        else ctx.notifyError('Enfocá un panel con terminal primero.')
      }
    }
  ]
}

export default ui
