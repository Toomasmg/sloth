import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
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
  type RevealTarget,
  type Workspace,
  type WorkspacePatch
} from '../../shared/types'
import { api } from './api'
import { UiContext, type NewWorkspacePreset, type PaneGuard, type UiCtx } from './features/host'
import { FEATURE_UIS } from './features/registry'
import { resolveAccountColor, useSettings } from './features/settings/store'
import { openChat, useChatAttach, useChatSnapshot } from './features/chat/store'
import { openSettings } from './features/settings/bus'
import { openHelp } from './features/help/bus'
import { colorHex } from './features/templates/catalog'
import { comboLabel, isCapturingShortcut, matchShortcut } from './shortcuts'
import type { ShortcutId } from '../../main/features/settings-model'
import { GlobalSlot, PaneBannerSlot, PaneHeaderSlot, TitlebarOnly } from './features/slots'
import { openPermissionReview } from './features/permissions/store'
import { PaletteBar, runFeatureCommand } from './features/palette'
import { TerminalView } from './TerminalView'
import { NewWorkspaceDialog } from './NewWorkspaceDialog'
import { ConfirmDialog, type ConfirmRequest } from './ConfirmDialog'
import { EmptyState } from './EmptyState'
import { StateIcon } from './StateIcon'
import { PermissionCard, toolLabel } from './PermissionCard'
import { LogoMark } from './Logo'
import { decidePermission } from './features/permissions/api'
import { setPaneVisible, useDocumentVisible, useVisiblePolling } from './visibility'
import {
  LAYOUT_CAP,
  LAYOUT_LABEL,
  TRES_WIDE_PX,
  cellRects,
  cycle,
  defaultSizes,
  shapeFor,
  loadSizes,
  locatePane,
  movePane,
  sameOrder,
  saveSizes,
  shapeKey,
  shiftPane,
  shiftPaneRow,
  sizesAreEqual,
  type DropMode,
  type Rect,
  type Sizes,
  type ViewMode
} from './layout/logic'
import { onEqualize, safeStorage, setViewMode, useViewMode } from './layout/store'
import { useReorderDrag } from './layout/useReorderDrag'
import { Separators } from './layout/Separators'
import { SIDE_DEFAULT, SideResizer, clampSide, sideMax } from './layout/SideResizer'
import { SleepingCard } from './SleepingCard'
import { openRamas } from './features/worktrees/store'
import { openHistory } from './features/history/index'
import { NavRail } from './layout/NavRail'
import { useNavDest } from './layout/nav'
import { NAV_LABEL } from './layout/nav-model'
import { sortPaneActions, type PaneAction } from './layout/pane-actions'
import { WorkspaceContextMenu, WorkspaceMenuButton } from './layout/WorkspaceMenu'
import { TabBar, type TabInfo } from './layout/TabBar'
import { IconButton, Tag, ToastHost, Tooltip, toast } from './ui'
import './layout/layout.css'
import './layout/shell.css'
import { WorkspaceIconPicker } from './WorkspaceIconPicker'
import { useFolderDrop } from './useFolderDrop'
import './workspace.css'
import { cleanError, shortPath, STATE_LABEL } from './format'
import {
  BroadcastIcon,
  BranchIcon,
  ChatIcon,
  CloseIcon,
  EditorIcon,
  FolderIcon,
  HideIcon,
  HistoryIcon,
  MaximizeIcon,
  PencilIcon,
  PermissionIcon,
  PlusIcon,
  SearchIcon,
  SidebarIcon,
  SpaceIcon,
  TrashIcon,
  UpdateIcon,
  WorktreeIcon
} from './icons/SlothIcons'

/* Íconos que SlothIcons todavía no tiene: mismo trazo (grilla 24, 1,6) que el resto. */
type GlyphProps = { size?: number; 'aria-hidden'?: boolean | 'true' | 'false' }
function Glyph({ size = 16, children }: GlyphProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" focusable="false" style={{ flex: 'none' }}>
      {children}
    </svg>
  )
}
const Equals = (p: GlyphProps): React.JSX.Element => <Glyph {...p}><path d="M5 9h14M5 15h14" /></Glyph>
const DotsSixVertical = (p: GlyphProps): React.JSX.Element => <Glyph {...p}><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" strokeWidth={2.6} /></Glyph>
const ArrowsLeftRight = (p: GlyphProps): React.JSX.Element => <Glyph {...p}><path d="M4 8h15l-3-3M20 16H5l3 3" /></Glyph>
const Smiley = (p: GlyphProps): React.JSX.Element => <Glyph {...p}><circle cx="12" cy="12" r="8" /><path d="M9 10h.01M15 10h.01M9 14.5c.9 1 1.9 1.5 3 1.5s2.1-.5 3-1.5" /></Glyph>

/** Distribución por tecla de Ctrl+Alt+1–4. */
const LAYOUT_BY_DIGIT: Record<string, ViewMode> = { Digit1: 'uno', Digit2: 'dos', Digit3: 'tres', Digit4: 'cuatro' }

