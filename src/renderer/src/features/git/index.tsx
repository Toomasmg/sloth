import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowClockwise,
  ArrowSquareOut,
  CheckCircle,
  CircleNotch,
  CloudArrowUp,
  GitBranch,
  GitCommit,
  GitDiff,
  GitPullRequest,
  Warning,
  X
} from '@phosphor-icons/react'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
import { isLoginPane } from '../../../../shared/types'
import { useDocumentVisible } from '../../visibility'
import { closeDrawer, onRefresh, openDrawer, requestRefresh, useDrawer } from './store'
import './git.css'

// ---------- Tipos (los mismos que devuelve main) ----------
type FileCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | 'T' | '??'
interface FileChange {
  path: string
  orig?: string
  code: FileCode
  xy: string
  add?: number
  del?: number
  binary?: boolean
  huge?: boolean
}
interface StatusRes {
  isRepo: boolean
  top?: string
  branch?: string | null
  files: FileChange[]
  truncated?: boolean
  base: string | null
  protected: boolean
}
interface DiffLine {
  t: string
  s: string
  o?: number
  n?: number
}
interface DiffRes {
  kind: 'text' | 'binary' | 'huge' | 'empty' | 'missing'
  lines: DiffLine[]
  truncated: boolean
  size?: number
}
interface Commit {
  sha: string
  subject: string
}
interface PushPreview {
  branch: string | null
  protected: boolean
  remote: string | null
  upstream: string | null
  commits: Commit[]
  command: string | null
}
interface PrRef {
  url: string
  number: number
  state: string
  title: string
}
interface PrPrep {
  branch: string | null
  base: string | null
  protected: boolean
  pushed: boolean
  upstream: string | null
  unpushed: number
  commits: Commit[]
  existing: PrRef | null
  ghError: string | null
  template: { path: string; body: string } | null
  defaultTitle: string
}

const PAGE = 2000
const PROTECTED = ['main', 'master', 'staging']

