import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Account, PermissionPrompt, Workspace } from '../../../../shared/types'
import { alwaysLabel, changesOf, explanationOf, filesOf, kindOf, titleOf, type FileChange } from '../../../../main/features/permissions-core'
import { CloseIcon, PermissionIcon } from '../../icons/SlothIcons'
import { CheckGlyph } from '../git/glyphs'
import { cleanError } from '../../format'
import { decidePermission, rejectAndTell } from './api'

/** Nivel de riesgo que muestra la revisión, derivado del tipo de pedido (no es una evaluación de seguridad). */
function riskOf(kind: ReturnType<typeof kindOf>, nChanges: number): { label: string; cls: string } {
  if (kind === 'edit') return { label: `Cambia ${nChanges} ${nChanges === 1 ? 'archivo' : 'archivos'} del repo`, cls: 'info' }
  if (kind === 'net') return { label: 'Accede a internet', cls: 'info' }
  if (kind === 'cmd') return { label: 'Corre un comando en la carpeta del espacio', cls: 'warn' }
  return { label: 'Pedido sin clasificar', cls: 'warn' }
}

interface Props {
  /** Pedidos vivos de todos los espacios, en orden de llegada. */
  prompts: PermissionPrompt[]
  workspaces: Workspace[]
  accounts: Account[]
  /** Pedido con el que se abre (por ejemplo, el de la tarjeta). */
  initialId: string | null
  onClose: () => void
}

const isText = (el: EventTarget | null): boolean => el instanceof HTMLElement && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')

