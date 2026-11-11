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
import { resolveAccountColor, useSettings } from './features/settings/store'
import { openChat, useChatAttach, useChatSnapshot } from './features/chat/store'
import { openSettings } from './features/settings/bus'
import { openHelp } from './features/help/bus'
import { colorHex } from './features/templates/catalog'
import { bindingOf, comboLabel, isCapturingShortcut, matchShortcut } from './shortcuts'
import type { ShortcutId } from '../../main/features/settings-model'
import { GlobalSlot, PaneBannerSlot, PaneHeaderSlot, TitlebarOnly } from './features/slots'
import { openPermissionReview } from './features/permissions/store'
import { PaletteBar, PALETTE_REMOVE_EVENT, PALETTE_RENAME_EVENT, runFeatureCommand } from './features/palette'
import { TerminalView } from './TerminalView'
import { NewWorkspaceDialog } from './NewWorkspaceDialog'
import { EmptyState } from './EmptyState'
import { StateIcon, StatePill } from './StateIcon'
import { PermissionCard, toolLabel } from './PermissionCard'
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
import { PaneMenu, type PaneMenuItem } from './layout/PaneMenu'
import { CrumbMenu, type CrumbGroup, type CrumbItem } from './layout/CrumbMenu'
import { openRamas } from './features/worktrees/store'
import { openHistory } from './features/history/index'
import { AppMenu } from './layout/AppMenu'
import { ToolsSection } from './layout/ToolsSection'
import { TabBar, type TabInfo } from './layout/TabBar'
import './layout/layout.css'
import './layout/shell.css'
import { WorkspaceIconPicker } from './WorkspaceIconPicker'
import { useFolderDrop } from './useFolderDrop'
import './workspace.css'
import { cleanError, fmtTok, shortPath, STATE_LABEL, totalTok, usageTitle } from './format'
import {
  BranchIcon,
  BroadcastIcon,
  CheckIcon,
  ChangesIcon,
  ChatIcon,
  CloseIcon,
  EditorIcon,
  ErrorIcon,
  FolderIcon,
  FourPanesIcon,
  HistoryIcon,
  MaximizeIcon,
  MoveAccountIcon,
  OnePaneIcon,
  PermissionIcon,
  SearchIcon,
  SettingsIcon,
  SidebarIcon,
  SpaceIcon,
  TemplatesIcon,
  ThreePanesIcon,
  TwoPanesIcon,
  UpdateIcon,
  WorktreeIcon
} from './icons/SlothIcons'

