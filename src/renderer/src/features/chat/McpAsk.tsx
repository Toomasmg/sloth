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
  const boxRef = useRef<HTMLDivElement>(null)
  const denyRef = useRef<HTMLButtonElement>(null)
  const prevFocus = useRef<HTMLElement | null>(null)

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
  const abierto = ask !== undefined

  useEffect(() => {
    if (asks.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [asks.length])

  useEffect(() => {
    if (!abierto) return
    const el = document.activeElement
    prevFocus.current = el instanceof HTMLElement ? el : null
    return () => {
      const prev = prevFocus.current
      prevFocus.current = null
      if (prev?.isConnected) prev.focus()
    }
  }, [abierto])

  useEffect(() => {
    if (askId) denyRef.current?.focus()
  }, [askId])

  const answer = (choice: ChatMcpChoice): void => {
    if (!ask) return
    const id = ask.id
    setAsks((cur) => cur.filter((a) => a.id !== id))
    // Con el diálogo ya cerrado, un error en línea no se vería.
    ui.invoke('feat:chat:mcpAnswer', id, choice).catch((e: unknown) => ui.notifyError(e instanceof Error ? e.message : String(e)))
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
      const items = [...(boxRef.current?.querySelectorAll<HTMLElement>('button, [tabindex="0"]') ?? [])]
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

  return (
    <div className="modal-backdrop">
      <div ref={boxRef} className="modal modal-confirm f-chat-mcpask" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} tabIndex={-1}>
        <h2 id={titleId} className="modal-confirm-title">
          {escribe ? `Claude quiere mandar un mensaje a «${ask.nombre}»` : `Claude quiere leer «${ask.nombre}»`}
        </h2>
        <p id={descId} className="f-chat-mcpask-note">
          Desde la cuenta {ask.account}
          {ask.workspace !== undefined && ` · la terminal dice ser del espacio ${ask.workspace} (no verificado)`}
        </p>
        {escribe && ask.preview !== undefined && (
          <>
            <p className="f-chat-mcpask-note">Este texto lo escribió Claude, no vos. Si lo mandás, sale con tu nombre y la marca «vía Claude»:</p>
            <pre className="f-chat-mcpask-preview" tabIndex={0} aria-label="Texto que escribió Claude">
              {ask.preview}
            </pre>
          </>
        )}
        {ask.sinSiempre !== undefined && (
          <p className="f-chat-mcpask-note">
            Esta cuenta corre con {ask.sinSiempre === 'bypassPermissions' ? 'permisos salteados' : 'ediciones aceptadas solas'}: lo que lea Claude del chat podría llevarlo a
            ejecutar cosas sin preguntarte. Por eso cada lectura se confirma.
          </p>
        )}
        <p className="f-chat-mcpask-note" role="timer" aria-live="off">
          Se deniega solo en {secs} s{lista.length > 1 ? ` · +${lista.length - 1} más esperando` : ''}
        </p>
        <div className="modal-actions f-chat-mcpask-actions">
          {escribe ? (
            <Button variant="ghost" onClick={() => answer('once')}>
              Mandar este texto
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => answer('once')}>
                Permitir una vez
              </Button>
              {ask.sinSiempre === undefined && (
                <Button variant="secondary" onClick={() => answer('always')}>
                  Siempre desde esta cuenta
                </Button>
              )}
            </>
          )}
          <Button variant="primary" ref={denyRef} onClick={() => answer('deny')}>
            No
          </Button>
        </div>
      </div>
    </div>
  )
}