const CODE_LABEL: Record<FileCode, string> = {
  M: 'Modificado',
  A: 'Agregado',
  D: 'Borrado',
  R: 'Renombrado',
  C: 'Copiado',
  U: 'En conflicto',
  T: 'Cambio de tipo',
  '??': 'Sin trackear'
}

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function fmtSize(n?: number): string {
  if (n === undefined) return ''
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(n / 1024)} KB`
}

// ---------- Botón del header ----------

function ChangesButton({ paneId }: { paneId: string }): React.JSX.Element | null {
  const ui = useUi()
  const ws = isLoginPane(paneId) ? undefined : ui.workspaces.find((w) => w.id === paneId)
  const wsId = ws?.id
  const [count, setCount] = useState<number | null>(null)
  const visible = useDocumentVisible()
  const pending = useRef(false)

  const refresh = useCallback(() => {
    if (!wsId || pending.current) return
    pending.current = true
    ui.invoke<number | null>('feat:git:count', wsId)
      .then((n) => setCount(typeof n === 'number' ? n : null))
      .catch(() => setCount(null))
      .finally(() => (pending.current = false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId])

  // Al abrir el panel y cada vez que la ventana vuelve a verse.
  useEffect(() => {
    if (visible) refresh()
  }, [visible, refresh])

  // Cuando Claude termina un turno en este espacio (hook Stop) o después de un commit.
  useEffect(() => {
    if (!wsId) return
    let t: ReturnType<typeof setTimeout> | undefined
    const later = (id: string): void => {
      if (id !== wsId) return
      clearTimeout(t)
      t = setTimeout(() => {
        if (document.visibilityState === 'visible') refresh()
      }, 400)
    }
    const off1 = ui.on('feat:git:changed', later)
    const off2 = onRefresh(later)
    return () => {
      clearTimeout(t)
      off1()
      off2()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, refresh])

  if (!ws || count === null) return null
  const label = count === 0 ? 'Cambios: sin archivos modificados' : `Cambios: ${count} archivo${count === 1 ? '' : 's'} modificado${count === 1 ? '' : 's'}`
  return (
    <button className={`f-git-btn ${count > 0 ? 'has' : ''}`} onClick={() => openDrawer(ws.id)} aria-label={label} title={label}>
      <GitDiff size={14} aria-hidden="true" />
      <span className="f-git-btn-label">Cambios</span>
      <span className="f-git-btn-n mono">{count}</span>
    </button>
  )
}

// ---------- Diff ----------

function DiffView({ wsId, file, onError }: { wsId: string; file: FileChange; onError: (m: string) => void }): React.JSX.Element {
  const ui = useUi()
  const [limit, setLimit] = useState(PAGE)
  const [res, setRes] = useState<DiffRes | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLimit(PAGE)
    setRes(null)
  }, [file.path])

  useEffect(() => {
    let alive = true
    setLoading(true)
    ui.invoke<DiffRes>('feat:git:diff', wsId, file.path, limit)
      .then((r) => alive && setRes(r))
      .catch((e) => alive && onError(errText(e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, file.path, limit])

  if (!res) return <div className="f-git-diff-msg">{loading ? 'Cargando diff…' : ''}</div>
  if (res.kind === 'binary')
    return (
      <div className="f-git-diff-msg">
        <Warning size={14} aria-hidden="true" /> Archivo binario{res.size ? ` (${fmtSize(res.size)})` : ''}: no se muestra el diff.
      </div>
    )
  if (res.kind === 'huge')
    return (
      <div className="f-git-diff-msg">
        <Warning size={14} aria-hidden="true" /> Archivo enorme ({fmtSize(res.size)}): no se muestra el diff. Abrilo con tu editor.
      </div>
    )
  if (res.kind === 'empty') return <div className="f-git-diff-msg">Sin diferencias de contenido (archivo vacío o solo cambió el modo).</div>
  if (res.kind === 'missing') return <div className="f-git-diff-msg">El archivo ya no existe.</div>
  return (
    <div className="f-git-diff" role="region" aria-label={`Diff de ${file.path}`} tabIndex={0}>
      {res.lines.map((l, i) => (
        <div key={i} className={`f-git-l f-git-l-${l.t === '+' ? 'add' : l.t === '-' ? 'del' : l.t === '@' ? 'hunk' : l.t === 'h' ? 'head' : 'ctx'}`}>
          <span className="f-git-ln">{l.o ?? ''}</span>
          <span className="f-git-ln">{l.n ?? ''}</span>
          <span className="f-git-sign" aria-hidden="true">
            {l.t === '+' || l.t === '-' ? l.t : ''}
          </span>
          <span className="f-git-txt">{l.s || ' '}</span>
        </div>
      ))}
      {res.truncated && (
        <div className="f-git-more">
          <span className="hint">Mostrando {res.lines.length} líneas.</span>
          <button className="btn sm" onClick={() => setLimit((n) => n + PAGE)} disabled={loading}>
            {loading ? 'Cargando…' : `Ver ${PAGE} más`}
          </button>
        </div>
      )}
    </div>
  )
}

// ---------- Confirmación de push ----------

function PushConfirm({ wsId, onClose, onDone }: { wsId: string; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const ui = useUi()
  const [prev, setPrev] = useState<PushPreview | null>(null)
  const [err, setErr] = useState('')
  const [running, setRunning] = useState(false)
  const [ok, setOk] = useState(false)

  useEffect(() => {
    ui.invoke<PushPreview>('feat:git:pushPreview', wsId).then(setPrev, (e) => setErr(errText(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId])

  const go = async (): Promise<void> => {
    if (!prev?.branch) return
    setRunning(true)
    setErr('')
    try {
      await ui.invoke('feat:git:push', wsId, prev.branch)
      setOk(true)
      onDone()
    } catch (e) {
      setErr(errText(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <SubDialog title="Confirmar push" icon={<CloudArrowUp size={16} aria-hidden="true" />} onClose={onClose}>
      {!prev && !err && <p className="hint">Revisando…</p>}
      {prev && (
        <>
          {prev.protected ? (
            <p className="form-error">
              <Warning size={13} aria-hidden="true" /> No se pushea directo a {prev.branch ?? 'un HEAD separado'} desde Sloth.
            </p>
          ) : (
            <>
              <p className="f-git-p">Se va a correr exactamente:</p>
              <pre className="f-git-cmd mono">{prev.command}</pre>
              <dl className="f-git-dl">
                <dt>Remoto</dt>
                <dd className="mono">{prev.remote ?? 'sin «origin»'}</dd>
                <dt>Upstream</dt>
                <dd className="mono">{prev.upstream ?? `se crea origin/${prev.branch}`}</dd>
              </dl>
              <p className="f-git-p">
                {prev.commits.length === 0 ? 'No hay commits nuevos para mandar.' : `Commits que se mandan (${prev.commits.length}${prev.commits.length >= 100 ? '+' : ''}):`}
              </p>
              {prev.commits.length > 0 && (
                <ul className="f-git-commits">
                  {prev.commits.map((c) => (
                    <li key={c.sha}>
                      <span className="mono">{c.sha}</span> {c.subject}
                    </li>
                  ))}
                </ul>
              )}
              <p className="hint">Nunca se usa --force. Si el remoto tiene commits que no tenés, el push se rechaza.</p>
            </>
          )}
        </>
      )}
      {err && <p className="form-error">{err}</p>}
      {ok && (
        <p className="f-git-ok">
          <CheckCircle size={14} aria-hidden="true" /> Push hecho.
        </p>
      )}
      <div className="f-git-sub-actions">
        <button className="btn ghost" onClick={onClose}>
          {ok ? 'Cerrar' : 'Cancelar'}
        </button>
        {!ok && (
          <button className="btn primary" onClick={() => void go()} disabled={!prev || prev.protected || !prev.remote || running}>
            {running ? <CircleNotch size={14} className="spin" aria-hidden="true" /> : <CloudArrowUp size={14} aria-hidden="true" />}
            {running ? 'Pusheando…' : 'Pushear'}
          </button>
        )}
      </div>
    </SubDialog>
  )
}

// ---------- PR ----------

function PrPanel({ wsId, base, onClose, onPush }: { wsId: string; base: string | null; onClose: () => void; onPush: () => void }): React.JSX.Element {
  const ui = useUi()
  const [prep, setPrep] = useState<PrPrep | null>(null)
  const [err, setErr] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [prBase, setPrBase] = useState(base ?? '')
  const [step, setStep] = useState<'form' | 'confirm' | 'done'>('form')
  const [cmd, setCmd] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [url, setUrl] = useState('')

  const load = useCallback(() => {
    setErr('')
    ui.invoke<PrPrep>('feat:git:prPrepare', wsId, base ?? undefined).then(
      (p) => {
        setPrep(p)
        setTitle((t) => t || p.defaultTitle)
        setBody((b) => b || p.template?.body || '')
        setPrBase((b) => b || p.base || '')
      },
      (e) => setErr(errText(e))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, base])
  useEffect(load, [load])

  const input = { base: prBase.trim(), head: prep?.branch ?? '', title: title.trim(), body }

  const review = async (): Promise<void> => {
    setErr('')
    try {
      setCmd(await ui.invoke<string[]>('feat:git:prCommand', input))
      setStep('confirm')
    } catch (e) {
      setErr(errText(e))
    }
  }
  const create = async (): Promise<void> => {
    setRunning(true)
    setErr('')
    try {
      setUrl(await ui.invoke<string>('feat:git:createPr', wsId, input))
      setStep('done')
    } catch (e) {
      setErr(errText(e))
    } finally {
      setRunning(false)
    }
  }
  const open = (u: string): void => {
    ui.invoke('feat:git:openUrl', u).catch((e) => setErr(errText(e)))
  }

  const existingOpen = prep?.existing && prep.existing.state === 'OPEN' ? prep.existing : null
  const blocked = !prep || prep.protected || !prep.branch || !prep.pushed || Boolean(existingOpen)

  return (
    <SubDialog title={step === 'confirm' ? 'Confirmar PR' : 'Crear PR'} icon={<GitPullRequest size={16} aria-hidden="true" />} onClose={onClose} wide>
      {!prep && !err && <p className="hint">Revisando rama, PR existente y plantilla…</p>}
      {prep && step === 'form' && (
        <>
          {existingOpen ? (
            <div className="f-git-existing">
              <GitPullRequest size={16} aria-hidden="true" />
              <span className="grow-min">
                Ya hay un PR abierto para <span className="mono">{prep.branch}</span>: <strong>#{existingOpen.number}</strong> {existingOpen.title}
              </span>
              <button className="btn sm primary" onClick={() => open(existingOpen.url)}>
                <ArrowSquareOut size={13} aria-hidden="true" /> Abrir en GitHub
              </button>
            </div>
          ) : (
            <>
              {prep.existing && (
                <p className="hint">
                  Hubo un PR #{prep.existing.number} ({prep.existing.state === 'MERGED' ? 'mergeado' : 'cerrado'}) para esta rama.{' '}
                  <button className="f-git-link" onClick={() => open(prep.existing!.url)}>
                    Ver
                  </button>
                </p>
              )}
              {prep.protected && (
                <p className="form-error">
                  <Warning size={13} aria-hidden="true" /> Estás en {prep.branch ?? 'un HEAD separado'}: creá una rama nueva para abrir un PR.
                </p>
              )}
              {!prep.protected && !prep.pushed && (
                <div className="f-git-warn">
                  <Warning size={14} aria-hidden="true" />
                  <span className="grow-min">
                    {prep.upstream ? `Hay ${prep.unpushed} commit${prep.unpushed === 1 ? '' : 's'} sin pushear.` : 'La rama todavía no está en el remoto.'} Pusheá antes de abrir el PR.
                  </span>
                  <button className="btn sm" onClick={onPush}>
                    <CloudArrowUp size={13} aria-hidden="true" /> Push…
                  </button>
                  <button className="icon-btn" onClick={load} aria-label="Volver a revisar" title="Volver a revisar">
                    <ArrowClockwise size={14} aria-hidden="true" />
                  </button>
                </div>
              )}
              {prep.ghError && <p className="form-error">{prep.ghError}</p>}
              <div className="f-git-grid2">
                <div className="field">
                  <label htmlFor="f-git-pr-head">Rama</label>
                  <input id="f-git-pr-head" className="mono" value={prep.branch ?? ''} readOnly />
                </div>
                <div className="field">
                  <label htmlFor="f-git-pr-base">Base</label>
                  <input id="f-git-pr-base" className="mono" value={prBase} onChange={(e) => setPrBase(e.target.value)} spellCheck={false} />
                </div>
              </div>
              <div className="field">
                <label htmlFor="f-git-pr-title">Título</label>
                <input id="f-git-pr-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
              </div>
              <div className="field">
                <label htmlFor="f-git-pr-body">Descripción</label>
                <textarea id="f-git-pr-body" className="f-git-ta mono" rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
                <p className="field-help">
                  {prep.template ? (
                    <>
                      Precargada desde <span className="mono">{prep.template.path}</span>.
                    </>
                  ) : (
                    'El repo no tiene plantilla de PR.'
                  )}{' '}
                  {prep.commits.length > 0 && `${prep.commits.length} commit${prep.commits.length === 1 ? '' : 's'} respecto de ${prBase || 'la base'}.`}
                </p>
              </div>
            </>
          )}
        </>
      )}
      {prep && step === 'confirm' && (
        <>
          <p className="f-git-p">
            Se va a crear un PR en GitHub de <span className="mono">{input.head}</span> hacia <span className="mono">{input.base}</span>. Comando exacto:
          </p>
          <pre className="f-git-cmd mono">{cmd.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}</pre>
          <p className="f-git-p">Cuerpo (por stdin):</p>
          <pre className="f-git-body mono">{body || '(vacío)'}</pre>
        </>
      )}
      {step === 'done' && (
        <div className="f-git-existing">
          <CheckCircle size={16} aria-hidden="true" />
          <span className="grow-min mono">{url}</span>
          <button className="btn sm primary" onClick={() => open(url)}>
            <ArrowSquareOut size={13} aria-hidden="true" /> Abrir en GitHub
          </button>
        </div>
      )}
      {err && <p className="form-error">{err}</p>}
      <div className="f-git-sub-actions">
        {step === 'confirm' ? (
          <>
            <button className="btn ghost" onClick={() => setStep('form')} disabled={running}>
              Volver
            </button>
            <button className="btn primary" onClick={() => void create()} disabled={running}>
              {running ? <CircleNotch size={14} className="spin" aria-hidden="true" /> : <GitPullRequest size={14} aria-hidden="true" />}
              {running ? 'Creando…' : 'Crear PR'}
            </button>
          </>
        ) : (
          <>
            <button className="btn ghost" onClick={onClose}>
              {step === 'done' || existingOpen ? 'Cerrar' : 'Cancelar'}
            </button>
            {step === 'form' && !existingOpen && (
              <button className="btn primary" onClick={() => void review()} disabled={blocked || !title.trim() || !prBase.trim()}>
                Revisar…
              </button>
            )}
          </>
        )}
      </div>
    </SubDialog>
  )
}

function SubDialog({
  title,
  icon,
  onClose,
  children,
  wide
}: {
  title: string
  icon: React.ReactNode
  onClose: () => void
  children: React.ReactNode
  wide?: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input:not([readonly]),textarea,button.primary')?.focus()
  }, [])
  return (
    <div className="f-git-sub-backdrop">
      <div ref={ref} className={`f-git-sub ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="f-git-sub-head">
          {icon}
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={14} aria-hidden="true" />
          </button>
        </header>
        <div className="f-git-sub-body">{children}</div>
      </div>
    </div>
  )
}

