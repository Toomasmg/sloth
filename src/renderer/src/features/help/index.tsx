import { useEffect, useRef, useState } from 'react'
import type { ChangelogEntry } from '../../../../shared/changelog'
import { CHANGELOG } from '../../../../shared/changelog'
import { HelpIcon, InviteIcon, KeyboardIcon, ReportIcon, UpdateIcon } from '../../icons/SlothIcons'
import type { Command, FeatureUi } from '../host'
import { useUi } from '../host'
import { onHelp, openHelp, type HelpAction } from './bus'
import { openReport } from '../report/bus'
import { AyudaPage } from './AyudaPage'
import { WhatsNewModal } from './WhatsNew'
import { InviteModal } from './Invite'
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

interface MenuItem {
  id: string
  label: string
  icon: React.ReactNode
  hint?: string
  run: () => void
}

const MENU: MenuItem[] = [
  { id: 'ayuda', label: 'Ayuda y atajos', icon: <KeyboardIcon size={16} />, hint: '?', run: () => openHelp('ayuda') },
  { id: 'whatsnew', label: 'Novedades', icon: <UpdateIcon size={16} />, run: () => openHelp('whatsnew') },
  { id: 'invite', label: 'Invitar a un compañero', icon: <InviteIcon size={16} />, run: () => openHelp('invite') },
  { id: 'report', label: 'Reportar un problema', icon: <ReportIcon size={16} />, run: () => openReport() }
]

/** Botón «Ayuda» de la barra de título, con su menú chico (role=menu, flechas, Escape). */
function HelpButton(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([])

  const close = (restoreFocus: boolean): void => {
    setOpen(false)
    if (restoreFocus) btnRef.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    itemsRef.current[0]?.focus()
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const focusItem = (i: number): void => {
    const n = MENU.length
    itemsRef.current[(i + n) % n]?.focus()
  }

  const onMenuKey = (e: React.KeyboardEvent): void => {
    const idx = itemsRef.current.indexOf(document.activeElement as HTMLButtonElement)
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focusItem(idx + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        focusItem(idx - 1)
        break
      case 'Home':
        e.preventDefault()
        focusItem(0)
        break
      case 'End':
        e.preventDefault()
        focusItem(MENU.length - 1)
        break
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        close(true)
        break
      case 'Tab':
        e.preventDefault()
        close(true)
        break
    }
  }

  const pick = (item: MenuItem): void => {
    // Antes de abrir la pieza, el foco vuelve al botón: así la pieza lo recuerda al cerrarse.
    close(true)
    item.run()
  }

  return (
    <div className="f-help-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="icon-btn f-help-btn"
        aria-label="Ayuda"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Ayuda"
        onClick={() => setOpen((o) => !o)}
      >
        <HelpIcon size={16} />
      </button>
      {open && (
        <div role="menu" aria-label="Ayuda" className="f-help-menu" onKeyDown={onMenuKey}>
          {MENU.map((item, i) => (
            <button
              key={item.id}
              ref={(el) => {
                itemsRef.current[i] = el
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="f-help-item"
              onClick={() => pick(item)}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.hint && <kbd>{item.hint}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Piezas que se montan una sola vez: la página de Ayuda y atajos («?»), Novedades (al arrancar, si
 * hay algo nuevo) e Invitar. Las abre `openHelp` desde el menú, la paleta o Configuración.
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
  if (dialog.kind === 'ayuda') return <AyudaPage onClose={close} />
  if (dialog.kind === 'invite') return <InviteModal onClose={close} />
  return <WhatsNewModal entries={dialog.entries} onClose={close} />
}

const ui: FeatureUi = {
  name: 'help',
  Titlebar: HelpButton,
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
