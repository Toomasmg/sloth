import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUi } from '../host'
import { openDrawer } from '../git/store'
import { BranchIcon, DoneIcon, PlusIcon, SearchIcon } from '../../icons/SlothIcons'
import { Modal } from '../../Modal'
import { closeRamas, setRamasCandidates, setRamasDialog, useRamas } from './store'
import '../help/page.css'

// ---------- Tipos (los mismos que devuelve main) ----------

export interface SpaceRef {
  id: string
  name: string
  accountLabel?: string
}

export interface RowView {
  repo: string
  path: string
  branch: string | null
  isMain: boolean
  exists: boolean
  locked: boolean
  /** Archivos con cambios sin confirmar. -1 = no se pudo leer. */
  changes: number
  /** Commits sin subir. -1 = no se pudo saber. */
  ahead: number
  gone: boolean
  merged: boolean
  mergedBy?: 'git' | 'pr'
  pr?: { number: number; url: string }
  lastCommitAt?: number
  lastUseAt?: number
  spaces: SpaceRef[]
}

export interface RepoView {
  id: string
  mainPath: string
  mainBranch: string | null
  bases: string[]
  defaultBase: string | null
  error?: string
  rows: RowView[]
}

interface RemoveResult {
  path: string
  ok: boolean
  error?: string
  closedSpaces: string[]
}

/** Tamaño de una carpeta: bytes (null si ya no existe) y si es un mínimo («más de»). */
export interface SizeVal {
  bytes: number | null
  partial: boolean
}

/** Evento `feat:worktrees:size`: llega una vez por carpeta, cuando main la terminó de contar. */
interface SizeMsg extends SizeVal {
  path: string
}

// ---------- Helpers ----------

const NF0 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 })
const NF1 = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** KB / MB / GB con coma decimal: «8,0 GB», «512 MB», «340 KB». */
export function fmtBytes(b: number): string {
  const gb = b / 1024 ** 3
  if (gb >= 1) return `${NF1.format(gb)} GB`
  const mb = b / 1024 ** 2
  if (mb >= 1) return `${mb >= 100 ? NF0.format(mb) : NF1.format(mb)} MB`
  return `${NF0.format(Math.round(b / 1024))} KB`
}

/** Texto de un tamaño: «Calculando…» mientras no llegó, «más de X» si se cortó por tiempo. */
function sizeText(v: SizeVal | undefined, failed: boolean): string {
  if (!v) return failed ? '—' : 'Calculando…'
  if (v.bytes === null) return '—'
  return v.partial ? `más de ${fmtBytes(v.bytes)}` : fmtBytes(v.bytes)
}

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function ago(ms?: number): string {
  if (!ms) return '—'
  const d = (Date.now() - ms) / 1000
  if (d < 60) return 'recién'
  if (d < 3600) return `hace ${Math.round(d / 60)} min`
  if (d < 86400) return `hace ${Math.round(d / 3600)} h`
  const days = Math.round(d / 86400)
  if (days < 60) return `hace ${days} día${days === 1 ? '' : 's'}`
  return `hace ${Math.round(days / 30)} meses`
}

function shortFolder(p: string): string {
  return p.length <= 40 ? p : `${p.slice(0, 22)}…${p.slice(-16)}`
}

const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const lastSegment = (b: string | null | undefined): string => (b ?? '').split('/').pop() ?? ''

/** Carpeta que se crea al lado de la copia principal (misma regla que main). */
function folderFor(mainPath: string, name: string): string {
  const parent = mainPath.replace(/[\\/][^\\/]*$/, '')
  const base = mainPath.split(/[\\/]/).pop() ?? ''
  const seg = name.trim().replace(/[\\/]/g, '-')
  return `${parent}\\${base}-${seg || '…'}`
}

type Tone = 'ok' | 'info' | 'warn' | 'err' | 'neutral'

interface Chip {
  label: string
  tone: Tone
}

function chipsOf(r: RowView): Chip[] {
  const out: Chip[] = []
  if (!r.exists) out.push({ label: 'Carpeta no encontrada', tone: 'err' })
  if (r.gone) out.push({ label: 'Rama borrada en origin', tone: 'warn' })
  if (r.changes > 0) out.push({ label: plural(r.changes, 'cambio sin confirmar', 'cambios sin confirmar'), tone: 'info' })
  else if (r.changes < 0) out.push({ label: 'No se pudo leer el estado', tone: 'err' })
  if (r.ahead > 0) out.push({ label: plural(r.ahead, 'commit por subir', 'commits por subir'), tone: 'neutral' })
  if (out.length === 0 && r.exists) out.push({ label: 'Al día', tone: 'ok' })
  if (r.merged && !r.gone) out.push({ label: 'Ya mergeada', tone: 'neutral' })
  return out
}

