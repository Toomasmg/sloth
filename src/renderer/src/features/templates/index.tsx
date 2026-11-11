import { useEffect, useRef, useState, lazy, Suspense } from 'react'
import { NewSpaceIcon, TicketIcon, BranchIcon, ChangesIcon, TemplatesIcon } from '../../icons/SlothIcons'
import { isLoginPane, type Workspace } from '../../../../shared/types'
import { useUi, type Command, type FeatureUi, type UiCtx } from '../host'
import { cleanError, shortPath } from '../../format'
import { createFrom, loadTemplates, openDialog, setView, useTemplates, usesTicket, getTemplates, type TemplateDto, type TemplatesView } from './store'
const TemplatesScreen = lazy(() => import('./TemplatesScreen').then((m) => ({ default: m.TemplatesScreen })))
import { colorHex, iconPath } from './catalog'
import './templates.css'

const accLabel = (ctx: UiCtx, id: string): string => (id === 'sugerida' ? 'Cuenta sugerida' : (ctx.accounts.find((a) => a.id === id)?.label ?? 'cuenta borrada'))

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Precarga una plantilla desde un espacio: el ticket se vuelve {ticket}. */
export function draftFromWorkspace(ws: Workspace): {
  name: string
  namePattern?: string
  initialPrompt?: string
  useWorktree?: { branchPattern: string }
} {
  const tk = ws.ticket
  // PROJ-123 → {ticket}; proj-123 → {ticketmin} (respeta cómo está escrito en la rama).
  const sub = (s?: string): string | undefined =>
    s && tk ? s.replace(new RegExp(escapeRe(tk), 'g'), '{ticket}').replace(new RegExp(escapeRe(tk.toLowerCase()), 'g'), '{ticketmin}') : s
  const hasTk = Boolean(tk && ws.name.toUpperCase().includes(tk))
  let name = hasTk && tk ? ws.name.replace(new RegExp(escapeRe(tk), 'gi'), '').replace(/^[\s·:\-–]+|[\s·:\-–]+$/g, '') : ws.name
  if (!name) name = ws.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? 'Plantilla'
  return {
    name,
    namePattern: hasTk ? sub(ws.name) : undefined,
    initialPrompt: sub(ws.initialPrompt),
    useWorktree: ws.branch ? { branchPattern: sub(ws.branch)! } : undefined
  }
}

/** Guarda un espacio como plantilla (con su carpeta) y abre la pantalla con ella seleccionada. */
async function saveFromWorkspace(ctx: UiCtx, ws: Workspace): Promise<void> {
  const d = draftFromWorkspace(ws)
  try {
    const t = await ctx.invoke<TemplateDto>('feat:templates:save', {
      name: d.name,
      repoPath: ws.repoPath,
      accountId: ws.accountId,
      namePattern: d.namePattern,
      initialPrompt: d.initialPrompt,
      useWorktree: d.useWorktree,
      autoStartClaude: ws.autoStartClaude,
      resume: ws.resume !== false
    })
    await loadTemplates(ctx)
    openDialog({ kind: 'manage', id: t.id })
  } catch (e) {
    ctx.notifyError(cleanError(e))
  }
}

function Global(): React.JSX.Element | null {
  const ctx = useUi()
  const { dialog } = useTemplates()
  const onRef = useRef(ctx.on)

  // Carga una vez y después solo escucha cambios (sin polling).
  useEffect(() => {
    let alive = true
    void loadTemplates(ctx)
    const off = onRef.current('feat:templates:changed', (v: TemplatesView) => {
      if (alive) setView(v)
    })
    return () => {
      alive = false
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!dialog) return null
  return (
    <Suspense fallback={null}>
      <TemplatesScreen key={dialog.id ?? 'new'} initialId={dialog.id} onClose={() => openDialog(null)} />
    </Suspense>
  )
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

  return (
    <section className="section f-templates" aria-labelledby="f-templates-h">
      <div className="section-row">
        <h2 id="f-templates-h" className="section-title">
          <button type="button" className="f-templates-toggle" onClick={toggle} aria-expanded={open} aria-controls="f-templates-body">
            {open ? <span aria-hidden="true">▾</span> : <span aria-hidden="true">▸</span>}
            Plantillas <span className="count">{list.length}</span>
          </button>
        </h2>
        <button className="icon-btn" onClick={() => openDialog({ kind: 'manage' })} aria-label="Administrar plantillas" title="Administrar plantillas">
          <NewSpaceIcon size={14} />
        </button>
      </div>
      <div id="f-templates-body" hidden={!open}>
        {loaded && list.length === 0 && <p className="hint">Guardá un espacio como plantilla con el marcador de su panel.</p>}
        <ul className="list f-templates-list">
          {list.map((t) => {
            const tk = usesTicket(t)
            const color = colorHex(t.color)
            return (
              <li key={t.id} className="f-templates-row">
                <button
                  className="icon-btn f-templates-play"
                  onClick={() => void createFrom(ctx, t)}
                  disabled={busy !== null}
                  aria-label={`Crear espacio desde la plantilla ${t.name}${tk ? ' (pide ticket)' : ''}`}
                  title={tk ? 'Crear espacio (pide el ticket)' : t.repoPath ? 'Crear espacio' : 'Crear espacio (elegí la carpeta)'}
                  style={{ color }}
                >
                  <NewSpaceIcon size={12} />
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
                        <TicketIcon size={12} />
                        <span className="sr-only">pide ticket</span>
                      </span>
                    )}
                    {t.useWorktree && (
                      <span className="f-templates-meta mono" title={`Rama: ${t.useWorktree.branchPattern}`}>
                        <BranchIcon size={11} />
                        {t.useWorktree.branchPattern}
                      </span>
                    )}
                    {!t.useWorktree && t.repoPath && <span className="mono f-templates-path">{shortPath(t.repoPath)}</span>}
                  </span>
                </span>
                <span className="f-templates-actions">
                  <button className="icon-btn" onClick={() => openDialog({ kind: 'manage', id: t.id })} aria-label={`Editar plantilla ${t.name}`} title="Editar">
                    <ChangesIcon size={13} />
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
    <button className="icon-btn" onClick={() => void saveFromWorkspace(ctx, ws)} aria-label={`Guardar ${ws.name} como plantilla`} title="Guardar espacio como plantilla">
      <TemplatesIcon size={15} />
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
      subtitle: [accLabel(ctx, t.accountId), t.useWorktree ? t.useWorktree.branchPattern : t.repoPath ? shortPath(t.repoPath) : '', usesTicket(t) ? 'pide ticket' : '']
        .filter(Boolean)
        .join(' · '),
      group: 'Plantillas',
      keywords: `plantilla template ${t.repoPath ?? ''}`,
      icon: <TemplatesIcon size={16} />,
      run: () => void createFrom(ctx, t)
    }))
    cmds.push({
      id: 'templates:new',
      title: 'Nueva plantilla',
      subtitle: 'Administrar plantillas: nombre, cuenta, rama y primer mensaje',
      group: 'Plantillas',
      keywords: 'crear template',
      run: () => openDialog({ kind: 'manage' })
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
        run: () => void saveFromWorkspace(ctx, ws)
      })
    return cmds
  }
}

export default ui