function Changes({ changes }: { changes: FileChange[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const shown = changes.slice(0, 1)
  const lines = shown.flatMap((c) => c.lines)
  return (
    <>
      <ul className="pr-files" aria-label="Archivos que va a cambiar">
        {changes.map((c) => (
          <li key={c.path} className="pr-file">
            <span className="pr-file-path mono">{c.path}</span>
            {c.isNew && <span className="pr-new">nuevo</span>}
            <span className="pr-add mono">+{c.add}</span>
            <span className="pr-del mono">−{c.del}</span>
          </li>
        ))}
      </ul>
      {lines.length > 0 && (
        <>
          <button type="button" className="pr-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Ocultar cambios' : `Ver cambios de ${shown[0].path.split(/[\\/]/).pop()}`}
          </button>
          {open && (
            <div className="pr-diff mono" aria-label="Cambios">
              {lines.map((l, i) => (
                <div key={i} className={`pr-diff-line ${l.t === '+' ? 'add' : 'del'}`}>
                  {l.t} {l.text}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  )
}

/**
 * Revisión de pedidos de permiso a pantalla completa: cola de todos los espacios («1 de N»), tipo,
 * explicación, carpeta y las acciones reales (permitir, permitir siempre, rechazar, rechazar y decir).
 */
export function PermissionReview({ prompts, workspaces, accounts, initialId, onClose }: Props): React.JSX.Element {
  const [currentId, setCurrentId] = useState<string | null>(initialId)
  const [msgOpen, setMsgOpen] = useState(false)
  const [msg, setMsg] = useState('')
  const [sending, setSending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const msgRef = useRef<HTMLTextAreaElement>(null)

  const n = prompts.length
  const found = currentId ? prompts.findIndex((p) => p.id === currentId) : -1
  const idx = n ? (found >= 0 ? found : 0) : 0
  const p = n ? prompts[idx] : null

  // Al cambiar de pedido se cierra lo abierto del anterior.
  useEffect(() => {
    setMsgOpen(false)
    setMsg('')
    setError(null)
  }, [p?.id])

  useEffect(() => {
    if (msgOpen) msgRef.current?.focus()
  }, [msgOpen])

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  const ws = useMemo(() => (p ? workspaces.find((w) => w.id === p.workspaceId) : undefined), [p, workspaces])
  const acc = useMemo(() => (ws ? accounts.find((a) => a.id === ws.accountId) : undefined), [ws, accounts])

  const go = (delta: number): void => {
    if (!n) return
    setCurrentId(prompts[(idx + delta + n) % n].id)
  }

  const run = async (key: string, fn: () => Promise<void>): Promise<void> => {
    if (!p || sending) return
    setSending(key)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(cleanError(e))
      setSending(null)
      return
    }
    setSending(null)
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (msgOpen) setMsgOpen(false)
      else onClose()
      return
    }
    if (isText(e.target) || n < 2) return
    if (e.key === 'ArrowLeft') go(-1)
    if (e.key === 'ArrowRight') go(1)
  }

  const kind = p ? kindOf(p.tool) : 'other'
  const changes = p && kind === 'edit' ? changesOf(p.tool, p.input) : []
  const files = p && kind === 'edit' ? filesOf(p.tool, p.input) : []
  const explanation = p ? explanationOf(p.input) : undefined
  const domain = p && kind === 'net' ? String(p.input.url ?? p.input.query ?? '') : ''
  const cmd = p && kind === 'cmd' ? String(p.input.command ?? '') : ''
  const otherJson = useMemo(() => {
    if (!p || kind !== 'other') return ''
    try {
      return JSON.stringify(p.input, null, 2).slice(0, 2000)
    } catch {
      return ''
    }
  }, [p, kind])

  return (
    <div className="modal-backdrop pr-backdrop">
      <div
        ref={dialogRef}
        className="modal pr-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKey}
      >
        <header className="pr-head">
          <span className="pr-head-icon" aria-hidden="true">
            <PermissionIcon size={18} strokeWidth={1.8} />
          </span>
          <div className="pr-head-text">
            <div id={titleId} className="pr-title">
              {p ? titleOf(kind, p.tool, p.input) : 'Pedidos de permiso'}
            </div>
            <div className="pr-sub">{p ? 'Claude está esperando tu respuesta para seguir.' : 'Sloth no tiene pedidos para mostrar.'}</div>
          </div>
          {n > 0 && (
            <div className="pr-queue" role="group" aria-label="Cola de pedidos">
              <button type="button" className="icon-btn pr-nav" onClick={() => go(-1)} disabled={n < 2} aria-label="Pedido anterior">
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 5l-7 7 7 7" />
                </svg>
              </button>
              <span className="pr-queue-label" aria-live="polite">
                {idx + 1} de {n} {n === 1 ? 'pedido' : 'pedidos'}
              </span>
              <button type="button" className="icon-btn pr-nav" onClick={() => go(1)} disabled={n < 2} aria-label="Pedido siguiente">
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          )}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar revisión">
            <CloseIcon size={14} />
          </button>
        </header>

        {!p ? (
          <div className="pr-empty">
            <span className="pr-empty-icon" aria-hidden="true">
              <CheckGlyph size={18} />
            </span>
            <div className="pr-empty-title">No hay pedidos pendientes</div>
            <div className="pr-empty-sub">Claude no espera nada de vos. Los pedidos nuevos aparecen acá.</div>
            <button type="button" className="btn primary" onClick={onClose}>
              Volver a los espacios
            </button>
          </div>
        ) : (
          <div className="pr-body">
            <dl className="pr-meta">
              <div>
                <dt>Espacio</dt>
                <dd>{ws?.name ?? 'Espacio borrado'}</dd>
              </div>
              <div>
                <dt>Cuenta</dt>
                <dd>{acc?.label ?? 'Cuenta borrada'}</dd>
              </div>
              <div>
                <dt>Carpeta</dt>
                <dd className="mono">{ws?.cwd ?? '—'}</dd>
              </div>
            </dl>

            {kind === 'cmd' && <code className="pr-code mono">{cmd}</code>}
            {kind === 'net' && <code className="pr-code mono">{domain || 'Sin dirección'}</code>}
            {kind === 'edit' && (
              <>
                {files.length === 0 && changes.length === 0 && <p className="pr-note">El pedido no dice qué archivos toca.</p>}
                {(files.length > 0 || changes.length > 0) && (
                  <Changes changes={changes.length ? changes : files.map((f) => ({ path: f, add: 0, del: 0, isNew: false, lines: [] }))} />
                )}
              </>
            )}
            {kind === 'other' && otherJson && otherJson !== '{}' && <pre className="pr-code mono">{otherJson}</pre>}

            <section className="pr-expl">
              <h3 className="pr-expl-title">Qué va a hacer (lo cuenta Claude)</h3>
              <p className="pr-expl-text">{explanation ?? 'Claude no dejó una explicación en este pedido.'}</p>
            </section>

            {p && (
              <div className="pr-risk">
                <span className="pr-risk-label">Riesgo</span>
                <span className={`pr-risk-pill ${riskOf(kind, changes.length || files.length).cls}`}>
                  {riskOf(kind, changes.length || files.length).label}
                </span>
              </div>
            )}

            {msgOpen && (
              <label className="pr-msg">
                <span>Decile a Claude qué hacer en cambio</span>
                <textarea
                  ref={msgRef}
                  rows={2}
                  value={msg}
                  disabled={sending !== null}
                  placeholder="Ej.: usá la base de dev, no staging"
                  onChange={(e) => setMsg(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      const text = msg.trim()
                      if (!text || !p) return
                      void run('text', async () => {
                        await rejectAndTell(p, text)
                        setMsg('')
                      })
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation()
                      setMsgOpen(false)
                    }
                  }}
                />
                <span className="pr-hint">Enter envía · Shift + Enter hace un salto de línea · Esc cierra</span>
              </label>
            )}

            <div className="pr-actions">
              <button
                type="button"
                className="btn primary"
                data-perm-primary
                disabled={sending !== null}
                onClick={() => void run('allow', () => decidePermission(p, 'allow'))}
              >
                {sending === 'allow' ? 'Permitiendo…' : 'Permitir una vez'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={sending !== null}
                title="Guarda una regla para este espacio: los pedidos iguales se aprueban solos"
                onClick={() => void run('always', () => decidePermission(p, 'allowAlways'))}
              >
                {alwaysLabel(kind)}
              </button>
              <span className="spacer" />
              <button type="button" className="btn ghost danger" disabled={sending !== null} onClick={() => void run('deny', () => decidePermission(p, 'deny'))}>
                {sending === 'deny' ? 'Rechazando…' : 'Rechazar'}
              </button>
              <button
                type="button"
                className="btn ghost"
                aria-expanded={msgOpen}
                disabled={sending !== null}
                onClick={() => setMsgOpen((o) => !o)}
              >
                Rechazar y decirle algo a Claude
              </button>
            </div>
            {error && (
              <p className="pr-error" role="alert">
                No se pudo enviar la respuesta: {error}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
