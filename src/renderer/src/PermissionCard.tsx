import { useEffect, useId, useRef, useState } from 'react'
import type { PermissionAnswer, PermissionPrompt } from '../../shared/types'
import { alwaysLabel, changesOf, filesOf, kindOf, otherName, titleOf } from '../../main/features/permissions-core'
import { PermissionIcon, WaitingIcon, CloseIcon } from './icons/SlothIcons'
import { cleanError } from './format'
import { openPermissionReview } from './features/permissions/store'
import './features/permissions/permissions.css'

/** Nombre corto para mostrar: en MCP, la herramienta sin el prefijo. */
export function toolLabel(tool: string): string {
  return otherName(tool)
}

/** Lo que pide el pedido, en una línea de mono (comando, archivos, dominio…). */
function Subject({ prompt }: { prompt: PermissionPrompt }): React.JSX.Element | null {
  const kind = kindOf(prompt.tool)
  const { tool, input } = prompt
  if (kind === 'cmd') {
    const command = typeof input.command === 'string' ? input.command : ''
    return command ? (
      <code className="pc-code mono" aria-label="Comando">
        {command}
      </code>
    ) : null
  }
  if (kind === 'edit') {
    const files = filesOf(tool, input)
    const n = changesOf(tool, input).reduce((a, c) => a + c.add + c.del, 0)
    return files.length ? (
      <code className="pc-code mono" aria-label="Archivos">
        {files.join('\n')}
        {n ? `\n(${n} líneas en el cambio)` : ''}
      </code>
    ) : null
  }
  if (kind === 'net') {
    const v = typeof input.url === 'string' ? input.url : typeof input.query === 'string' ? input.query : ''
    return v ? (
      <code className="pc-code mono" aria-label="Dirección">
        {v}
      </code>
    ) : null
  }
  return null
}

interface Props {
  prompt: PermissionPrompt
  /** Cuántos permisos más esperan detrás de este en el mismo espacio. */
  queued: number
  /** Reloj compartido (ms), lo actualiza App una vez por segundo. */
  now: number
  /** Nombre del espacio y de la cuenta (la tarjeta dice «En {espacio}, con {cuenta}»). */
  spaceName?: string
  accountLabel?: string
  /**
   * Responde el pedido. App debe mandar `allow`, `allowAlways` (regla del espacio), `deny` y
   * `terminal` a `decidePermission` (features/permissions/api.ts).
   */
  onAnswer: (answer: PermissionAnswer, message?: string) => Promise<void>
}

/**
 * Pedido de permiso de Claude dentro del panel del espacio. No toma el foco solo: se anuncia con una
 * región en vivo y los botones quedan a mano con Tab. «Revisar» abre la vista a pantalla completa.
 */
export function PermissionCard({ prompt, queued, now, spaceName, accountLabel, onAnswer }: Props): React.JSX.Element {
  const [sending, setSending] = useState<PermissionAnswer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const reasonRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const kind = kindOf(prompt.tool)
  const secs = Math.max(0, Math.ceil((prompt.expiresAt - now) / 1000))
  const urgent = secs <= 15

  useEffect(() => {
    if (denying) reasonRef.current?.focus()
  }, [denying])

  const send = async (answer: PermissionAnswer, message?: string): Promise<void> => {
    setSending(answer)
    setError(null)
    try {
      await onAnswer(answer, message)
    } catch (e) {
      setError(cleanError(e))
      setSending(null)
    }
  }
  const busy = sending !== null

  return (
    <section className="pc-card" role="region" aria-labelledby={titleId} data-perm-id={prompt.id}>
      <div className="pc-head">
        <span className="pc-icon" aria-hidden="true">
          <PermissionIcon size={16} strokeWidth={1.8} />
        </span>
        <div className="pc-head-text">
          <h3 id={titleId} className="pc-title">
            {titleOf(kind, prompt.tool, prompt.input)}
          </h3>
          <span className="pc-sub">
            {spaceName ? `En ${spaceName}` : 'En este espacio'}
            {accountLabel ? `, con ${accountLabel}` : ''}
            {queued > 0 ? ` · +${queued} en cola` : ''}
          </span>
        </div>
        <span
          className={`pc-timer ${urgent ? 'urgent' : ''}`}
          title="Si no respondés antes, Claude pregunta en la terminal"
          aria-label={`Expira en ${secs} segundos`}
        >
          <WaitingIcon size={13} aria-hidden="true" />
          {secs} s
        </span>
      </div>

      <Subject prompt={prompt} />

      {denying ? (
        <form
          className="pc-deny-form"
          onSubmit={(e) => {
            e.preventDefault()
            void send('deny', reason.trim() || undefined)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !busy) {
              e.stopPropagation()
              setDenying(false)
            }
          }}
        >
          <label className="sr-only" htmlFor={`${titleId}-reason`}>
            Motivo del rechazo (opcional)
          </label>
          <input
            id={`${titleId}-reason`}
            ref={reasonRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Motivo (opcional): Claude lo va a leer"
            disabled={busy}
          />
          <button type="submit" className="btn sm danger" disabled={busy}>
            {sending === 'deny' ? 'Rechazando…' : 'Confirmar rechazo'}
          </button>
          <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setDenying(false)}>
            Cancelar
          </button>
        </form>
      ) : (
        <div className="pc-actions">
          <button type="button" className="btn sm primary" disabled={busy} onClick={() => void send('allow')} data-perm-primary>
            {sending === 'allow' ? 'Permitiendo…' : 'Permitir una vez'}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={() => void send('allowAlways')}
            title="Guarda una regla para este espacio: los pedidos iguales se aprueban solos"
          >
            {sending === 'allowAlways' ? 'Guardando…' : alwaysLabel(kind)}
          </button>
          <span className="spacer" />
          <button type="button" className="btn sm ghost danger" disabled={busy} onClick={() => setDenying(true)}>
            <CloseIcon size={12} aria-hidden="true" />
            Rechazar
          </button>
          <button type="button" className="pc-link" disabled={busy} onClick={() => openPermissionReview(prompt.id)}>
            Revisar
          </button>
          <button
            type="button"
            className="pc-link"
            disabled={busy}
            onClick={() => void send('terminal')}
            title="Deja que Claude te pregunte como siempre, en la terminal"
          >
            Responder en la terminal
          </button>
        </div>
      )}

      {error && (
        <p className="pc-error" role="alert">
          No se pudo enviar la respuesta: {error}
        </p>
      )}
    </section>
  )
}
