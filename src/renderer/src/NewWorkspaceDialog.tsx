import { useEffect, useMemo, useState } from 'react'
import { FolderOpen, Ticket, X } from '@phosphor-icons/react'
import type { Account, AccountStatus, AccountUsage, Workspace } from '../../shared/types'
import { api } from './api'
import { cleanError, emptyTotals, fmtTok, totalTok } from './format'

interface Props {
  mode: 'normal' | 'ticket'
  accounts: Account[]
  statuses: Record<string, AccountStatus>
  usage: Record<string, AccountUsage>
  defaultRepo: string
  onClose: () => void
  onCreated: (ws: Workspace) => void
}

const TICKET_RE = /^[A-Z][A-Z0-9]*-\d+$/

export function NewWorkspaceDialog(props: Props): React.JSX.Element {
  const { accounts, statuses, usage, mode, onClose } = props
  const ticketMode = mode === 'ticket'

  // Sugerida: con sesión iniciada y la que menos usó en las últimas 5 h.
  const suggested = useMemo(() => {
    const logged = accounts.filter((a) => statuses[a.id]?.loggedIn)
    const pool = logged.length ? logged : accounts
    const used = (a: Account): number => totalTok(usage[a.id]?.last5h ?? emptyTotals)
    return [...pool].sort((a, b) => used(a) - used(b))[0]?.id ?? ''
  }, [accounts, statuses, usage])

  const [ticket, setTicket] = useState('')
  const [name, setName] = useState('')
  const [repoPath, setRepoPath] = useState(ticketMode ? props.defaultRepo : '')
  const [accountId, setAccountId] = useState(suggested)
  const [useWorktree, setUseWorktree] = useState(false)
  const [branch, setBranch] = useState('')
  const [autoStartClaude, setAutoStart] = useState(true)
  const [prompt, setPrompt] = useState('')
  const [resume, setResume] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const ticketId = ticket.trim().toUpperCase()
  const ticketOk = TICKET_RE.test(ticketId)
  const ticketInvalid = ticket.trim().length > 0 && !ticketOk

  const pick = async (): Promise<void> => {
    const p = await api.pickFolder()
    if (!p) return
    setRepoPath(p)
    if (!name && !ticketMode) setName(p.split(/[\\/]/).filter(Boolean).pop() ?? '')
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      const ws = await api.addWorkspace(
        ticketMode
          ? {
              name: name.trim() || ticketId,
              repoPath,
              accountId,
              autoStartClaude: true,
              ticket: ticketId,
              // La skill /ticket ya abre su propio worktree desde origin/staging.
              initialPrompt: `/ticket ${ticketId}`,
              resume: true
            }
          : {
              name,
              repoPath,
              accountId,
              branch: useWorktree ? branch : undefined,
              autoStartClaude,
              initialPrompt: autoStartClaude ? prompt : undefined,
              resume
            }
      )
      props.onCreated(ws)
    } catch (e2) {
      setErr(cleanError(e2))
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = ticketMode
    ? ticketOk && repoPath.trim() && accountId
    : name.trim() && repoPath.trim() && accountId && (!useWorktree || branch.trim())

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nw-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
      >
        <header className="modal-head">
          {ticketMode && <Ticket size={18} weight="duotone" aria-hidden="true" className="modal-icon" />}
          <h2 id="nw-title">{ticketMode ? 'Espacio desde ticket' : 'Nuevo espacio'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        {ticketMode && (
          <div className="field">
            <label htmlFor="nw-ticket">Ticket</label>
            <input
              id="nw-ticket"
              className="mono"
              autoFocus
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              placeholder="TCK-1234"
              aria-invalid={ticketInvalid}
              aria-describedby="nw-ticket-help"
            />
            <p id="nw-ticket-help" className={ticketInvalid ? 'field-error' : 'field-help'}>
              {ticketInvalid
                ? 'Tiene que ser tipo TCK-1234.'
                : `Arranca Claude con «/ticket ${ticketOk ? ticketId : 'TCK-…'}». Tu skill se encarga del worktree, el PR y las horas.`}
            </p>
          </div>
        )}

        <div className="field">
          <label htmlFor="nw-repo">Repo</label>
          <div className="input-row">
            <input id="nw-repo" className="mono" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="C:\ruta\al\repo" />
            <button type="button" className="btn" onClick={() => void pick()}>
              <FolderOpen size={15} aria-hidden="true" /> Elegir
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="nw-name">Nombre{ticketMode ? ' (opcional)' : ''}</label>
          <input
            id="nw-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={ticketMode ? ticketId || 'TCK-1234' : 'Ej: backend · cuenta trabajo'}
          />
        </div>

        <div className="field">
          <label htmlFor="nw-account">Cuenta de Claude</label>
          <select id="nw-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => {
              const u = usage[a.id]
              const st = statuses[a.id]
              const who = st?.email ? ` (${st.email})` : st?.loggedIn ? '' : ' (sin sesión)'
              return (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {who}
                  {u ? ` · 5h ${fmtTok(totalTok(u.last5h))}` : ''}
                  {a.id === suggested ? ' · sugerida' : ''}
                </option>
              )
            })}
          </select>
          <p className="field-help">Sugerimos la cuenta con sesión que menos usaste en las últimas 5 h.</p>
        </div>

        {!ticketMode && (
          <>
            <label className="check">
              <input type="checkbox" checked={useWorktree} onChange={(e) => setUseWorktree(e.target.checked)} />
              <span>
                Trabajar en un worktree aparte
                <small>Rama propia; no toca tu copia del repo.</small>
              </span>
            </label>
            {useWorktree && (
              <div className="field indent">
                <label htmlFor="nw-branch">Rama</label>
                <input id="nw-branch" className="mono" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feature/mi-cambio" />
              </div>
            )}
            <label className="check">
              <input type="checkbox" checked={autoStartClaude} onChange={(e) => setAutoStart(e.target.checked)} />
              <span>Abrir Claude automáticamente en la PowerShell</span>
            </label>
            {autoStartClaude && (
              <>
                <div className="field indent">
                  <label htmlFor="nw-prompt">Prompt inicial (opcional)</label>
                  <input id="nw-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="/dia, o «revisá los tests que fallan»" />
                  <p className="field-help">Se manda solo la primera vez que se abre el espacio.</p>
                </div>
                <label className="check indent">
                  <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} />
                  <span>Al reabrir, retomar la última conversación de esa carpeta</span>
                </label>
              </>
            )}
          </>
        )}

        {err && (
          <p className="form-error" role="alert">
            {err}
          </p>
        )}

        <footer className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" type="submit" disabled={busy || !canSubmit}>
            {busy ? 'Creando…' : 'Crear espacio'}
          </button>
        </footer>
      </form>
    </div>
  )
}
