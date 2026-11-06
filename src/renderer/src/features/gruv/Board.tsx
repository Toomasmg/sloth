import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowClockwise,
  ArrowSquareOut,
  CircleNotch,
  FolderOpen,
  GearSix,
  Kanban,
  Play,
  Plus,
  Trash,
  WarningCircle,
  X
} from '@phosphor-icons/react'
import { useUi } from '../host'
import { api } from '../../api'
import { StatePill } from '../../StateIcon'
import { accountColor, cleanError, fmtTok, shortPath, totalTok } from '../../format'
import type { Workspace } from '../../../../shared/types'
import {
  columnFor,
  DOING,
  estadoLabel,
  setBoardOpen,
  setSnapshot,
  timeAgo,
  useSnapshot,
  type ColumnKey,
  type Snapshot,
  type Ticket
} from './model'

interface Card extends Ticket {
  col: ColumnKey
  /** El estado de Gruv no coincide con la columna (se movió en Sloth). */
  moved: boolean
  ws?: Workspace
  /** Solo existe como espacio de Sloth (Gruv no lo trajo). */
  onlySloth?: boolean
}

const DRAG_TYPE = 'application/x-sloth-ticket'

export function Board(): React.JSX.Element {
  const ui = useUi()
  const snap = useSnapshot()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [settings, setSettings] = useState(false)
  const [adding, setAdding] = useState(false)
  const [dragOver, setDragOver] = useState<ColumnKey | null>(null)
  const [queryAcc, setQueryAcc] = useState<string>('')
  const firstBtn = useRef<HTMLButtonElement>(null)

  const loggedIn = ui.accounts.filter((a) => ui.statuses[a.id]?.loggedIn)
  const accIndex = new Map(ui.accounts.map((a, i) => [a.id, i]))
  const accLabel = (id?: string): string => ui.accounts.find((a) => a.id === id)?.label ?? '—'

  useEffect(() => {
    if (!snap) return
    setQueryAcc((cur) => cur || snap.config.queryAccountId || loggedIn[0]?.id || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap?.config.queryAccountId, loggedIn.length])

  // Foco al abrir y vuelta al botón que lo abrió al cerrar.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    firstBtn.current?.focus()
    return () => prev?.focus?.()
  }, [])

  const close = (): void => setBoardOpen(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (confirming) setConfirming(false)
      else if (adding) setAdding(false)
      else close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [confirming, adding])

  const cards = useMemo<Card[]>(() => {
    if (!snap) return []
    const wsByTicket = new Map<string, Workspace>()
    for (const w of ui.workspaces) if (w.ticket) wsByTicket.set(w.ticket.toUpperCase(), w)
    const seen = new Set<string>()
    const out: Card[] = []
    const push = (t: Ticket): void => {
      if (seen.has(t.id)) return
      seen.add(t.id)
      const ws = wsByTicket.get(t.id)
      const col = columnFor(t, snap, Boolean(ws))
      const natural = columnFor(t, { columns: snap.columns, overrides: {} }, Boolean(ws))
      out.push({ ...t, col, moved: col !== natural, ws })
    }
    snap.tickets.forEach(push)
    snap.manual.forEach(push)
    for (const [id, ws] of wsByTicket) {
      if (seen.has(id)) continue
      push({ id, titulo: ws.name !== id ? ws.name : 'Espacio de Sloth (Gruv no lo trajo)' })
      out[out.length - 1].onlySloth = true
    }
    return out
  }, [snap, ui.workspaces])

  const run = async (label: string, fn: () => Promise<unknown>): Promise<unknown> => {
    setBusy(label)
    setErr(null)
    try {
      return await fn()
    } catch (e) {
      setErr(cleanError(e))
      return undefined
    } finally {
      setBusy(null)
    }
  }

  const apply = (r: unknown): void => {
    if (r && typeof r === 'object' && 'tickets' in r) setSnapshot(r as Snapshot)
  }

  const refresh = async (): Promise<void> => {
    setConfirming(false)
    setInfo(null)
    const r = (await run('refresh', () => ui.invoke('feat:gruv:refresh', queryAcc))) as
      | { count: number; tokens?: number }
      | undefined
    if (r) setInfo(`Gruv trajo ${r.count} ${r.count === 1 ? 'ticket' : 'tickets'}${r.tokens ? ` · ~${fmtTok(r.tokens)} tokens` : ''}.`)
  }

  const askRefresh = (): void => {
    if (!snap) return
    if (!queryAcc) {
      setSettings(true)
      setErr('Elegí la cuenta con la que se consulta Gruv.')
      return
    }
    if (snap.config.confirmRefresh) setConfirming(true)
    else void refresh()
  }

  const start = async (c: Card): Promise<void> => {
    const r = (await run(`start:${c.id}`, () => ui.invoke('feat:gruv:start', c.id))) as
      | { id: string; created: boolean }
      | undefined
    if (r) close()
  }

  const moveTo = async (c: Card, col: ColumnKey): Promise<void> => {
    if (col === c.col && !(col === DOING && !c.ws)) return
    if (col === DOING) return start(c)
    apply(await run(`move:${c.id}`, () => ui.invoke('feat:gruv:move', c.id, col)))
  }

  const resetCol = async (c: Card): Promise<void> => {
    apply(await run(`move:${c.id}`, () => ui.invoke('feat:gruv:move', c.id, null)))
  }

  const onCardKey = (e: React.KeyboardEvent, c: Card): void => {
    if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
    e.preventDefault()
    const cols = snap?.columns ?? []
    const i = cols.findIndex((k) => k.clave === c.col)
    const j = Math.max(0, Math.min(cols.length - 1, i + (e.key === 'ArrowLeft' ? -1 : 1)))
    if (j !== i) void moveTo(c, cols[j].clave)
  }

  if (!snap) {
    return (
      <div className="modal-backdrop f-gruv-backdrop">
        <div className="f-gruv-board" role="dialog" aria-modal="true" aria-label="Tablero de tickets">
          <p className="hint">Cargando…</p>
        </div>
      </div>
    )
  }

  const running = snap.running || busy === 'refresh'
  const usage5h = (id: string): number => {
    const u = ui.usage[id]
    return u ? totalTok(u.last5h) : 0
  }
  const open = cards.length

  return (
    <div className="modal-backdrop f-gruv-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="f-gruv-board" role="dialog" aria-modal="true" aria-labelledby="f-gruv-title">
        <header className="f-gruv-head">
          <Kanban size={18} weight="bold" aria-hidden="true" className="f-gruv-head-ic" />
          <h2 id="f-gruv-title">Tickets</h2>
          <span className="f-gruv-meta" aria-live="polite">
            {running ? (
              <>
                <CircleNotch size={12} weight="bold" className="spin" aria-hidden="true" /> Consultando Gruv con{' '}
                {accLabel(queryAcc)}… (hasta 2 min)
              </>
            ) : snap.fetchedAt ? (
              <>
                {open} {open === 1 ? 'ticket' : 'tickets'} · Gruv actualizado {timeAgo(snap.fetchedAt)} con {accLabel(snap.fetchedBy)}
                {snap.lastRun?.tokens ? ` · ~${fmtTok(snap.lastRun.tokens)} tokens` : ''}
              </>
            ) : (
              <>{open} {open === 1 ? 'ticket' : 'tickets'} · todavía no se consultó Gruv</>
            )}
          </span>
          <div className="f-gruv-head-actions">
            {running ? (
              <button type="button" className="btn sm" onClick={() => void ui.invoke('feat:gruv:cancel')}>
                <X size={14} aria-hidden="true" /> Cancelar consulta
              </button>
            ) : (
              <button
                ref={firstBtn}
                type="button"
                className="btn sm"
                onClick={askRefresh}
                title={queryAcc ? `Usa tokens de ${accLabel(queryAcc)}` : 'Elegí una cuenta en Configuración'}
              >
                <ArrowClockwise size={14} aria-hidden="true" /> Actualizar
                {queryAcc ? <span className="f-gruv-sub">usa tokens de {accLabel(queryAcc)}</span> : null}
              </button>
            )}
            <button type="button" className="btn sm" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
              <Plus size={14} aria-hidden="true" /> A mano
            </button>
            <button type="button" className="btn sm ghost" aria-expanded={settings} onClick={() => setSettings((v) => !v)}>
              <GearSix size={14} aria-hidden="true" /> Configuración
            </button>
            <button type="button" className="icon-btn" aria-label="Cerrar tablero (Esc)" title="Cerrar (Esc)" onClick={close}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        {confirming && (
          <div className="f-gruv-bar f-gruv-confirm" role="alertdialog" aria-label="Confirmar consulta a Gruv">
            <WarningCircle size={16} weight="fill" aria-hidden="true" className="f-gruv-warn" />
            <span>
              Para leer Gruv se abre Claude sin ventana con <b>{accLabel(queryAcc)}</b> (modelo {snap.config.model}) y
              usa tokens de esa cuenta. Solo lee: no cambia nada en Gruv.
            </span>
            <label className="check f-gruv-inline-check">
              <input
                type="checkbox"
                onChange={(e) => void ui.invoke('feat:gruv:setConfig', { confirmRefresh: !e.target.checked }).then(apply)}
              />
              No volver a preguntar
            </label>
            <button type="button" className="btn sm primary" autoFocus onClick={() => void refresh()}>
              Consultar
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setConfirming(false)}>
              Cancelar
            </button>
          </div>
        )}
        {(err || (snap.lastError && !running)) && (
          <p className="form-error f-gruv-msg" role="alert">
            {err ?? `Última consulta: ${snap.lastError}`}
          </p>
        )}
        {info && !err && <p className="f-gruv-msg f-gruv-ok" role="status">{info}</p>}

        {adding && <AddManual onDone={(s) => { apply(s); setAdding(false) }} onError={setErr} />}
        {settings && (
          <Settings
            snap={snap}
            queryAcc={queryAcc}
            setQueryAcc={setQueryAcc}
            projects={[...new Set(cards.map((c) => c.proyecto).filter((p): p is string => Boolean(p)))]}
            apply={apply}
            onError={setErr}
          />
        )}

        <div className="f-gruv-cols">
          {snap.columns.map((column) => {
            const col = { key: column.clave, title: column.nombre }
            const list = cards.filter((c) => c.col === col.key)
            return (
              <section
                key={col.key}
                className={`f-gruv-col ${dragOver === col.key ? 'over' : ''}`}
                aria-labelledby={`f-gruv-col-${col.key}`}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setDragOver(col.key)
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(null)
                  const id = e.dataTransfer.getData(DRAG_TYPE)
                  const c = cards.find((x) => x.id === id)
                  if (c) void moveTo(c, col.key)
                }}
              >
                <h3 id={`f-gruv-col-${col.key}`} className="f-gruv-col-title" title={col.key === DOING ? 'Soltá una tarjeta acá para crear su espacio' : `Estado de Gruv: ${col.key}`}>
                  {col.title} <span className="f-gruv-count">{list.length}</span>
                </h3>
                <ul className="f-gruv-list">
                  {list.map((c) => (
                    <li
                      key={c.id}
                      className={`f-gruv-card ${busy?.endsWith(`:${c.id}`) ? 'busy' : ''}`}
                      tabIndex={0}
                      draggable
                      aria-label={`${c.id}: ${c.titulo}. Alt+flechas para moverlo de columna.`}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DRAG_TYPE, c.id)
                        e.dataTransfer.effectAllowed = 'move'
                      }}
                      onKeyDown={(e) => onCardKey(e, c)}
                    >
                      <div className="f-gruv-card-top">
                        <span className="mono f-gruv-id">{c.id}</span>
                        {c.prioridad && <span className={`tag f-gruv-prio f-gruv-prio-${prioClass(c.prioridad)}`}>{c.prioridad}</span>}
                        {c.manual && <span className="f-gruv-chip">a mano</span>}
                        {c.onlySloth && <span className="f-gruv-chip">solo Sloth</span>}
                        {c.url && (
                          <a className="icon-btn f-gruv-link" href={c.url} target="_blank" rel="noreferrer" aria-label={`Abrir ${c.id} en Gruv`} title="Abrir en Gruv">
                            <ArrowSquareOut size={13} aria-hidden="true" />
                          </a>
                        )}
                      </div>
                      <p className="f-gruv-title">{c.titulo}</p>
                      {(c.proyecto || (c.estado && c.estado !== c.col)) && (
                        <p className="f-gruv-sub-line">
                          {c.proyecto}
                          {c.proyecto && c.estado && c.estado !== c.col ? ' · ' : ''}
                          {c.estado && c.estado !== c.col ? `Gruv: ${estadoLabel(c.estado)}` : ''}
                        </p>
                      )}
                      <div className="f-gruv-card-foot">
                        {c.ws ? (
                          <>
                            {ui.agents[c.ws.id] ? (
                              <StatePill state={ui.agents[c.ws.id].state} detail={ui.agents[c.ws.id].detail} />
                            ) : (
                              <span className="pill">Sin abrir</span>
                            )}
                            <span className="f-gruv-acc" title={`Cuenta del espacio · ${fmtTok(usage5h(c.ws.accountId))} tokens en 5 h`}>
                              <span className="f-gruv-dot" style={{ background: accountColor(accIndex.get(c.ws.accountId) ?? 0) }} aria-hidden="true" />
                              {accLabel(c.ws.accountId)}
                            </span>
                            <button type="button" className="btn sm ghost f-gruv-go" onClick={() => void start(c)}>
                              <ArrowSquareOut size={13} aria-hidden="true" /> Abrir
                            </button>
                          </>
                        ) : (
                          <>
                            {c.moved && (
                              <button type="button" className="btn sm ghost" onClick={() => void resetCol(c)} title="Volver a la columna del estado de Gruv">
                                Como en Gruv
                              </button>
                            )}
                            {c.manual && (
                              <button
                                type="button"
                                className="icon-btn"
                                aria-label={`Quitar ${c.id} del tablero`}
                                title="Quitar del tablero"
                                onClick={async () => apply(await run(`rm:${c.id}`, () => ui.invoke('feat:gruv:removeManual', c.id)))}
                              >
                                <Trash size={13} aria-hidden="true" />
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn sm f-gruv-go"
                              disabled={Boolean(busy)}
                              onClick={() => void start(c)}
                              title={`Crea el espacio ${c.id} y arranca Claude con /ticket ${c.id}`}
                            >
                              {busy === `start:${c.id}` ? (
                                <CircleNotch size={13} weight="bold" className="spin" aria-hidden="true" />
                              ) : (
                                <Play size={13} weight="fill" aria-hidden="true" />
                              )}
                              Empezar
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                  {list.length === 0 && (
                    <li className="f-gruv-empty" aria-hidden="true">
                      {col.key === DOING ? 'Soltá una tarjeta acá para crear su espacio' : 'Sin tickets'}
                    </li>
                  )}
                </ul>
              </section>
            )
          })}
        </div>
        <footer className="f-gruv-foot hint">
          Arrastrá a «En curso» (o tocá «Empezar») para crear el espacio con <span className="mono">/ticket</span>. Moverlas
          acá no cambia nada en Gruv. Con el teclado: Alt+← / Alt+→ sobre una tarjeta.
        </footer>
      </div>
    </div>
  )
}

