import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BookmarkSimple, CaretDown, CaretRight, FolderOpen, GitBranch, PencilSimple, Play, Plus, Ticket, Trash, X } from '@phosphor-icons/react'
import { isLoginPane, type Workspace } from '../../../../shared/types'
import { useUi, type Command, type FeatureUi, type UiCtx } from '../host'
import { cleanError, shortPath } from '../../format'
import {
  createFrom,
  getTemplates,
  openDialog,
  setTemplates,
  SUGGESTED,
  TICKET_RE,
  useTemplates,
  usesTicket,
  type Draft,
  type TemplateDto
} from './store'
import './templates.css'

const accLabel = (ctx: UiCtx, id: string): string =>
  id === SUGGESTED ? 'Cuenta sugerida' : (ctx.accounts.find((a) => a.id === id)?.label ?? 'cuenta borrada')

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Precarga una plantilla desde un espacio: el ticket se vuelve {ticket}. */
export function draftFromWorkspace(ws: Workspace): Draft {
  const tk = ws.ticket
  // TCK-1234 → {ticket}; tck-1234 → {ticketmin} (respeta cómo está escrito en la rama).
  const sub = (s?: string): string | undefined =>
    s && tk ? s.replace(new RegExp(escapeRe(tk), 'g'), '{ticket}').replace(new RegExp(escapeRe(tk.toLowerCase()), 'g'), '{ticketmin}') : s
  const hasTk = Boolean(tk && ws.name.toUpperCase().includes(tk))
  let name = hasTk && tk ? ws.name.replace(new RegExp(escapeRe(tk), 'gi'), '').replace(/^[\s·:\-–]+|[\s·:\-–]+$/g, '') : ws.name
  if (!name) name = ws.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? 'Plantilla'
  return {
    name,
    repoPath: ws.repoPath,
    accountId: ws.accountId,
    namePattern: hasTk ? sub(ws.name) : undefined,
    initialPrompt: sub(ws.initialPrompt),
    useWorktree: ws.branch ? { branchPattern: sub(ws.branch)! } : undefined,
    autoStartClaude: ws.autoStartClaude,
    resume: ws.resume !== false
  }
}

/** Devuelve el foco a donde estaba cuando se cierra un diálogo. */
function useReturnFocus(): void {
  useLayoutEffect(() => {
    const a = document.activeElement
    const prev = a instanceof HTMLElement && a !== document.body ? a : null
    return () => {
      if (prev?.isConnected) prev.focus()
    }
  }, [])
}

