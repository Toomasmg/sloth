import { useEffect, useId, useRef, useState } from 'react'
import { Check, Checks, ShieldWarning, TerminalWindow, Timer, X } from '@phosphor-icons/react'
import type { PermissionAnswer, PermissionPrompt } from '../../shared/types'
import { cleanError } from './format'

const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit'])
const JSON_LIMIT = 300

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

function compactJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return String(v)
  }
}

/** `mcp__servidor__herramienta` → { server, tool }. */
function parseMcp(tool: string): { server: string; tool: string } | null {
  if (!tool.startsWith('mcp__')) return null
  const rest = tool.slice('mcp__'.length)
  const i = rest.indexOf('__')
  return i < 0 ? { server: rest, tool: '' } : { server: rest.slice(0, i), tool: rest.slice(i + 2) }
}

/** Texto para el title de «Aprobar siempre»: las reglas que sugiere Claude, si se pueden leer. */
export function describeSuggestions(suggestions: unknown[] | undefined): string {
  const rules: string[] = []
  for (const s of suggestions ?? []) {
    const list = (s as { rules?: unknown })?.rules
    if (!Array.isArray(list)) continue
    for (const r of list) {
      const name = str((r as { toolName?: unknown })?.toolName)
      const content = str((r as { ruleContent?: unknown })?.ruleContent)
      if (name) rules.push(content ? `${name}(${content})` : name)
    }
  }
  const base = 'Aprueba y agrega la regla que sugiere Claude, así no vuelve a preguntar por esto'
  return rules.length ? `${base}:\n${rules.join('\n')}` : base
}

/** Nombre corto para mostrar: en MCP, la herramienta sin el prefijo. */
export function toolLabel(tool: string): string {
  const mcp = parseMcp(tool)
  return mcp ? mcp.tool || mcp.server : tool
}

function Summary({ prompt }: { prompt: PermissionPrompt }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const { tool, input } = prompt

  if (tool === 'Bash') {
    const command = str(input.command)
    const description = str(input.description)
    if (command)
      return (
        <div className="perm-body">
          {description && <p className="perm-desc">{description}</p>}
          <pre className="perm-code mono" aria-label="Comando">
            {command}
          </pre>
        </div>
      )
  }
  if (FILE_TOOLS.has(tool)) {
    const path = str(input.file_path) ?? str(input.notebook_path)
    if (path)
      return (
        <div className="perm-body">
          <pre className="perm-code mono" aria-label="Archivo">
            {path}
          </pre>
        </div>
      )
  }
  if (tool === 'WebFetch' && str(input.url))
    return (
      <div className="perm-body">
        <pre className="perm-code mono" aria-label="Dirección">
          {str(input.url)}
        </pre>
      </div>
    )
  if (tool === 'WebSearch' && str(input.query))
    return (
      <div className="perm-body">
        <pre className="perm-code mono" aria-label="Búsqueda">
          {str(input.query)}
        </pre>
      </div>
    )

  const mcp = parseMcp(tool)
  const json = compactJson(input)
  const long = json.length > JSON_LIMIT
  const shown = long && !expanded ? `${json.slice(0, JSON_LIMIT)}…` : json
  return (
    <div className="perm-body">
      {mcp && (
        <p className="perm-desc">
          Servidor MCP <strong>{mcp.server}</strong>
          {mcp.tool && (
            <>
              {' '}
              · herramienta <strong>{mcp.tool}</strong>
            </>
          )}
        </p>
      )}
      {json !== '{}' && (
        <pre className="perm-code mono" aria-label="Datos de la herramienta">
          {shown}
        </pre>
      )}
      {long && (
        <button type="button" className="perm-link" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
          {expanded ? 'Ver menos' : 'Ver todo'}
        </button>
      )}
    </div>
  )
}

interface Props {
  prompt: PermissionPrompt
  /** Cuántos permisos más esperan detrás de este en el mismo espacio. */
  queued: number
  /** Reloj compartido (ms), lo actualiza App una vez por segundo. */
  now: number
  onAnswer: (answer: PermissionAnswer, message?: string) => Promise<void>
}

/**
 * Pedido de permiso de Claude dentro del panel del espacio. No toma el foco solo:
 * se anuncia con una región en vivo y los botones quedan a mano con Tab.
 */
export function PermissionCard({ prompt, queued, now, onAnswer }: Props): React.JSX.Element {
  const [sending, setSending] = useState<PermissionAnswer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const reasonRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const canAlways = Array.isArray(prompt.suggestions) && prompt.suggestions.length > 0
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
    <section className="perm-card" role="region" aria-labelledby={titleId} data-perm-id={prompt.id}>
      <div className="perm-head">
        <ShieldWarning size={18} weight="fill" className="perm-icon" aria-hidden="true" />
        <h3 id={titleId} className="perm-title">
          Claude quiere usar <code className="mono">{toolLabel(prompt.tool)}</code>
        </h3>
        {queued > 0 && <span className="perm-queue">+{queued} en cola</span>}
        <span className="spacer" />
        <span
          className={`perm-timer ${urgent ? 'urgent' : ''}`}
          title="Si no respondés antes, Claude pregunta en la terminal"
          aria-label={`Expira en ${secs} segundos`}
        >
          <Timer size={13} aria-hidden="true" />
          {secs} s
        </span>
      </div>

      <Summary prompt={prompt} />

      {denying ? (
        <form
          className="perm-deny"
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
            <X size={14} weight="bold" aria-hidden="true" />
            {sending === 'deny' ? 'Rechazando…' : 'Confirmar rechazo'}
          </button>
          <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setDenying(false)}>
            Cancelar
          </button>
        </form>
      ) : (
        <div className="perm-actions">
          <button type="button" className="btn sm primary" disabled={busy} onClick={() => void send('allow')} data-perm-primary>
            <Check size={14} weight="bold" aria-hidden="true" />
            {sending === 'allow' ? 'Aprobando…' : 'Aprobar'}
          </button>
          {canAlways && (
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => void send('allowAlways')}
              title={describeSuggestions(prompt.suggestions)}
            >
              <Checks size={14} weight="bold" aria-hidden="true" />
              {sending === 'allowAlways' ? 'Aprobando…' : 'Aprobar siempre'}
            </button>
          )}
          <button type="button" className="btn sm danger" disabled={busy} onClick={() => setDenying(true)}>
            <X size={14} weight="bold" aria-hidden="true" />
            Rechazar
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy}
            onClick={() => void send('terminal')}
            title="Deja que Claude te pregunte como siempre, en la terminal"
          >
            <TerminalWindow size={14} aria-hidden="true" />
            Responder en la terminal
          </button>
        </div>
      )}

      {error && (
        <p className="perm-error" role="alert">
          No se pudo enviar la respuesta: {error}
        </p>
      )}
    </section>
  )
}
