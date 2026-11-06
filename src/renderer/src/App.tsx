import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowClockwise,
  ArrowsIn,
  ArrowsLeftRight,
  ArrowsOut,
  DotsSixVertical,
  Equals,
  GridFour,
  EyeSlash,
  Plus,
  ShieldWarning,
  SignIn,
  Tabs as TabsIcon,
  Terminal as TerminalIcon,
  Ticket,
  Trash,
  WarningCircle,
  X
} from '@phosphor-icons/react'
import {
  accountIdFromLoginPane,
  isLoginPane,
  loginPaneId,
  type Account,
  type AccountStatus,
  type AccountUsage,
  type AgentStatus,
  type PermissionAnswer,
  type PermissionPrompt,
  type Workspace
} from '../../shared/types'
import { api } from './api'
import { UiContext, type UiCtx } from './features/host'
import { GlobalSlot, PaneBannerSlot, PaneHeaderSlot, SidebarSlot, TitlebarSlot } from './features/slots'
import { TerminalView } from './TerminalView'
import { NewWorkspaceDialog } from './NewWorkspaceDialog'
import { LogoMark, Wordmark } from './Logo'
import { StateIcon, StatePill } from './StateIcon'
import { PermissionCard, toolLabel } from './PermissionCard'
import { DaemonStatus } from './DaemonStatus'
import { useDocumentVisible, useVisiblePolling } from './visibility'
import {
  cellRects,
  cycle,
  defaultSizes,
  gridShape,
  loadSizes,
  movePane,
  sameOrder,
  saveSizes,
  shapeKey,
  shiftPane,
  sizesAreEqual,
  type DropMode,
  type Rect,
  type Sizes
} from './layout/logic'
import { onEqualize, safeStorage, setViewMode, useViewMode } from './layout/store'
import { useReorderDrag } from './layout/useReorderDrag'
import { Separators } from './layout/Separators'
import { TabBar, type TabInfo } from './layout/TabBar'
import './layout/layout.css'
import { accountColor, cleanError, fmtTok, shortPath, STATE_LABEL, totalTok, usageTitle } from './format'

