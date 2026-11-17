import { useEffect } from 'react'
import { toast } from '../../ui'
import { useUi, type FeatureUi } from '../host'

function Global(): null {
  const ui = useUi()
  useEffect(() => {
    const mostrar = (): void => {
      ui.invoke<unknown>('feat:avisos:tomar')
        .then((lista) => {
          if (!Array.isArray(lista)) return
          for (const m of lista) if (typeof m === 'string') toast({ tone: 'warning', message: m, duration: 0 })
        })
        .catch((e: unknown) => toast({ tone: 'danger', message: `No pude leer los avisos del arranque: ${(e as Error).message}`, duration: 0 }))
    }
    mostrar()
    return ui.on('feat:avisos:nuevos', mostrar)
  }, [ui])
  return null
}

const ui: FeatureUi = { name: 'avisos', Global }

export default ui
