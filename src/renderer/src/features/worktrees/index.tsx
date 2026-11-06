import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Broom, CaretDown, CaretRight, CheckCircle, CircleNotch, GitBranch, Warning, WarningCircle, X } from '@phosphor-icons/react'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
import './worktrees.css'

// ---------- Tipos (los mismos que devuelve main) ----------
interface WorktreeInfo {
  repo: string
  path: string
  branch: string | null
  head?: string
  exists: boolean
  locked: boolean
  dirty: number
  unpushed: number
  merged: boolean
  mergedBy?: 'git' | 'pr'
  sameAsBase?: boolean
  pr?: { number: number; url: string }
  base: string | null
  lastCommitAt?: number
  workspaces: { id: string; name: string }[]
  safe: boolean
  reasons: string[]
}
interface RepoScan {
  repo: string
  base: string | null
  error?: string
  worktrees: WorktreeInfo[]
}
interface Summary {
  at: number
  ready: number
  total: number
}
interface RowOpts {
  deleteBranch: boolean
  force: boolean
  forceBranch: boolean
}
interface PlanItem {
  path: string
  branch: string | null
  commands: string[]
  workspaces: { id: string; name: string }[]
}
interface RemoveResult {
  path: string
  ok: boolean
  removedWorktree: boolean
  removedBranch: boolean
  error?: string
}

// Estado del modal compartido entre el Sidebar y la paleta.
let modalOpen = false
const subs = new Set<() => void>()
function setModal(v: boolean): void {
  modalOpen = v
  for (const s of subs) s()
}
function useModal(): boolean {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => modalOpen
  )
}

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function ago(ms?: number): string {
  if (!ms) return '—'
  const d = (Date.now() - ms) / 1000
  if (d < 3600) return `hace ${Math.max(1, Math.round(d / 60))} min`
  if (d < 86400) return `hace ${Math.round(d / 3600)} h`
  const days = Math.round(d / 86400)
  if (days < 60) return `hace ${days} día${days === 1 ? '' : 's'}`
  return `hace ${Math.round(days / 30)} meses`
}

function tail(p: string, n = 2): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length <= n ? p : `…\\${parts.slice(-n).join('\\')}`
}

// ---------- Sidebar ----------

