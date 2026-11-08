import { useEffect, useRef, useState, lazy, Suspense } from 'react'
import type { ChangelogEntry } from '../../../../shared/changelog'
import { CHANGELOG } from '../../../../shared/changelog'
import { InviteIcon, KeyboardIcon, UpdateIcon } from '../../icons/SlothIcons'
import type { Command, FeatureUi } from '../host'
import { useUi } from '../host'
import { onHelp, openHelp, type HelpAction } from './bus'
const AyudaPage = lazy(() => import('./AyudaPage').then((m) => ({ default: m.AyudaPage })))
const WhatsNewModal = lazy(() => import('./WhatsNew').then((m) => ({ default: m.WhatsNewModal })))
const InviteModal = lazy(() => import('./Invite').then((m) => ({ default: m.InviteModal })))
import './help.css'

interface WhatsNewReply {
  current: string
  lastSeen: string | null
  show: boolean
  entries: ChangelogEntry[]
}

type Dialog =
  | { kind: 'ayuda' }
  | { kind: 'invite' }
  /** `seen`: versión a marcar como vista al cerrar (solo en la apertura automática). */
  | { kind: 'whatsnew'; entries: ChangelogEntry[]; seen?: string }

/**
 * Piezas que se montan una sola vez: la página de Ayuda y atajos («?»), Novedades (al arrancar, si
 * hay algo nuevo) e Invitar. Las abre `openHelp` desde la paleta o Configuración. No hay botón de
 * ayuda en la barra de título: el artboard no lo tiene.
 */
function HelpGlobal(): React.JSX.Element {
  const ui = useUi()
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const dialogRef = useRef<Dialog | null>(null)
  dialogRef.current = dialog
  const invokeRef = useRef(ui.invoke)
  invokeRef.current = ui.invoke

  // Novedades automáticas: una vez al montar. Si hay algo nuevo, se muestra y al cerrar se marca visto.
  useEffect(() => {
    let alive = true
    invokeRef
      .current<WhatsNewReply>('feat:help:whatsnew')
      .then((r) => {
        if (!alive || !r.show || r.entries.length === 0) return
        setDialog((cur) => cur ?? { kind: 'whatsnew', entries: r.entries, seen: r.current })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  useEffect(
    () =>
      onHelp((a: HelpAction) => {
        if (a === 'ayuda' || a === 'shortcuts') setDialog({ kind: 'ayuda' })
        else if (a === 'invite') setDialog({ kind: 'invite' })
        // Desde el menú se muestra siempre la última entrada, sin marcar nada como visto.
        else setDialog({ kind: 'whatsnew', entries: CHANGELOG.slice(0, 1) })
      }),
    []
  )

  // «?» abre la página de ayuda, salvo que se esté escribiendo, con la terminal enfocada o con otro modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '?' || e.ctrlKey || e.altKey || e.metaKey) return
      const a = document.activeElement
      if (a instanceof HTMLElement && (a.matches('input, textarea, select, [contenteditable]') || a.closest('.xterm'))) return
      if (document.querySelector('[aria-modal="true"]')) return
      e.preventDefault()
      setDialog((cur) => cur ?? { kind: 'ayuda' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const close = (): void => {
    const d = dialogRef.current
    setDialog(null)
    if (d?.kind === 'whatsnew' && d.seen) void invokeRef.current('feat:help:seen', d.seen).catch(() => {})
  }

  if (!dialog) return <></>
  return (
    <Suspense fallback={null}>
      {dialog.kind === 'ayuda' ? (
        <AyudaPage onClose={close} />
      ) : dialog.kind === 'invite' ? (
        <InviteModal onClose={close} />
      ) : (
        <WhatsNewModal entries={dialog.entries} onClose={close} />
      )}
    </Suspense>
  )
}

const ui: FeatureUi = {
  name: 'help',
  Global: HelpGlobal,
  commands: (): Command[] => [
    {
      id: 'help:ayuda',
      title: 'Ayuda y atajos',
      subtitle: 'Primeros pasos, atajos de teclado y preguntas frecuentes',
      group: 'Sloth',
      keywords: 'ayuda atajos teclas shortcuts hoja ? faq preguntas tutorial',
      shortcut: '?',
      icon: <KeyboardIcon size={16} />,
      run: () => openHelp('ayuda')
    },
    {
      id: 'help:whatsnew',
      title: 'Novedades',
      subtitle: 'Qué cambió en la última versión',
      group: 'Sloth',
      keywords: 'novedades cambios changelog versión release',
      icon: <UpdateIcon size={16} />,
      run: () => openHelp('whatsnew')
    },
    {
      id: 'help:invite',
      title: 'Invitar a un compañero',
      subtitle: 'Copiar el mensaje con el link de descarga',
      group: 'Sloth',
      keywords: 'invitar compañero amigo compartir descargar link',
      icon: <InviteIcon size={16} />,
      run: () => openHelp('invite')
    }
  ]
}

export default ui
