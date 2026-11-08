import { useEffect, useState } from 'react'
import { ReportIcon } from '../../icons/SlothIcons'
import type { FeatureUi } from '../host'
import { onOpenReport, openReport } from './bus'
import { ReportPage } from './ReportPage'
import './report.css'

/** Global de «report»: la página de Reportar se abre desde la paleta, el menú de ayuda o Configuración. */
function Global(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  useEffect(() => onOpenReport(() => setOpen(true)), [])
  return open ? <ReportPage onClose={() => setOpen(false)} /> : null
}

const ui: FeatureUi = {
  name: 'report',
  Global,
  commands: () => [
    {
      id: 'report:open',
      title: 'Reportar un problema',
      subtitle: 'Revisás el texto antes de abrir GitHub',
      group: 'Sloth',
      keywords: 'bug error problema issue reportar falla',
      icon: <ReportIcon size={16} />,
      run: () => openReport()
    }
  ]
}

export default ui
