import { useState } from 'react'
import { buildPayload } from '../features/broadcast/payload'
import { cleanError } from '../format'
import { MoreIcon } from '../icons/SlothIcons'
import { ActionMenu, type ActionMenuItem } from './ActionMenu'

export type PaneMenuItem = ActionMenuItem

/**
 * Menú «más» del header de un panel (Renombrar, Ver cambios, Historial, Mover…). Mismo menú que el de
 * la app (ActionMenu): Escape o clic afuera lo cierran; las flechas se mueven entre opciones.
 */
export function PaneMenu({ label, items }: { label: string; items: PaneMenuItem[] }): React.JSX.Element {
  return (
    <ActionMenu
      label={label}
      items={items}
      trigger={<MoreIcon size={18} />}
      triggerClassName="icon-btn pane-menu-btn"
      wrapClassName="pane-menu-wrap"
    />
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