function prioClass(p: string): string {
  const s = p.toLowerCase()
  if (/crit|urg|bloq/.test(s)) return 'crit'
  if (/alta|high/.test(s)) return 'high'
  if (/baja|low/.test(s)) return 'low'
  return 'mid'
}

function AddManual({ onDone, onError }: { onDone: (s: unknown) => void; onError: (m: string) => void }): React.JSX.Element {
  const ui = useUi()
  const [id, setId] = useState('')
  const [titulo, setTitulo] = useState('')
  const [proyecto, setProyecto] = useState('')
  const valid = /^[A-Za-z][A-Za-z0-9]*-\d{1,7}$/.test(id.trim()) && titulo.trim().length > 0
  return (
    <form
      className="f-gruv-bar f-gruv-add"
      onSubmit={async (e) => {
        e.preventDefault()
        try {
          onDone(await ui.invoke('feat:gruv:addManual', { id: id.trim(), titulo, proyecto: proyecto || undefined }))
        } catch (er) {
          onError(cleanError(er))
        }
      }}
    >
      <label className="f-gruv-field">
        <span>Ticket</span>
        <input className="mono" autoFocus value={id} placeholder="TCK-1234" maxLength={20} onChange={(e) => setId(e.target.value.toUpperCase())} />
      </label>
      <label className="f-gruv-field grow">
        <span>Título</span>
        <input value={titulo} maxLength={300} onChange={(e) => setTitulo(e.target.value)} />
      </label>
      <label className="f-gruv-field">
        <span>Proyecto (opcional)</span>
        <input value={proyecto} maxLength={80} onChange={(e) => setProyecto(e.target.value)} />
      </label>
      <button type="submit" className="btn sm primary" disabled={!valid}>
        <Plus size={14} aria-hidden="true" /> Agregar
      </button>
    </form>
  )
}

