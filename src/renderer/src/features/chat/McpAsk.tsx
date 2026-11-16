import { useEffect, useId, useRef, useState } from 'react'
import type { ChatMcpAsk, ChatMcpChoice } from '../../../../shared/chat-mcp'
import { Button } from '../../ui'
import { useUi } from '../host'
import { segundosRestantes, vigentes } from './mcp-ask'

export function McpAsk(): React.JSX.Element | null {
  const ui = useUi()
  const titleId = useId()
  const descId = useId()
  const [asks, setAsks] = useState<ChatMcpAsk[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const denyRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let alive = true
    ui.invoke<ChatMcpAsk[]>('feat:chat:mcpPending').then(
      (l) => {
        if (alive) setAsks((cur) => (cur.length ? cur : l))
      },
      () => undefined
    )
    const off = ui.on('feat:chat:mcpAsks', (l: ChatMcpAsk[]) => setAsks(l))
    return () => {
      alive = false
      off()
    }
  }, [ui])

  const lista = vigentes(asks, now)
  const ask = lista[0]
  const askId = ask?.id

  useEffect(() => {
    if (asks.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [asks.length])

  useEffect(() => {
    if (!askId) return
    setError(null)
    denyRef.current?.focus()
  }, [askId])

  const answer = (choice: ChatMcpChoice): void => {
    if (!ask) return
    const id = ask.id
    setAsks((cur) => cur.filter((a) => a.id !== id))
    ui.invoke('feat:chat:mcpAnswer', id, choice).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  useEffect(() => {
    if (!askId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        answer('deny')
        return
      }
      if (e.key !== 'Tab') return
      const items = [...(boxRef.current?.querySelectorAll<HTMLElement>('button') ?? [])]
      if (items.length === 0) return
      const i = items.indexOf(document.activeElement as HTMLElement)
      e.preventDefault()
      items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length].focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  if (!ask) return null
  const escribe = ask.op === 'enviar'
  const secs = segundosRestantes(ask.expiresAt, now)
  const quien = ask.account ? `Desde ${ask.workspace} · cuenta ${ask.account}` : `Desde ${ask.workspace}`

  return (
    <div className="modal-backdrop">
      <div ref={boxRef} className="modal modal-confirm f-chat-mcpask" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} tabIndex={-1}>
        <h2 id={titleId} className="modal-confirm-title">
          {escribe ? `Claude quiere escribir en «${ask.nombre}»` : `Claude quiere leer «${ask.nombre}»`}
        </h2>
        <p id={descId} className="f-chat-mcpask-note">
          {quien}
        </p>
        {escribe && ask.preview !== undefined && (
          <>
            <p className="f-chat-mcpask-note">Saldría con tu nombre y la marca «vía Claude». Este es el texto:</p>
            <pre className="f-chat-mcpask-preview" tabIndex={0} aria-label="Texto que Claude quiere mandar">
              {ask.preview}
            </pre>
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <p className="f-chat-mcpask-note" role="timer" aria-live="off">
          Se deniega solo en {secs} s{lista.length > 1 ? ` · +${lista.length - 1} más esperando` : ''}
        </p>
        <div className="modal-actions f-chat-mcpask-actions">
          <Button variant="ghost" onClick={() => answer('once')}>
            Permitir una vez
          </Button>
          <Button variant="secondary" onClick={() => answer('always')}>
            Siempre en esta conversación
          </Button>
          <Button variant="primary" ref={denyRef} onClick={() => answer('deny')}>
            No
          </Button>
        </div>
      </div>
    </div>
  )
}
