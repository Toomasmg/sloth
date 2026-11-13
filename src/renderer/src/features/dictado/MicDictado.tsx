import { useEffect, useRef } from 'react'
import { MicrophoneIcon, XIcon } from '@phosphor-icons/react'
import { cleanError } from '../../format'
import { abrirAjustes, empezar, mostrarError, parar, recibirTexto, useDictado } from './store'
import './dictado.css'

/**
 * Micrófono de la terminal: un toque empieza a escuchar y otro termina. El texto cae en el prompt de
 * Claude sin Enter, para revisarlo antes de mandarlo.
 */
export function MicDictado({ paneId, onTexto }: { paneId: string; onTexto(texto: string): void }): React.JSX.Element {
  const ev = useDictado(paneId)
  const onTextoRef = useRef(onTexto)
  onTextoRef.current = onTexto
  useEffect(() => recibirTexto(paneId, (t) => onTextoRef.current(t)), [paneId])
  // Si el panel se cierra mientras escucha, se suelta el micrófono.
  useEffect(() => () => void parar(paneId).catch(() => undefined), [paneId])

  const estado = ev?.estado ?? 'inactivo'
  const error = ev?.error
  const activo = estado !== 'inactivo'
  const fallar = (e: unknown): void => mostrarError(paneId, { tipo: 'otro', mensaje: cleanError(e), ajustes: false })

  const tocar = (): void => {
    if (estado === 'transcribiendo') return
    if (activo) void parar(paneId).catch(fallar)
    else void empezar(paneId).catch(fallar)
  }

  return (
    <div className="dictado" data-estado={estado}>
      {(activo || error) && (
        <div className={`dictado-pill${error ? ' is-error' : ''}`} role={error ? 'alert' : 'status'}>
          {error ? (
            <>
              <span className="dictado-msg">{error.mensaje}</span>
              {error.ajustes && (
                <button type="button" className="dictado-link" onClick={() => void abrirAjustes(error.tipo).catch(fallar)}>
                  Abrir Configuración
                </button>
              )}
              <button type="button" className="dictado-x" aria-label="Cerrar aviso" onClick={() => mostrarError(paneId)}>
                <XIcon size={12} aria-hidden="true" />
              </button>
            </>
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
        aria-label={activo ? 'Terminar de dictar' : 'Dictar con el micrófono'}
        title={activo ? 'Terminar de dictar' : 'Dictar: hablá y el texto aparece en la terminal, sin mandarse'}
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
