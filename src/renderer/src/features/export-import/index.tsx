import { useEffect, useState, lazy, Suspense } from 'react'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
import { View } from '../../ui/View'
const ExportTab = lazy(() => import('./ExportTab').then((m) => ({ default: m.ExportTab })))
const ImportTab = lazy(() => import('./ImportTab').then((m) => ({ default: m.ImportTab })))
import { onRequest, request } from './bus'
import './export-import.css'

type Tab = 'exportar' | 'importar'

/**
 * Exportar / importar la configuración: página a pantalla completa con dos pestañas (la abre la paleta,
 * el menú de Sloth o Configuración → Copia de seguridad). Vuelve a Configuración con «‹ Configuración», como en el artboard.
 */
function EiPage({ initial, onClose }: { initial: Tab; onClose: () => void }): React.JSX.Element {
  const ui = useUi()
  const [tab, setTab] = useState<Tab>(initial)

  return (
    <View
      labelId="f-ei-view-title"
      title="Exportar e importar"
      onClose={onClose}
      backLabel="Configuración"
    >
      <div className="f-ei-wrap">
        <div className="f-ei-head">
          <h1 id="f-ei-h1">Exportar e importar la configuración</h1>
          <p>Pasá Sloth a otra PC o compartí la configuración del equipo con un archivo .sloth.</p>
        </div>

        <div role="tablist" aria-label="Exportar o importar" className="f-ei-tabs">
          <button
            type="button"
            role="tab"
            id="ei-tab-exp"
            aria-selected={tab === 'exportar'}
            aria-controls="ei-panel-exp"
            className={tab === 'exportar' ? 'on' : ''}
            onClick={() => setTab('exportar')}
          >
            Exportar
          </button>
          <button
            type="button"
            role="tab"
            id="ei-tab-imp"
            aria-selected={tab === 'importar'}
            aria-controls="ei-panel-imp"
            className={tab === 'importar' ? 'on' : ''}
            onClick={() => setTab('importar')}
          >
            Importar
          </button>
        </div>

        {/* Las dos pestañas quedan montadas: cambiar de pestaña no pierde lo que estabas eligiendo. */}
        <div id="ei-panel-exp" role="tabpanel" aria-labelledby="ei-tab-exp" hidden={tab !== 'exportar'}>
          <Suspense fallback={null}>
            <ExportTab ui={ui} />
          </Suspense>
        </div>
        <div id="ei-panel-imp" role="tabpanel" aria-labelledby="ei-tab-imp" hidden={tab !== 'importar'}>
          <Suspense fallback={null}>
            <ImportTab ui={ui} onClose={onClose} />
          </Suspense>
        </div>
      </div>
    </View>
  )
}

function Global(): React.JSX.Element | null {
  const [open, setOpen] = useState<Tab | null>(null)
  useEffect(
    () =>
      onRequest((r) => {
        setOpen(r.kind === 'export' ? 'exportar' : 'importar')
      }),
    []
  )
  if (!open) return null
  return <EiPage initial={open} onClose={() => setOpen(null)} />
}

const ui: FeatureUi = {
  name: 'export-import',
  Global,
  commands: () => [
    {
      id: 'export-import:export',
      title: 'Exportar configuración',
      subtitle: 'Espacios, plantillas, apariencia y reglas en un archivo .sloth (sin sesiones)',
      group: 'Sloth',
      keywords: 'export backup respaldo otra pc sloth archivo',
      run: () => request({ kind: 'export' })
    },
    {
      id: 'export-import:import',
      title: 'Importar configuración',
      subtitle: 'Desde un archivo .sloth de otra PC',
      group: 'Sloth',
      keywords: 'import restaurar otra pc sloth archivo json',
      run: () => request({ kind: 'import' })
    }
  ]
}

export default ui
