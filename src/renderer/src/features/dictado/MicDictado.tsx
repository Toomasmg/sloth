import { useEffect, useRef } from 'react'
import { MicrophoneIcon, XIcon } from '@phosphor-icons/react'
import { abrirAjustes, cerrarAviso, empezar, marcarConocido, montar, soltar, terminar, useDictado, useMostrarNovedad } from './store'
import './dictado.css'

/**
 * Micrófono de la terminal: un toque empieza a grabar y otro termina. Whisper lo transcribe en la PC
 * y el texto cae en el prompt de Claude sin Enter, para revisarlo antes de mandarlo.
 */
export function MicDictado({ paneId, onTexto }: { paneId: string; onTexto(texto: string): void }): React.JSX.Element {
  const { estado, error, vacio } = useDictado(paneId)
  const novedad = useMostrarNovedad(paneId)
  useEffect(() => montar(paneId), [paneId])
  const onTextoRef = useRef(onTexto)
  onTextoRef.current = onTexto
  const pegar = (t: string): void => onTextoRef.current(t)
  useEffect(() => () => soltar(paneId), [paneId])
  // «No se escuchó nada» se va solo.
  useEffect(() => {
    if (!vacio) return
    const t = setTimeout(() => cerrarAviso(paneId), 2500)
    return () => clearTimeout(t)
  }, [vacio, paneId])

  const activo = estado !== 'inactivo'
  const tocar = (): void => {
    if (estado === 'transcribiendo') return
    if (estado === 'escuchando') void terminar(paneId, pegar)
    else void empezar(paneId, pegar)
  }

  return (
    <div className="dictado" data-estado={estado}>
      {novedad && !activo && !error && !vacio && (
        <div className="dictado-pill dictado-novedad" role="note">
          <span className="dictado-nuevo">Nuevo</span>
          Dictá con tu voz
          <button type="button" className="dictado-x" aria-label="Cerrar aviso del dictado" onClick={marcarConocido}>
            <XIcon size={12} aria-hidden="true" />
          </button>
        </div>
      )}
      {(activo || error || vacio) && (
        <div className={`dictado-pill${error ? ' is-error' : ''}`} role={error ? 'alert' : 'status'}>
          {error ? (
            <>
              <span className="dictado-msg">{error.mensaje}</span>
              {error.ajustes && (
                <button type="button" className="dictado-link" onClick={() => void abrirAjustes(error.tipo)}>
                  Abrir Configuración
                </button>
              )}
              <button type="button" className="dictado-x" aria-label="Cerrar aviso" onClick={() => cerrarAviso(paneId)}>
                <XIcon size={12} aria-hidden="true" />
              </button>
            </>
          ) : vacio ? (
            'No se escuchó nada'
          ) : (
            <>
              <span className="dictado-dot" aria-hidden="true" />
              {estado === 'escuchando' ? 'Escuchando…' : 'Transcribiendo…'}
            </>
          )}
        </div>
      )}
      <button
        type="button"
        className="dictado-mic"
        aria-pressed={activo}
        aria-label={estado === 'escuchando' ? 'Terminar de dictar' : 'Dictar con el micrófono'}
        title={estado === 'escuchando' ? 'Terminar de dictar' : 'Dictar: hablá y el texto aparece en la terminal, sin mandarse'}
        disabled={estado === 'transcribiendo'}
        // Sin robarle el foco a la terminal: se puede seguir escribiendo mientras se dicta.
        onMouseDown={(e) => e.preventDefault()}
        onClick={tocar}
      >
        <MicrophoneIcon size={15} weight={activo ? 'fill' : 'regular'} aria-hidden="true" />
      </button>
    </div>
  )
}
