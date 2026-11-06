import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Broadcast as BroadcastIcon, CheckCircle, PaperPlaneTilt, X } from '@phosphor-icons/react'
import { isLoginPane } from '../../../../shared/types'
import { useUi, type FeatureUi, type UiCtx } from '../host'
import { StateIcon } from '../../StateIcon'
import { STATE_LABEL, accountColor, cleanError } from '../../format'
import { buildPayload, MAX_PROMPT } from './payload'
import './broadcast.css'

// Estado abierto/cerrado compartido entre el comando de la paleta, el atajo y el modal.
let isOpen = false
const subs = new Set<() => void>()
const setOpen = (v: boolean): void => {
  if (isOpen === v) return
  isOpen = v
  subs.forEach((f) => f())
}
const useOpen = (): boolean =>
  useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => isOpen
  )

/** Pausa entre el texto y el Enter: deja que Claude Code termine de procesar el pegado. */
const SUBMIT_DELAY = 150
const CONFIRM_OVER = 3

interface Target {
  id: string
  name: string
  accountLabel: string
  accIndex: number
  state?: keyof typeof STATE_LABEL
  hidden: boolean
  ticket?: string
}

/** Espacios con terminal corriendo: los abiertos en paneles y los ocultos que siguen vivos. */
function targetsOf(ctx: UiCtx): Target[] {
  const accIdx = new Map(ctx.accounts.map((a, i) => [a.id, i]))
  const accLabel = new Map(ctx.accounts.map((a) => [a.id, a.label]))
  const open = new Set(ctx.openPanes.filter((p) => !isLoginPane(p)))
  const out: Target[] = []
  for (const ws of ctx.workspaces) {
    const ag = ctx.agents[ws.id]
    const isOpenPane = open.has(ws.id)
    const aliveHidden = !isOpenPane && ag && ag.state !== 'exited'
    if (!isOpenPane && !aliveHidden) continue
    out.push({
      id: ws.id,
      name: ws.name,
      accountLabel: accLabel.get(ws.accountId) ?? 'cuenta borrada',
      accIndex: accIdx.get(ws.accountId) ?? 0,
      state: ag?.state,
      hidden: !isOpenPane,
      ticket: ws.ticket
    })
  }
  // Primero los abiertos, en el orden de los paneles.
  const order = ctx.openPanes
  return out.sort((a, b) => (a.hidden === b.hidden ? order.indexOf(a.id) - order.indexOf(b.id) : a.hidden ? 1 : -1))
}

