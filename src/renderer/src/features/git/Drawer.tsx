import { useCallback, useEffect, useRef, useState } from 'react'
import { CloseIcon, BranchIcon } from '../../icons/SlothIcons'
import { CheckGlyph } from './glyphs'
import { useUi } from '../host'
import { isLoginPane } from '../../../../shared/types'
import { useDocumentVisible } from '../../visibility'
import { closeDrawer, onRefresh, openDrawer, requestRefresh, useDrawer } from './store'
import { Cambios } from './Cambios'
import { Historial } from './Historial'
import { Ramas } from './Ramas'
import { PrPanel } from './Pr'
import { errText, type BranchesRes, type GitShared, type SessionPr, type StashRes, type StatusRes, type SyncRes } from './util'

type Tab = 'cambios' | 'historial' | 'ramas'

export function Drawer(): React.JSX.Element | null {
  const ui = useUi()
  const { wsId, view, nonce } = useDrawer()
  const ws = wsId ? ui.workspaces.find((w) => w.id === wsId) : undefined
  const [tab, setTab] = useState<Tab>('cambios')
  const [st, setSt] = useState<StatusRes | null>(null)
  const [sync, setSync] = useState<SyncRes | null>(null)
  const [stash, setStash] = useState<StashRes | null>(null)
  const [branches, setBranches] = useState<BranchesRes | null>(null)
  const [rev, setRev] = useState(0)
  const [loadErr, setLoadErr] = useState('')
  const [err, setErr] = useState('')
  const [toast, setToast] = useState('')
  const [prOpen, setPrOpen] = useState(false)
  const [prs, setPrs] = useState<SessionPr[]>([])
  const panelRef = useRef<HTMLDivElement>(null)
  const prevFocus = useRef<HTMLElement | null>(null)
  const toastT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const say = useCallback((m: string) => {
    setErr('')
    setToast(m)
    clearTimeout(toastT.current)
    toastT.current = setTimeout(() => setToast(''), 2600)
  }, [])

  const fail = useCallback((m: string) => setErr(m), [])

  /** Vuelve a leer todo lo del espacio. Lo llaman las pestañas después de cada operación. */
  const reload = useCallback(async (): Promise<void> => {
    if (!wsId) return
    try {
      const [s, y, t, b] = await Promise.all([
        ui.invoke<StatusRes>('feat:git:status', wsId),
        ui.invoke<SyncRes | null>('feat:git:sync', wsId),
        ui.invoke<StashRes | null>('feat:git:stashInfo', wsId),
        ui.invoke<BranchesRes>('feat:git:branches', wsId)
      ])
      setSt(s)
      setSync(y)
      setStash(t)
      setBranches(b)
      setLoadErr('')
      setRev((r) => r + 1)
      requestRefresh(wsId)
    } catch (e) {
      setLoadErr(errText(e))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId])

  useEffect(() => {
    if (!wsId) return
    prevFocus.current = document.activeElement as HTMLElement | null
    setSt(null)
    setSync(null)
    setStash(null)
    setBranches(null)
    setErr('')
    setToast('')
    setTab('cambios')
    setPrOpen(view === 'pr')
    void reload()
    setTimeout(() => panelRef.current?.focus(), 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, nonce])

  // Si Claude cambia archivos mientras el panel está abierto, se vuelve a leer.
  useEffect(() => {
    if (!wsId) return
    let t: ReturnType<typeof setTimeout> | undefined
    const off = ui.on('feat:git:changed', (id: string) => {
      if (id !== wsId) return
      clearTimeout(t)
      t = setTimeout(() => {
        if (document.visibilityState === 'visible') void reload()
      }, 400)
    })
    return () => {
      clearTimeout(t)
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, reload])

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
      if (prOpen) setPrOpen(false)
      else close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [wsId, prOpen, close])

  useEffect(() => () => clearTimeout(toastT.current), [])

  if (!wsId) return null

  const shared: GitShared = { wsId, reload, say, fail, addPr: (pr) => setPrs((p) => [...p, pr]), prs }
  const cur = st?.branch ?? (st ? 'HEAD separado' : '')
  const nFiles = st?.files.length ?? 0
  const tabs: { id: Tab; label: string; count?: string }[] = [
    { id: 'cambios', label: 'Cambios', count: String(nFiles) },
    { id: 'historial', label: 'Historial' },
    { id: 'ramas', label: 'Ramas' }
  ]

  return (
    <>
      <div className="f-git-backdrop" onMouseDown={close} aria-hidden="true" />
      <aside ref={panelRef} className="f-git-drawer" role="dialog" aria-modal="true" aria-label={`Git de ${ws?.name ?? 'espacio'}`} tabIndex={-1}>
        <header className="f-git-head">
          <div role="tablist" aria-label="Vista de Git" className="g-tabs">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`g-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="g-panel"
                className="g-tab"
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.count !== undefined && <span className="g-tab-n">{t.count}</span>}
              </button>
            ))}
          </div>
          <span className="g-head-sp" />
          {cur && (
            <span className="g-branch mono" title={`Rama actual: ${cur}`}>
              <BranchIcon size={14} strokeWidth={1.8} aria-hidden="true" />
              <span className="g-branch-name">{cur}</span>
            </span>
          )}
          <button className="icon-btn" onClick={close} aria-label="Cerrar Git" title="Cerrar (Esc)">
            <CloseIcon size={12} aria-hidden="true" />
          </button>
        </header>

        {st && !st.isRepo && <p className="f-git-empty">La carpeta del espacio no es un repositorio git.</p>}
        {loadErr && !st && (
          <p className="form-error f-git-err" role="alert">
            {loadErr}
          </p>
        )}

        {st?.isRepo && (
          <div id="g-panel" role="tabpanel" aria-labelledby={`g-tab-${tab}`} className="g-body">
            {err && (
              <div role="alert" className="g-err">
                <span className="grow-min">{err}</span>
                <button type="button" className="icon-btn" onClick={() => setErr('')} aria-label="Cerrar aviso">
                  <CloseIcon size={12} aria-hidden="true" />
                </button>
              </div>
            )}
            {tab === 'cambios' && <Cambios g={shared} st={st} sync={sync} onOpenPr={() => setPrOpen(true)} />}
            {tab === 'historial' && <Historial g={shared} rev={rev} />}
            {tab === 'ramas' && <Ramas g={shared} st={st} sync={sync} stash={stash} branches={branches} onGoCambios={() => setTab('cambios')} />}
          </div>
        )}
        {!st && !loadErr && <p className="g-loading">Cargando…</p>}
        {!st && loadErr && <p className="form-error f-git-err">{loadErr}</p>}

        {toast && (
          <div role="status" className="g-toast">
            <CheckGlyph size={15} />
            {toast}
          </div>
        )}

        {prOpen && wsId && (
          <PrPanel
            wsId={wsId}
            base={st?.base ?? null}
            onClose={() => setPrOpen(false)}
            onPush={async (branch) => {
              await ui.invoke('feat:git:push', wsId, branch)
              say(`Subido a origin/${branch}`)
              await reload()
            }}
            onCreated={(pr) => {
              shared.addPr(pr)
              say(pr.number ? `PR #${pr.number} abierto` : 'PR abierto')
            }}
          />
        )}
      </aside>
    </>
  )
}