function CleanupSection(): React.JSX.Element {
  const ui = useUi()
  const [expanded, setExpanded] = useState(false)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [scanning, setScanning] = useState(false)

  useEffect(() => {
    ui.invoke<Summary | null>('feat:worktrees:summary').then(setSummary, () => {})
    return ui.on('feat:worktrees:summary', (s: Summary) => setSummary(s))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = (): void => {
    const next = !expanded
    setExpanded(next)
    // Se escanea solo a pedido: al expandir.
    if (next && !scanning) {
      setScanning(true)
      ui.invoke('feat:worktrees:scan')
        .catch(() => {})
        .finally(() => setScanning(false))
    }
  }

  return (
    <section className="section f-wt-section">
      <button className="f-wt-toggle" onClick={toggle} aria-expanded={expanded} aria-controls="f-wt-body">
        {expanded ? <CaretDown size={12} aria-hidden="true" /> : <CaretRight size={12} aria-hidden="true" />}
        <span className="section-title f-wt-title">
          <Broom size={13} aria-hidden="true" /> Limpieza
        </span>
        <span className="spacer" />
        {scanning ? (
          <CircleNotch size={13} className="spin f-wt-muted" aria-label="Escaneando" />
        ) : (
          summary && (
            <span className={`count ${summary.ready > 0 ? 'f-wt-count-on' : ''}`} title={`${summary.ready} worktree(s) listos para borrar`} aria-label={`${summary.ready} listos para borrar`}>
              {summary.ready}
            </span>
          )
        )}
      </button>
      {expanded && (
        <div id="f-wt-body" className="f-wt-body">
          <p className="hint">
            {scanning
              ? 'Revisando worktrees…'
              : summary
                ? `${summary.ready} listo${summary.ready === 1 ? '' : 's'} para borrar (mergeados y limpios) de ${summary.total}.`
                : 'Todavía no se revisó.'}
          </p>
          <button className="btn sm" onClick={() => setModal(true)} disabled={scanning}>
            <Broom size={13} aria-hidden="true" /> Revisar worktrees…
          </button>
        </div>
      )}
    </section>
  )
}

// ---------- Modal ----------

function CleanupModal(): React.JSX.Element | null {
  const ui = useUi()
  const open = useModal()
  const [repos, setRepos] = useState<RepoScan[] | null>(null)
  const [err, setErr] = useState('')
  const [scanning, setScanning] = useState(false)
  const [showUnsafe, setShowUnsafe] = useState(false)
  const [sel, setSel] = useState<Record<string, RowOpts>>({})
  const [plan, setPlan] = useState<PlanItem[] | null>(null)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<RemoveResult[] | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const scan = useCallback(async () => {
    setScanning(true)
    setErr('')
    try {
      setRepos(await ui.invoke<RepoScan[]>('feat:worktrees:scan'))
    } catch (e) {
      setErr(errText(e))
    } finally {
      setScanning(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!open) return
    setSel({})
    setPlan(null)
    setResults(null)
    setShowUnsafe(false)
    void scan()
    setTimeout(() => ref.current?.focus(), 0)
  }, [open, scan])

  const close = useCallback(() => setModal(false), [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || running) return
      e.preventDefault()
      e.stopPropagation()
      if (plan) setPlan(null)
      else close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, plan, running, close])

  const all = useMemo(() => repos?.flatMap((r) => r.worktrees) ?? [], [repos])
  const byPath = useMemo(() => new Map(all.map((w) => [w.path, w])), [all])
  const selected = Object.keys(sel).filter((p) => byPath.has(p))

  if (!open) return null

  const selectable = (w: WorktreeInfo): boolean => w.exists && !w.locked && (w.safe || showUnsafe)
  const toggle = (w: WorktreeInfo): void =>
    setSel((s) => {
      const n = { ...s }
      if (n[w.path]) delete n[w.path]
      else n[w.path] = { deleteBranch: Boolean(w.branch) && w.safe, force: false, forceBranch: false }
      return n
    })
  const setOpt = (path: string, k: keyof RowOpts, v: boolean): void => setSel((s) => ({ ...s, [path]: { ...s[path], [k]: v } }))

  const requests = selected.map((p) => ({ path: p, ...sel[p], removeWorkspaces: true }))
  const review = async (): Promise<void> => {
    setErr('')
    try {
      setPlan(await ui.invoke<PlanItem[]>('feat:worktrees:plan', requests))
    } catch (e) {
      setErr(errText(e))
    }
  }
  const run = async (): Promise<void> => {
    setRunning(true)
    setErr('')
    try {
      const r = await ui.invoke<RemoveResult[]>('feat:worktrees:remove', requests)
      setResults(r)
      setPlan(null)
      setSel({})
      await ui.reload()
      await scan()
    } catch (e) {
      setErr(errText(e))
    } finally {
      setRunning(false)
    }
  }

  const unsafeSelected = selected.some((p) => !byPath.get(p)?.safe)

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !running && close()}>
      <div ref={ref} className="modal f-wt-modal" role="dialog" aria-modal="true" aria-labelledby="f-wt-h" tabIndex={-1}>
        <header className="modal-head">
          <Broom size={18} aria-hidden="true" />
          <h2 id="f-wt-h">{plan ? 'Confirmar borrado' : 'Limpieza de worktrees'}</h2>
          <button className="icon-btn" onClick={close} aria-label="Cerrar" disabled={running}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        {!plan && (
          <>
            {results && (
              <ul className="f-wt-results">
                {results.map((r) => (
                  <li key={r.path} className={r.ok ? 'ok' : 'bad'}>
                    {r.ok ? <CheckCircle size={14} aria-hidden="true" /> : <WarningCircle size={14} aria-hidden="true" />}
                    <span className="mono">{tail(r.path, 3)}</span>
                    <span>{r.ok ? `borrado${r.removedBranch ? ' (y su rama)' : ''}` : r.error}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="f-wt-bar">
              <span className="hint">
                {scanning ? 'Escaneando…' : repos ? `${all.filter((w) => w.safe).length} listos para borrar de ${all.length}` : ''}
              </span>
              <span className="spacer" />
              <label className={`check f-wt-unsafe-toggle ${showUnsafe ? 'on' : ''}`}>
                <input type="checkbox" checked={showUnsafe} onChange={(e) => setShowUnsafe(e.target.checked)} />
                <span>Mostrar también con cambios</span>
              </label>
            </div>
            {showUnsafe && (
              <p className="f-wt-danger">
                <Warning size={14} weight="fill" aria-hidden="true" />
                <span>
                  <strong>Cuidado:</strong> los worktrees con cambios sin commitear o commits sin pushear pierden ese trabajo para siempre si se borran con «forzar». Revisá cada uno antes.
                </span>
              </p>
            )}
            <div className="f-wt-list">
              {repos?.length === 0 && <p className="hint">Ningún espacio apunta a un repo git.</p>}
              {repos?.map((r) => (
                <section key={r.repo} className="f-wt-repo">
                  <h3 className="f-wt-repo-h">
                    <span className="mono" title={r.repo}>
                      {tail(r.repo, 2)}
                    </span>
                    <span className="hint">base: {r.base ?? '—'}</span>
                  </h3>
                  {r.error && <p className="form-error">{r.error}</p>}
                  {!r.error && r.worktrees.length === 0 && <p className="hint f-wt-none">Sin worktrees aparte del principal.</p>}
                  <ul className="f-wt-rows">
                    {r.worktrees.map((w) => {
                      const can = selectable(w)
                      const on = Boolean(sel[w.path])
                      const id = `f-wt-${w.path.replace(/[^A-Za-z0-9]/g, '_')}`
                      return (
                        <li key={w.path} className={`f-wt-row ${w.safe ? 'safe' : 'unsafe'} ${on ? 'on' : ''}`}>
                          <div className="f-wt-row-main">
                            {can ? (
                              <input id={id} type="checkbox" className="f-wt-cb" checked={on} onChange={() => toggle(w)} aria-label={`Seleccionar ${w.branch ?? w.path}`} />
                            ) : (
                              <span className="f-wt-cb-space" aria-hidden="true" />
                            )}
                            <label htmlFor={can ? id : undefined} className="f-wt-row-text grow-min">
                              <span className="f-wt-branch">
                                <GitBranch size={12} aria-hidden="true" />
                                <span className="mono">{w.branch ?? 'HEAD separado'}</span>
                              </span>
                              <span className="f-wt-path mono" title={w.path}>
                                {tail(w.path, 2)}
                              </span>
                            </label>
                            <span className="f-wt-badges">
                              {w.safe ? (
                                <span className="f-wt-b ok">
                                  <CheckCircle size={11} aria-hidden="true" /> Listo
                                </span>
                              ) : (
                                <span className="f-wt-b warn">
                                  <Warning size={11} aria-hidden="true" /> No seguro
                                </span>
                              )}
                              {w.merged && (
                                <span className="f-wt-b">
                                  {w.mergedBy === 'pr' && w.pr ? `PR #${w.pr.number} mergeado` : w.sameAsBase ? 'igual a la base' : `mergeada en ${w.base}`}
                                </span>
                              )}
                              <span className="f-wt-b dim">{ago(w.lastCommitAt)}</span>
                              {w.workspaces.map((s) => (
                                <span key={s.id} className="f-wt-b wsp" title="Espacio de Sloth que lo usa: se quita al borrar">
                                  espacio: {s.name}
                                </span>
                              ))}
                            </span>
                          </div>
                          {!w.safe && w.reasons.length > 0 && (
                            <ul className="f-wt-reasons">
                              {w.reasons.map((x) => (
                                <li key={x}>{x}</li>
                              ))}
                            </ul>
                          )}
                          {on && (
                            <div className="f-wt-opts">
                              {w.branch && (
                                <label className="check">
                                  <input type="checkbox" checked={sel[w.path].deleteBranch} onChange={(e) => setOpt(w.path, 'deleteBranch', e.target.checked)} />
                                  <span>
                                    Borrar también la rama local <span className="mono">{w.branch}</span> (<span className="mono">git branch -d</span>)
                                  </span>
                                </label>
                              )}
                              {!w.safe && (
                                <>
                                  <label className="check f-wt-force">
                                    <input type="checkbox" checked={sel[w.path].force} onChange={(e) => setOpt(w.path, 'force', e.target.checked)} />
                                    <span>
                                      Forzar (<span className="mono">--force</span>): descarta los cambios sin commitear
                                    </span>
                                  </label>
                                  {w.branch && sel[w.path].deleteBranch && (
                                    <label className="check f-wt-force">
                                      <input type="checkbox" checked={sel[w.path].forceBranch} onChange={(e) => setOpt(w.path, 'forceBranch', e.target.checked)} />
                                      <span>
                                        Borrar la rama aunque no esté mergeada (<span className="mono">-D</span>): se pierden sus commits
                                      </span>
                                    </label>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )}

        {plan && (
          <div className="f-wt-plan">
            <p className="f-wt-p">Se va a hacer exactamente esto, en orden:</p>
            {unsafeSelected && (
              <p className="f-wt-danger">
                <Warning size={14} weight="fill" aria-hidden="true" />
                <span>Hay worktrees no seguros en la lista: lo que no esté commiteado y pusheado se pierde.</span>
              </p>
            )}
            <ol className="f-wt-plan-list">
              {plan.map((p) => (
                <li key={p.path}>
                  <div className="f-wt-plan-h">
                    <span className="mono">{p.path}</span>
                    {p.branch && <span className="hint"> · rama {p.branch}</span>}
                  </div>
                  {p.workspaces.map((s) => (
                    <div key={s.id} className="f-wt-plan-step">
                      Cerrar la terminal y quitar el espacio «{s.name}» de Sloth
                    </div>
                  ))}
                  {p.commands.map((c) => (
                    <pre key={c} className="f-wt-cmd mono">
                      {c}
                    </pre>
                  ))}
                </li>
              ))}
            </ol>
          </div>
        )}

        {err && <p className="form-error">{err}</p>}

        <div className="modal-actions">
          {plan ? (
            <>
              <button className="btn ghost" onClick={() => setPlan(null)} disabled={running}>
                Volver
              </button>
              <button className="btn danger" onClick={() => void run()} disabled={running}>
                {running ? <CircleNotch size={14} className="spin" aria-hidden="true" /> : <Broom size={14} aria-hidden="true" />}
                {running ? 'Borrando…' : `Borrar ${plan.length}`}
              </button>
            </>
          ) : (
            <>
              <button className="btn ghost" onClick={() => void scan()} disabled={scanning}>
                Volver a escanear
              </button>
              <span className="spacer" />
              <button className="btn ghost" onClick={close}>
                Cerrar
              </button>
              <button className="btn danger" onClick={() => void review()} disabled={selected.length === 0 || scanning}>
                <Broom size={14} aria-hidden="true" /> Borrar seleccionados{selected.length ? ` (${selected.length})` : ''}…
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const ui: FeatureUi = {
  name: 'worktrees',
  Sidebar: CleanupSection,
  Global: CleanupModal,
  commands() {
    return [
      {
        id: 'worktrees:cleanup',
        title: 'Limpiar worktrees',
        subtitle: 'Mergeados y limpios, listos para borrar',
        group: 'Git',
        keywords: 'worktree limpieza borrar ramas mergeadas',
        run() {
          setModal(true)
        }
      }
    ]
  }
}

export default ui