export function App(): React.JSX.Element {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [statuses, setStatuses] = useState<Record<string, AccountStatus>>({})
  const [usage, setUsage] = useState<Record<string, AccountUsage>>({})
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [openPanes, setOpenPanesState] = useState<string[]>([])
  const [agents, setAgents] = useState<Record<string, AgentStatus>>({})
  const [generations, setGenerations] = useState<Record<string, number>>({})
  const [focused, setFocused] = useState<string | null>(null)
  const [maximized, setMaximized] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newWsMode, setNewWsMode] = useState<null | 'normal' | 'ticket'>(null)
  const [loaded, setLoaded] = useState(false)
  const [perms, setPerms] = useState<PermissionPrompt[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [announceId, setAnnounceId] = useState<string | null>(null)
  const docVisible = useDocumentVisible()

  const refreshStatuses = useCallback(() => void api.accountStatuses().then(setStatuses), [])

  useEffect(() => {
    void api.getState().then((s) => {
      setAccounts(s.accounts)
      setWorkspaces(s.workspaces)
      const valid = new Set([...s.workspaces.map((w) => w.id), ...s.accounts.map((a) => loginPaneId(a.id))])
      setOpenPanesState(s.openPanes.filter((p) => valid.has(p)))
      setAgents(s.agents)
      setLoaded(true)
    })
    const off = api.onAgentStatus((id, st) => setAgents((a) => ({ ...a, [id]: st })))
    return off
  }, [])

  // Polling liviano y solo con la ventana visible (al volver se refresca una vez).
  useVisiblePolling(refreshStatuses, 15_000)
  useVisiblePolling(() => void api.accountUsage().then(setUsage).catch(() => undefined), 60_000, [accounts.length])

  // Permisos: lo que ya estaba pendiente + los que llegan; se descartan los vencidos.
  useEffect(() => {
    let alive = true
    const add = (list: PermissionPrompt[]): void =>
      setPerms((prev) => {
        const t = Date.now()
        const seen = new Set(prev.map((p) => p.id))
        const fresh = list.filter((p) => !seen.has(p.id) && p.expiresAt > t)
        return fresh.length ? [...prev, ...fresh].sort((a, b) => a.at - b.at) : prev
      })
    const offNew = api.onPermission((p) => {
      add([p])
      setNow(Date.now())
      setAnnounceId(p.id)
    })
    const offRes = api.onPermissionResolved((id) => setPerms((prev) => prev.filter((p) => p.id !== id)))
    void api
      .pendingPermissions()
      .then((list) => {
        if (alive) add(list)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      offNew()
      offRes()
    }
  }, [])

  // Un solo reloj de 1 s para todas las cuentas regresivas, solo mientras haya permisos.
  const hasPerms = perms.length > 0
  useEffect(() => {
    if (!hasPerms) return
    setNow(Date.now())
    const t = setInterval(() => {
      const n = Date.now()
      setNow(n)
      setPerms((prev) => (prev.some((p) => p.expiresAt <= n) ? prev.filter((p) => p.expiresAt > n) : prev))
    }, 1000)
    return () => clearInterval(t)
  }, [hasPerms])

  const setOpenPanes = useCallback((updater: (prev: string[]) => string[]) => {
    setOpenPanesState((prev) => {
      const next = updater(prev)
      void api.setOpenPanes(next)
      return next
    })
  }, [])

  const openPane = (id: string): void => {
    setOpenPanes((p) => (p.includes(id) ? p : [...p, id]))
    setFocused(id)
    if (maximized && maximized !== id) setMaximized(id)
  }
  const closePane = (id: string): void => {
    setOpenPanes((p) => p.filter((x) => x !== id))
    if (maximized === id) setMaximized(null)
  }
  const restartPane = async (id: string): Promise<void> => {
    await api.ptyKill(id)
    setGenerations((g) => ({ ...g, [id]: (g[id] ?? 0) + 1 }))
  }

  /** Relee cuentas y espacios de main (las funciones crean o editan espacios). */
  const reload = useCallback(async (): Promise<void> => {
    const s = await api.getState()
    setAccounts(s.accounts)
    setWorkspaces(s.workspaces)
    setAgents((a) => ({ ...a, ...s.agents }))
    const valid = new Set([...s.workspaces.map((w) => w.id), ...s.accounts.map((a) => loginPaneId(a.id))])
    setOpenPanesState((prev) => prev.filter((x) => valid.has(x)))
  }, [])

  // Órdenes de main (de las funciones): recargar, abrir o reiniciar un panel.
  const openPaneRef = useRef(openPane)
  openPaneRef.current = openPane
  useEffect(
    () =>
      api.onUi((cmd) => {
        if (cmd.type === 'reload') void reload()
        else if (cmd.type === 'open-pane') void reload().then(() => openPaneRef.current(cmd.id))
        else if (cmd.type === 'restart-pane') setGenerations((g) => ({ ...g, [cmd.id]: (g[cmd.id] ?? 0) + 1 }))
      }),
    [reload]
  )

  const accountIndex = useMemo(() => new Map(accounts.map((a, i) => [a.id, i])), [accounts])
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const wsById = useMemo(() => new Map(workspaces.map((w) => [w.id, w])), [workspaces])
  const livePerms = useMemo(() => perms.filter((p) => wsById.has(p.workspaceId) && p.expiresAt > now), [perms, wsById, now])
  const permsByWs = useMemo(() => {
    const m = new Map<string, PermissionPrompt[]>()
    for (const p of livePerms) {
      const list = m.get(p.workspaceId)
      if (list) list.push(p)
      else m.set(p.workspaceId, [p])
    }
    return m
  }, [livePerms])
  const announced = announceId ? livePerms.find((p) => p.id === announceId) : undefined

  const answerPermission = async (p: PermissionPrompt, answer: PermissionAnswer, message?: string): Promise<void> => {
    await api.answerPermission(p.id, answer, message)
    setPerms((prev) => prev.filter((x) => x.id !== p.id))
    // El botón que tenía el foco desaparece: pasarlo al próximo permiso del panel o a la terminal.
    requestAnimationFrame(() => {
      const pane = document.querySelector(`[data-pane-id="${CSS.escape(p.workspaceId)}"]`)
      const next = pane?.querySelector<HTMLElement>('[data-perm-primary]')
      const term = pane?.querySelector<HTMLElement>('.xterm-helper-textarea')
      ;(next ?? term)?.focus()
    })
  }

  const colorOf = (accountId?: string): string => accountColor(accountId ? (accountIndex.get(accountId) ?? 0) : 0)

  const addAccount = async (label: string): Promise<void> => {
    try {
      const acc = await api.addAccount(label)
      setAccounts((a) => [...a, acc])
      openPane(loginPaneId(acc.id))
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const removeAccount = async (acc: Account): Promise<void> => {
    if (!window.confirm(`¿Quitar la cuenta «${acc.label}» de Sloth?`)) return
    try {
      await api.removeAccount(acc.id)
      setAccounts((a) => a.filter((x) => x.id !== acc.id))
      closePane(loginPaneId(acc.id))
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const toggleShare = async (acc: Account): Promise<void> => {
    const next = acc.shareSetup === false
    try {
      await api.setShareSetup(acc.id, next)
      setAccounts((list) => list.map((a) => (a.id === acc.id ? { ...a, shareSetup: next } : a)))
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const removeWorkspace = async (ws: Workspace): Promise<void> => {
    const extra = ws.branch ? `\n\nEl worktree en ${ws.cwd} queda en disco.` : ''
    if (!window.confirm(`¿Quitar el espacio «${ws.name}»? Se cierra su terminal.${extra}`)) return
    await api.removeWorkspace(ws.id)
    setWorkspaces((w) => w.filter((x) => x.id !== ws.id))
    setOpenPanesState((p) => p.filter((x) => x !== ws.id))
  }

  const onTermError = useCallback((m: string) => setError(m), [])

  // ---------- Layout de paneles: vista (grilla/pestañas), proporciones y orden ----------
  const viewMode = useViewMode()
  const areaRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const [layoutMsg, setLayoutMsg] = useState('')
  const maxId = maximized && openPanes.includes(maximized) ? maximized : null
  const activeTab = focused && openPanes.includes(focused) ? focused : (openPanes[0] ?? null)
  // En pestañas se ve una sola (la maximizada o la activa); las demás quedan montadas con display:none.
  const shownTab = viewMode === 'tabs' ? (maxId ?? activeTab) : null
  const visiblePanes = viewMode === 'tabs' ? (shownTab ? [shownTab] : []) : maxId ? [maxId] : openPanes
  const nVisible = visiblePanes.length
  const shape = useMemo(() => gridShape(nVisible), [nVisible])
  const shapeK = shapeKey(shape)
  const [sizeOverrides, setSizeOverrides] = useState<Record<string, Sizes>>({})
  const sizes = useMemo(() => sizeOverrides[shapeK] ?? loadSizes(safeStorage(), shape), [sizeOverrides, shapeK, shape])
  const rects = useMemo(() => cellRects(shape, sizes), [shape, sizes])
  const rectOf = new Map(visiblePanes.map((id, i) => [id, rects[i]]))
  const commitSizes = useCallback(
    (next: Sizes) => {
      setSizeOverrides((o) => ({ ...o, [shapeK]: next }))
      saveSizes(safeStorage(), shape, next)
    },
    [shapeK, shape]
  )
  const equalizeRef = useRef(() => {})
  equalizeRef.current = () => commitSizes(defaultSizes(shape))
  useEffect(() => onEqualize(() => equalizeRef.current()), [])

  const paneName = (id: string): string =>
    isLoginPane(id) ? `Terminal de ${accountById.get(accountIdFromLoginPane(id))?.label ?? 'cuenta'}` : (wsById.get(id)?.name ?? 'Panel')

  /** Elige un panel: lo enfoca y, si había uno maximizado (o en pestañas), pasa a mostrar ese. */
  const selectPane = (id: string, focusTerm: boolean): void => {
    setFocused(id)
    if (maxId && maxId !== id) setMaximized(id)
    if (focusTerm) focusTerminal(id)
  }

  const announceOrder = (id: string, list: string[]): void => {
    setLayoutMsg(`«${paneName(id)}» quedó en la posición ${list.indexOf(id) + 1} de ${list.length}.`)
  }

  const dropPane = (id: string, target: string, mode: DropMode): void => {
    const next = movePane(openPanes, id, target, mode)
    if (sameOrder(next, openPanes)) return
    setOpenPanes(() => next)
    setFocused(id)
    if (mode === 'swap') setLayoutMsg(`«${paneName(id)}» intercambiado con «${paneName(target)}».`)
    else announceOrder(id, next)
  }

  const paneDrag = useReorderDrag({
    kind: 'pane',
    attr: 'data-pane-id',
    scope: areaRef,
    ghost: ghostRef,
    ignore: 'button, a, input, textarea, select, [role="button"]',
    onDrop: dropPane
  })
  const tabDrag = useReorderDrag({ kind: 'tab', attr: 'data-tab-id', scope: tabsRef, ghost: ghostRef, onDrop: dropPane })
  const dragging = paneDrag.drag ?? tabDrag.drag
  const canDragPanes = viewMode === 'grid' && nVisible > 1

  const hideTab = (id: string): void => {
    const i = openPanes.indexOf(id)
    const neighbor = openPanes[i + 1] ?? openPanes[i - 1]
    closePane(id)
    if (id === shownTab && neighbor) setFocused(neighbor)
  }

  // Atajos: Ctrl+Tab / Ctrl+Shift+Tab cambian de panel; Ctrl+Alt+← / → mueven el panel enfocado.
  const kbRef = useRef({ count: 0, cycleBy: (_d: 1 | -1): void => {}, shiftBy: (_id: string, _d: number, _tab: boolean): void => {} })
  kbRef.current = {
    count: openPanes.length,
    cycleBy: (d) => {
      const cur = viewMode === 'tabs' ? shownTab : (maxId ?? (focused && openPanes.includes(focused) ? focused : null))
      const next = cycle(openPanes, cur, d)
      if (!next) return
      selectPane(next, true)
      setLayoutMsg(`${paneName(next)}, ${openPanes.indexOf(next) + 1} de ${openPanes.length}.`)
    },
    shiftBy: (id, d, fromTab) => {
      const next = shiftPane(openPanes, id, d)
      if (sameOrder(next, openPanes)) {
        setLayoutMsg(`«${paneName(id)}» ya está ${d < 0 ? 'primero' : 'último'}.`)
        return
      }
      setOpenPanes(() => next)
      announceOrder(id, next)
      // React movió el nodo en el DOM: devolverle el foco a donde estaba.
      requestAnimationFrame(() => {
        if (fromTab) tabsRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`)?.focus()
        else focusTerminal(id)
      })
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey) return
      const k = kbRef.current
      const ae = document.activeElement
      if (e.ctrlKey && !e.altKey && e.key === 'Tab') {
        // Solo desde los paneles (o sin foco): no pisar el Tab de modales y paletas.
        if (ae && ae !== document.body && !ae.closest('.panes')) return
        if (k.count < 2) return
        e.preventDefault()
        e.stopPropagation()
        k.cycleBy(e.shiftKey ? -1 : 1)
        return
      }
      if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const host = ae?.closest<HTMLElement>('[data-pane-id], [data-tab-id]')
        const id = host?.getAttribute('data-pane-id') ?? host?.getAttribute('data-tab-id')
        if (!host || !id) return
        e.preventDefault()
        e.stopPropagation()
        k.shiftBy(id, e.key === 'ArrowLeft' ? -1 : 1, host.hasAttribute('data-tab-id'))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const tabs: TabInfo[] =
    viewMode === 'tabs'
      ? openPanes.map((id) => {
          const login = isLoginPane(id)
          const accId = login ? accountIdFromLoginPane(id) : wsById.get(id)?.accountId
          return {
            id,
            title: login ? 'Terminal de cuenta' : (wsById.get(id)?.name ?? 'Panel'),
            account: (accId && accountById.get(accId)?.label) || 'cuenta borrada',
            color: colorOf(accId),
            state: login ? undefined : agents[id]?.state,
            perms: permsByWs.get(id)?.length ?? 0
          }
        })
      : []
  const countBy = (s: AgentStatus['state']): number => workspaces.filter((w) => agents[w.id]?.state === s).length
  const needsYou = countBy('waiting')
  const working = countBy('working')
  const done = countBy('done')

  const uiCtx: UiCtx = {
    accounts,
    workspaces,
    statuses,
    usage,
    agents,
    permissions: perms,
    openPanes,
    focused,
    maximized,
    openPane,
    closePane,
    setMaximized,
    restartPane,
    reload,
    openNewWorkspace: (mode) => setNewWsMode(mode),
    notifyError: (m) => setError(m),
    invoke: (channel, ...args) => api.feat.invoke(channel, ...args),
    on: (channel, cb) => api.feat.on(channel, cb)
  }

  return (
    <UiContext.Provider value={uiCtx}>
    <div className={`shell ${docVisible ? '' : 'doc-hidden'}`}>
      <header className="titlebar">
        <div className="titlebar-brand">
          <Wordmark />
        </div>
        <div className="titlebar-status" role="status" aria-live="polite">
          {working > 0 && (
            <span className="tb-chip tb-working">
              <StateIcon state="working" size={12} /> {working} trabajando
            </span>
          )}
          {needsYou > 0 && (
            <span className="tb-chip tb-waiting">
              <StateIcon state="waiting" size={12} /> {needsYou} te {needsYou === 1 ? 'necesita' : 'necesitan'}
            </span>
          )}
          {livePerms.length > 0 && (
            <button
              type="button"
              className="tb-chip tb-perm"
              onClick={() => openPane(livePerms[0].workspaceId)}
              title={`Ir a «${wsById.get(livePerms[0].workspaceId)?.name ?? ''}»`}
            >
              <ShieldWarning size={12} weight="fill" aria-hidden="true" />
              {livePerms.length} {livePerms.length === 1 ? 'permiso' : 'permisos'}
            </button>
          )}
          {done > 0 && (
            <span className="tb-chip tb-done">
              <StateIcon state="done" size={12} /> {done} {done === 1 ? 'terminó' : 'terminaron'}
            </span>
          )}
        </div>
        <div className="titlebar-right">
          <TitlebarSlot />
          <DaemonStatus />
        </div>
        <div className="sr-only" role="alert">
          {announced
            ? `${wsById.get(announced.workspaceId)?.name ?? 'Un espacio'}: Claude quiere usar ${toolLabel(announced.tool)}. Respondé en su panel.`
            : ''}
        </div>
      </header>
    <div className="app">
      <aside className="sidebar" aria-label="Cuentas y espacios">
        <section className="section" aria-labelledby="h-accounts">
          <h2 id="h-accounts" className="section-title">
            Cuentas de Claude <span className="count">{accounts.length}</span>
          </h2>
          {accounts.length === 0 && <p className="hint">Agregá una cuenta para empezar.</p>}
          <ul className="list">
            {accounts.map((acc) => {
              const st = statuses[acc.id]
              const u = usage[acc.id]
              return (
                <li key={acc.id} className="account" style={{ '--acc': colorOf(acc.id) } as React.CSSProperties}>
                  <div className="account-top">
                    <span className="acc-chip" aria-hidden="true">
                      {acc.label.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="grow-min">
                      <div className="item-title">{acc.label}</div>
                      <div className={`item-sub ${st?.loggedIn ? '' : 'warn'}`} title={st?.email}>
                        {st?.loggedIn ? st.email ?? 'Sesión iniciada' : 'Sin sesión'}
                      </div>
                    </div>
                    <button
                      className="icon-btn"
                      onClick={() => openPane(loginPaneId(acc.id))}
                      aria-label={st?.loggedIn ? `Abrir terminal de ${acc.label}` : `Iniciar sesión en ${acc.label}`}
                      title={st?.loggedIn ? 'Terminal de la cuenta' : 'Iniciar sesión'}
                    >
                      {st?.loggedIn ? <TerminalIcon size={16} aria-hidden="true" /> : <SignIn size={16} aria-hidden="true" />}
                    </button>
                    <button className="icon-btn danger" onClick={() => void removeAccount(acc)} aria-label={`Quitar cuenta ${acc.label}`} title="Quitar cuenta">
                      <Trash size={15} aria-hidden="true" />
                    </button>
                  </div>
                  {u && (
                    <dl className="usage" title={usageTitle(u)}>
                      <div>
                        <dt>5 h</dt>
                        <dd>{fmtTok(totalTok(u.last5h))}</dd>
                      </div>
                      <div>
                        <dt>Hoy</dt>
                        <dd>{fmtTok(totalTok(u.today))}</dd>
                      </div>
                      <div>
                        <dt>7 días</dt>
                        <dd>{fmtTok(totalTok(u.last7d))}</dd>
                      </div>
                    </dl>
                  )}
                  <label className="switch" title="Enlaza tus skills, agents, hooks, plugins, settings y MCP de ~/.claude">
                    <span className="switch-text">
                      Usar mi setup de <span className="mono">~/.claude</span>
                    </span>
                    <input type="checkbox" role="switch" checked={acc.shareSetup !== false} onChange={() => void toggleShare(acc)} />
                    <span className="switch-track" aria-hidden="true" />
                  </label>
                </li>
              )
            })}
          </ul>
          <AddAccount onAdd={addAccount} />
        </section>

        <section className="section grow" aria-labelledby="h-ws">
          <div className="section-row">
            <h2 id="h-ws" className="section-title">
              Espacios <span className="count">{workspaces.length}</span>
            </h2>
            <div className="btn-group">
              <button className="btn sm" disabled={accounts.length === 0} onClick={() => setNewWsMode('ticket')} title="Abre Claude con /ticket TCK-…">
                <Ticket size={14} aria-hidden="true" /> Ticket
              </button>
              <button className="btn sm primary" disabled={accounts.length === 0} onClick={() => setNewWsMode('normal')}>
                <Plus size={14} weight="bold" aria-hidden="true" /> Nuevo
              </button>
            </div>
          </div>
          {workspaces.length === 0 && <p className="hint">Un espacio = un repo + una cuenta + una PowerShell.</p>}
          <ul className="list">
            {workspaces.map((ws) => {
              const ag = agents[ws.id]
              const acc = accountById.get(ws.accountId)
              const open = openPanes.includes(ws.id)
              const nPerm = permsByWs.get(ws.id)?.length ?? 0
              return (
                <li key={ws.id} className="ws-li" style={{ '--acc': colorOf(ws.accountId) } as React.CSSProperties}>
                  <button
                    className={`ws ${open ? 'open' : ''} ${focused === ws.id ? 'focused' : ''} ${ag?.state === 'waiting' || nPerm ? 'waiting' : ''}`}
                    onClick={() => openPane(ws.id)}
                    aria-label={`${ws.name}, ${acc?.label ?? 'cuenta borrada'}, ${ag ? STATE_LABEL[ag.state] : 'sin abrir'}${nPerm ? `, ${nPerm === 1 ? 'permiso pendiente' : `${nPerm} permisos pendientes`}` : ''}`}
                  >
                    <StateIcon state={ag?.state} />
                    <span className="grow-min">
                      <span className="item-title">
                        <span className="ws-name">{ws.name}</span>
                        {nPerm > 0 && (
                          <span className="perm-tag">
                            <ShieldWarning size={11} weight="fill" aria-hidden="true" />
                            Permiso{nPerm > 1 ? ` ×${nPerm}` : ''}
                          </span>
                        )}
                      </span>
                      <span className="item-sub">
                        <span className="acc-dot" aria-hidden="true" />
                        <span className="ws-acc">{acc?.label ?? 'cuenta borrada'}</span>
                        {ws.ticket && <span className="tag">{ws.ticket}</span>}
                        <span className="mono ws-where">{ws.branch ?? shortPath(ws.cwd)}</span>
                      </span>
                    </span>
                  </button>
                  <button className="icon-btn danger ws-del" onClick={() => void removeWorkspace(ws)} aria-label={`Quitar espacio ${ws.name}`} title="Quitar espacio">
                    <Trash size={14} aria-hidden="true" />
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
        <SidebarSlot />
      </aside>

      <main className={`panes view-${viewMode} ${openPanes.length === 0 ? 'is-empty' : ''}`} aria-label="Paneles">
        {loaded && openPanes.length === 0 && <EmptyState hasAccounts={accounts.length > 0} hasWs={workspaces.length > 0} />}
        {openPanes.length > 0 && (
          <div className="panes-bar">
            {viewMode === 'tabs' ? (
              <TabBar
                tabs={tabs}
                active={shownTab}
                drag={tabDrag.drag}
                scope={tabsRef}
                onSelect={selectPane}
                onHide={hideTab}
                onPointerDown={tabDrag.onPointerDown}
              />
            ) : maxId ? (
              <div className="panes-bar-info">
                <span className="panes-bar-max">
                  <ArrowsOut size={13} aria-hidden="true" /> Maximizado: <strong>{paneName(maxId)}</strong>
                </span>
                <button type="button" className="panes-bar-link" onClick={() => setMaximized(null)}>
                  Volver a la grilla
                </button>
              </div>
            ) : (
              <div className="panes-bar-info">
                <span className="panes-bar-count">
                  {openPanes.length} {openPanes.length === 1 ? 'panel' : 'paneles'}
                </span>
                {openPanes.length > 1 && (
                  <span className="panes-bar-hint">
                    Arrastrá un panel por su barra para moverlo · <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> · <kbd>Ctrl</kbd>+<kbd>Tab</kbd> cambia
                  </span>
                )}
              </div>
            )}
            <div className="panes-bar-tools">
              {viewMode === 'grid' && nVisible > 1 && !sizesAreEqual(sizes) && (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => {
                    commitSizes(defaultSizes(shape))
                    setLayoutMsg('Paneles repartidos por igual.')
                  }}
                  aria-label="Repartir los paneles por igual"
                  title="Repartir por igual (o doble clic en un separador)"
                >
                  <Equals size={14} aria-hidden="true" />
                </button>
              )}
              <div className="panes-seg" role="group" aria-label="Vista de los paneles">
                <button
                  type="button"
                  className="panes-seg-btn"
                  aria-pressed={viewMode === 'grid'}
                  onClick={() => setViewMode('grid')}
                  title="Grilla: todas las terminales a la vista"
                >
                  <GridFour size={13} aria-hidden="true" />
                  <span>Grilla</span>
                </button>
                <button
                  type="button"
                  className="panes-seg-btn"
                  aria-pressed={viewMode === 'tabs'}
                  onClick={() => setViewMode('tabs')}
                  title="Pestañas: una terminal a la vez (Ctrl+Tab cambia, clic del medio oculta)"
                >
                  <TabsIcon size={13} aria-hidden="true" />
                  <span>Pestañas</span>
                </button>
              </div>
            </div>
          </div>
        )}
        <div ref={areaRef} className="panes-area">
        {openPanes.map((paneId) => {
          const login = isLoginPane(paneId)
          const ws = login ? undefined : wsById.get(paneId)
          const accId = login ? accountIdFromLoginPane(paneId) : ws?.accountId
          const acc = accId ? accountById.get(accId) : undefined
          const ag = ws ? agents[ws.id] : undefined
          const email = acc ? statuses[acc.id]?.email : undefined
          const rect = rectOf.get(paneId)
          const hidden = !rect
          const paneQueue = ws ? permsByWs.get(ws.id) : undefined
          const perm = paneQueue?.[0]
          return (
            <section
              key={paneId}
              data-pane-id={paneId}
              className={`pane ${focused === paneId ? 'focused' : ''} ${ag ? `pane-${ag.state}` : ''} ${perm ? 'pane-perm' : ''} ${hidden ? 'hidden' : ''} ${paneDrag.drag?.id === paneId ? 'dragging' : ''}`}
              style={{ '--acc': colorOf(accId), ...rectVars(rect) } as React.CSSProperties}
              onMouseDown={() => setFocused(paneId)}
              onFocus={() => setFocused(paneId)}
              aria-describedby={canDragPanes ? 'pane-move-hint' : undefined}
              aria-label={login ? `Terminal de la cuenta ${acc?.label}` : `${ws?.name} con ${acc?.label}`}
            >
              <header
                className={`pane-head ${canDragPanes ? 'draggable' : ''}`}
                onPointerDown={canDragPanes ? (e) => paneDrag.onPointerDown(e, paneId) : undefined}
              >
                <span className="pane-id">
                  <span className="acc-dot pane-dot" aria-hidden="true" />
                  <span className="pane-title" title={login ? undefined : ws?.name}>
                    {login ? 'Terminal de cuenta' : ws?.name}
                  </span>
                  {ws?.ticket && <span className="tag">{ws.ticket}</span>}
                  <span className="pane-meta">
                    <span className="acc-badge" title={email}>
                      {acc?.label ?? '?'}
                    </span>
                    {!login && ws && (
                      <span className="pane-path mono" title={ws.cwd}>
                        {shortPath(ws.cwd)}
                      </span>
                    )}
                  </span>
                </span>
                {ag && <StatePill state={ag.state} detail={ag.detail} />}
                <span className="pane-actions">
                <PaneHeaderSlot paneId={paneId} />
                <button
                  className="icon-btn"
                  onClick={() => setMaximized(maximized === paneId ? null : paneId)}
                  hidden={viewMode === 'tabs'}
                  aria-label={maximized === paneId ? 'Volver a la grilla' : 'Maximizar'}
                  title={maximized === paneId ? 'Volver a la grilla' : 'Maximizar'}
                >
                  {maximized === paneId ? <ArrowsIn size={15} aria-hidden="true" /> : <ArrowsOut size={15} aria-hidden="true" />}
                </button>
                <button className="icon-btn" onClick={() => void restartPane(paneId)} aria-label="Reiniciar terminal" title="Cerrar el proceso y abrir otra terminal">
                  <ArrowClockwise size={15} aria-hidden="true" />
                </button>
                <button className="icon-btn" onClick={() => closePane(paneId)} aria-label="Ocultar panel" title="Ocultar (la terminal sigue corriendo)">
                  <EyeSlash size={15} aria-hidden="true" />
                </button>
                </span>
              </header>
              {perm && (
                <PermissionCard
                  key={perm.id}
                  prompt={perm}
                  queued={(paneQueue?.length ?? 1) - 1}
                  now={now}
                  onAnswer={(answer, message) => answerPermission(perm, answer, message)}
                />
              )}
              <PaneBannerSlot paneId={paneId} />
              <TerminalView id={paneId} generation={generations[paneId] ?? 0} onError={onTermError} />
            </section>
          )
        })}
          {viewMode === 'grid' && nVisible > 1 && (
            <Separators shape={shape} sizes={sizes} names={visiblePanes.map(paneName)} area={areaRef} onCommit={commitSizes} />
          )}
          {paneDrag.drag?.target && paneDrag.drag.mode && rectOf.has(paneDrag.drag.target) && (
            <div
              className={`pane-drop ${paneDrag.drag.mode}`}
              style={rectVars(rectOf.get(paneDrag.drag.target)) as React.CSSProperties}
              aria-hidden="true"
            >
              <span className="pane-drop-label">
                <ArrowsLeftRight size={14} aria-hidden="true" />
                {paneDrag.drag.mode === 'swap' ? 'Intercambiar' : paneDrag.drag.mode === 'before' ? 'Mover antes' : 'Mover después'}
              </span>
            </div>
          )}
        </div>
        <div ref={ghostRef} className="drag-ghost" hidden={!dragging} aria-hidden="true">
          <DotsSixVertical size={14} aria-hidden="true" />
          {dragging && <span>{paneName(dragging.id)}</span>}
        </div>
        <span id="pane-move-hint" className="sr-only">
          Ctrl+Alt+flecha izquierda o derecha mueve este panel. Ctrl+Tab pasa al siguiente.
        </span>
        <div className="sr-only" role="status" aria-live="polite">
          {layoutMsg}
        </div>
      </main>


      <GlobalSlot />

      {newWsMode && (
        <NewWorkspaceDialog
          mode={newWsMode}
          accounts={accounts}
          statuses={statuses}
          usage={usage}
          defaultRepo={workspaces[workspaces.length - 1]?.repoPath ?? ''}
          onClose={() => setNewWsMode(null)}
          onCreated={(ws) => {
            setWorkspaces((w) => [...w, ws])
            setNewWsMode(null)
            openPane(ws.id)
          }}
        />
      )}

      {error && (
        <div className="toast" role="alert">
          <WarningCircle size={18} weight="fill" aria-hidden="true" />
          <span className="grow-min">{error}</span>
          <button className="icon-btn" onClick={() => setError(null)} aria-label="Cerrar aviso">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
    </div>
    </UiContext.Provider>
  )
}

/** Fracciones del rectángulo como variables CSS (las usa layout/layout.css). */
function rectVars(r: Rect | undefined): Record<string, number> {
  return r ? { '--x': r.x, '--y': r.y, '--w': r.w, '--h': r.h } : {}
}

/** Enfoca la terminal de un panel; si recién se muestra, reintenta un par de cuadros. */
function focusTerminal(id: string, tries = 8): void {
  const ta = document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(id)}"] .xterm-helper-textarea`)
  if (ta && ta.closest<HTMLElement>('.pane')?.offsetParent !== null) ta.focus()
  else if (tries > 0) requestAnimationFrame(() => focusTerminal(id, tries - 1))
}

function EmptyState({ hasAccounts, hasWs }: { hasAccounts: boolean; hasWs: boolean }): React.JSX.Element {
  const steps = [
    { done: hasAccounts, title: 'Agregá tus cuentas', text: 'Cada una se abre en su propia carpeta para iniciar sesión.' },
    { done: hasWs, title: 'Creá un espacio', text: 'Un repo y una cuenta, o directo desde un ticket.' },
    { done: false, title: 'Abrí varios en paralelo', text: 'Cada uno en su PowerShell, con su estado en vivo.' }
  ]
  return (
    <div className="empty">
      <div className="empty-logo">
        <LogoMark size={72} />
      </div>
      <h1>
        <span>Sloth</span>
      </h1>
      <p className="empty-lead">Varias cuentas de Claude, cada una en su terminal y su repo.</p>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={s.title} className={s.done ? 'done' : ''}>
            <span className="step-n" aria-hidden="true">
              {i + 1}
            </span>
            <div>
              <strong>{s.title}</strong>
              <p>{s.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function AddAccount({ onAdd }: { onAdd: (label: string) => Promise<void> }): React.JSX.Element {
  const [label, setLabel] = useState('')
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (!label.trim()) return
        void onAdd(label).then(() => setLabel(''))
      }}
    >
      <label htmlFor="new-acc" className="sr-only">
        Nombre de la cuenta nueva
      </label>
      <input id="new-acc" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Nueva cuenta: Personal, Trabajo…" />
      <button className="btn icon-only" type="submit" disabled={!label.trim()} aria-label="Agregar cuenta" title="Agregar cuenta">
        <Plus size={14} weight="bold" aria-hidden="true" />
      </button>
    </form>
  )
}
