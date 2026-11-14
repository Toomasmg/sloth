import { useEffect, useRef } from 'react'
import { cerrarAviso, montar, registrarPegador, soltar, useDictado } from './store'

/**
 * Sin dibujo: conecta la terminal de un panel con el dictado. El botón vive en la cabecera del panel
 * (index.tsx) y el texto dictado cae en el prompt de Claude sin Enter, para revisarlo antes de mandarlo.
 */
export function MicDictado({ paneId, onTexto }: { paneId: string; onTexto(texto: string): void }): null {
  const { vacio } = useDictado(paneId)
  const onTextoRef = useRef(onTexto)
  onTextoRef.current = onTexto
  useEffect(() => montar(paneId), [paneId])
  useEffect(() => registrarPegador(paneId, (t) => onTextoRef.current(t)), [paneId])
  useEffect(() => () => soltar(paneId), [paneId])
  // «No se escuchó nada» se va solo.
  useEffect(() => {
    if (!vacio) return
    const t = setTimeout(() => cerrarAviso(paneId), 2500)
    return () => clearTimeout(t)
  }, [vacio, paneId])
  return null
}
