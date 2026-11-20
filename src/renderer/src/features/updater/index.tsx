import { lazy, Suspense, useEffect, useState } from 'react'
import { ModalLoading } from '../../Modal'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
import { CheckIcon, CloseIcon, UpdateIcon } from '../../icons/SlothIcons'
import { IconButton } from '../../ui/IconButton'
import { onOpenAbout, onUpdateToast, openAbout, showUpdateToast } from './bus'
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

/** Confirmaciones breves del actualizador: viven en la píldora de la barra superior, no flotan sobre el contenido. */
function useUpdateNote(): string {
  const [note, setNote] = useState('')
  useEffect(() => {
    let timer: number | undefined
    const off = onUpdateToast((m) => {
      setNote(m)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setNote(''), 2400)
    })
    return () => {
      off()
      window.clearTimeout(timer)
    }
  }, [])
  return note
}

/**
 * Aviso discreto en la barra superior, en una sola línea: versión, «Ver novedades» (o «Reiniciar») y una × de «Más tarde».
 * «Más tarde» lo oculta y deja un punto en el acceso a Configuración (ver useUpdateDot).
 */
function UpdateBanner(): React.JSX.Element | null {
  const ui = useUi()
  const st = useUpdateStatus()
  const { phase } = usePhase()
  const note = useUpdateNote()
  if (note) {
    return (
      <div role="status" className="f-updater-banner is-flash">
        <CheckIcon size={14} />
        <span className="f-updater-banner-text">{note}</span>
      </div>
    )
  }
  if (!st || !st.version || st.later) return null
  const v = st.version
  const queued = !!st.queued

  let text: string | null = null
  let full = ''
  let actions: React.ReactNode = null
  if (st.state === 'available') {
    if (queued) {
      text = `${v} al cerrar`
      full = `La ${v} se instala al cerrar Sloth`
    } else {
      text = `Actualización ${v}`
      full = `Hay una versión nueva (${v})`
      actions = (
        <>
          <button type="button" className="btn primary sm" onClick={() => setPhase('notes')}>
            Ver novedades
          </button>
          <IconButton
            label="Más tarde"
            icon={<CloseIcon size={12} />}
            size="sm"
            onClick={() => void ui.invoke('feat:updater:later').catch(() => showUpdateToast('No se pudo dejar el aviso para más tarde'))}
          />
        </>
      )
    }
  } else if (st.state === 'downloading') {
    text = queued ? `${v} al cerrar` : `Descargando ${st.percent ?? 0} %`
    full = queued ? `La ${v} se instala al cerrar Sloth` : `Descargando la ${v}: ${st.percent ?? 0} %`
  } else if (st.state === 'ready') {
    if (queued) {
      text = `${v} al cerrar`
      full = `La ${v} se instala al cerrar Sloth`
    } else {
      text = `${v} lista`
      full = `Sloth ${v} ya está descargada`
      actions = (
        <button type="button" className="btn primary sm" onClick={() => setPhase('dl')}>
          Reiniciar
        </button>
      )
    }
  }
  if (!text || (phase === 'dl' && st.state === 'downloading')) return null

  return (
    <div role="status" className={`f-updater-banner${actions ? ' has-act' : ''}`} aria-label={full} title={full}>
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
        <Suspense fallback={<ModalLoading />}>
          <UpdateDialogs />
        </Suspense>
      )}
      {open && (
        <Suspense fallback={<ModalLoading />}>
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