/** Rama aparte que se puede limpiar: sin espacio, sin nada sin confirmar ni sin subir, y ya mergeada o borrada en origin. */
function cleanable(r: RowView): boolean {
  return !r.isMain && r.exists && !r.locked && r.spaces.length === 0 && r.changes === 0 && r.ahead === 0 && (r.merged || r.gone)
}

const TONE: Record<Tone, { bg: string; fg: string }> = {
  ok: { bg: 'var(--success-soft)', fg: 'var(--ok-fg)' },
  info: { bg: 'var(--info-soft)', fg: 'var(--info)' },
  warn: { bg: 'var(--warn-soft)', fg: 'var(--warn-fg)' },
  err: { bg: 'var(--danger-soft)', fg: 'var(--danger-fg)' },
  neutral: { bg: 'var(--surface-2)', fg: 'var(--fg-2)' }
}

// ---------- Panel ----------

export function RamasPage(): React.JSX.Element | null {
  const ui = useUi()
  const uiRef = useRef(ui)
  uiRef.current = ui
  const { open, dialog, nonce, repoPath } = useRamas()

  const [repos, setRepos] = useState<RepoView[] | null>(null)
  const [scanErr, setScanErr] = useState('')
  const [scanning, setScanning] = useState(false)
  const [q, setQ] = useState('')
  const [repoF, setRepoF] = useState('todos')
  const [soloCambios, setSoloCambios] = useState(false)
  const [sinEspacio, setSinEspacio] = useState(false)
  const [rmPath, setRmPath] = useState<string | null>(null)
  const [rmText, setRmText] = useState('')
  const [rmTried, setRmTried] = useState(false)
  const [rmErr, setRmErr] = useState('')
  const [rmBusy, setRmBusy] = useState(false)
  const [toast, setToast] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  /** Tamaños por ruta. Sin clave = todavía se calcula. */
  const [sizes, setSizes] = useState<Record<string, SizeVal>>({})
  const [sizeFailed, setSizeFailed] = useState(false)

  const say = useCallback((m: string) => {
    setToast(m)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2800)
  }, [])

  const scan = useCallback(async () => {
    setScanning(true)
    setScanErr('')
    try {
      setRepos(await uiRef.current.invoke<RepoView[]>('feat:worktrees:scan'))
    } catch (e) {
      setScanErr(errText(e))
    } finally {
      setScanning(false)
    }
  }, [])

  // Cada vez que se abre, se escanea (nada en segundo plano).
  useEffect(() => {
    if (!open) return
    setRmPath(null)
    setRmErr('')
    void scan()
    setTimeout(() => panelRef.current?.focus(), 0)
  }, [open, nonce, scan])

  // Filtro de repo inicial: una vez por apertura, cuando hay lista (el repo del espacio, o todos).
  const repoAppliedFor = useRef(-1)
  useEffect(() => {
    if (!repos || repoAppliedFor.current === nonce) return
    repoAppliedFor.current = nonce
    setRepoF(repoPath ? (repoIdOf(repos, repoPath) ?? 'todos') : 'todos')
  }, [repos, nonce, repoPath])

  // Tamaños: main los cuenta en segundo plano y avisa fila por fila. Al cerrar la pantalla se cancelan.
  useEffect(() => {
    const off = uiRef.current.on('feat:worktrees:size', (m: SizeMsg) => {
      setSizes((s) => ({ ...s, [m.path]: { bytes: m.bytes, partial: m.partial } }))
    })
    return () => {
      off()
      void uiRef.current.invoke('feat:worktrees:sizesCancel').catch(() => undefined)
    }
  }, [])

  // Después de cada lista: lo que ya está en caché llega enseguida; el resto llega por evento.
  useEffect(() => {
    if (!repos) return
    let alive = true
    setSizeFailed(false)
    const paths = repos.flatMap((r) => r.rows.map((x) => x.path))
    void uiRef.current
      .invoke<Record<string, { bytes: number; partial: boolean }>>('feat:worktrees:sizes', paths)
      .then((res) => {
        if (!alive) return
        setSizes((s) => {
          const next = { ...s }
          for (const [p, v] of Object.entries(res)) next[p] = { bytes: v.bytes, partial: v.partial }
          return next
        })
      })
      .catch(() => {
        if (alive) setSizeFailed(true)
      })
    return () => {
      alive = false
    }
  }, [repos])

  // Escape: primero cierra el diálogo o la confirmación; después el panel.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      // Con un diálogo abierto, el Esc es del Modal.
      if (e.key !== 'Escape' || rmBusy || dialog) return
      e.preventDefault()
      e.stopPropagation()
      if (rmPath) {
        setRmPath(null)
        setRmText('')
        setRmTried(false)
        setRmErr('')
      } else closeRamas()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, dialog, rmPath, rmBusy])

  const allRows = useMemo(() => repos?.flatMap((r) => r.rows) ?? [], [repos])
  const branchRows = useMemo(() => allRows.filter((r) => !r.isMain), [allRows])
  const cleanCount = useMemo(() => branchRows.filter(cleanable).length, [branchRows])

  // El número del badge de la barra lateral sale de este escaneo (queda guardado al cerrar el panel).
  useEffect(() => {
    if (repos) setRamasCandidates(cleanCount)
  }, [repos, cleanCount])

  const qn = norm(q.trim())
  const passes = (repo: RepoView, r: RowView): boolean =>
    (repoF === 'todos' || repoF === repo.id) &&
    (!qn || norm([repo.id, r.branch ?? '', r.path, ...r.spaces.map((s) => s.name)].join(' ')).includes(qn)) &&
    (!soloCambios || r.changes > 0) &&
    (!sinEspacio || r.spaces.length === 0)

  const groups = useMemo(
    () =>
      (repos ?? [])
        .filter((repo) => repoF === 'todos' || repoF === repo.id)
        .map((repo) => ({ repo, rows: repo.rows.filter((r) => passes(repo, r)) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repos, repoF, qn, soloCambios, sinEspacio]
  )
  const shownCount = groups.reduce((a, g) => a + g.rows.length, 0)
  const nCambios = branchRows.filter((r) => r.changes > 0).length
  // Total en disco: solo las ramas aparte (como el artboard), no la copia principal.
  const sizeMissing = !repos || branchRows.some((r) => !(r.path in sizes))
  const totalBytes = branchRows.reduce((a, r) => a + (sizes[r.path]?.bytes ?? 0), 0)
  const totalPartial = branchRows.some((r) => sizes[r.path]?.partial)
  const totalText = !sizeMissing ? `${totalPartial ? 'más de' : '≈'} ${fmtBytes(totalBytes)}` : sizeFailed ? '—' : 'Calculando…'

  const askRemove = (r: RowView): void => {
    setRmPath(r.path)
    setRmText('')
    setRmTried(false)
    setRmErr('')
    setTimeout(() => document.getElementById(r.changes > 0 ? 'f-wt-rm-in' : 'f-wt-rm-ok')?.focus(), 0)
  }

  const doRemove = async (r: RowView): Promise<void> => {
    const hasCh = r.changes > 0
    if (hasCh && rmText.trim() !== r.branch) {
      setRmTried(true)
      document.getElementById('f-wt-rm-in')?.focus()
      return
    }
    setRmBusy(true)
    setRmErr('')
    try {
      const res = await uiRef.current.invoke<RemoveResult>('feat:worktrees:remove', { path: r.path, force: hasCh })
      if (!res.ok) {
        setRmErr(res.error ?? 'No se pudo quitar.')
        return
      }
      setRmPath(null)
      setRmText('')
      setRmTried(false)
      say(`Rama aparte quitada: ${r.branch ?? r.path}${res.closedSpaces.length ? `. Se cerró el espacio «${res.closedSpaces.join(', ')}»` : ''}`)
      await scan()
    } catch (e) {
      setRmErr(errText(e))
    } finally {
      setRmBusy(false)
    }
  }

  const openSpace = (r: RowView): void => {
    const sp = r.spaces[0]
    if (!sp) return
    uiRef.current.openPane(sp.id)
    closeRamas()
  }

  const newSpaceHere = (r: RowView): void => {
    uiRef.current.openNewWorkspace('normal', { repoPath: r.path, name: lastSegment(r.branch) || undefined })
    closeRamas()
  }

  const openFolder = async (r: RowView): Promise<void> => {
    try {
      const err = await uiRef.current.invoke<string>('feat:worktrees:openFolder', r.path)
      if (err) say(`No se pudo abrir la carpeta: ${err}`)
    } catch (e) {
      say(errText(e))
    }
  }

  const viewChanges = (r: RowView): void => {
    const sp = r.spaces[0]
    if (!sp) return
    uiRef.current.openPane(sp.id)
    openDrawer(sp.id)
    closeRamas()
  }

  if (!open) return null

  const candidates = branchRows.filter(cleanable)

  return (
    <div ref={panelRef} className="page-shell f-wt-shell" role="dialog" aria-modal="true" aria-labelledby="f-wt-h" tabIndex={-1}>
      <header className="page-head">
        <button ref={backRef} type="button" className="page-back" onClick={closeRamas} disabled={rmBusy}>
          ‹ Espacios
        </button>
        <span className="page-sep" aria-hidden="true" />
        <span className="page-name">Sloth · ramas aparte</span>
      </header>

      <div className="page-body f-wt-body">
        <div className="f-wt-inner">
          <header className="f-wt-head">
            <div className="f-wt-head-text">
              <h1 id="f-wt-h">Ramas aparte</h1>
              <p className="f-wt-sub">Una rama aparte es una copia de trabajo del mismo repo en otra carpeta, para que dos Claude no se pisen.</p>
            </div>
            <div className="f-wt-head-actions">
              <button type="button" className="f-wt-btn lg solid" onClick={() => setRamasDialog('limpiar')}>
                Limpiar ramas que ya no se usan
              </button>
              <button type="button" className="f-wt-btn lg primary" onClick={() => setRamasDialog('nueva')} disabled={scanning || !repos?.length} title={scanning ? 'Esperá a que termine el escaneo' : !repos?.length ? 'Hace falta un espacio con un repo git' : undefined}>
                <PlusIcon size={14} /> Nueva rama aparte
              </button>
            </div>
          </header>

          <div className="f-wt-tiles" role="group" aria-label="Resumen">
            <div className="f-wt-tile">
              <span className="f-wt-tile-n">{branchRows.length}</span>
              <span className="f-wt-tile-l">ramas aparte</span>
            </div>
            <div className="f-wt-tile">
              <span className="f-wt-tile-n">{nCambios}</span>
              <span className="f-wt-tile-l">con cambios sin confirmar</span>
            </div>
            <div className="f-wt-tile">
              <span className="f-wt-tile-n">{totalText}</span>
              <span className="f-wt-tile-l">de espacio en disco, aprox.</span>
            </div>
          </div>

          <div className="f-wt-filters" role="search">
            <label className="f-wt-search">
              <SearchIcon size={14} />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar rama, carpeta o espacio" aria-label="Buscar rama, carpeta o espacio" />
            </label>
            <select className="f-wt-select" value={repoF} onChange={(e) => setRepoF(e.target.value)} aria-label="Filtrar por repositorio">
              <option value="todos">Todos los repos</option>
              {(repos ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}
                </option>
              ))}
            </select>
            <button type="button" className={`f-wt-pill ${soloCambios ? 'on' : ''}`} aria-pressed={soloCambios} onClick={() => setSoloCambios((v) => !v)}>
              Solo con cambios
            </button>
            <button type="button" className={`f-wt-pill ${sinEspacio ? 'on' : ''}`} aria-pressed={sinEspacio} onClick={() => setSinEspacio((v) => !v)}>
              Sin espacio
            </button>
            <span className="f-wt-result">{repos ? `Mostrando ${shownCount} de ${allRows.length} (incluye las copias principales)` : scanning ? 'Escaneando…' : ''}</span>
          </div>

          {scanErr && <p className="form-error" role="alert">{scanErr}</p>}
          {repos?.length === 0 && !scanErr && (
            <p className="hint f-wt-empty">
              Ningún espacio apunta a un repo git. Abrí un espacio con un repo para ver sus ramas aparte.{' '}
              <button
                type="button"
                className="f-wt-btn lg solid"
                onClick={() => {
                  closeRamas()
                  ui.openNewWorkspace('normal')
                }}
              >
                Nuevo espacio
              </button>
            </p>
          )}

          {groups.map(({ repo, rows }) => (
            <section key={repo.id} className="f-wt-group" aria-labelledby={`f-wt-g-${repo.id}`}>
              <header className="f-wt-group-head">
                <span className="f-wt-group-icon" aria-hidden="true">
                  <BranchIcon size={14} />
                </span>
                <h2 id={`f-wt-g-${repo.id}`} className="mono">{repo.id}</h2>
                <span className="f-wt-group-count">{plural(repo.rows.filter((r) => !r.isMain).length, 'rama aparte', 'ramas aparte')}</span>
              </header>
              {repo.error && <p className="form-error f-wt-pad">{repo.error}</p>}
              <div className="f-wt-row f-wt-cols" aria-hidden="true">
                <span>Rama</span>
                <span>Carpeta</span>
                <span>Espacio</span>
                <span>Estado</span>
                <span>Último uso</span>
                <span className="f-wt-cols-end">Acciones</span>
              </div>
              {rows.length === 0 && <p className="f-wt-empty-group">Nada coincide con los filtros.</p>}
              {rows.map((r, i) => {
                const removing = rmPath === r.path
                const hasCh = r.changes > 0
                const typedOk = rmText.trim() === r.branch
                const rowKey = r.path
                const sp = r.spaces[0]
                return (
                  <div key={rowKey} role="group" aria-label={`Rama ${r.branch ?? r.path}${r.isMain ? ' (copia principal)' : ''}`} className={`f-wt-row ${i > 0 ? 'sep' : ''}`}>
                    <div className="f-wt-cell f-wt-cell-branch">
                      <span className="f-wt-branch mono">{r.branch ?? 'HEAD separado'}</span>
                      {r.isMain && <span className="f-wt-tag">Copia principal</span>}
                    </div>
                    <div className="f-wt-cell f-wt-folder mono" title={r.path}>
                      {shortFolder(r.path)}
                    </div>
                    <div className="f-wt-cell f-wt-space">
                      {sp ? (
                        <>
                          <span className="f-wt-space-name">{sp.name}</span>
                          {sp.accountLabel && <span className="f-wt-space-acc">{sp.accountLabel}</span>}
                        </>
                      ) : (
                        <span className="f-wt-muted">Sin espacio</span>
                      )}
                    </div>
                    <div className="f-wt-cell f-wt-chips">
                      {chipsOf(r).map((c) => (
                        <span key={c.label} className="f-wt-chip" style={{ background: TONE[c.tone].bg, color: TONE[c.tone].fg }}>
                          {c.label}
                        </span>
                      ))}
                    </div>
                    <div className="f-wt-cell f-wt-last">
                      <span>{ago(r.lastUseAt ?? r.lastCommitAt)}</span>
                      <span className="f-wt-size" title="Tamaño en disco de la carpeta">
                        {sizeText(sizes[r.path], sizeFailed)}
                      </span>
                    </div>
                    <div className="f-wt-actions">
                      {sp ? (
                        <button type="button" className="f-wt-btn solid" onClick={() => openSpace(r)}>
                          Abrir espacio
                        </button>
                      ) : (
                        <button type="button" className="f-wt-btn solid" onClick={() => newSpaceHere(r)}>
                          Abrir un espacio
                        </button>
                      )}
                      <button type="button" className="f-wt-btn ring" onClick={() => void openFolder(r)} aria-label={`Abrir carpeta de ${r.branch ?? r.path}`}>
                        Abrir carpeta
                      </button>
                      <button
                        type="button"
                        className="f-wt-btn plain"
                        onClick={() => viewChanges(r)}
                        disabled={!sp}
                        title={sp ? 'Ver los cambios en el panel Git' : 'Abrí un espacio para ver sus cambios'}
                      >
                        Ver cambios
                      </button>
                      {!r.isMain && !removing && (
                        <button type="button" className="f-wt-btn plain f-wt-remove" onClick={() => askRemove(r)} aria-label={`Quitar la rama aparte ${r.branch ?? r.path}`}>
                          Quitar
                        </button>
                      )}
                    </div>

                    {removing && (
                      <div role="alertdialog" aria-label={`Confirmar quitar ${r.branch ?? r.path}`} className={`f-wt-confirm ${hasCh ? 'danger' : ''}`}>
                        {hasCh ? (
                          <>
                            <p className="f-wt-confirm-text">
                              Tiene {plural(r.changes, 'cambio', 'cambios')} sin confirmar. Si la quitás, se pierden: la carpeta se borra con esos archivos.
                            </p>
                            <label className="f-wt-confirm-field">
                              <span className="hint">
                                Para confirmar, escribí el nombre de la rama: <span className="mono">{r.branch}</span>
                              </span>
                              <input
                                id="f-wt-rm-in"
                                type="text"
                                className="f-wt-input mono"
                                autoComplete="off"
                                spellCheck={false}
                                value={rmText}
                                onChange={(e) => {
                                  setRmText(e.target.value)
                                  setRmErr('')
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault()
                                    void doRemove(r)
                                  }
                                }}
                                placeholder="Nombre de la rama"
                                aria-invalid={rmTried && !typedOk}
                                aria-describedby="f-wt-rm-err"
                              />
                            </label>
                            {rmTried && !typedOk && <p id="f-wt-rm-err" role="alert" className="f-wt-err">Escribí exactamente «{r.branch}» para confirmar.</p>}
                          </>
                        ) : (
                          <p className="f-wt-confirm-text">¿Quitar la rama aparte «{r.branch}»? La carpeta se borra; la rama queda en el repo.</p>
                        )}
                        {sp && <p className="hint">Se cierra el espacio «{sp.name}».</p>}
                        {rmErr && (
                          <p role="alert" className="f-wt-err">
                            {rmErr}
                          </p>
                        )}
                        <div className="f-wt-confirm-actions">
                          <button id="f-wt-rm-ok" type="button" className="f-wt-btn lg danger" onClick={() => void doRemove(r)} disabled={rmBusy}>
                            {hasCh ? 'Quitar y perder cambios' : 'Quitar'}
                          </button>
                          <button type="button" className="f-wt-btn lg plain" onClick={() => { setRmPath(null); setRmErr('') }} disabled={rmBusy}>
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </section>
          ))}

          {repos && shownCount === 0 && repos.length > 0 && (
            <p className="f-wt-empty">Ninguna rama aparte coincide con los filtros.</p>
          )}

          <p className="f-wt-foot">Cada rama aparte vive en su propia carpeta, al lado de la copia principal. Quitarla borra esa carpeta; la rama queda en el repo.</p>
        </div>
      </div>

        {dialog === 'nueva' && repos && (
          <NuevaDialog
            repos={repos}
            onDone={async (msg) => {
              setRamasDialog(null)
              say(msg)
              await scan()
            }}
            onClose={() => setRamasDialog(null)}
          />
        )}
        {dialog === 'limpiar' && (
          <LimpiarDialog
            candidates={candidates}
            repos={repos ?? []}
            loading={!repos && !scanErr}
            scanErr={repos ? '' : scanErr}
            sizes={sizes}
            sizeFailed={sizeFailed}
            onDone={async (msg) => {
              setRamasDialog(null)
              say(msg)
              await scan()
            }}
            onClose={() => setRamasDialog(null)}
          />
        )}

        {toast && (
          <div role="status" className="f-wt-toast">
            <DoneIcon size={14} /> {toast}
          </div>
        )}
    </div>
  )
}

// ---------- Nueva rama aparte ----------

/** Id del repo al que pertenece una carpeta (la copia principal o una rama aparte). */
function repoIdOf(repos: RepoView[], path: string): string | undefined {
  const normPath = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()
  const want = normPath(path)
  return repos.find((r) => normPath(r.mainPath) === want || r.rows.some((x) => normPath(x.path) === want))?.id
}

/** Mismas reglas y textos que el diseño (Ramas.dc.html › branchErr). */
function branchError(b: string, repo: RepoView | undefined, repos: RepoView[]): string {
  if (!b) return 'Poné un nombre para la rama.'
  if (/\s/.test(b)) return 'Sin espacios: usá guiones o barras (feat/mi-cambio).'
  if (!/^[A-Za-z0-9._/-]+$/.test(b) || b.includes('..') || /^[/.-]/.test(b) || /[/.]$/.test(b) || b.endsWith('.lock'))
    return 'Esa rama no es válida. Usá letras, números, guiones, puntos o barras.'
  if (repo && b === repo.mainBranch) return 'Esa es la copia principal del repo. Elegí otro nombre.'
  if (repo && repos.some((x) => x.id === repo.id && x.rows.some((r) => !r.isMain && r.branch === b)))
    return 'Ya hay una rama aparte con ese nombre en este repo.'
  return ''
}

function NuevaDialog({ repos, onDone, onClose }: { repos: RepoView[]; onDone: (msg: string) => Promise<void> | void; onClose: () => void }): React.JSX.Element {
  const ui = useUi()
  const [repoPath, setRepoPath] = useState(repos[0]?.mainPath ?? '')
  const repo = repos.find((r) => r.mainPath === repoPath) ?? repos[0]
  const [base, setBase] = useState<string | null>(null)
  const effBase = repo && repo.bases.includes(base ?? '') ? (base as string) : (repo?.defaultBase ?? repo?.bases[0] ?? '')
  const [name, setName] = useState('')
  const [tried, setTried] = useState(false)
  const [err, setErr] = useState('')
  const [openSpace, setOpenSpace] = useState(false)
  const accounts = useMemo(() => [...ui.accounts].sort((a, b) => a.label.localeCompare(b.label, 'es')), [ui.accounts])
  const [accId, setAccId] = useState(accounts[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const localErr = branchError(name.trim(), repo, repos)
  const shownErr = tried ? localErr || err : err
  const folder = repo ? folderFor(repo.mainPath, name) : ''

  const submit = async (e: { preventDefault(): void }): Promise<void> => {
    e.preventDefault()
    if (busy) return
    setTried(true)
    setErr('')
    if (localErr || !repo) {
      inputRef.current?.focus()
      return
    }
    if (openSpace && !accId) {
      setErr('Elegí una cuenta para el espacio.')
      return
    }
    setBusy(true)
    try {
      await ui.invoke('feat:worktrees:create', { repoPath: repo.mainPath, name: name.trim(), base: effBase, openSpace, accountId: openSpace ? accId : undefined })
      await onDone(`Rama aparte creada: ${name.trim()} (desde ${effBase})`)
    } catch (e2) {
      setErr(errText(e2))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal className="f-wt-dialog" title="Nueva rama aparte" dirty={name.trim() !== ''} locked={busy} onClose={onClose} onSubmit={(e) => void submit(e)}>
        <div className="f-wt-form">
          <label className="f-wt-field">
            <span>Repositorio</span>
            <select className="f-wt-select" value={repo?.mainPath ?? ''} onChange={(e) => { setRepoPath(e.target.value); setBase(null) }}>
              {repos.map((r) => (
                <option key={r.mainPath} value={r.mainPath}>
                  {r.id}
                </option>
              ))}
            </select>
          </label>

          <label className="f-wt-field">
            <span>Nombre de la rama</span>
            <input
              ref={inputRef}
              type="text"
              className="f-wt-input mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="feat/mi-cambio"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setTried(false)
                setErr('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void submit(e)
                }
              }}
              aria-invalid={Boolean(shownErr)}
              aria-describedby="f-wt-nr-err"
            />
          </label>
          {shownErr && (
            <p id="f-wt-nr-err" role="alert" className="f-wt-err">
              {shownErr}
            </p>
          )}

          <label className="f-wt-field">
            <span>Rama base (de donde sale)</span>
            <select className="f-wt-select" value={effBase} onChange={(e) => setBase(e.target.value)}>
              {(repo?.bases ?? []).map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>

          <div className="f-wt-field">
            <span>Carpeta destino (automática)</span>
            <span className="f-wt-folder-box mono">{folder}</span>
            <span className="hint">Se crea sola al lado de la copia principal.</span>
          </div>

          <label className="f-wt-check">
            <input type="checkbox" checked={openSpace} onChange={(e) => setOpenSpace(e.target.checked)} />
            <span>Abrir un espacio con ella</span>
          </label>
          {openSpace && (
            <label className="f-wt-field">
              <span>Cuenta de Claude para ese espacio</span>
              <select className="f-wt-select" value={accId} onChange={(e) => setAccId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          {err && !tried && <p role="alert" className="f-wt-err">{err}</p>}

          <div className="f-wt-form-actions">
            <button type="button" className="f-wt-btn lg plain" onClick={onClose} disabled={busy}>
              Cancelar
            </button>
            <button type="submit" className="f-wt-btn lg primary" disabled={busy}>
              {busy ? 'Creando…' : 'Crear rama aparte'}
            </button>
          </div>
        </div>
    </Modal>
  )
}

// ---------- Limpiar ramas que ya no se usan ----------

function LimpiarDialog({
  candidates,
  repos,
  loading,
  scanErr,
  sizes,
  sizeFailed,
  onDone,
  onClose
}: {
  candidates: RowView[]
  repos: RepoView[]
  /** Todavía no llegó el escaneo: el diálogo se abre igual y espera. */
  loading: boolean
  /** Si el escaneo falló y no hay datos. */
  scanErr: string
  sizes: Record<string, SizeVal>
  sizeFailed: boolean
  onDone: (msg: string) => Promise<void> | void
  onClose: () => void
}): React.JSX.Element {
  const ui = useUi()
  const [sel, setSel] = useState<Record<string, boolean>>({})
  const [failed, setFailed] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const on = (p: string): boolean => sel[p] !== false
  const chosen = candidates.filter((c) => on(c.path))
  // Espacio que se libera: suma de lo ya contado de las elegidas.
  const freedOf = (list: RowView[]): number => list.reduce((a, c) => a + (sizes[c.path]?.bytes ?? 0), 0)
  const chosenPending = chosen.some((c) => !(c.path in sizes)) && !sizeFailed
  const chosenPartial = chosen.some((c) => sizes[c.path]?.partial)
  const freeLabel = chosenPending
    ? 'Calculando cuánto se libera…'
    : `Se liberan ${chosenPartial ? 'más de ' : '≈ '}${fmtBytes(freedOf(chosen))}. Las ramas quedan en el repo; solo se borran sus carpetas.`
  const reasonOf = (c: RowView): string => {
    if (c.gone) return 'Borrada en origin'
    const base = repos.find((r) => r.id === c.repo)?.defaultBase
    return `Ya mergeada${base ? ` en ${base}` : ''}`
  }

  const listed = loading ? null : candidates.length > 0 ? (
    <div role="group" aria-label="Ramas para quitar" className="f-wt-list">
      {candidates.map((c, i) => (
        <label key={c.path} className={`f-wt-pick ${i > 0 ? 'sep' : ''}`}>
          <input type="checkbox" checked={on(c.path)} onChange={() => setSel((s) => ({ ...s, [c.path]: !on(c.path) }))} aria-label={`Quitar ${c.branch ?? c.path}`} />
          <span className="f-wt-pick-text">
            <span className="mono">{c.branch}</span>
            <span className="f-wt-reason" title={c.path}>
              {reasonOf(c)} · {shortFolder(c.path)}
            </span>
            {failed[c.path] && <span className="f-wt-err">{failed[c.path]}</span>}
          </span>
          <span className="f-wt-pick-size">{sizeText(sizes[c.path], sizeFailed)}</span>
        </label>
      ))}
    </div>
  ) : (
    <p className="f-wt-none">
      {scanErr ? 'No se pudo revisar las ramas. Cerrá esta ventana y probá de nuevo.' : 'No hay ramas para limpiar. Todas tienen espacio, cambios o commits sin subir.'}
    </p>
  )
  const confirm = async (): Promise<void> => {
    if (busy) return
    if (chosen.length === 0) {
      setErr('Marcá al menos una rama para quitar.')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const res = await ui.invoke<RemoveResult[]>('feat:worktrees:clean', chosen.map((c) => c.path))
      const okRows = candidates.filter((c) => res.some((r) => r.ok && r.path === c.path))
      const ok = okRows.length
      const freed = ok ? ` · se liberan ≈ ${fmtBytes(freedOf(okRows))}` : ''
      const bad = Object.fromEntries(res.filter((r) => !r.ok).map((r) => [r.path, r.error ?? 'No se pudo quitar.']))
      if (Object.keys(bad).length === 0) {
        await onDone(`${plural(ok, 'rama aparte quitada', 'ramas aparte quitadas')}${freed}`)
      } else {
        setFailed(bad)
        setSel({})
        await onDone(`${plural(ok, 'rama aparte quitada', 'ramas aparte quitadas')}${freed}. ${Object.keys(bad).length} no se pudieron quitar.`)
      }
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal className="f-wt-dialog wide" title="Limpiar ramas que ya no se usan" locked={busy} onClose={onClose}>
        <div className="f-wt-form">
          <p className="f-wt-lead">
            Estas ramas aparte no tienen espacio, no tienen cambios ni commits sin subir, y ya están mergeadas o borradas en origin. Destildá las que quieras conservar.
          </p>

          {loading ? (
            <p role="status" className="f-wt-none">
              Revisando las ramas…
            </p>
          ) : (
            listed
          )}

          {err && (
            <p role="alert" className="f-wt-err">
              {err}
            </p>
          )}

          <div className="f-wt-form-actions">
            <span className="f-wt-grow">{!loading && chosen.length ? `${freeLabel}` : ''}</span>
            <button type="button" className="f-wt-btn lg plain" onClick={onClose} disabled={busy}>
              {loading || candidates.length ? 'Cancelar' : 'Cerrar'}
            </button>
            {!loading && candidates.length > 0 && (
              <button type="button" className="f-wt-btn lg danger" onClick={() => void confirm()} disabled={busy}>
                {busy ? 'Quitando…' : chosen.length ? `Quitar ${plural(chosen.length, 'rama', 'ramas')}` : 'Quitar ramas'}
              </button>
            )}
          </div>
        </div>
    </Modal>
  )
}
