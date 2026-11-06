import type { Command, FeatureUi } from '../features/host'
import { getViewMode, requestEqualize, setViewMode } from './store'

/**
 * Comandos del layout para la paleta (Ctrl+K). Para que aparezcan hay que sumar esta FeatureUi
 * al registro (`features/registry.ts`): ver «pedido al núcleo» en el informe de paneles.
 */
function commands(): Command[] {
  const mode = getViewMode()
  return [
    {
      id: 'layout:view-toggle',
      title: mode === 'grid' ? 'Ver paneles en pestañas' : 'Ver paneles en grilla',
      subtitle: mode === 'grid' ? 'Una terminal a la vez, con barra de pestañas' : 'Todas las terminales a la vista',
      group: 'Paneles',
      keywords: 'vista modo grilla pestañas tabs layout',
      run: () => setViewMode(mode === 'grid' ? 'tabs' : 'grid')
    },
    {
      id: 'layout:equalize',
      title: 'Repartir los paneles por igual',
      subtitle: 'Vuelve las filas y columnas al mismo tamaño',
      group: 'Paneles',
      keywords: 'tamaño proporciones igualar redimensionar layout',
      run: () => requestEqualize()
    }
  ]
}

const layoutUi: FeatureUi = { name: 'layout', commands }
export default layoutUi
