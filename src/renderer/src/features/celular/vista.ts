import { useEffect, useState } from 'react'
import type { CelularVista } from '../../../../shared/celular'
import { useUi } from '../host'

/** La vista de «celular» al día: la pide una vez y después escucha los cambios. */
export function useVistaCelular(): CelularVista | null {
  const ui = useUi()
  const [v, setV] = useState<CelularVista | null>(null)
  useEffect(() => {
    let vivo = true
    void ui.invoke<CelularVista>('feat:celular:vista').then(
      (x) => vivo && setV(x),
      // Sin la vista, el chip no se muestra: no hay nada que avisar.
      () => undefined
    )
    const off = ui.on('feat:celular:changed', (x: CelularVista) => setV(x))
    return () => {
      vivo = false
      off()
    }
  }, [ui])
  return v
}