/* Íconos que SlothIcons todavía no tiene: mismo trazo (grilla 24, 1,6) que el resto. */
type GlyphProps = { size?: number; weight?: string; 'aria-hidden'?: boolean | 'true' | 'false' }
function Glyph({ size = 16, children }: GlyphProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" focusable="false" style={{ flex: 'none' }}>
      {children}
    </svg>
  )
}
const Plus = (p: GlyphProps): React.JSX.Element => <Glyph {...p}><path d="M12 5v14M5 12h14" /></Glyph>
const Trash = (p: GlyphProps): React.JSX.Element => <Glyph {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></Glyph>
const PencilSimple = (p: GlyphProps): React.JSX.Element => <Glyph {...p}><path d="M4 20l1-4L16 5l3 3L8 19l-4 1zM14 7l3 3" /></Glyph>
const Equals = (p: GlyphProps): React.JSX.Element => <Glyph {...p}><path d="M5 9h14M5 15h14" /></Glyph>
const DotsSixVertical = (p: GlyphProps): React.JSX.Element => <Glyph {...p}><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" strokeWidth={2.6} /></Glyph>
const ArrowsLeftRight = (p: GlyphProps): React.JSX.Element => <Glyph {...p}><path d="M4 8h15l-3-3M20 16H5l3 3" /></Glyph>
const Smiley = (p: GlyphProps): React.JSX.Element => <Glyph {...p}><circle cx="12" cy="12" r="8" /><path d="M9 10h.01M15 10h.01M9 14.5c.9 1 1.9 1.5 3 1.5s2.1-.5 3-1.5" /></Glyph>

/** Texto de un atajo como teclas («Ctrl + K»), siempre al día con Configuración. */
function Keys({ id }: { id: ShortcutId }): React.JSX.Element {
  return (
    <>
      {bindingOf(id)
        .split(' ')
        .map((k, i) => (
          <span key={i}>
            {i > 0 && '+'}
            <kbd>{k}</kbd>
          </span>
        ))}
    </>
  )
}

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

const STATE_CHIP: Record<AgentStatus['state'], string> = {
  working: 'chip-working',
  waiting: 'chip-waiting',
  done: 'chip-done',
  exited: 'chip-error',
  idle: 'chip-idle'
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
  const [error, setError] = useState<string | null>(null)
  const [newWsMode, setNewWsMode] = useState<null | 'normal' | 'ticket'>(null)
  const [newWsPreset, setNewWsPreset] = useState<NewWorkspacePreset | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const [perms, setPerms] = useState<PermissionPrompt[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [announceId, setAnnounceId] = useState<string | null>(null)
  // Renombrar un espacio desde el sidebar o desde el header de su panel (uno a la vez).
  const [renaming, setRenaming] = useState<{ id: string; from: 'side' | 'pane' } | null>(null)
  // Picker de ícono: `back` devuelve el foco a quien lo abrió. Menú chico del sidebar (clic derecho).
  const [iconPick, setIconPick] = useState<{ wsId: string; x: number; y: number; back: () => void } | null>(null)
  const [wsMenu, setWsMenu] = useState<{ wsId: string; x: number; y: number } | null>(null)
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
  const requestRestartPane = async (id: string): Promise<void> => {
    if (await allowPaneAction(id, 'restart')) await restartPane(id)
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

  // v0.5 · espacios: cambios por IPC (validados en main), abrir en VS Code / carpeta, soltar carpeta.
  const patchWorkspace = async (ws: Workspace, patch: WorkspacePatch): Promise<void> => {
    try {
      const updated = await api.updateWorkspace(ws.id, patch)
      setWorkspaces((list) => list.map((w) => (w.id === ws.id ? updated : w)))
    } catch (e) {
      setError(cleanError(e))
    }
  }
  const revealWs = async (ws: Workspace, target: RevealTarget): Promise<void> => {
    try {
      await api.revealWorkspace(ws.id, target)
    } catch (e) {
      setError(cleanError(e))
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
    onError: (m) => setError(m)
  })

  const onTermError = useCallback((m: string) => setError(m), [])

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
  const showTabs = openPanes.length > 0 && (viewMode === 'uno' || openPanes.length > cap)
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

  // Pedidos desde la paleta: renombrar o quitar un espacio (la lógica vive acá, con su confirmación).
  const latestRef = useRef({ wsById, removeWorkspace })
  latestRef.current = { wsById, removeWorkspace }
  useEffect(() => {
    const onRename = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail
      if (typeof id === 'string' && latestRef.current.wsById.has(id)) setRenaming({ id, from: 'pane' })
    }
    const onRemove = (e: Event): void => {
      const ws = latestRef.current.wsById.get((e as CustomEvent<string>).detail)
      if (ws) void latestRef.current.removeWorkspace(ws)
    }
    window.addEventListener(PALETTE_RENAME_EVENT, onRename)
    window.addEventListener(PALETTE_REMOVE_EVENT, onRemove)
    return () => {
      window.removeEventListener(PALETTE_RENAME_EVENT, onRename)
      window.removeEventListener(PALETTE_REMOVE_EVENT, onRemove)
    }
  }, [])

  const tabs: TabInfo[] =
    showTabs
      ? openPanes.map((id) => {
          const login = isLoginPane(id)
          const accId = login ? accountIdFromLoginPane(id) : wsById.get(id)?.accountId
          return {
            id,
            title: login ? 'Terminal de cuenta' : (wsById.get(id)?.name ?? 'Panel'),
            account: (accId && accountById.get(accId)?.label) || 'cuenta borrada',
            color: colorOf(accId),
            state: login ? undefined : agents[id]?.state,
            perms: permsByWs.get(id)?.length ?? 0,
            icon: login ? undefined : wsById.get(id)?.icon
          }
        })
      : []
  const countBy = (s: AgentStatus['state']): number => workspaces.filter((w) => agents[w.id]?.state === s).length
  const needsYou = countBy('waiting')
  const working = countBy('working')
  const done = countBy('done')
  /** Pedidos de permiso vivos (uno o más por espacio). El chip del resumen los cuenta; no se repiten en otro lado. */
  const pendingPerms = [...permsByWs.values()].reduce((n, q) => n + q.length, 0)
  const activeTerms = workspaces.filter((w) => agents[w.id] && agents[w.id].state !== 'exited').length
  /** Primer espacio con ese estado (para ir al tocar un resumen). */
  const firstWs = (s: AgentStatus['state']): Workspace | undefined => workspaces.find((w) => agents[w.id]?.state === s)

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
    notifyError: (m) => setError(m),
    invoke: (channel, ...args) => api.feat.invoke(channel, ...args),
    on: (channel, cb) => api.feat.on(channel, cb)
  }
  // Chat del equipo: el botón de la barra muestra los no leídos (useChatAttach conecta la función).
  useChatAttach(uiCtx)
  const chatUnread = useChatSnapshot()?.unreadTotal ?? 0

  // Barra de paneles: distribución elegida (se guarda en esta PC). Uno = 1 a la vista; Dos = 2; Cuatro = 4.
  const layoutPressed = { uno: viewMode === 'uno', dos: viewMode === 'dos', tres: viewMode === 'tres', cuatro: viewMode === 'cuatro' }
  const pickLayout = (k: ViewMode): void => {
    setViewMode(k)
    if (maximized) setMaximized(null)
    setLayoutMsg(`Distribución ${LAYOUT_LABEL[k]}: hasta ${LAYOUT_CAP[k]} ${LAYOUT_CAP[k] === 1 ? 'panel' : 'paneles'} a la vista. El resto queda en pestañas.`)
  }
  const editorName = appSettings.settings.editor
  const editorLabel = editorName === 'Bloc de notas' ? 'carpeta' : editorName

  // Ruta «cuenta › espacio» del panel enfocado.
  const focusedAccId = focused ? (isLoginPane(focused) ? accountIdFromLoginPane(focused) : wsById.get(focused)?.accountId) : undefined
  const crumbAccount = focusedAccId ? (accountById.get(focusedAccId)?.label ?? 'cuenta borrada') : 'Sloth'

  /** Chip de estado de un espacio: el permiso pendiente manda sobre el estado de su terminal. */
  const chipOf = (ws: Workspace): { cls: string; label: string } | null => {
    const nPerm = permsByWs.get(ws.id)?.length ?? 0
    const ag = agents[ws.id]
    return nPerm > 0 ? { cls: 'chip-perm', label: `Permiso${nPerm > 1 ? ` ×${nPerm}` : ''}` } : ag ? { cls: STATE_CHIP[ag.state], label: STATE_LABEL[ag.state] } : null
  }

  const renderWs = (ws: Workspace): React.JSX.Element => {
    const ag = agents[ws.id]
    const acc = accountById.get(ws.accountId)
    const open = openPanes.includes(ws.id)
    const nPerm = permsByWs.get(ws.id)?.length ?? 0
    const editing = renaming?.id === ws.id && renaming.from === 'side'
    const chip = chipOf(ws)
    return (
      <li
        key={ws.id}
        className="sl-li"
        data-account-id={ws.accountId}
        onContextMenu={(e) => {
          e.preventDefault()
          setWsMenu({ wsId: ws.id, x: e.clientX, y: e.clientY })
        }}
      >
        {editing ? (
          <div className="ws-edit">
            <StateIcon state={ag?.state} />
            <RenameInput className="ws-rename" initial={ws.name} label={`Nuevo nombre del espacio ${ws.name}`} onDone={(next) => endRename(ws, 'side', next)} />
          </div>
        ) : (
          <button
            type="button"
            className={`sl-row ${open ? 'open' : ''} ${focused === ws.id ? 'focused' : ''}`}
            style={{ '--acc': colorOf(ws.accountId) } as CSSProperties}
            data-ws-btn={ws.id}
            onClick={() => openPane(ws.id)}
            onDoubleClick={() => setRenaming({ id: ws.id, from: 'side' })}
            onKeyDown={(e) => {
              if (e.key !== 'F2') return
              e.preventDefault()
              setRenaming({ id: ws.id, from: 'side' })
            }}
            aria-label={`${ws.icon ? `${ws.icon} ` : ''}${ws.name}, ${acc?.label ?? 'cuenta borrada'}, ${ag ? STATE_LABEL[ag.state] : 'sin abrir'}${nPerm ? `, ${nPerm === 1 ? 'permiso pendiente' : `${nPerm} permisos pendientes`}` : ''}`}
            title="Doble clic o F2 para renombrar · clic derecho para más opciones"
          >
            <span className={`sl-ico${ws.color ? '' : ' no-color'}`} aria-hidden="true" style={ws.color ? ({ '--ws': colorHex(ws.color) } as CSSProperties) : undefined}>
              {ws.icon ? ws.icon : <SpaceIcon size={15} />}
            </span>
            <span className="sl-txt">
              <span className="sl-name">
                <span className="sl-name-text">{ws.name}</span>
                {ws.ticket && <span className="tag">{ws.ticket}</span>}
              </span>
              <span className="sl-sub">
                <BranchIcon size={11} aria-hidden="true" />
                <span className="mono">{ws.branch ?? shortPath(ws.cwd)}</span>
              </span>
            </span>
            {chip && <span className={`chip sl-state ${chip.cls}`}>{chip.label}</span>}
          </button>
        )}
        <button type="button" className="icon-btn danger sl-del" onClick={() => void removeWorkspace(ws)} aria-label={`Quitar espacio ${ws.name}`} title="Quitar espacio">
          <Trash size={14} aria-hidden="true" />
        </button>
      </li>
    )
  }

  const q = wsQuery.trim().toLowerCase()
  const matchWs = (ws: Workspace): boolean => !q || (ws.name + ' ' + (ws.branch ?? '')).toLowerCase().includes(q)
  const orphans = workspaces.filter((w) => !accountById.has(w.accountId))

  // Ruta «cuenta › espacio»: cada parte abre su menú. Elegir un espacio = el mismo openPane del sidebar.
  const spaceItem = (ws: Workspace): CrumbItem => {
    const chip = chipOf(ws)
    return {
      id: ws.id,
      current: focused === ws.id,
      onSelect: () => openPane(ws.id),
      body: (
        <>
          <span className={`crumb-ws-ico${ws.color ? '' : ' no-color'}`} style={ws.color ? ({ '--ws': colorHex(ws.color) } as CSSProperties) : undefined} aria-hidden="true">
            {ws.icon ? ws.icon : <SpaceIcon size={13} aria-hidden="true" />}
          </span>
          <span className="crumb-ws-main">
            <span className="crumb-ws-name">{ws.name}</span>
            {ws.branch && (
              <span className="crumb-ws-branch mono">
                <BranchIcon size={11} aria-hidden="true" />
                {ws.branch}
              </span>
            )}
          </span>
          {chip && <span className={`chip crumb-chip ${chip.cls}`}>{chip.label}</span>}
          {focused === ws.id && <CheckIcon size={13} aria-hidden="true" />}
        </>
      )
    }
  }
  const accountGroups: CrumbGroup[] = [
    ...accounts.map((acc) => ({
      id: acc.id,
      title: acc.label,
      items: workspaces.filter((w) => w.accountId === acc.id).map(spaceItem),
      empty: 'Sin espacios. Usá + en la barra lateral para crear uno.'
    })),
    ...(orphans.length ? [{ id: 'huerfanos', title: 'Cuenta borrada', items: orphans.map(spaceItem), empty: '' }] : [])
  ]
  const spaceGroups: CrumbGroup[] = focusedAccId
    ? [
        {
          id: focusedAccId,
          title: crumbAccount,
          items: workspaces.filter((w) => w.accountId === focusedAccId).map(spaceItem),
          empty: 'Sin espacios. Usá + en la barra lateral para crear uno.'
        }
      ]
    : []

  return (
    <UiContext.Provider value={uiCtx}>
      <div className={`sl-shell ${docVisible ? '' : 'doc-hidden'}`}>
        <header className="sl-top">
          <div className="sl-top-left">
            <button
              type="button"
              className="icon-btn"
              onClick={toggleSide}
              aria-pressed={sideShown}
              aria-label="Mostrar u ocultar la barra lateral"
              title={`Barra lateral (${comboLabel('sidebar')})`}
            >
              <SidebarIcon size={17} aria-hidden="true" />
            </button>
            <AppMenu ctx={uiCtx} />
          </div>
          <div className="sl-top-search">
            <PaletteBar />
          </div>
          <div className="sl-top-right">
            <div className="sl-top-status" role="status" aria-live="polite">
              {working > 0 && (
                <button type="button" className="chip chip-working" onClick={() => { const w = firstWs('working'); if (w) openPane(w.id) }} title="Ir al primero que está trabajando">
                  <StateIcon state="working" size={12} />
                  {working} trabajando
                </button>
              )}
              {needsYou > 0 && (
                <button type="button" className="chip chip-waiting" onClick={() => { const w = firstWs('waiting'); if (w) openPane(w.id) }} title="Ir al que te espera">
                  <StateIcon state="waiting" size={12} />
                  {needsYou} te {needsYou === 1 ? 'espera' : 'esperan'}
                </button>
              )}
              {done > 0 && (
                <button type="button" className="chip chip-done" onClick={() => { const w = firstWs('done'); if (w) openPane(w.id) }} title="Ir al que terminó">
                  <StateIcon state="done" size={12} />
                  {done} {done === 1 ? 'listo' : 'listos'}
                </button>
              )}
              {pendingPerms > 0 && (
                <button type="button" className="chip chip-perm" onClick={() => openPermissionReview()} title="Revisar los pedidos de permiso">
                  <PermissionIcon size={12} strokeWidth={2.2} />
                  {pendingPerms === 1 ? '1 pide permiso' : `${pendingPerms} piden permiso`}
                </button>
              )}
            </div>
            <div className="sl-upd">
              <TitlebarOnly name="updater" />
            </div>
            <div className="sl-top-tools">
              <span className="sl-top-sep" aria-hidden="true" />
              <button type="button" className="sl-tool" onClick={() => openChat()} aria-label={chatUnread > 0 ? `Chat del equipo, ${chatUnread} sin leer` : 'Chat del equipo'} title="Chat del equipo">
                <ChatIcon size={17} aria-hidden="true" />
                {chatUnread > 0 && (
                  <span className="sl-tool-badge" aria-hidden="true">
                    {chatUnread > 99 ? '99+' : chatUnread}
                  </span>
                )}
              </button>
              <button type="button" className="sl-tool" onClick={() => openSettings()} aria-label="Configuración" title={`Configuración (${comboLabel('settings')})`}>
                <SettingsIcon size={17} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="sr-only" role="alert">
            {announced
              ? `${wsById.get(announced.workspaceId)?.name ?? 'Un espacio'}: Claude quiere usar ${toolLabel(announced.tool)}. Respondé en su panel.`
              : ''}
          </div>
        </header>

        <div ref={sideBodyRef} className={`sl-body ${sideShown ? '' : 'no-side'}`} style={{ '--side-w': `${sideWidth}px` } as CSSProperties}>
          <aside className="sl-side" aria-label="Cuentas y espacios">
            <label className="sl-filter">
              <SearchIcon size={14} aria-hidden="true" />
              <input
                type="search"
                value={wsQuery}
                onChange={(e) => setWsQuery(e.target.value)}
                placeholder="Filtrar espacios"
                aria-label="Filtrar espacios"
                spellCheck={false}
              />
            </label>

            {accounts.length === 0 && (
              <section className="sl-acc sl-acc-none" aria-label="Sin cuentas">
                <p className="sl-hint">Agregá una cuenta para empezar.</p>
                <button type="button" className="sl-newbtn" onClick={() => openSettings('cuentas')}>
                  Agregar cuenta
                </button>
              </section>
            )}

            {accounts.map((acc) => {
              const st = statuses[acc.id]
              const u = usage[acc.id]
              const mine = workspaces.filter((w) => w.accountId === acc.id)
              const shown = mine.filter(matchWs)
              const open = !collapsed[acc.id] || !!q
              const bodyId = `acc-body-${acc.id}`
              return (
                <section key={acc.id} className="sl-acc" data-account-id={acc.id} aria-label={`Cuenta ${acc.label}`} style={{ '--acc': colorOf(acc.id) } as CSSProperties}>
                  <div className="sl-acc-head">
                    <button
                      type="button"
                      className="sl-acc-toggle"
                      aria-expanded={open}
                      aria-controls={bodyId}
                      aria-label={`Mostrar u ocultar los espacios de ${acc.label}`}
                      onClick={() => setCollapsed((c) => ({ ...c, [acc.id]: open }))}
                    >
                      <span className="sl-avatar" aria-hidden="true">
                        {acc.label.slice(0, 1).toUpperCase()}
                        <span className={`sl-dot ${st?.loggedIn ? 'on' : ''}`} />
                      </span>
                      <span className="sl-acc-meta">
                        <span className="sl-acc-name">{acc.label}</span>
                        {appSettings.settings.accountPlans[acc.id] && <span className="sl-acc-plan">{appSettings.settings.accountPlans[acc.id]}</span>}
                        <span className={`sl-acc-sub ${st?.loggedIn ? '' : 'warn'}`} title={st?.email}>
                          {mine.length === 1 ? '1 espacio' : `${mine.length} espacios`} · {st?.loggedIn ? 'Sesión iniciada' : 'Sin sesión'}
                        </span>
                      </span>
                      <svg className="sl-chev" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => {
                        setNewWsPreset({ accountId: acc.id })
                        setNewWsMode('normal')
                      }}
                      aria-label={`Nuevo espacio en ${acc.label}`}
                      title={`Nuevo espacio en ${acc.label}`}
                    >
                      <Plus size={15} weight="bold" aria-hidden="true" />
                    </button>
                  </div>
                  {open && (
                    <div id={bodyId} className="sl-acc-body">
                      {shown.length > 0 && <ul className="sl-list">{shown.map(renderWs)}</ul>}
                      {shown.length === 0 && <p className="sl-acc-empty">{mine.length ? 'Ningún espacio coincide.' : 'Sin espacios. Usá + para crear uno.'}</p>}
                    </div>
                  )}
                </section>
              )
            })}

            {orphans.length > 0 && (
              <section className="sl-acc" aria-label="Espacios de una cuenta borrada">
                <p className="sl-acc-empty">Cuenta borrada</p>
                <ul className="sl-list">{orphans.filter(matchWs).map(renderWs)}</ul>
              </section>
            )}

            <ToolsSection ctx={uiCtx} />

            <div className="sl-foot">
              <button type="button" className="sl-newbtn" disabled={accounts.length === 0} onClick={() => setNewWsMode('normal')}>
                <Plus size={15} weight="bold" aria-hidden="true" />
                Nuevo espacio
                <kbd>{comboLabel('new')}</kbd>
              </button>
            </div>
          </aside>

          <main className={`panes sl-main view-${viewMode} ${openPanes.length === 0 ? 'is-empty' : ''}`} aria-label="Paneles">
            {loaded && openPanes.length === 0 && <EmptyState onCreate={() => setNewWsMode('normal')} />}
            {openPanes.length > 0 && (
              <>
                <div className="sl-bar">
                  <nav className="sl-crumb" aria-label="Ubicación">
                    <CrumbMenu
                      label={`Elegir cuenta y espacio. Ahora: ${crumbAccount}`}
                      trigger={crumbAccount}
                      groups={accountGroups}
                      emptyText="Todavía no hay cuentas. Agregá una en Configuración."
                    />
                    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                    {focusedAccId && focused ? (
                      <CrumbMenu
                        label={`Elegir espacio de ${crumbAccount}. Ahora: ${paneName(focused)}`}
                        trigger={<span className="sl-crumb-space">{paneName(focused)}</span>}
                        groups={spaceGroups}
                        emptyText=""
                      />
                    ) : (
                      <strong>{focused ? paneName(focused) : 'Sloth'}</strong>
                    )}
                  </nav>
                  <div className="sl-bar-tools">
                    {cap > 1 && nVisible > 1 && !sizesAreEqual(sizes) && (
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
                    <div className="seg" role="group" aria-label="Distribución de paneles">
                      <button type="button" aria-pressed={layoutPressed.uno} onClick={() => pickLayout('uno')} title="Uno (Ctrl+Alt+1): 1 panel a la vista; el resto en pestañas">
                        <OnePaneIcon size={14} aria-hidden="true" /> Uno
                      </button>
                      <button type="button" aria-pressed={layoutPressed.dos} onClick={() => pickLayout('dos')} title="Dos (Ctrl+Alt+2): hasta 2 paneles a la vista; el resto en pestañas">
                        <TwoPanesIcon size={14} aria-hidden="true" /> Dos
                      </button>
                      <button type="button" aria-pressed={layoutPressed.tres} onClick={() => pickLayout('tres')} title="Tres (Ctrl+Alt+3): hasta 3 paneles a la vista; el resto en pestañas">
                        <ThreePanesIcon size={14} aria-hidden="true" /> Tres
                      </button>
                      <button type="button" aria-pressed={layoutPressed.cuatro} onClick={() => pickLayout('cuatro')} title="Cuatro (Ctrl+Alt+4): hasta 4 paneles a la vista; el resto en pestañas">
                        <FourPanesIcon size={14} aria-hidden="true" /> Cuatro
                      </button>
                    </div>
                    <button
                      type="button"
                      className="sl-bcast"
                      disabled={workspaces.length === 0}
                      onClick={() => runFeatureCommand('broadcast:open', uiCtx)}
                      title="Mandar un mensaje a los espacios con terminal"
                    >
                      <BroadcastIcon size={14} aria-hidden="true" />
                      Enviar a todos
                    </button>
                  </div>
                </div>

                {showTabs && (
                  <div className="sl-tabsrow">
                    <TabBar tabs={tabs} active={activeId} drag={tabDrag.drag} scope={tabsRef} onSelect={selectPane} onHide={hideTab} onPointerDown={tabDrag.onPointerDown} />
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
              </>
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
                const menuItems: PaneMenuItem[] = [
                  ...(ws
                    ? [
                        {
                          id: 'rename',
                          label: 'Renombrar',
                          hint: 'F2',
                          icon: <PencilSimple size={15} aria-hidden="true" />,
                          onSelect: () => setRenaming({ id: ws.id, from: 'pane' })
                        },
                        {
                          id: 'git',
                          label: 'Ver cambios (Git)',
                          icon: <ChangesIcon size={15} aria-hidden="true" />,
                          sepBefore: true,
                          onSelect: () => runFeatureCommand('git:changes', { ...uiCtx, focused: paneId })
                        },
                        {
                          id: 'historial',
                          label: 'Historial de este espacio',
                          icon: <HistoryIcon size={15} aria-hidden="true" />,
                          onSelect: () => openHistory(ws.id)
                        },
                        {
                          id: 'ramas',
                          label: 'Ramas aparte de este repo',
                          icon: <WorktreeIcon size={15} aria-hidden="true" />,
                          onSelect: () => openRamas(null, ws.repoPath)
                        },
                        {
                          id: 'plantilla',
                          label: 'Guardar como plantilla',
                          icon: <TemplatesIcon size={15} aria-hidden="true" />,
                          onSelect: () => runFeatureCommand('templates:from-focused', { ...uiCtx, focused: paneId })
                        },
                        {
                          id: 'vscode',
                          label: editorLabel === 'carpeta' ? 'Abrir carpeta' : `Abrir en ${editorLabel}`,
                          icon: <EditorIcon size={15} aria-hidden="true" />,
                          sepBefore: true,
                          onSelect: () => void revealWs(ws, 'vscode')
                        },
                        {
                          id: 'folder',
                          label: 'Abrir carpeta',
                          icon: <FolderIcon size={15} aria-hidden="true" />,
                          onSelect: () => void revealWs(ws, 'folder')
                        }
                      ]
                    : []),
                  ...(ws && accounts.length >= 2
                    ? [
                        {
                          id: 'move',
                          label: 'Mover a otra cuenta',
                          icon: <MoveAccountIcon size={15} aria-hidden="true" />,
                          onSelect: () => runFeatureCommand('move-account.focused', { ...uiCtx, focused: paneId })
                        }
                      ]
                    : []),
                  {
                    id: 'restart',
                    label: 'Reiniciar terminal',
                    hint: 'cierra el proceso',
                    icon: <UpdateIcon size={15} />,
                    sepBefore: Boolean(ws),
                    onSelect: () => void requestRestartPane(paneId)
                  },
                  {
                    id: 'hide',
                    label: 'Cerrar panel',
                    hint: 'la terminal sigue',
                    icon: <CloseIcon size={15} aria-hidden="true" />,
                    danger: true,
                    sepBefore: true,
                    onSelect: () => void requestHidePane(paneId)
                  }
                ]
                const title = login ? 'Terminal de cuenta' : (ws?.name ?? '')
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
                        {ws && (
                          <button
                            type="button"
                            className="pane-icon-btn"
                            style={ws.color ? ({ '--ws': colorHex(ws.color) } as CSSProperties) : undefined}
                            onClick={(e) => {
                              const btn = e.currentTarget
                              const r = btn.getBoundingClientRect()
                              openIconPicker(ws.id, r.left, r.bottom + 6, () => btn.focus())
                            }}
                            aria-label={`Elegir ícono de ${ws.name}`}
                            title="Elegir ícono"
                          >
                            {ws.icon ? <span aria-hidden="true">{ws.icon}</span> : <SpaceIcon size={13} aria-hidden="true" />}
                          </button>
                        )}
                        {ws && renaming?.id === ws.id && renaming.from === 'pane' ? (
                          <RenameInput className="pane-title-input" initial={ws.name} label={`Nuevo nombre de ${ws.name}`} onDone={(next) => endRename(ws, 'pane', next)} />
                        ) : (
                          <span className="pane-title" title={login ? undefined : ws?.name} onDoubleClick={ws ? () => setRenaming({ id: ws.id, from: 'pane' }) : undefined}>
                            {title}
                          </span>
                        )}
                        {ws?.ticket && <span className="tag">{ws.ticket}</span>}
                        {ws?.branch && (
                          <span className="pane-branch" title={`Rama ${ws.branch}`}>
                            <BranchIcon size={12} aria-hidden="true" />
                            {ws.branch}
                          </span>
                        )}
                      </span>
                      {ag && <StatePill state={ag.state} detail={ag.detail} />}
                      <span className="pane-actions">
                        <PaneHeaderSlot paneId={paneId} />
                        <button
                          className="icon-btn"
                          onClick={() => setMaximized(maximized === paneId ? null : paneId)}
                          hidden={cap < 2}
                          aria-label={maximized === paneId ? 'Volver a la grilla' : 'Maximizar'}
                          title={maximized === paneId ? 'Volver a la grilla' : 'Maximizar'}
                        >
                          {maximized === paneId ? <ArrowsInIcon /> : <MaximizeIcon size={15} aria-hidden="true" />}
                        </button>
                        <PaneMenu label={`Más acciones de ${title}`} items={menuItems} />
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
                    <TerminalView id={paneId} generation={generations[paneId] ?? 0} onError={onTermError} />
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
          <span className="sl-status-keys">
            {comboLabel('palette')} buscar · {comboLabel('new')} nuevo · {bindingOf('layout')} distribución
          </span>
        </footer>

        <GlobalSlot />

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

        {wsMenu && wsById.get(wsMenu.wsId) && (
          <WsMenu
            x={wsMenu.x}
            y={wsMenu.y}
            onClose={() => {
              setWsMenu(null)
              requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-ws-btn="${CSS.escape(wsMenu.wsId)}"]`)?.focus())
            }}
            onRename={() => {
              const id = wsMenu.wsId
              setWsMenu(null)
              setRenaming({ id, from: 'side' })
            }}
            onIcon={() => {
              const id = wsMenu.wsId
              const { x, y } = wsMenu
              setWsMenu(null)
              openIconPicker(id, x, y, () => document.querySelector<HTMLElement>(`[data-ws-btn="${CSS.escape(id)}"]`)?.focus())
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

        {error && (
          <div className="toast" role="alert">
            <ErrorIcon size={18} />
            <span className="grow-min">{error}</span>
            <button className="icon-btn" onClick={() => setError(null)} aria-label="Cerrar aviso">
              <CloseIcon size={14} aria-hidden="true" />
            </button>
          </div>
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

/** Menú chico de un espacio en el sidebar (clic derecho). Escape o clic afuera lo cierran. */
function WsMenu({
  x,
  y,
  onRename,
  onIcon,
  onClose
}: {
  x: number
  y: number
  onRename(): void
  onIcon(): void
  onClose(): void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus()
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeRef.current()
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [])
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    e.preventDefault()
    const j = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
    items[j]?.focus()
  }
  return (
    <div
      ref={ref}
      className="ws-menu"
      role="menu"
      aria-label="Opciones del espacio"
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - 196)), top: Math.max(8, Math.min(y, window.innerHeight - 110)) }}
      onKeyDown={onKeyDown}
    >
      <button type="button" role="menuitem" onClick={onRename}>
        <PencilSimple size={14} aria-hidden="true" /> Renombrar
      </button>
      <button type="button" role="menuitem" onClick={onIcon}>
        <Smiley size={14} aria-hidden="true" /> Cambiar ícono
      </button>
    </div>
  )
}