function EditDialog({ draft, onClose }: { draft: Draft; onClose: () => void }): React.JSX.Element {
  const ctx = useUi()
  useReturnFocus()
  const [name, setName] = useState(draft.name ?? '')
  const [repoPath, setRepoPath] = useState(draft.repoPath ?? '')
  const [accountId, setAccountId] = useState(draft.accountId && (draft.accountId === SUGGESTED || ctx.accounts.some((a) => a.id === draft.accountId)) ? draft.accountId : SUGGESTED)
  const [namePattern, setNamePattern] = useState(draft.namePattern ?? '')
  const [prompt, setPrompt] = useState(draft.initialPrompt ?? '')
  const [wt, setWt] = useState(Boolean(draft.useWorktree))
  const [branch, setBranch] = useState(draft.useWorktree?.branchPattern ?? '')
  const [autoStart, setAutoStart] = useState(draft.autoStartClaude !== false)
  const [resume, setResume] = useState(draft.resume !== false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const editing = Boolean(draft.id)
  const branchFixed = wt && branch.trim() !== '' && !/\{(ticket|ticketmin|n|fecha)\}/.test(branch)

  const pick = async (): Promise<void> => {
    const p = await window.sloth.pickFolder()
    if (p) setRepoPath(p)
  }

  const save = async (): Promise<void> => {
    setErr(null)
    setBusy(true)
    try {
      await ctx.invoke('feat:templates:save', {
        id: draft.id,
        name,
        repoPath,
        accountId,
        namePattern: namePattern.trim() || undefined,
        initialPrompt: prompt.trim() || undefined,
        useWorktree: wt ? { branchPattern: branch } : undefined,
        autoStartClaude: autoStart,
        resume
      })
      onClose()
    } catch (e) {
      setErr(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  const can = name.trim() && repoPath.trim() && (!wt || branch.trim()) && !busy
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal f-templates-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="f-templates-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (can) void save()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <header className="modal-head">
          <BookmarkSimple size={18} weight="duotone" aria-hidden="true" className="f-templates-icon" />
          <h2 id="f-templates-title">{editing ? 'Editar plantilla' : 'Nueva plantilla'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="field">
          <label htmlFor="f-tpl-name">Nombre de la plantilla</label>
          <input id="f-tpl-name" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Ej: Cosmos front" />
        </div>

        <div className="field">
          <label htmlFor="f-tpl-repo">Carpeta del repo</label>
          <div className="input-row">
            <input id="f-tpl-repo" className="mono" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="C:\repos\…" />
            <button type="button" className="btn" onClick={() => void pick()}>
              <FolderOpen size={14} aria-hidden="true" /> Elegir
            </button>
          </div>
        </div>

        <div className="f-templates-grid">
          <div className="field">
            <label htmlFor="f-tpl-acc">Cuenta</label>
            <select id="f-tpl-acc" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value={SUGGESTED}>Sugerida (con sesión y menos uso en 5 h)</option>
              {ctx.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-tpl-wsname">Nombre del espacio</label>
            <input id="f-tpl-wsname" value={namePattern} maxLength={120} onChange={(e) => setNamePattern(e.target.value)}
              placeholder={usesTicket({ initialPrompt: prompt, useWorktree: wt ? { branchPattern: branch } : undefined }) ? '{plantilla} {ticket}' : '{plantilla} #{n}'}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="f-tpl-prompt">Prompt inicial (opcional)</label>
          <textarea id="f-tpl-prompt" className="f-templates-text" rows={3} maxLength={4000} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="/ticket {ticket}" />
        </div>

        <label className="check">
          <input type="checkbox" checked={wt} onChange={(e) => setWt(e.target.checked)} />
          <span>
            Crear un worktree en una rama nueva
            <small>Cada espacio en su propia carpeta, al lado del repo.</small>
          </span>
        </label>
        {wt && (
          <div className="field indent">
            <label htmlFor="f-tpl-branch">Rama</label>
            <input id="f-tpl-branch" className="mono" value={branch} maxLength={200} onChange={(e) => setBranch(e.target.value)} placeholder="feat/{ticket}" aria-describedby="f-tpl-branch-help" />
            <p className="field-help" id="f-tpl-branch-help">
              {branchFixed ? 'Sin variables, la segunda vez va a chocar con la rama ya creada: sumá {ticket} o {n}.' : 'Ej: feat/{ticketmin} o prueba-{fecha}-{n}.'}
            </p>
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
          <span>Abrir Claude al crear el espacio</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} />
          <span>Retomar la última conversación al reabrir</span>
        </label>

        <p className="hint f-templates-vars">
          Variables: <code className="mono">{'{ticket}'}</code> o <code className="mono">{'{ticketmin}'}</code> (se pide al crear),{' '}<code className="mono">{'{fecha}'}</code> (AAAA-MM-DD),{' '}
          <code className="mono">{'{n}'}</code> (contador) y <code className="mono">{'{plantilla}'}</code>.
        </p>

        {err && (
          <p className="form-error" role="alert">
            {err}
          </p>
        )}
        <footer className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={!can}>
            {busy ? 'Guardando…' : 'Guardar plantilla'}
          </button>
        </footer>
      </form>
    </div>
  )
}

function TicketDialog({ template, onClose }: { template: TemplateDto; onClose: () => void }): React.JSX.Element {
  const ctx = useUi()
  useReturnFocus()
  const [ticket, setTicket] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = ticket.trim().toUpperCase()
  const ok = TICKET_RE.test(id)
  const invalid = ticket.trim().length > 0 && !ok

  const go = async (): Promise<void> => {
    if (!ok || busy) return
    setErr(null)
    setBusy(true)
    const done = await createFrom({ invoke: ctx.invoke, notifyError: setErr }, template, id)
    setBusy(false)
    if (done) onClose()
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal f-templates-mini"
        role="dialog"
        aria-modal="true"
        aria-labelledby="f-tpl-tk-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void go()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <header className="modal-head">
          <Ticket size={18} weight="duotone" aria-hidden="true" className="modal-icon" />
          <h2 id="f-tpl-tk-title">Crear desde «{template.name}»</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="field">
          <label htmlFor="f-tpl-tk">Ticket</label>
          <input
            id="f-tpl-tk"
            className="mono"
            autoFocus
            value={ticket}
            maxLength={40}
            onChange={(e) => setTicket(e.target.value)}
            placeholder="TCK-1234"
            aria-invalid={invalid}
            aria-describedby="f-tpl-tk-help"
          />
          <p className={invalid ? 'field-error' : 'field-help'} id="f-tpl-tk-help">
            {invalid ? 'Tiene que ser tipo TCK-1234.' : 'Reemplaza {ticket} en el nombre, la rama y el prompt.'}
          </p>
        </div>
        {err && (
          <p className="form-error" role="alert">
            {err}
          </p>
        )}
        <footer className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={!ok || busy}>
            <Play size={13} weight="fill" aria-hidden="true" /> {busy ? 'Creando…' : 'Crear espacio'}
          </button>
        </footer>
      </form>
    </div>
  )
}

function Global(): React.JSX.Element | null {
  const ctx = useUi()
  const { dialog } = useTemplates()
  const invokeRef = useRef(ctx.invoke)
  const onRef = useRef(ctx.on)

  // Carga una vez y después solo escucha cambios (sin polling).
  useEffect(() => {
    let alive = true
    void invokeRef
      .current<TemplateDto[]>('feat:templates:list')
      .then((l) => alive && setTemplates(l))
      .catch(() => undefined)
    const off = onRef.current('feat:templates:changed', (l: TemplateDto[]) => setTemplates(l))
    return () => {
      alive = false
      off()
    }
  }, [])

  if (!dialog) return null
  const close = (): void => openDialog(null)
  return dialog.kind === 'edit' ? <EditDialog draft={dialog.draft} onClose={close} /> : <TicketDialog template={dialog.template} onClose={close} />
}

const OPEN_KEY = 'sloth.templates.open'

function Sidebar(): React.JSX.Element {
  const ctx = useUi()
  const { list, loaded, busy } = useTemplates()
  const [open, setOpenState] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== '0'
    } catch {
      return true
    }
  })
  const toggle = (): void =>
    setOpenState((v) => {
      try {
        localStorage.setItem(OPEN_KEY, v ? '0' : '1')
      } catch {
        /* nada */
      }
      return !v
    })

  const remove = async (t: TemplateDto): Promise<void> => {
    if (!window.confirm(`¿Borrar la plantilla «${t.name}»? Los espacios ya creados con ella no se tocan.`)) return
    try {
      await ctx.invoke('feat:templates:remove', t.id)
    } catch (e) {
      ctx.notifyError(cleanError(e))
    }
  }

  return (
    <section className="section f-templates" aria-labelledby="f-templates-h">
      <div className="section-row">
        <h2 id="f-templates-h" className="section-title">
          <button type="button" className="f-templates-toggle" onClick={toggle} aria-expanded={open} aria-controls="f-templates-body">
            {open ? <CaretDown size={12} aria-hidden="true" /> : <CaretRight size={12} aria-hidden="true" />}
            Plantillas <span className="count">{list.length}</span>
          </button>
        </h2>
        <button className="icon-btn" onClick={() => openDialog({ kind: 'edit', draft: { accountId: SUGGESTED, autoStartClaude: true, resume: true } })} aria-label="Nueva plantilla" title="Nueva plantilla">
          <Plus size={14} weight="bold" aria-hidden="true" />
        </button>
      </div>
      <div id="f-templates-body" hidden={!open}>
      {loaded && list.length === 0 && <p className="hint">Guardá un espacio como plantilla con el marcador de su panel.</p>}
      <ul className="list f-templates-list">
        {list.map((t) => {
          const tk = usesTicket(t)
          return (
            <li key={t.id} className="f-templates-row">
              <button
                className="icon-btn f-templates-play"
                onClick={() => void createFrom(ctx, t)}
                disabled={busy !== null}
                aria-label={`Crear espacio desde la plantilla ${t.name}${tk ? ' (pide ticket)' : ''}`}
                title={tk ? 'Crear espacio (pide el ticket)' : 'Crear espacio'}
              >
                <Play size={12} weight="fill" aria-hidden="true" />
              </button>
              <span className="grow-min">
                <span className="item-title">
                  <span className="f-templates-name">{t.name}</span>
                  {busy === t.id && <span className="f-templates-busy">creando…</span>}
                </span>
                <span className="item-sub">
                  <span>{accLabel(ctx, t.accountId)}</span>
                  {tk && (
                    <span className="f-templates-meta" title="Pide el ticket">
                      <Ticket size={12} aria-hidden="true" />
                      <span className="sr-only">pide ticket</span>
                    </span>
                  )}
                  {t.useWorktree && (
                    <span className="f-templates-meta mono" title={`Rama: ${t.useWorktree.branchPattern}`}>
                      <GitBranch size={11} aria-hidden="true" />
                      {t.useWorktree.branchPattern}
                    </span>
                  )}
                  {!t.useWorktree && <span className="mono f-templates-path">{shortPath(t.repoPath)}</span>}
                </span>
              </span>
              <span className="f-templates-actions">
                <button className="icon-btn" onClick={() => openDialog({ kind: 'edit', draft: t })} aria-label={`Editar plantilla ${t.name}`} title="Editar">
                  <PencilSimple size={13} aria-hidden="true" />
                </button>
                <button className="icon-btn danger" onClick={() => void remove(t)} aria-label={`Borrar plantilla ${t.name}`} title="Borrar">
                  <Trash size={13} aria-hidden="true" />
                </button>
              </span>
            </li>
          )
        })}
      </ul>
      </div>
    </section>
  )
}

function PaneHeader({ paneId }: { paneId: string }): React.JSX.Element | null {
  const ctx = useUi()
  if (isLoginPane(paneId)) return null
  const ws = ctx.workspaces.find((w) => w.id === paneId)
  if (!ws) return null
  return (
    <button
      className="icon-btn"
      onClick={() => openDialog({ kind: 'edit', draft: draftFromWorkspace(ws) })}
      aria-label={`Guardar ${ws.name} como plantilla`}
      title="Guardar espacio como plantilla"
    >
      <BookmarkSimple size={15} aria-hidden="true" />
    </button>
  )
}

const ui: FeatureUi = {
  name: 'templates',
  Global,
  Sidebar,
  PaneHeader,
  commands: (ctx) => {
    const cmds: Command[] = getTemplates().map((t) => ({
      id: `templates:create:${t.id}`,
      title: `Crear desde plantilla ${t.name}`,
      subtitle: [accLabel(ctx, t.accountId), t.useWorktree ? t.useWorktree.branchPattern : shortPath(t.repoPath), usesTicket(t) ? 'pide ticket' : '']
        .filter(Boolean)
        .join(' · '),
      group: 'Plantillas',
      keywords: `plantilla template ${t.repoPath}`,
      run: () => void createFrom(ctx, t)
    }))
    cmds.push({
      id: 'templates:new',
      title: 'Nueva plantilla',
      subtitle: 'Repo, cuenta, rama y prompt para crear espacios en un clic',
      group: 'Plantillas',
      keywords: 'crear template',
      run: () => openDialog({ kind: 'edit', draft: { accountId: SUGGESTED, autoStartClaude: true, resume: true } })
    })
    const f = ctx.focused
    const ws = f && !isLoginPane(f) ? ctx.workspaces.find((w) => w.id === f) : undefined
    if (ws)
      cmds.push({
        id: 'templates:from-focused',
        title: 'Guardar espacio enfocado como plantilla',
        subtitle: ws.name,
        group: 'Plantillas',
        keywords: 'template marcador',
        run: () => openDialog({ kind: 'edit', draft: draftFromWorkspace(ws) })
      })
    return cmds
  }
}

export default ui
