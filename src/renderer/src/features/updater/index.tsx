import { lazy, Suspense, useEffect, useState } from 'react'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
import { UpdateIcon } from '../../icons/SlothIcons'
import { onOpenAbout, openAbout } from './bus'
import { setPhase, usePhase } from './phase'
import { useUpdateDot, useUpdateStatus } from './useUpdateStatus'
import './updater.css'

// Diálogos (novedades, descarga, reinicio y «Acerca de») se cargan recién cuando hacen falta.
const UpdateDialogs = lazy(() => import('./Dialogs').then((m) => ({ default: m.UpdateDialogs })))
const AboutModal = lazy(() => import('./Dialogs').then((m) => ({ default: m.AboutModal })))

/**
 * Punto del acceso a Configuración (el engranaje lo muestra): hay una versión que quedó para después
 * con «Más tarde». Lo pinta el engranaje de features/settings; no hace nada más.
 */
export function UpdateDot(): React.JSX.Element | null {
  return useUpdateDot() ? <span className="f-updater-dot" role="img" aria-label="Hay una versión pendiente" title="Hay una versión pendiente" /> : null
}

/**
 * Aviso discreto en la barra superior: «Hay una versión nueva» con «Ver novedades» y «Más tarde».
 * «Más tarde» lo oculta y deja un punto en el acceso a Configuración (ver useUpdateDot).
 */
function UpdateBanner(): React.JSX.Element | null {
  const ui = useUi()
  const st = useUpdateStatus()
  const { phase } = usePhase()
  if (!st || !st.version || st.later) return null
  const v = st.version
  const queued = !!st.queued

  let text: string | null = null
  let actions: React.ReactNode = null
  if (st.state === 'available') {
    if (queued) text = `La ${v} se instala al cerrar Sloth`
    else {
      text = `Hay una versión nueva (${v})`
      actions = (
        <>
          <button type="button" className="btn primary sm" onClick={() => setPhase('notes')}>
            Ver novedades
          </button>
          <button type="button" className="btn ghost sm" onClick={() => void ui.invoke('feat:updater:later').catch(() => {})}>
            Más tarde
          </button>
        </>
      )
    }
  } else if (st.state === 'downloading') {
    text = queued ? `La ${v} se instala al cerrar Sloth` : `Descargando ${v}: ${st.percent ?? 0} %`
  } else if (st.state === 'ready') {
    if (queued) text = `La ${v} se instala al cerrar Sloth`
    else {
      text = `Sloth ${v} ya está descargada`
      actions = (
        <button type="button" className="btn primary sm" onClick={() => setPhase('dl')}>
          Reiniciar
        </button>
      )
    }
  }
  if (!text || (phase === 'dl' && st.state === 'downloading')) return null

  return (
    <div role="status" className="f-updater-banner">
      <UpdateIcon size={14} />
      <span className="f-updater-banner-text">{text}</span>
      {actions}
    </div>
  )
}

function Global(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { phase } = usePhase()
  useEffect(() => onOpenAbout(() => setOpen(true)), [])
  return (
    <>
      {phase && (
        <Suspense fallback={null}>
          <UpdateDialogs />
        </Suspense>
      )}
      {open && (
        <Suspense fallback={null}>
          <AboutModal onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  )
}

const ui: FeatureUi = {
  name: 'updater',
  Titlebar: UpdateBanner,
  Global,
  commands: (ctx) => [
    {
      id: 'updater:check',
      title: 'Buscar actualizaciones',
      group: 'Sloth',
      keywords: 'update actualizar version nueva',
      run: () => {
        openAbout()
        void ctx.invoke('feat:updater:check').catch(() => {})
      }
    },
    {
      id: 'updater:notes',
      title: 'Ver novedades de la versión',
      group: 'Sloth',
      keywords: 'novedades cambios release notas actualizacion',
      run: () => setPhase('notes')
    },
    {
      id: 'updater:about',
      title: 'Acerca de Sloth',
      subtitle: 'Versión, repositorio y bandeja',
      group: 'Sloth',
      keywords: 'about version bandeja tray cerrar',
      run: openAbout
    }
  ]
}

export default ui
