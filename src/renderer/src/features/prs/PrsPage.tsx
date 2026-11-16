import { useCallback, useEffect, useRef, useState } from 'react'
import { View } from '../../ui/View'
import { Button, EmptyState, IconButton, InlineAlert, Menu, Segmented, Tag, Tooltip, toast } from '../../ui'
import { CheckCircleIcon, ErrorIcon, MoreIcon, PullRequestIcon, RefreshIcon, SpinnerIcon } from '../../icons/SlothIcons'
import { useVisiblePolling } from '../../visibility'
import { useUi } from '../host'
import { rebaseBlocker } from '../../../../shared/prs'
import type { OpenBranchMode, OpenBranchResult, PrRow, PrsProblem, PrsSnapshot, PrTarget, RepoPrs } from '../../../../shared/prs'
import { DivergedDialog, MergeDialog, RebaseDialog } from './MergeDialog'
import { ago, checksLabel, counts, filterPrs, reviewLabel, type PrFilter } from './model'
import { closePrs } from './store'

const FILTER_KEY = 'sloth.prs.filter'
const EMPTY: PrsSnapshot = { problem: null, login: null, repos: [], at: 0, refreshing: true }

function readFilter(): PrFilter {
  try {
    const v = localStorage.getItem(FILTER_KEY)
    if (v === 'mine' || v === 'review' || v === 'all') return v
  } catch {
    // sin almacenamiento: queda el filtro por defecto
  }
  return 'mine'
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

type Dialog =
  | { kind: 'merge' | 'rebase'; repo: RepoPrs; pr: PrRow }
  | { kind: 'diverged'; repo: RepoPrs; pr: PrRow; info: Extract<OpenBranchResult, { kind: 'diverged' }> }
  | null

export function PrsPage(): React.JSX.Element {
  const ui = useUi()
  const [snap, setSnap] = useState<PrsSnapshot>(EMPTY)
  const [filter, setFilter] = useState<PrFilter>(readFilter)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const uiRef = useRef(ui)
  uiRef.current = ui

  useEffect(() => {
    const { invoke, on } = uiRef.current
    const off = on('feat:prs:updated', (s: PrsSnapshot) => setSnap(s))
    void invoke('feat:prs:setOpen', true)
    invoke<PrsSnapshot>('feat:prs:list').then(setSnap, (e) => toast({ tone: 'danger', message: msg(e) }))
    return () => {
      off()
      void invoke('feat:prs:setOpen', false)
    }
  }, [])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const first = useRef(true)
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setSnap(await uiRef.current.invoke<PrsSnapshot>('feat:prs:refresh'))
    } catch (e) {
      toast({ tone: 'danger', message: msg(e) })
    }
  }, [])
  // El primer tick corre al montar y ya lo cubre `list`, que dispara su propio refresco.
  useVisiblePolling(() => {
    if (first.current) {
      first.current = false
      return
    }
    void refresh()
  }, 5 * 60_000)

  const pick = (f: PrFilter): void => {
    setFilter(f)
    try {
      localStorage.setItem(FILTER_KEY, f)
    } catch {
      // el filtro solo dura esta sesión
    }
  }

  const n = counts(snap.repos)
  const shown = filterPrs(snap.repos, filter)
  const loading = snap.at === 0 && snap.refreshing && !snap.problem

  // El main abre el panel del espacio (open-pane); acá solo se cierra la vista.
  const openBranch = async (repo: RepoPrs, pr: PrRow, mode?: OpenBranchMode): Promise<void> => {
    setOpening(`${repo.repo}#${pr.number}`)
    try {
      const r = await ui.invoke<OpenBranchResult>('feat:prs:openBranch', { repo: repo.repo, number: pr.number }, mode)
      if (r.kind === 'diverged') {
        setDialog({ kind: 'diverged', repo, pr, info: r })
        return
      }
      setDialog(null)
      closePrs()
    } catch (e) {
      toast({ tone: 'danger', message: msg(e) })
    } finally {
      setOpening(null)
    }
  }

  const live = dialog ? (snap.repos.find((r) => r.repo === dialog.repo.repo)?.prs.find((p) => p.number === dialog.pr.number) ?? null) : null
  const liveRepo = (repo: RepoPrs): RepoPrs => snap.repos.find((r) => r.repo === repo.repo) ?? repo

  const openUrl = (t: PrTarget, url: string): void => {
    ui.invoke('feat:prs:openUrl', t, url).catch((e) => toast({ tone: 'danger', message: msg(e) }))
  }

  const actions = (
    <>
      <span className="f-prs-updated" role="status">
        {snap.refreshing ? 'Actualizando…' : snap.at ? `Actualizado ${ago(snap.at, now)}` : ''}
      </span>
      <IconButton label="Refrescar" icon={<RefreshIcon size={16} />} disabled={snap.refreshing} onClick={() => void refresh()} />
    </>
  )

  return (
    <View labelId="f-prs-view-title" title="PRs" onClose={closePrs} actions={actions} className="f-prs-view">
      <div className="f-prs-body">
        {loading ? (
          <div className="f-prs-loading" role="status">
            <SpinnerIcon size={18} /> Buscando PRs abiertos…
          </div>
        ) : snap.problem ? (
          <Problem problem={snap.problem} refreshing={snap.refreshing} onRefresh={() => void refresh()} />
        ) : (
          <>
            <div className="f-prs-filter">
              <Segmented<PrFilter>
                aria-label="Filtrar PRs"
                size="sm"
                value={filter}
                onChange={pick}
                options={[
                  { value: 'mine', label: `Míos (${n.mine})` },
                  { value: 'review', label: `Me piden revisión (${n.review})` },
                  { value: 'all', label: `Todos (${n.all})` }
                ]}
              />
            </div>
            {shown.length === 0 ? (
              <EmptyState
                icon={<PullRequestIcon size={28} />}
                title="No hay PRs abiertos acá"
                description={filter !== 'all' && n.all > 0 ? 'Probá con «Todos» para ver los PRs de otras personas.' : 'Cuando haya PRs abiertos en los repos de tus espacios, aparecen en esta lista.'}
                action={
                  filter !== 'all' && n.all > 0 ? (
                    <Button variant="secondary" onClick={() => pick('all')}>
                      Ver todos
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              shown.map((repo) => (
                <section key={repo.repo} className="f-prs-repo" aria-label={repo.repo}>
                  <h2 className="f-prs-repo-name">{repo.repo}</h2>
                  {repo.error && <InlineAlert tone="danger">{repo.error}</InlineAlert>}
                  {repo.prs.length > 0 && (
                    <ul className="f-prs-list">
                      {repo.prs.map((pr) => (
                        <PrItem
                          key={pr.number}
                          pr={pr}
                          rebaseBlocked={rebaseBlocker(pr, liveRepo(repo))}
                          canMerge={repo.mergeMethods.length > 0}
                          loading={opening === `${repo.repo}#${pr.number}`}
                          onUrl={(url) => openUrl({ repo: repo.repo, number: pr.number }, url)}
                          onBranch={() => void openBranch(repo, pr)}
                          onRebase={() => setDialog({ kind: 'rebase', repo, pr })}
                          onMerge={() => setDialog({ kind: 'merge', repo, pr })}
                          onRefresh={() => void refresh()}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              ))
            )}
          </>
        )}
      </div>
      {dialog?.kind === 'merge' && <MergeDialog repo={dialog.repo} pr={dialog.pr} live={live} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rebase' && <RebaseDialog repo={dialog.repo} pr={dialog.pr} live={live} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'diverged' && (
        <DivergedDialog info={dialog.info} onPick={(mode) => openBranch(dialog.repo, dialog.pr, mode)} onClose={() => setDialog(null)} />
      )}
    </View>
  )
}

function Problem({ problem, refreshing, onRefresh }: { problem: NonNullable<PrsProblem>; refreshing: boolean; onRefresh: () => void }): React.JSX.Element {
  const icon = <PullRequestIcon size={28} />
  if (problem === 'no-gh') {
    return <EmptyState icon={icon} title="Necesitás GitHub CLI" description="Instalalo desde cli.github.com y volvé a abrir esta vista." />
  }
  if (problem === 'no-login') {
    return (
      <EmptyState
        icon={icon}
        title="Iniciá sesión en GitHub CLI"
        description={
          <>
            Corré <code>gh auth login</code> en una terminal y tocá Refrescar.
          </>
        }
        action={
          <Button variant="primary" loading={refreshing} onClick={onRefresh}>
            Refrescar
          </Button>
        }
      />
    )
  }
  return <EmptyState icon={icon} title="Ningún espacio apunta a un repo de GitHub" description="Creá un espacio con la carpeta de un repo que tenga remoto en GitHub y van a aparecer sus PRs." />
}

function ChecksGlyph({ pr }: { pr: PrRow }): React.JSX.Element | null {
  if (pr.checks === 'none') return null
  const icon = pr.checks === 'ok' ? <CheckCircleIcon size={15} /> : pr.checks === 'fail' ? <ErrorIcon size={15} /> : <SpinnerIcon size={15} />
  return (
    <Tooltip text={checksLabel(pr)}>
      <span className={`f-prs-checks is-${pr.checks}`} role="img" aria-label={checksLabel(pr)} tabIndex={0}>
        {icon}
      </span>
    </Tooltip>
  )
}

interface PrItemProps {
  pr: PrRow
  rebaseBlocked: string | null
  canMerge: boolean
  loading: boolean
  onUrl: (url: string) => void
  onBranch: () => void
  onRebase: () => void
  onMerge: () => void
  onRefresh: () => void
}

function PrItem({ pr, rebaseBlocked, canMerge, loading, onUrl, onBranch, onRebase, onMerge, onRefresh }: PrItemProps): React.JSX.Element {
  const review = reviewLabel(pr.review)
  const failUrl = pr.failing[0]?.url ?? null
  return (
    <li className="f-prs-row">
      <div className="f-prs-main">
        <button type="button" className="f-prs-title" onClick={() => onUrl(pr.url)}>
          {pr.title}
        </button>
        <div className="f-prs-meta">
          <span className="f-prs-num">#{pr.number}</span>
          <span>{pr.author}</span>
          <Tag>
            {pr.base} ← {pr.head}
          </Tag>
          {pr.isDraft && <Tag mono={false}>Borrador</Tag>}
        </div>
      </div>
      <div className="f-prs-state">
        <ChecksGlyph pr={pr} />
        {pr.checks === 'fail' && failUrl && (
          <button type="button" className="f-prs-link" onClick={() => onUrl(failUrl)}>
            Ver check fallido
          </button>
        )}
        {review && (
          <Tag mono={false} tone={pr.review === 'approved' ? 'done' : pr.review === 'changes' ? 'danger' : 'waiting'}>
            {review}
          </Tag>
        )}
        {pr.reviewRequestedFromMe && (
          <Tag mono={false} tone="accent">
            Te piden revisión
          </Tag>
        )}
        {pr.mergeable === 'conflict' && (
          <Tag mono={false} tone="danger">
            Conflictos
          </Tag>
        )}
        <Menu
          aria-label={`Acciones de #${pr.number}`}
          align="end"
          trigger={(p) => <IconButton {...p} label="Acciones" icon={<MoreIcon size={16} />} loading={loading} />}
          items={[
            { id: 'url', label: 'Abrir en GitHub', onSelect: () => onUrl(pr.url) },
            { id: 'branch', label: 'Abrir espacio en esta rama', hint: pr.crossRepo ? 'PR de un fork' : undefined, disabled: pr.crossRepo || loading, onSelect: onBranch },
            { id: 'rebase', label: `Rebase sobre ${pr.base}`, hint: rebaseBlocked ?? undefined, disabled: !!rebaseBlocked, onSelect: onRebase },
            {
              id: 'merge',
              label: 'Mergear…',
              danger: true,
              hint: pr.isDraft ? 'Es un borrador' : canMerge ? undefined : 'El repo no tiene métodos de merge habilitados',
              disabled: pr.isDraft || !canMerge,
              onSelect: onMerge
            },
            { id: 'refresh', label: 'Refrescar', onSelect: onRefresh }
          ]}
        />
      </div>
    </li>
  )
}