function BroadcastDialog({ onClose, onSent }: { onClose: () => void; onSent: (n: number) => void }): React.JSX.Element {
  const ctx = useUi()
  const targets = useMemo(() => targetsOf(ctx), [ctx.workspaces, ctx.openPanes, ctx.agents, ctx.accounts]) // eslint-disable-line react-hooks/exhaustive-deps
  const sendable = targets.filter((t) => t.state !== 'exited')
  const [sel, setSel] = useState<Set<string>>(() => new Set(sendable.filter((t) => !t.hidden).map((t) => t.id)))
  const [text, setText] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => taRef.current?.focus(), [])
  useEffect(() => setConfirming(false), [sel, text])

  const chosen = sendable.filter((t) => sel.has(t.id))
  const toggle = (id: string): void =>
    setSel((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const send = (): void => {
    setErr(null)
    let payload
    try {
      payload = buildPayload(text)
    } catch (e) {
      setErr(cleanError(e))
      return
    }
    if (!payload) {
      setErr('Escribí el prompt.')
      return
    }
    if (!chosen.length) {
      setErr('Elegí al menos un espacio.')
      return
    }
    if (chosen.length > CONFIRM_OVER && !confirming) {
      setConfirming(true)
      return
    }
    const ids = chosen.map((t) => t.id)
    const { body, submit } = payload
    try {
      for (const id of ids) window.sloth.ptyWrite(id, body)
      setTimeout(() => {
        for (const id of ids) window.sloth.ptyWrite(id, submit)
      }, SUBMIT_DELAY)
    } catch (e) {
      setErr(cleanError(e))
      return
    }
    onSent(ids.length)
  }

  const lines = text.split('\n').length
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal f-broadcast-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="f-broadcast-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          } else if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault()
            send()
          }
        }}
      >
        <header className="modal-head">
          <BroadcastIcon size={18} weight="duotone" aria-hidden="true" className="f-broadcast-icon" />
          <h2 id="f-broadcast-title">Enviar a varios espacios</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <fieldset className="f-broadcast-set">
          <legend className="f-broadcast-legend">
            <span>
              Espacios <span className="count">{chosen.length}/{sendable.length}</span>
            </span>
            <span className="btn-group">
              <button type="button" className="btn sm ghost" onClick={() => setSel(new Set(sendable.map((t) => t.id)))} disabled={!sendable.length}>
                Todos
              </button>
              <button type="button" className="btn sm ghost" onClick={() => setSel(new Set())} disabled={!sel.size}>
                Ninguno
              </button>
            </span>
          </legend>
          {targets.length === 0 && <p className="hint">No hay espacios con la terminal abierta. Abrí alguno desde el sidebar.</p>}
          <ul className="f-broadcast-list">
            {targets.map((t) => {
              const dead = t.state === 'exited'
              return (
                <li key={t.id}>
                  <label className={`f-broadcast-row ${dead ? 'dead' : ''}`} style={{ '--acc': accountColor(t.accIndex) } as React.CSSProperties}>
                    <input type="checkbox" checked={!dead && sel.has(t.id)} disabled={dead} onChange={() => toggle(t.id)} />
                    <span className="f-broadcast-name">
                      {t.name}
                      {t.ticket && <span className="tag">{t.ticket}</span>}
                      {t.hidden && <span className="f-broadcast-hidden">oculto</span>}
                    </span>
                    <span className="f-broadcast-acc">
                      <span className="acc-dot" aria-hidden="true" />
                      {t.accountLabel}
                    </span>
                    <span className="f-broadcast-state">
                      <StateIcon state={t.state} size={12} />
                      {t.state ? (dead ? 'Terminal cerrada' : STATE_LABEL[t.state]) : 'Sin estado'}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        </fieldset>

        <div className="field">
          <label htmlFor="f-broadcast-text">Prompt</label>
          <textarea
            id="f-broadcast-text"
            ref={taRef}
            className="f-broadcast-text"
            value={text}
            maxLength={MAX_PROMPT}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ej: corré los tests y contame si algo falla"
            rows={5}
            aria-describedby="f-broadcast-help"
          />
          <p className="field-help" id="f-broadcast-help">
            Se escribe en cada terminal y se manda con Enter{lines > 1 ? `; las ${lines} líneas van pegadas como un solo prompt` : ''}. Ctrl+Enter envía.
          </p>
        </div>

        {err && (
          <p className="form-error" role="alert">
            {err}
          </p>
        )}
        {confirming && (
          <p className="f-broadcast-confirm" role="alert">
            Vas a escribir este prompt en {chosen.length} terminales: {chosen.map((t) => t.name).join(', ')}. Tocá «Confirmar» para enviarlo.
          </p>
        )}

        <footer className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={!chosen.length || !text.trim()}>
            <PaperPlaneTilt size={14} weight="bold" aria-hidden="true" />
            {confirming ? `Confirmar envío a ${chosen.length}` : `Enviar${chosen.length ? ` a ${chosen.length}` : ''}`}
          </button>
        </footer>
      </form>
    </div>
  )
}

function Global(): React.JSX.Element | null {
  const open = useOpen()
  const [sent, setSent] = useState<number | null>(null)
  const prevFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyB') {
        e.preventDefault()
        e.stopPropagation()
        setOpen(!isOpen)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useLayoutEffect(() => {
    if (open) {
      const a = document.activeElement
      prevFocus.current = a instanceof HTMLElement && a !== document.body ? a : null
    } else {
      const el = prevFocus.current
      prevFocus.current = null
      if (el?.isConnected) el.focus()
    }
  }, [open])

  // El aviso se va solo (un único timer, solo mientras se muestra).
  useEffect(() => {
    if (sent === null) return
    const t = setTimeout(() => setSent(null), 2600)
    return () => clearTimeout(t)
  }, [sent])

  return (
    <>
      {open && (
        <BroadcastDialog
          onClose={() => setOpen(false)}
          onSent={(n) => {
            setOpen(false)
            setSent(n)
          }}
        />
      )}
      <div className="f-broadcast-live" role="status" aria-live="polite">
        {sent !== null && (
          <span className="f-broadcast-toast">
            <CheckCircle size={16} weight="fill" aria-hidden="true" />
            Enviado a {sent} {sent === 1 ? 'espacio' : 'espacios'}
          </span>
        )}
      </div>
    </>
  )
}

const ui: FeatureUi = {
  name: 'broadcast',
  Global,
  commands: (ctx) =>
    ctx.workspaces.length
      ? [
          {
            id: 'broadcast:open',
            title: 'Enviar a varios espacios',
            subtitle: 'El mismo prompt en varias terminales a la vez',
            group: 'Espacios',
            keywords: 'broadcast difundir prompt todos multiple',
            shortcut: 'Ctrl+Shift+B',
            run: () => setOpen(true)
          }
        ]
      : []
}

export default ui