/** Estado de la barra lateral y de las cuentas plegadas (preferencias de esta PC). */
const SIDEBAR_KEY = 'sloth.sidebar.shown'
const COLLAPSED_KEY = 'sloth.sidebar.collapsed'
const SIDE_W_KEY = 'sloth.sidebar.width'
function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* sin espacio o bloqueado: la preferencia se pierde, nada más */
  }
}

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
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null)
  const askConfirm = (o: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> => new Promise((resolve) => setConfirmReq({ ...o, resolve }))
  const [newWsMode, setNewWsMode] = useState<null | 'normal' | 'ticket'>(null)
  const [newWsPreset, setNewWsPreset] = useState<NewWorkspacePreset | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const [perms, setPerms] = useState<PermissionPrompt[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [announceId, setAnnounceId] = useState<string | null>(null)
  // Renombrar un espacio desde el sidebar o desde el header de su panel (uno a la vez).
  const [renaming, setRenaming] = useState<{ id: string; from: 'side' | 'pane' } | null>(null)
  // Picker de ícono y menú del espacio en un punto (clic derecho): `back` devuelve el foco a quien los abrió.
  const [iconPick, setIconPick] = useState<{ wsId: string; x: number; y: number; back: () => void } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ paneId: string; from: 'side' | 'pane'; x: number; y: number; back: () => void } | null>(null)
  // Barra lateral: visible o no, cuentas plegadas y filtro de espacios.
  const [sideShown, setSideShown] = useState(() => readStorage(SIDEBAR_KEY) !== '0')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const v = JSON.parse(readStorage(COLLAPSED_KEY) ?? '{}') as unknown
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, boolean>) : {}
    } catch {
      return {}
    }
  })
  const [wsQuery, setWsQuery] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  // Ancho de la barra lateral (tirador): lo guardado o el por defecto; se acota a la ventana al mostrarlo.
  const [sideW, setSideW] = useState(() => {
    const n = Number.parseInt(readStorage(SIDE_W_KEY) ?? '', 10)
    return Number.isFinite(n) ? n : SIDE_DEFAULT
  })
  const [winW, setWinW] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = (): void => setWinW(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const sideWidth = clampSide(sideW, winW)
  const sideBodyRef = useRef<HTMLDivElement>(null)
  const setSideWidth = (w: number): void => {
    const v = clampSide(w, window.innerWidth)
    setSideW(v)
    writeStorage(SIDE_W_KEY, String(v))
  }
  const docVisible = useDocumentVisible()
  const navDest = useNavDest()
  // Un solo lugar para los avisos de error: la cola de ui/Toast (se quedan hasta que se cierran).
  const notifyError = useCallback((m: string): void => void toast({ tone: 'danger', message: m, duration: 0 }), [])

  useEffect(() => writeStorage(COLLAPSED_KEY, JSON.stringify(collapsed)), [collapsed])

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
    await decidePermission(p, answer, message)
    setPerms((prev) => prev.filter((x) => x.id !== p.id))
    // El botón que tenía el foco desaparece: pasarlo al próximo permiso del panel o a la terminal.
    requestAnimationFrame(() => {
      const pane = document.querySelector(`[data-pane-id="${CSS.escape(p.workspaceId)}"]`)
      const next = pane?.querySelector<HTMLElement>('[data-perm-primary]')
      const term = pane?.querySelector<HTMLElement>('.xterm-helper-textarea')
      ;(next ?? term)?.focus()
    })
  }

  // Color de cuenta: el elegido en Configuración o el automático (se re-renderiza al cambiarlo).
  const appSettings = useSettings()
  const colorOf = (accountId?: string): string =>
    resolveAccountColor(accountId, accountId ? (accountIndex.get(accountId) ?? 0) : 0, appSettings)

  // Guardas antes de ocultar/reiniciar desde el header o la pestaña (ver UiCtx.onBeforeClosePane).
  const paneGuards = useRef(new Set<PaneGuard>())
  const onBeforeClosePane = useCallback((g: PaneGuard): (() => void) => {
    paneGuards.current.add(g)
    return () => void paneGuards.current.delete(g)
  }, [])
  const allowPaneAction = async (id: string, action: 'hide' | 'restart'): Promise<boolean> => {
    for (const g of [...paneGuards.current]) {
      try {
        if ((await g(id, action)) === false) return false
      } catch (e) {
        console.error('[guarda de panel]', e)
      }
    }
    return true
  }
  const requestHidePane = async (id: string): Promise<void> => {
    if (await allowPaneAction(id, 'hide')) closePane(id)
  }
  const requestClosePane = async (id: string): Promise<void> => {
    if (agents[id]?.state === 'working' && !(await askConfirm({ title: '¿Cerrar el panel?', body: 'Claude está trabajando en este panel. Si lo cerrás, se corta la terminal y lo que está haciendo.', yes: 'Cerrar panel', no: 'Seguir trabajando' }))) return
    if (!(await allowPaneAction(id, 'hide'))) return
    closePane(id)
    try {
      await api.ptyKill(id)
    } catch (e) {
      notifyError(cleanError(e))
    }
  }
  const requestRestartPane = async (id: string): Promise<void> => {
    if (await allowPaneAction(id, 'restart')) await restartPane(id)
  }


  const removeAccount = async (acc: Account): Promise<void> => {
    const n = workspaces.filter((w) => w.accountId === acc.id).length
    const body = n === 0 ? 'Se saca de Sloth. Podés volver a agregarla cuando quieras.' : `Sus ${n === 1 ? '1 espacio queda' : `${n} espacios quedan`} sin cuenta: podés moverlos a otra cuenta o quitarlos.`
    if (!(await askConfirm({ title: `¿Quitar la cuenta «${acc.label}»?`, body, yes: 'Quitar cuenta' }))) return
    try {
      await api.removeAccount(acc.id)
      setAccounts((a) => a.filter((x) => x.id !== acc.id))
      closePane(loginPaneId(acc.id))
    } catch (e) {
      notifyError(cleanError(e))
    }
  }

  const toggleShare = async (acc: Account): Promise<void> => {
    const next = acc.shareSetup === false
    try {
      await api.setShareSetup(acc.id, next)
      setAccounts((list) => list.map((a) => (a.id === acc.id ? { ...a, shareSetup: next } : a)))
    } catch (e) {
      notifyError(cleanError(e))
    }
  }

  const removeWorkspace = async (ws: Workspace): Promise<void> => {
    const files = ws.branch ? `El worktree en ${ws.cwd} queda en disco.` : 'Los archivos de la carpeta no se tocan.'
    const working = agents[ws.id]?.state === 'working' ? ' Claude está trabajando ahí: se corta lo que hace.' : ''
    if (!(await askConfirm({ title: `¿Quitar el espacio «${ws.name}»?`, body: `Se cierra su terminal. ${files}${working}`, yes: 'Quitar espacio' }))) return
    try {
      await api.removeWorkspace(ws.id)
      setWorkspaces((w) => w.filter((x) => x.id !== ws.id))
      setOpenPanesState((p) => p.filter((x) => x !== ws.id))
    } catch (e) {
      notifyError(cleanError(e))
    }
  }

  // v0.5 · espacios: cambios por IPC (validados en main), abrir en VS Code / carpeta, soltar carpeta.
  const patchWorkspace = async (ws: Workspace, patch: WorkspacePatch): Promise<void> => {
    try {
      const updated = await api.updateWorkspace(ws.id, patch)
      setWorkspaces((list) => list.map((w) => (w.id === ws.id ? updated : w)))
    } catch (e) {
      notifyError(cleanError(e))
    }
  }
  const revealWs = async (ws: Workspace, target: RevealTarget): Promise<void> => {
    try {
      await api.revealWorkspace(ws.id, target)
    } catch (e) {
      notifyError(cleanError(e))
    }
  }
  /** Cierra la edición y devuelve el foco. `next` null = cancelar. */
  const endRename = (ws: Workspace, from: 'side' | 'pane', next: string | null): void => {
    setRenaming(null)
    if (next !== null && next !== ws.name) void patchWorkspace(ws, { name: next })
    requestAnimationFrame(() => {
      if (from === 'side') document.querySelector<HTMLElement>(`[data-ws-btn="${CSS.escape(ws.id)}"]`)?.focus()
      else focusTerminal(ws.id)
    })
  }
  const openIconPicker = (wsId: string, x: number, y: number, back: () => void): void => setIconPick({ wsId, x, y, back })
  const dropActive = useFolderDrop({
    canCreate: accounts.length > 0,
    onFolder: (repoPath, name) => {
      setNewWsPreset({ repoPath, name })
      setNewWsMode('normal')
    },
    onError: (m) => notifyError(m)
  })

  const onTermError = notifyError

  // ---------- Layout de paneles: distribución (Uno/Dos/Cuatro), proporciones y orden ----------
  const viewMode = useViewMode()
  const cap = LAYOUT_CAP[viewMode]
  const areaRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const [layoutMsg, setLayoutMsg] = useState('')
  const maxId = maximized && cap > 1 && openPanes.includes(maximized) ? maximized : null
  // El panel activo siempre está a la vista. Con más paneles que la distribución, se ven `cap` seguidos
  // que incluyen al activo; los demás quedan en la barra de pestañas (y montados, con display:none).
  const activeId = maxId ?? (focused && openPanes.includes(focused) ? focused : (openPanes[0] ?? null))
  const winStart =
    openPanes.length <= cap || !activeId
      ? 0
      : Math.max(0, Math.min(openPanes.indexOf(activeId) - (cap - 1), openPanes.length - cap))
  const visiblePanes = maxId ? [maxId] : openPanes.slice(winStart, winStart + cap)
  const nVisible = visiblePanes.length
  const shape = useMemo(() => shapeFor(viewMode, nVisible, winW >= TRES_WIDE_PX), [viewMode, nVisible, winW])
  const shapeK = shapeKey(shape)
  const [sizeOverrides, setSizeOverrides] = useState<Record<string, Sizes>>({})
  const sizes = useMemo(() => sizeOverrides[shapeK] ?? loadSizes(safeStorage(), shape), [sizeOverrides, shapeK, shape])
  const rects = useMemo(() => cellRects(shape, sizes), [shape, sizes])
  const rectOf = new Map(visiblePanes.map((id, i) => [id, rects[i]]))
  // Qué paneles se ven en la grilla (los de pestañas quedan ocultos): lo miran terminales y el botón de Git.
  useEffect(() => {
    for (const id of openPanes) setPaneVisible(id, rectOf.has(id))
  })
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
  const canDragPanes = cap > 1 && nVisible > 1

  const hideTab = async (id: string): Promise<void> => {
    if (!(await allowPaneAction(id, 'hide'))) return
    const i = openPanes.indexOf(id)
    const neighbor = openPanes[i + 1] ?? openPanes[i - 1]
    closePane(id)
    if (id === activeId && neighbor) setFocused(neighbor)
  }

  // Atajos: Ctrl+Tab / Ctrl+Shift+Tab cambian de panel; Ctrl+Alt+← / → mueven el panel enfocado.
  const kbRef = useRef({
    count: 0,
    cycleBy: (_d: 1 | -1): void => {},
    shiftBy: (_id: string, _d: number, _tab: boolean): void => {},
    shiftRowBy: (_id: string, _d: -1 | 1): void => {}
  })
  kbRef.current = {
    shiftRowBy: (id, d) => {
      if (cap < 2 || maxId) {
        setLayoutMsg('Cambiar de fila funciona con los paneles en grilla, sin maximizar.')
        return
      }
      const shape = shapeFor(viewMode, openPanes.length, winW >= TRES_WIDE_PX)
      const next = shiftPaneRow(openPanes, id, d, shape)
      if (sameOrder(next, openPanes)) {
        setLayoutMsg(`«${paneName(id)}» no tiene fila ${d < 0 ? 'arriba' : 'abajo'} a donde moverse.`)
        return
      }
      setOpenPanes(() => next)
      const at = locatePane(next, id, shape)
      setLayoutMsg(at ? `«${paneName(id)}» quedó en la fila ${at.row + 1}, columna ${at.col + 1}.` : `«${paneName(id)}» cambió de fila.`)
      requestAnimationFrame(() => focusTerminal(id))
    },
    count: openPanes.length,
    cycleBy: (d) => {
      const next = cycle(openPanes, activeId, d)
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
      if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const host = ae?.closest<HTMLElement>('[data-pane-id], [data-tab-id]')
        const id = host?.getAttribute('data-pane-id') ?? host?.getAttribute('data-tab-id')
        if (!host || !id) return
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') k.shiftRowBy(id, e.key === 'ArrowUp' ? -1 : 1)
        else k.shiftBy(id, e.key === 'ArrowLeft' ? -1 : 1, host.hasAttribute('data-tab-id'))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Atajos de la ventana, todos configurables (matchShortcut). Dentro de una terminal, esas teclas son de la
  // shell: solo funcionan fuera de ella (como antes). Ctrl+K y Ctrl+, están en su propio componente.
  const toggleSide = (): void => {
    const next = !sideShown
    setSideShown(next)
    writeStorage(SIDEBAR_KEY, next ? '1' : '0')
  }
  const accountsRef = useRef(accounts)
  accountsRef.current = accounts
  const winKeys = useRef({
    side: () => {},
    newWs: () => {},
    rename: (): boolean => false,
    layout: (_m: ViewMode) => {},
    chat: () => {},
    broadcastNow: () => {}
  })
  winKeys.current = {
    side: toggleSide,
    newWs: () => setNewWsMode('normal'),
    rename: () => {
      // Renombra el panel activo (no un terminal de cuenta ni un espacio ya borrado).
      if (!focused || isLoginPane(focused) || !wsById.has(focused)) return false
      setRenaming({ id: focused, from: 'pane' })
      return true
    },
    layout: (m) => pickLayout(m),
    chat: () => openChat(),
    broadcastNow: () => {
      runFeatureCommand('broadcast:open', uiCtx)
      focusBroadcastText()
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || isCapturingShortcut()) return
      const k = winKeys.current
      const ae = document.activeElement
      const inTerm = !!ae?.closest('.terminal-host')
      const typing = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || (ae as HTMLElement).isContentEditable)
      // Ctrl+1–4 van también desde la terminal (como Ctrl+Tab y Ctrl+Alt+flechas): no son teclas de la shell.
      const focusN = FOCUS_IDS.findIndex((id) => matchShortcut(id, e))
      if (focusN >= 0) {
        e.preventDefault()
        e.stopPropagation()
        focusVisiblePane(focusN + 1)
      } else if (matchShortcut('help', e)) {
        // F1 es de la terminal cuando está enfocada (p. ej. vim o less): solo fuera de ella.
        if (inTerm) return
        e.preventDefault()
        openHelp('ayuda')
      } else if (matchShortcut('broadcastNow', e)) {
        if (inTerm) return
        e.preventDefault()
        k.broadcastNow()
      } else if (matchShortcut('sidebar', e)) {
        if (inTerm) return
        e.preventDefault()
        k.side()
      } else if (matchShortcut('new', e)) {
        if (inTerm || accountsRef.current.length === 0) return
        e.preventDefault()
        k.newWs()
      } else if (matchShortcut('rename', e)) {
        // En la lista de espacios, F2 lo maneja la fila (su propio botón). Escribiendo, no se toca.
        if (inTerm || typing || ae?.closest('.sl-side')) return
        if (k.rename()) e.preventDefault()
      } else if (matchShortcut('chat', e)) {
        if (inTerm) return
        e.preventDefault()
        k.chat()
      } else if (e.ctrlKey && e.altKey && !e.shiftKey && LAYOUT_BY_DIGIT[e.code]) {
        // Distribución fija (Ctrl+Alt+1–4): no se graba en Configuración.
        if (inTerm) return
        e.preventDefault()
        k.layout(LAYOUT_BY_DIGIT[e.code])
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const tabs: TabInfo[] = openPanes.map((id) => {
    const login = isLoginPane(id)
    const accId = login ? accountIdFromLoginPane(id) : wsById.get(id)?.accountId
    return {
      id,
      title: login ? 'Terminal de cuenta' : (wsById.get(id)?.name ?? 'Panel'),
      account: (accId && accountById.get(accId)?.label) || 'cuenta borrada',
      state: login ? undefined : agents[id]?.state,
      perms: permsByWs.get(id)?.length ?? 0,
      icon: login ? undefined : wsById.get(id)?.icon,
      onScreen: rectOf.has(id)
    }
  })
  const countBy = (s: AgentStatus['state']): number => workspaces.filter((w) => agents[w.id]?.state === s).length
  const needsYou = countBy('waiting')
  const working = countBy('working')
  const done = countBy('done')
  /** Pedidos de permiso vivos (uno o más por espacio). El chip del resumen los cuenta; no se repiten en otro lado. */
  const pendingPerms = [...permsByWs.values()].reduce((n, q) => n + q.length, 0)
  const activeTerms = workspaces.filter((w) => agents[w.id] && agents[w.id].state !== 'exited' && agents[w.id].state !== 'sleeping').length
  /** Primer espacio con ese estado (para ir al tocar un resumen). */
  const firstWs = (s: AgentStatus['state']): Workspace | undefined => workspaces.find((w) => agents[w.id]?.state === s)

  const editorName = appSettings.settings.editor
  const editorLabel = editorName === 'Bloc de notas' ? 'carpeta' : editorName

  /** Picker de ícono al lado de la fila de la barra lateral o del título del panel. */
  const pickIconFor = (wsId: string, from: 'side' | 'pane'): void => {
    if (from === 'pane') openPane(wsId)
    requestAnimationFrame(() => {
      const sel = from === 'side' ? `[data-ws-btn="${CSS.escape(wsId)}"]` : `[data-pane-id="${CSS.escape(wsId)}"] .pane-title`
      const r = document.querySelector<HTMLElement>(sel)?.getBoundingClientRect()
      const back = (): void => {
        if (from === 'side') document.querySelector<HTMLElement>(`[data-ws-btn="${CSS.escape(wsId)}"]`)?.focus()
        else focusTerminal(wsId)
      }
      openIconPicker(wsId, r?.left ?? 120, (r?.bottom ?? 120) + 6, back)
    })
  }

  /**
   * Acciones del núcleo para un panel o espacio. `from` dice dónde se pidió: renombrar y el ícono se
   * hacen ahí mismo (en la fila de la barra lateral o en la cabecera del panel).
   */
  const coreActions = (paneId: string, from: 'side' | 'pane'): PaneAction[] => {
    const ws = isLoginPane(paneId) ? undefined : wsById.get(paneId)
    const list: PaneAction[] = []
    if (ws) {
      list.push(
        {
          id: 'rename',
          label: 'Renombrar',
          group: 'editar',
          order: 10,
          shortcut: 'F2',
          icon: <PencilIcon size={15} />,
          run: () => {
            if (from === 'pane') openPane(ws.id)
            setRenaming({ id: ws.id, from })
          }
        },
        { id: 'icon', label: 'Cambiar ícono', group: 'editar', order: 20, icon: <Smiley size={15} />, run: () => pickIconFor(ws.id, from) },
        { id: 'historial', label: 'Historial de este espacio', group: 'ver', order: 20, icon: <HistoryIcon size={15} />, run: () => openHistory(ws.id) },
        { id: 'ramas', label: 'Ramas aparte de este repo', group: 'ver', order: 30, icon: <WorktreeIcon size={15} />, run: () => openRamas(null, ws.repoPath) },
        ...(editorLabel === 'carpeta'
          ? []
          : [{ id: 'vscode', label: `Abrir en ${editorLabel}`, group: 'abrir' as const, order: 10, icon: <EditorIcon size={15} />, run: () => void revealWs(ws, 'vscode') }]),
        { id: 'folder', label: 'Abrir carpeta', group: 'abrir', order: 20, icon: <FolderIcon size={15} />, run: () => void revealWs(ws, 'folder') },
        { id: 'remove', label: 'Quitar espacio', group: 'quitar', order: 10, danger: true, icon: <TrashIcon size={15} />, run: () => void removeWorkspace(ws) }
      )
    }
    if (openPanes.includes(paneId)) {
      list.push(
        { id: 'restart', label: 'Reiniciar terminal', hint: 'cierra el proceso', group: 'panel', order: 10, icon: <UpdateIcon size={15} />, run: () => void requestRestartPane(paneId) },
        { id: 'hide', label: 'Ocultar panel', hint: 'la terminal sigue', group: 'panel', order: 20, icon: <HideIcon size={15} />, run: () => void requestHidePane(paneId) },
        { id: 'close', label: 'Cerrar panel', hint: 'corta la terminal', group: 'panel', order: 30, icon: <CloseIcon size={15} />, run: () => void requestClosePane(paneId) }
      )
    }
    return list
  }

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
    openNewWorkspace: (mode, preset) => {
      setNewWsPreset(preset)
      setNewWsMode(mode)
    },
    onBeforeClosePane,
    notifyError,
    paneActions: (paneId) => actionsFor(paneId, 'pane'),
    invoke: (channel, ...args) => api.feat.invoke(channel, ...args),
    on: (channel, cb) => api.feat.on(channel, cb)
  }
  /** Lo que muestra el menú del espacio: lo del núcleo más lo que suma cada función, en un solo orden. */
  function actionsFor(paneId: string, from: 'side' | 'pane'): PaneAction[] {
    const extra: PaneAction[] = []
    for (const f of FEATURE_UIS) {
      if (!f.paneActions) continue
      try {
        extra.push(...f.paneActions(uiCtx, paneId))
      } catch (e) {
        console.error(`[función ${f.name}]`, e)
      }
    }
    return sortPaneActions([...coreActions(paneId, from), ...extra])
  }
  // Chat del equipo: el botón de la barra muestra los no leídos (useChatAttach conecta la función).
  useChatAttach(uiCtx)
  const chatUnread = useChatSnapshot()?.unreadTotal ?? 0

  // Distribución elegida (se guarda en esta PC). Uno = 1 a la vista; Dos = 2; Tres = 3; Cuatro = 4.
  const pickLayout = (k: ViewMode): void => {
    setViewMode(k)
    if (maximized) setMaximized(null)
    setLayoutMsg(`Distribución ${LAYOUT_LABEL[k]}: hasta ${LAYOUT_CAP[k]} ${LAYOUT_CAP[k] === 1 ? 'panel' : 'paneles'} a la vista. El resto queda en pestañas.`)
  }
  const openBroadcast = (): void =>
    workspaces.length ? runFeatureCommand('broadcast:open', uiCtx) : notifyError('Abrí un espacio con la terminal para mandarle un mensaje.')

  // Ubicación corta en la barra superior: el destino, o «cuenta › espacio» del panel enfocado.
  const focusedAccId = focused ? (isLoginPane(focused) ? accountIdFromLoginPane(focused) : wsById.get(focused)?.accountId) : undefined
  const crumbAccount = focusedAccId ? (accountById.get(focusedAccId)?.label ?? 'cuenta borrada') : null

  const openSideMenu = (ws: Workspace, x: number, y: number): void =>
    setCtxMenu({ paneId: ws.id, from: 'side', x, y, back: () => document.querySelector<HTMLElement>(`[data-ws-btn="${CSS.escape(ws.id)}"]`)?.focus() })

  const renderWs = (ws: Workspace): React.JSX.Element => {
    const ag = agents[ws.id]
    const acc = accountById.get(ws.accountId)
    const open = openPanes.includes(ws.id)
    const nPerm = permsByWs.get(ws.id)?.length ?? 0
    const editing = renaming?.id === ws.id && renaming.from === 'side'
    // En reposo no hay glifo: solo se marca lo que pide mirar (trabaja, espera, terminó, permiso).
    const glyph = nPerm > 0 ? <PermissionIcon size={13} className="ic ic-waiting" /> : ag && ag.state !== 'idle' ? <StateIcon state={ag.state} size={12} /> : null
    const where = ws.branch ?? shortPath(ws.cwd)
    return (
      <li
        key={ws.id}
        className="sl-li"
        data-account-id={ws.accountId}
        onContextMenu={(e) => {
          e.preventDefault()
          openSideMenu(ws, e.clientX, e.clientY)
        }}
      >
        {editing ? (
          <div className="ws-edit">
            <RenameInput className="ws-rename" initial={ws.name} label={`Nuevo nombre del espacio ${ws.name}`} onDone={(next) => endRename(ws, 'side', next)} />
          </div>
        ) : (
          <button
            type="button"
            className={`sl-row ${open ? 'open' : ''} ${focused === ws.id && open ? 'focused' : ''}`}
            data-ws-btn={ws.id}
            onClick={() => openPane(ws.id)}
            onDoubleClick={() => setRenaming({ id: ws.id, from: 'side' })}
            onKeyDown={(e) => {
              if (e.key === 'F2') {
                e.preventDefault()
                setRenaming({ id: ws.id, from: 'side' })
              } else if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                openSideMenu(ws, r.left + 24, r.bottom + 2)
              }
            }}
            aria-label={`${ws.icon ? `${ws.icon} ` : ''}${ws.name}, ${acc?.label ?? 'cuenta borrada'}, ${ag ? STATE_LABEL[ag.state] : 'sin abrir'}${nPerm ? `, ${nPerm === 1 ? 'permiso pendiente' : `${nPerm} permisos pendientes`}` : ''}`}
            title={`${ws.name} · ${where}\nDoble clic o F2 para renombrar · clic derecho para más opciones`}
          >
            <span className={`sl-ico${ws.icon ? ' has-emoji' : ''}`} aria-hidden="true" style={ws.color ? ({ '--ws': colorHex(ws.color) } as CSSProperties) : undefined}>
              {ws.icon ?? null}
            </span>
            <span className="sl-name">{ws.name}</span>
            {ws.ticket && <Tag>{ws.ticket}</Tag>}
            {glyph && <span className="sl-glyph">{glyph}</span>}
            {nPerm > 1 && <span className="sl-perm-n">{nPerm}</span>}
          </button>
        )}
      </li>
    )
  }

  const q = wsQuery.trim().toLowerCase()
  const matchWs = (ws: Workspace): boolean => !q || (ws.name + ' ' + (ws.branch ?? '') + ' ' + (ws.ticket ?? '')).toLowerCase().includes(q)
  const orphans = workspaces.filter((w) => !accountById.has(w.accountId))
  const menuWs = ctxMenu ? wsById.get(ctxMenu.paneId) : undefined

  return (
    <UiContext.Provider value={uiCtx}>
      <div className={`sl-shell ${docVisible ? '' : 'doc-hidden'}`}>
        <header className="sl-top">
          <div className="sl-top-left">
            <IconButton
              label={sideShown ? 'Ocultar la barra lateral' : 'Mostrar la barra lateral'}
              shortcut={comboLabel('sidebar')}
              icon={<SidebarIcon size={17} />}
              pressed={sideShown}
              disabled={navDest !== 'espacios'}
              onClick={toggleSide}
            />
            <LogoMark size={26} />
            <nav className="sl-where" aria-label="Ubicación">
              {navDest !== 'espacios' ? (
                <strong>{NAV_LABEL[navDest]}</strong>
              ) : focused && openPanes.includes(focused) ? (
                <>
                  {crumbAccount && <span className="sl-where-acc">{crumbAccount}</span>}
                  {crumbAccount && <span aria-hidden="true">›</span>}
                  <strong>{paneName(focused)}</strong>
                </>
              ) : (
                <strong>Espacios</strong>
              )}
            </nav>
          </div>
          <div className="sl-top-search">
            <PaletteBar />
          </div>
          <div className="sl-top-right">
            <div className="sl-top-status" role="status" aria-live="polite">
              {pendingPerms > 0 && (
                <button type="button" className="sl-sum is-waiting" onClick={() => openPermissionReview()} title="Revisar los pedidos de permiso">
                  <PermissionIcon size={12} />
                  {pendingPerms === 1 ? '1 pide permiso' : `${pendingPerms} piden permiso`}
                </button>
              )}
              {needsYou > 0 && (
                <button type="button" className="sl-sum is-waiting" onClick={() => { const w = firstWs('waiting'); if (w) openPane(w.id) }} title="Ir al que te espera">
                  <StateIcon state="waiting" size={12} />
                  {needsYou} te {needsYou === 1 ? 'espera' : 'esperan'}
                </button>
              )}
              {working > 0 && (
                <button type="button" className="sl-sum is-working" onClick={() => { const w = firstWs('working'); if (w) openPane(w.id) }} title="Ir al primero que está trabajando">
                  <StateIcon state="working" size={12} />
                  {working} trabajando
                </button>
              )}
              {done > 0 && (
                <button type="button" className="sl-sum is-done" onClick={() => { const w = firstWs('done'); if (w) openPane(w.id) }} title="Ir al que terminó">
                  <StateIcon state="done" size={12} />
                  {done} {done === 1 ? 'listo' : 'listos'}
                </button>
              )}
            </div>
            <div className="sl-upd">
              <TitlebarOnly name="updater" />
            </div>
            <Tooltip text="Chat del equipo" shortcut={comboLabel('chat')}>
              <button type="button" className="sl-chat" onClick={() => openChat()} aria-label={chatUnread > 0 ? `Chat del equipo, ${chatUnread} sin leer` : 'Chat del equipo'}>
                <ChatIcon size={17} aria-hidden="true" />
                {chatUnread > 0 && (
                  <span className="sl-chat-badge" aria-hidden="true">
                    {chatUnread > 99 ? '99+' : chatUnread}
                  </span>
                )}
              </button>
            </Tooltip>
          </div>
          <div className="sr-only" role="alert">
            {announced
              ? `${wsById.get(announced.workspaceId)?.name ?? 'Un espacio'}: Claude quiere usar ${toolLabel(announced.tool)}. Respondé en su panel.`
              : ''}
          </div>
        </header>

        <NavRail />

        <div ref={sideBodyRef} className={`sl-body ${sideShown ? '' : 'no-side'}`} style={{ '--side-w': `${sideWidth}px` } as CSSProperties}>
          <aside className="sl-side" aria-label="Cuentas y espacios">
            <div className="sl-side-head">
              <h2 className="sl-side-title">Espacios</h2>
              <IconButton
                label="Buscar un espacio"
                icon={<SearchIcon size={15} />}
                size="sm"
                pressed={filterOpen}
                onClick={() => {
                  if (filterOpen) setWsQuery('')
                  setFilterOpen(!filterOpen)
                }}
              />
            </div>
            {filterOpen && (
              <input
                className="sl-filter"
                type="search"
                autoFocus
                value={wsQuery}
                onChange={(e) => setWsQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return
                  e.preventDefault()
                  e.stopPropagation()
                  setWsQuery('')
                  setFilterOpen(false)
                }}
                placeholder="Filtrar por nombre, rama o ticket"
                aria-label="Filtrar espacios"
                spellCheck={false}
              />
            )}

            <div className="sl-groups">
              {accounts.length === 0 && (
                <section className="sl-acc-none" aria-label="Sin cuentas">
                  <p className="sl-hint">Agregá una cuenta de Claude para crear tu primer espacio.</p>
                  <button type="button" className="sl-newbtn" onClick={() => openSettings('cuentas')}>
                    <PlusIcon size={15} />
                    Agregar cuenta
                  </button>
                </section>
              )}

              {accounts.map((acc) => {
                const st = statuses[acc.id]
                const mine = workspaces.filter((w) => w.accountId === acc.id)
                const shown = mine.filter(matchWs)
                if (q && shown.length === 0) return null
                const open = !collapsed[acc.id] || !!q
                const bodyId = `acc-body-${acc.id}`
                const plan = appSettings.settings.accountPlans[acc.id]
                return (
                  <section key={acc.id} className="sl-acc" data-account-id={acc.id} aria-label={`Cuenta ${acc.label}`} style={{ '--acc': colorOf(acc.id) } as CSSProperties}>
                    <div className="sl-acc-head">
                      <button
                        type="button"
                        className="sl-acc-toggle"
                        aria-expanded={open}
                        aria-controls={bodyId}
                        aria-label={`Mostrar u ocultar los espacios de ${acc.label}`}
                        title={st?.email ? `${acc.label} · ${st.email}` : acc.label}
                        onClick={() => setCollapsed((c) => ({ ...c, [acc.id]: open }))}
                      >
                        <span className="sl-avatar" aria-hidden="true">
                          {acc.label.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="sl-acc-name">{acc.label}</span>
                        {st?.loggedIn ? plan && <span className="sl-acc-plan">{plan}</span> : <span className="sl-acc-warn">Sin sesión</span>}
                      </button>
                      <IconButton
                        label={`Nuevo espacio en ${acc.label}`}
                        icon={<PlusIcon size={14} />}
                        size="sm"
                        className="sl-acc-add"
                        onClick={() => {
                          setNewWsPreset({ accountId: acc.id })
                          setNewWsMode('normal')
                        }}
                      />
                    </div>
                    {open && (
                      <div id={bodyId}>
                        {shown.length > 0 ? <ul className="sl-list">{shown.map(renderWs)}</ul> : <p className="sl-acc-empty">Sin espacios. Usá el + de la cuenta para crear uno.</p>}
                      </div>
                    )}
                  </section>
                )
              })}

              {orphans.length > 0 && (
                <section className="sl-acc" aria-label="Espacios de una cuenta borrada">
                  <div className="sl-acc-head">
                    <span className="sl-acc-toggle is-static">
                      <span className="sl-acc-name">Cuenta borrada</span>
                    </span>
                  </div>
                  <ul className="sl-list">{orphans.filter(matchWs).map(renderWs)}</ul>
                </section>
              )}

              {q && accounts.every((acc) => !workspaces.some((w) => w.accountId === acc.id && matchWs(w))) && !orphans.some(matchWs) && (
                <p className="sl-hint">Ningún espacio coincide con «{wsQuery.trim()}».</p>
              )}
            </div>

            <div className="sl-foot">
              <button type="button" className="sl-newbtn" onClick={() => (accounts.length ? setNewWsMode('normal') : openSettings('cuentas'))} title={accounts.length ? undefined : 'Primero agregá una cuenta de Claude'}>
                <PlusIcon size={15} />
                Nuevo espacio
                <kbd>{comboLabel('new')}</kbd>
              </button>
            </div>
          </aside>

          <main className={`panes sl-main view-${viewMode} ${openPanes.length === 0 ? 'is-empty' : ''}`} aria-label="Paneles">
            {loaded && openPanes.length === 0 && <EmptyState onCreate={() => (accounts.length ? setNewWsMode('normal') : openSettings('cuentas'))} />}
            {openPanes.length > 0 && (
              <div className="sl-tabbar">
                <TabBar
                  tabs={tabs}
                  active={activeId}
                  drag={tabDrag.drag}
                  scope={tabsRef}
                  onSelect={selectPane}
                  onHide={hideTab}
                  onPointerDown={tabDrag.onPointerDown}
                  onMenu={(id, x, y) =>
                    setCtxMenu({ paneId: id, from: 'pane', x, y, back: () => tabsRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`)?.focus() })
                  }
                />
                <div className="sl-tabbar-tools">
                  {cap > 1 && nVisible > 1 && !sizesAreEqual(sizes) && (
                    <IconButton
                      label="Repartir los paneles por igual"
                      icon={<Equals size={14} />}
                      size="sm"
                      onClick={() => {
                        commitSizes(defaultSizes(shape))
                        setLayoutMsg('Paneles repartidos por igual.')
                      }}
                    />
                  )}
                  <button type="button" className="sl-bcast" onClick={openBroadcast} aria-label="Enviar a varios espacios" title={`Mandar un mensaje a varios espacios (${comboLabel('broadcast')})`}>
                    <BroadcastIcon size={14} aria-hidden="true" />
                    Enviar a varios
                  </button>
                  <div className="sl-layout" role="group" aria-label="Distribución de paneles">
                    {(['uno', 'dos', 'tres', 'cuatro'] as const).map((k, i) => (
                      <Tooltip key={k} text={`${LAYOUT_LABEL[k]}: ${LAYOUT_CAP[k] === 1 ? '1 panel' : `hasta ${LAYOUT_CAP[k]} paneles`} a la vista`} shortcut={`Ctrl+Alt+${i + 1}`}>
                        <button type="button" aria-pressed={viewMode === k} aria-label={`${LAYOUT_LABEL[k]}: ${LAYOUT_CAP[k] === 1 ? '1 panel' : `hasta ${LAYOUT_CAP[k]} paneles`} a la vista`} onClick={() => pickLayout(k)}>
                          {i + 1}
                        </button>
                      </Tooltip>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {cap > 1 && maxId && (
              <div className="sl-maxnote">
                <MaximizeIcon size={13} aria-hidden="true" />
                Maximizado: <strong>{paneName(maxId)}</strong>
                <button type="button" onClick={() => setMaximized(null)}>
                  Volver a la grilla
                </button>
              </div>
            )}
            <div ref={areaRef} className="panes-area">
              {openPanes.map((paneId) => {
                const login = isLoginPane(paneId)
                const ws = login ? undefined : wsById.get(paneId)
                const accId = login ? accountIdFromLoginPane(paneId) : ws?.accountId
                const acc = accId ? accountById.get(accId) : undefined
                const ag = ws ? agents[ws.id] : undefined
                const rect = rectOf.get(paneId)
                const hidden = !rect
                const paneQueue = ws ? permsByWs.get(ws.id) : undefined
                const perm = paneQueue?.[0]
                const title = login ? 'Terminal de cuenta' : (ws?.name ?? '')
                const showState = !!ag && ag.state !== 'idle' && !perm
                return (
                  <section
                    key={paneId}
                    data-pane-id={paneId}
                    data-account-id={accId}
                    className={`pane ${focused === paneId ? 'focused' : ''} ${ag ? `pane-${ag.state}` : ''} ${perm ? 'pane-perm' : ''} ${hidden ? 'hidden' : ''} ${paneDrag.drag?.id === paneId ? 'dragging' : ''}`}
                    style={{ '--acc': colorOf(accId), ...rectVars(rect) } as CSSProperties}
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
                        {ws?.icon && (
                          <span className="pane-emoji" aria-hidden="true">
                            {ws.icon}
                          </span>
                        )}
                        {ws && renaming?.id === ws.id && renaming.from === 'pane' ? (
                          <RenameInput className="pane-title-input" initial={ws.name} label={`Nuevo nombre de ${ws.name}`} onDone={(next) => endRename(ws, 'pane', next)} />
                        ) : (
                          <span className="pane-title" title={login ? acc?.label : `${ws?.name ?? ''} · ${acc?.label ?? 'cuenta borrada'}`} onDoubleClick={ws ? () => setRenaming({ id: ws.id, from: 'pane' }) : undefined}>
                            {title}
                          </span>
                        )}
                        {ws?.ticket && <Tag>{ws.ticket}</Tag>}
                        {ws?.branch && (
                          <span className="pane-branch" title={`Rama ${ws.branch}`}>
                            <BranchIcon size={12} aria-hidden="true" />
                            <span className="pane-branch-text">{ws.branch}</span>
                          </span>
                        )}
                      </span>
                      {perm && (
                        <span className="pane-state is-waiting" role="status">
                          <PermissionIcon size={12} />
                          <span className="pane-state-label">Pide permiso</span>
                        </span>
                      )}
                      {showState && (
                        <span className={`pane-state is-${ag.state}`} role="status" title={ag.detail}>
                          <StateIcon state={ag.state} size={12} />
                          <span className="pane-state-label">
                            {STATE_LABEL[ag.state]}
                            {ag.state === 'working' && ag.detail ? <span className="pane-state-detail"> · {ag.detail}</span> : null}
                          </span>
                        </span>
                      )}
                      <span className="pane-actions">
                        <PaneHeaderSlot paneId={paneId} />
                        {cap > 1 && (
                          <IconButton
                            label={maximized === paneId ? 'Volver a la grilla' : 'Maximizar'}
                            icon={maximized === paneId ? <ArrowsInIcon /> : <MaximizeIcon size={15} />}
                            size="sm"
                            onClick={() => setMaximized(maximized === paneId ? null : paneId)}
                          />
                        )}
                        <WorkspaceMenuButton name={title} actions={actionsFor(paneId, 'pane')} />
                      </span>
                    </header>
                    {perm && (
                      <PermissionCard
                        key={perm.id}
                        prompt={perm}
                        queued={(paneQueue?.length ?? 1) - 1}
                        now={now}
                        spaceName={wsById.get(paneId)?.name}
                        accountLabel={accountById.get(wsById.get(paneId)?.accountId ?? '')?.label}
                        onAnswer={(answer, message) => answerPermission(perm, answer, message)}
                      />
                    )}
                    <PaneBannerSlot paneId={paneId} />
                    {agents[paneId]?.state === 'sleeping' ? (
                      <SleepingCard paneId={paneId} name={title} onError={onTermError} />
                    ) : (
                      <TerminalView id={paneId} generation={generations[paneId] ?? 0} onError={onTermError} />
                    )}
                  </section>
                )
              })}
              {cap > 1 && nVisible > 1 && (
                <Separators shape={shape} sizes={sizes} names={visiblePanes.map(paneName)} area={areaRef} onCommit={commitSizes} />
              )}
              {paneDrag.drag?.target && paneDrag.drag.mode && rectOf.has(paneDrag.drag.target) && (
                <div className={`pane-drop ${paneDrag.drag.mode}`} style={rectVars(rectOf.get(paneDrag.drag.target)) as CSSProperties} aria-hidden="true">
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
              Ctrl+Alt+flecha izquierda o derecha mueve este panel de lugar. Ctrl+Alt+flecha arriba o abajo lo pasa a otra fila. Ctrl+Tab pasa al siguiente.
            </span>
            <div className="sr-only" role="status" aria-live="polite">
              {layoutMsg}
            </div>
          </main>
          {sideShown && <SideResizer width={sideWidth} max={sideMax(winW)} bodyRef={sideBodyRef} onChange={setSideWidth} />}
        </div>

        <footer className="sl-status" aria-label="Estado">
          <span className="sl-status-count">
            <span className="sl-status-dot" aria-hidden="true" />
            Terminales activas: {activeTerms}
          </span>
          <span className="sl-status-persist">Siguen corriendo aunque cierres la ventana</span>
          <span className="sl-status-keys">{comboLabel('palette')} para todo lo demás</span>
        </footer>

        <GlobalSlot />
        <ToastHost />

        {newWsMode && (
          <NewWorkspaceDialog
            mode={newWsMode}
            accounts={accounts}
            statuses={statuses}
            usage={usage}
            defaultRepo={newWsPreset?.repoPath ?? workspaces[workspaces.length - 1]?.repoPath ?? ''}
            preset={newWsPreset}
            onClose={() => {
              setNewWsMode(null)
              setNewWsPreset(undefined)
            }}
            onCreated={(ws) => {
              setWorkspaces((w) => [...w, ws])
              setNewWsMode(null)
              setNewWsPreset(undefined)
              openPane(ws.id)
            }}
          />
        )}

        {dropActive && (
          <div className="folder-drop" role="status" aria-live="polite">
            <div className="folder-drop-card">Soltá la carpeta para crear un espacio</div>
          </div>
        )}

        {ctxMenu && (menuWs || openPanes.includes(ctxMenu.paneId)) && (
          <WorkspaceContextMenu
            name={menuWs?.name ?? paneName(ctxMenu.paneId)}
            x={ctxMenu.x}
            y={ctxMenu.y}
            actions={actionsFor(ctxMenu.paneId, ctxMenu.from)}
            onClose={(returnFocus) => {
              const back = ctxMenu.back
              setCtxMenu(null)
              if (returnFocus) back()
            }}
          />
        )}

        {iconPick && wsById.get(iconPick.wsId) && (
          <WorkspaceIconPicker
            name={wsById.get(iconPick.wsId)!.name}
            current={wsById.get(iconPick.wsId)!.icon}
            x={iconPick.x}
            y={iconPick.y}
            onClose={() => {
              const back = iconPick.back
              setIconPick(null)
              requestAnimationFrame(back)
            }}
            onPick={(icon) => {
              const ws = wsById.get(iconPick.wsId)!
              const back = iconPick.back
              setIconPick(null)
              requestAnimationFrame(back)
              void patchWorkspace(ws, { icon })
            }}
          />
        )}

        {confirmReq && (
          <ConfirmDialog
            req={confirmReq}
            onDone={(ok) => {
              confirmReq.resolve(ok)
              setConfirmReq(null)
            }}
          />
        )}
      </div>
    </UiContext.Provider>
  )
}

/** Ícono de «maximizado → volver» (flechas hacia adentro). */
function ArrowsInIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4v5H4M15 20v-5h5M4 9l5-5M20 15l-5 5" />
    </svg>
  )
}

/** Fracciones del rectángulo como variables CSS (las usa layout/layout.css). */
function rectVars(r: Rect | undefined): Record<string, number> {
  return r ? { '--x': r.x, '--y': r.y, '--w': r.w, '--h': r.h } : {}
}

const FOCUS_IDS: readonly ShortcutId[] = ['focus1', 'focus2', 'focus3', 'focus4']

/**
 * Enfoca la terminal del panel visible N (1–4), leyendo de izquierda a derecha y de arriba abajo.
 * Si no hay tantos paneles visibles, no hace nada.
 */
function focusVisiblePane(n: number): void {
  const panes = [...document.querySelectorAll<HTMLElement>('.panes .pane[data-pane-id]:not(.hidden)')]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .sort((a, b) => (Math.abs(a.r.top - b.r.top) > 8 ? a.r.top - b.r.top : a.r.left - b.r.left))
  panes[n - 1]?.el.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus()
}

/** Enfoca el mensaje de «Enviar a varios espacios»; el diálogo se carga recién al abrirlo, así que reintenta. */
function focusBroadcastText(tries = 30): void {
  const ta = document.getElementById('f-broadcast-text')
  if (ta) ta.focus()
  else if (tries > 0) requestAnimationFrame(() => focusBroadcastText(tries - 1))
}

/** Enfoca la terminal de un panel; si recién se muestra, reintenta un par de cuadros. */
function focusTerminal(id: string, tries = 8): void {
  const ta = document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(id)}"] .xterm-helper-textarea`)
  if (ta && ta.closest<HTMLElement>('.pane')?.offsetParent !== null) ta.focus()
  else if (tries > 0) requestAnimationFrame(() => focusTerminal(id, tries - 1))
}

/** Input para renombrar. Enter o salir guardan (si hay texto); Escape cancela. Responde una sola vez. */
function RenameInput({
  initial,
  label,
  className,
  onDone
}: {
  initial: string
  label: string
  className: string
  onDone(next: string | null): void
}): React.JSX.Element {
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (next: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(next)
  }
  const value = (): string | null => text.trim() || null
  return (
    <input
      ref={ref}
      className={className}
      value={text}
      maxLength={80}
      aria-label={label}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(value())
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish(null)
        }
      }}
      onBlur={() => finish(value())}
    />
  )
}
