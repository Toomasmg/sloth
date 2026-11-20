import { lazy, Suspense, useEffect, useState } from 'react'
import { ModalLoading } from '../../Modal'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
import { CheckIcon, UpdateIcon } from '../../icons/SlothIcons'
import { Tooltip } from '../../ui/Tooltip'
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
 * Aviso de la barra superior: un chip compacto con el ícono y la versión (o el %). Cede lugar a los resúmenes
 * de estado, así que el detalle va en el tooltip; «Más tarde» está en el diálogo de novedades.
 */
function UpdateBanner(): React.JSX.Element | null {
  const st = useUpdateStatus()
  const { phase } = usePhase()
  const note = useUpdateNote()
  if (note) {
    return (
      <div role="status" className="f-updater-banner is-flash" title={note}>
        <CheckIcon size={14} />
        <span className="f-updater-banner-text">{note}</span>
      </div>
    )
  }
  if (!st || !st.version || st.later) return null
  const v = st.version
  const queued = !!st.queued
  const alCerrar = `La ${v} se instala al cerrar Sloth`

  let text: string | null = null
  let full = ''
  let onClick: (() => void) | null = null
  if (st.state === 'available') {
    text = v
    if (queued) full = alCerrar
    else {
      full = `Hay una versión nueva (${v}): ver novedades`
      onClick = () => setPhase('notes')
    }
  } else if (st.state === 'downloading') {
    text = queued ? v : `${st.percent ?? 0} %`
    full = queued ? alCerrar : `Descargando la ${v}: ${st.percent ?? 0} %`
  } else if (st.state === 'ready') {
    text = v
    if (queued) full = alCerrar
    else {
      full = `Sloth ${v} ya está descargada: reiniciar para instalarla`
      onClick = () => setPhase('dl')
    }
  }
  if (!text || (phase === 'dl' && st.state === 'downloading')) return null

  const inner = (
    <>
      <UpdateIcon size={14} />
      <span className="f-updater-banner-text">{text}</span>
    </>
  )
  return (
    <Tooltip text={full}>
      {onClick ? (
        <button type="button" className="f-updater-banner is-act" aria-label={full} onClick={onClick}>
          {inner}
        </button>
      ) : (
        <div role="status" className="f-updater-banner" aria-label={full} tabIndex={0}>
          {inner}
        </div>
      )}
    </Tooltip>
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
