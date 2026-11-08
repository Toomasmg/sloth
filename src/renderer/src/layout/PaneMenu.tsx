import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { buildPayload } from '../features/broadcast/payload'
import { cleanError } from '../format'
import { MoreIcon } from '../icons/SlothIcons'

export interface PaneMenuItem {
  id: string
  label: string
  hint?: string
  icon: ReactNode
  danger?: boolean
  onSelect(): void
}

/**
 * Menú «más» del header de un panel (Renombrar, Abrir en VS Code, Mover…). Se cierra con Escape o clic
 * afuera; las flechas se mueven entre opciones y las opciones se leen con su nombre completo.
 */
export function PaneMenu({ label, items }: { label: string; items: PaneMenuItem[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const id = useId()
  const wrapRef = useRef<HTMLSpanElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
    const onDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
      btnRef.current?.focus()
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const btns = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    if (!btns.length) return
    const i = btns.indexOf(document.activeElement as HTMLButtonElement)
    e.preventDefault()
    const j = e.key === 'ArrowDown' ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length
    btns[j].focus()
  }

  return (
    <span ref={wrapRef} className="pane-menu-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`icon-btn pane-menu-btn ${open ? 'on' : ''}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreIcon size={18} />
      </button>
      {open && (
        <div ref={menuRef} id={id} className="pane-menu" role="menu" aria-label={label} onKeyDown={onMenuKey}>
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              role="menuitem"
              className={`pane-menu-item ${it.danger ? 'danger' : ''}`}
              onClick={() => {
                setOpen(false)
                it.onSelect()
              }}
            >
              <span className="pane-menu-ico">
                {it.icon}
              </span>
              <span className="pane-menu-label">{it.label}</span>
              {it.hint && <span className="pane-menu-hint">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

/**
 * Campo «Escribile a Claude» de un espacio: manda el texto a su terminal y después Enter, igual que
 * el envío a varios espacios (mismo armado y misma pausa antes del Enter).
 */
export function PaneInput({
  paneId,
  name,
  onError
}: {
  paneId: string
  name: string
  onError(message: string): void
}): React.JSX.Element {
  const [text, setText] = useState('')
  return (
    <label className="pane-input">
      <span className="pane-input-prompt">
        ›
      </span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
          e.preventDefault()
          const payload = buildPayload(text)
          if (!payload) return
          setText('')
          try {
            window.sloth.ptyWrite(paneId, payload.body)
            setTimeout(() => {
              try {
                window.sloth.ptyWrite(paneId, payload.submit)
              } catch (err) {
                onError(cleanError(err))
              }
            }, 150)
          } catch (err) {
            onError(cleanError(err))
          }
        }}
        aria-label={`Escribile a Claude en ${name}`}
        placeholder="Escribile a Claude… (Enter envía)"
        spellCheck={false}
        autoComplete="off"
      />
    </label>
  )
}