function Settings(props: {
  snap: Snapshot
  queryAcc: string
  setQueryAcc: (id: string) => void
  projects: string[]
  apply: (s: unknown) => void
  onError: (m: string) => void
}): React.JSX.Element {
  const ui = useUi()
  const { snap, apply, onError } = props
  const [assignee, setAssignee] = useState(snap.config.assigneeId)
  const save = async (patch: Record<string, unknown>): Promise<void> => {
    try {
      apply(await ui.invoke('feat:gruv:setConfig', patch))
    } catch (e) {
      onError(cleanError(e))
    }
  }
  const pick = async (): Promise<string | null> => api.pickFolder()
  return (
    <div className="f-gruv-settings">
      <div className="f-gruv-set-row">
        <label className="f-gruv-field">
          <span>Cuenta para consultar Gruv</span>
          <select
            value={props.queryAcc}
            onChange={(e) => {
              props.setQueryAcc(e.target.value)
              void save({ queryAccountId: e.target.value })
            }}
          >
            <option value="">Elegí una cuenta…</option>
            {ui.accounts.map((a) => (
              <option key={a.id} value={a.id} disabled={!ui.statuses[a.id]?.loggedIn}>
                {a.label}
                {ui.statuses[a.id]?.loggedIn ? '' : ' (sin sesión)'}
              </option>
            ))}
          </select>
        </label>
        <label className="f-gruv-field">
          <span>Modelo de la consulta</span>
          <select value={snap.config.model} onChange={(e) => void save({ model: e.target.value })}>
            <option value="haiku">Haiku (más barato)</option>
            <option value="sonnet">Sonnet</option>
            <option value="opus">Opus</option>
          </select>
        </label>
        <label className="f-gruv-field grow">
          <span>Tu id de persona en Gruv</span>
          <input
            className="mono"
            value={assignee}
            maxLength={80}
            onChange={(e) => setAssignee(e.target.value)}
            onBlur={() => assignee !== snap.config.assigneeId && void save({ assigneeId: assignee })}
          />
        </label>
      </div>
      <p className="hint">
        Gruv es un conector de claude.ai: la cuenta elegida tiene que tenerlo conectado. La consulta solo puede usar
        herramientas de lectura de Gruv.
      </p>
      <div className="f-gruv-set-row">
        <RepoField
          label="Repo por defecto"
          value={snap.config.defaultRepo}
          placeholder={snap.lastRepo ? `Último usado: ${shortPath(snap.lastRepo)}` : 'Elegí la carpeta del repo'}
          onPick={async () => {
            const p = await pick()
            if (p) await save({ defaultRepo: p })
          }}
          onClear={() => void save({ defaultRepo: '' })}
        />
        {props.projects.map((p) => (
          <RepoField
            key={p}
            label={`Repo de ${p}`}
            value={snap.config.projectRepos[p]}
            placeholder="Usa el repo por defecto"
            onPick={async () => {
              const d = await pick()
              if (d) await save({ projectRepo: { project: p, repo: d } })
            }}
            onClear={() => void save({ projectRepo: { project: p, repo: '' } })}
          />
        ))}
      </div>
    </div>
  )
}

function RepoField(p: {
  label: string
  value?: string
  placeholder: string
  onPick: () => void
  onClear: () => void
}): React.JSX.Element {
  return (
    <div className="f-gruv-field f-gruv-repo">
      <span>{p.label}</span>
      <div className="f-gruv-repo-row">
        <span className={`mono f-gruv-path ${p.value ? '' : 'f-gruv-path-empty'}`} title={p.value}>
          {p.value ? shortPath(p.value) : p.placeholder}
        </span>
        <button type="button" className="btn sm" onClick={p.onPick}>
          <FolderOpen size={13} aria-hidden="true" /> Elegir
        </button>
        {p.value && (
          <button type="button" className="icon-btn" aria-label={`Quitar ${p.label.toLowerCase()}`} onClick={p.onClear}>
            <X size={13} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  )
}