// ---------- Panel lateral ----------

function Drawer(): React.JSX.Element | null {
  const ui = useUi()
  const { wsId, view, nonce } = useDrawer()
  const ws = wsId ? ui.workspaces.find((w) => w.id === wsId) : undefined
  const [st, setSt] = useState<StatusRes | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')
  const [committing, setCommitting] = useState(false)
  const [note, setNote] = useState('')
  const [sub, setSub] = useState<null | 'push' | 'pr'>(null)
  const [baseDraft, setBaseDraft] = useState('')
  const [baseWarn, setBaseWarn] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const prevFocus = useRef<HTMLElement | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!wsId) return
    setLoading(true)
    setErr('')
    try {
      const r = await ui.invoke<StatusRes>('feat:git:status', wsId)
      setSt(r)
      setBaseDraft(r.base ?? '')
      setSel((cur) => (cur && r.files.some((f) => f.path === cur) ? cur : (r.files[0]?.path ?? null)))
    } catch (e) {
      setErr(errText(e))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId])

  useEffect(() => {
    if (!wsId) return
    prevFocus.current = document.activeElement as HTMLElement | null
    setSt(null)
    setSel(null)
    setNote('')
    setMsg('')
    setBaseWarn('')
    setSub(view === 'pr' ? 'pr' : null)
    void load()
    setTimeout(() => panelRef.current?.focus(), 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, nonce])

  const close = useCallback(() => {
    closeDrawer()
    prevFocus.current?.focus?.()
  }, [])

  useEffect(() => {
    if (!wsId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (sub) setSub(null)
      else close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [wsId, sub, close])

  const selected = useMemo(() => st?.files.find((f) => f.path === sel) ?? null, [st, sel])

  if (!wsId) return null

  const branch = st?.branch
  const prot = st?.protected ?? false
  const totals = st?.files.reduce((a, f) => ({ add: a.add + (f.add ?? 0), del: a.del + (f.del ?? 0) }), { add: 0, del: 0 })

  const commit = async (): Promise<void> => {
    setCommitting(true)
    setErr('')
    setNote('')
    try {
      const sha = await ui.invoke<string>('feat:git:commit', wsId, msg)
      setNote(`Commit ${sha} creado.`)
      setMsg('')
      await load()
      requestRefresh(wsId)
    } catch (e) {
      setErr(errText(e))
    } finally {
      setCommitting(false)
    }
  }
  const saveBase = async (): Promise<void> => {
    const b = baseDraft.trim()
    if (!b || b === st?.base) return
    try {
      const r = await ui.invoke<{ base: string; exists: boolean }>('feat:git:setBase', wsId, b)
      setSt((s) => (s ? { ...s, base: r.base } : s))
      setBaseWarn(r.exists ? '' : `No encuentro ${b} ni origin/${b}.`)
    } catch (e) {
      setBaseWarn(errText(e))
    }
  }
  const makeBranch = async (): Promise<void> => {
    setErr('')
    try {
      const b = await ui.invoke<string>('feat:git:createBranch', wsId, newBranch.trim())
      setNote(`Ahora estás en la rama ${b}. Los cambios siguen ahí.`)
      setNewBranch('')
      await load()
    } catch (e) {
      setErr(errText(e))
    }
  }

  return (
    <>
      <div className="f-git-backdrop" onMouseDown={close} aria-hidden="true" />
      <aside ref={panelRef} className="f-git-drawer" role="dialog" aria-label={`Cambios de ${ws?.name ?? 'espacio'}`} tabIndex={-1}>
        <header className="f-git-head">
          <GitDiff size={16} aria-hidden="true" />
          <h2 className="grow-min">
            Cambios <span className="f-git-ws">· {ws?.name ?? 'espacio borrado'}</span>
          </h2>
          <button className="icon-btn" onClick={() => void load()} aria-label="Actualizar" title="Actualizar" disabled={loading}>
            <ArrowClockwise size={15} className={loading ? 'spin' : ''} aria-hidden="true" />
          </button>
          <button className="icon-btn" onClick={close} aria-label="Cerrar panel de cambios" title="Cerrar (Esc)">
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        {st && !st.isRepo && <p className="f-git-empty">La carpeta del espacio no es un repositorio git.</p>}

        {st?.isRepo && (
          <>
            <div className="f-git-meta">
              <span className="f-git-meta-item" title="Rama actual">
                <GitBranch size={13} aria-hidden="true" />
                <span className="mono">{branch ?? 'HEAD separado'}</span>
              </span>
              <span className="f-git-arrow" aria-hidden="true">
                →
              </span>
              <label className="f-git-base">
                <span className="sr-only">Rama base</span>
                <span className="hint f-git-base-l">base</span>
                <input
                  className="mono"
                  value={baseDraft}
                  placeholder="staging"
                  onChange={(e) => setBaseDraft(e.target.value)}
                  onBlur={() => void saveBase()}
                  onKeyDown={(e) => e.key === 'Enter' && void saveBase()}
                  spellCheck={false}
                  aria-label="Rama base para el PR"
                />
              </label>
              <span className="spacer" />
              {totals && (
                <span className="f-git-tot mono" aria-label={`${st.files.length} archivos, ${totals.add} líneas agregadas, ${totals.del} borradas`}>
                  {st.files.length} arch. <span className="f-git-plus">+{totals.add}</span> <span className="f-git-minus">−{totals.del}</span>
                </span>
              )}
            </div>
            {baseWarn && <p className="f-git-note warn">{baseWarn}</p>}

            {prot && (
              <div className="f-git-warn">
                <Warning size={14} aria-hidden="true" />
                <span className="grow-min">
                  Estás en <span className="mono">{branch ?? 'HEAD separado'}</span>: no se commitea directo. Creá una rama nueva (los cambios la siguen).
                </span>
                <input
                  className="mono f-git-newbranch"
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && newBranch.trim() && void makeBranch()}
                  placeholder="feat/mi-cambio"
                  aria-label="Nombre de la rama nueva"
                  spellCheck={false}
                />
                <button className="btn sm" onClick={() => void makeBranch()} disabled={!newBranch.trim()}>
                  <GitBranch size={13} aria-hidden="true" /> Crear rama
                </button>
              </div>
            )}

            <ul className="f-git-files" aria-label="Archivos con cambios">
              {st.files.length === 0 && <li className="f-git-empty">Sin cambios: el árbol está limpio.</li>}
              {st.files.map((f) => {
                const slash = f.path.lastIndexOf('/')
                return (
                  <li key={f.path}>
                    <button className={`f-git-file ${sel === f.path ? 'sel' : ''}`} onClick={() => setSel(f.path)} aria-current={sel === f.path ? 'true' : undefined} title={f.orig ? `${f.orig} → ${f.path}` : f.path}>
                      <span className={`f-git-code c-${f.code === '??' ? 'u' : f.code}`} title={CODE_LABEL[f.code]} aria-label={CODE_LABEL[f.code]}>
                        {f.code}
                      </span>
                      <span className="f-git-path grow-min mono">
                        {slash >= 0 && <span className="f-git-dir">{f.path.slice(0, slash + 1)}</span>}
                        {f.path.slice(slash + 1)}
                      </span>
                      <span className="f-git-stat mono">
                        {f.binary ? (
                          <span className="hint">bin</span>
                        ) : f.huge ? (
                          <span className="hint">enorme</span>
                        ) : (
                          <>
                            {f.add !== undefined && <span className="f-git-plus">+{f.add}</span>}
                            {f.del !== undefined && <span className="f-git-minus">−{f.del}</span>}
                          </>
                        )}
                      </span>
                    </button>
                  </li>
                )
              })}
              {st.truncated && <li className="hint f-git-empty">Hay más archivos: se muestran los primeros 3000.</li>}
            </ul>

            <div className="f-git-diffwrap">{selected ? <DiffView key={selected.path} wsId={wsId} file={selected} onError={setErr} /> : <div className="f-git-diff-msg">Elegí un archivo para ver el diff.</div>}</div>

            <footer className="f-git-foot">
              {err && <p className="form-error f-git-err">{err}</p>}
              {note && (
                <p className="f-git-ok">
                  <CheckCircle size={14} aria-hidden="true" /> {note}
                </p>
              )}
              <div className="f-git-commit">
                <textarea
                  className="f-git-ta"
                  rows={2}
                  value={msg}
                  onChange={(e) => setMsg(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.ctrlKey && msg.trim() && !prot && st.files.length) void commit()
                  }}
                  placeholder={prot ? 'Creá una rama para poder commitear' : 'Mensaje del commit (obligatorio) — Ctrl+Enter'}
                  aria-label="Mensaje del commit"
                  disabled={prot}
                  maxLength={10000}
                />
              </div>
              <div className="f-git-actions">
                <button
                  className="btn sm primary"
                  onClick={() => void commit()}
                  disabled={prot || committing || !msg.trim() || st.files.length === 0}
                  title={prot ? `No se commitea en ${branch ?? 'HEAD separado'}` : 'Stage de todo (git add -A) + commit'}
                >
                  {committing ? <CircleNotch size={14} className="spin" aria-hidden="true" /> : <GitCommit size={14} aria-hidden="true" />}
                  Commit
                </button>
                <span className="spacer" />
                <button className="btn sm" onClick={() => setSub('push')} disabled={prot}>
                  <CloudArrowUp size={14} aria-hidden="true" /> Push…
                </button>
                <button className="btn sm" onClick={() => setSub('pr')} disabled={prot}>
                  <GitPullRequest size={14} aria-hidden="true" /> Crear PR…
                </button>
              </div>
            </footer>
          </>
        )}
        {!st && err && <p className="form-error f-git-err">{err}</p>}

        {sub === 'push' && (
          <PushConfirm
            wsId={wsId}
            onClose={() => setSub(null)}
            onDone={() => {
              void load()
              requestRefresh(wsId)
            }}
          />
        )}
        {sub === 'pr' && <PrPanel wsId={wsId} base={st?.base ?? null} onClose={() => setSub(null)} onPush={() => setSub('push')} />}
      </aside>
    </>
  )
}

const ui: FeatureUi = {
  name: 'git',
  PaneHeader: ChangesButton,
  Global: Drawer,
  commands(ctx) {
    const ws = ctx.workspaces.find((w) => w.id === ctx.focused)
    const need = (): string | null => {
      if (!ws) {
        ctx.notifyError('Enfocá el panel de un espacio primero.')
        return null
      }
      return ws.id
    }
    return [
      {
        id: 'git:changes',
        title: 'Ver cambios del espacio enfocado',
        subtitle: ws ? ws.name : undefined,
        group: 'Git',
        keywords: 'git diff status cambios archivos modificados',
        run() {
          const id = need()
          if (id) openDrawer(id, 'changes')
        }
      },
      {
        id: 'git:pr',
        title: 'Crear PR del espacio enfocado',
        subtitle: ws ? ws.name : undefined,
        group: 'Git',
        keywords: 'git pull request pr github gh push',
        run() {
          const id = need()
          if (!id) return
          if (ws?.branch && PROTECTED.includes(ws.branch)) ctx.notifyError(`El espacio está en ${ws.branch}: creá una rama antes del PR.`)
          openDrawer(id, 'pr')
        }
      }
    ]
  }
}

export default ui
