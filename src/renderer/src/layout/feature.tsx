import type { Command, FeatureUi } from '../features/host'
import { LAYOUT_CAP, LAYOUT_LABEL, type ViewMode } from './logic'
import { getViewMode, requestEqualize, setViewMode } from './store'
import { goTo } from './nav'
import { NAV_LABEL, NAV_MAIN } from './nav-model'

/**
 * Comandos del layout para la paleta (Ctrl+K): ir a cada destino del riel y la distribución. Para que aparezcan hay que sumar esta FeatureUi
 * al registro (`features/registry.ts`).
 */
const KINDS: ViewMode[] = ['uno', 'dos', 'tres', 'cuatro']

function commands(): Command[] {
  const current = getViewMode()
  const distribution: Command[] = KINDS.map((k) => ({
    id: `layout:${k}`,
    title: `Distribución ${LAYOUT_LABEL[k]}${k === current ? ' (actual)' : ''}`,
    subtitle: `${LAYOUT_CAP[k] === 1 ? '1 panel a la vista' : `hasta ${LAYOUT_CAP[k]} paneles a la vista`}, el resto en pestañas`,
    group: 'Paneles',
    keywords: 'distribucion vista uno dos tres cuatro grilla pestañas tabs layout',
    run: () => setViewMode(k)
  }))
  const nav: Command[] = NAV_MAIN.map((d, i) => ({
    id: `nav:${d}`,
    title: `Ir a ${NAV_LABEL[d]}`,
    group: 'Ir a',
    shortcut: `Ctrl+Shift+${i + 1}`,
    keywords: 'ir navegar riel destino vista',
    run: () => goTo(d)
  }))
  return [
    ...nav,
    ...distribution,
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
