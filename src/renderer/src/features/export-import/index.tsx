import { useEffect, useRef, useState, lazy, Suspense } from 'react'
import { ExportIcon, CloseIcon } from '../../icons/SlothIcons'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
const ExportTab = lazy(() => import('./ExportTab').then((m) => ({ default: m.ExportTab })))
const ImportTab = lazy(() => import('./ImportTab').then((m) => ({ default: m.ImportTab })))
import { onRequest, request } from './bus'
import './export-import.css'

type Tab = 'exportar' | 'importar'

/** Exportar / importar la configuración: dos pestañas en un solo diálogo (lo abre la paleta). */
function EiModal({ initial, onClose }: { initial: Tab; onClose: () => void }): React.JSX.Element {
  const ui = useUi()
  const [tab, setTab] = useState<Tab>(initial)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    ref.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        className="modal f-ei-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="f-ei-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head f-ei-head">
          <ExportIcon size={18} className="f-ei-head-icon" />
          <h2 id="f-ei-title">Exportar e importar la configuración</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <CloseIcon size={16} />
          </button>
        </header>
        <p className="f-ei-lead">Pasá Sloth a otra PC o compartí la configuración con un archivo .sloth.</p>

        <div role="tablist" aria-label="Exportar o importar" className="seg f-ei-tabs">
          <button type="button" role="tab" id="ei-tab-exp" aria-selected={tab === 'exportar'} aria-controls="ei-panel-exp" aria-pressed={tab === 'exportar'} onClick={() => setTab('exportar')}>
            Exportar
          </button>
          <button type="button" role="tab" id="ei-tab-imp" aria-selected={tab === 'importar'} aria-controls="ei-panel-imp" aria-pressed={tab === 'importar'} onClick={() => setTab('importar')}>
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
    </div>
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
  return <EiModal initial={open} onClose={() => setOpen(null)} />
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
