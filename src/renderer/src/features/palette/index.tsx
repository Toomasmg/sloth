import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Workspace } from '../../../../shared/types'
import { api } from '../../api'
import { cleanError, shortPath, STATE_LABEL } from '../../format'
import { ChangesIcon, CloseIcon, EditorIcon, FolderIcon, MaximizeIcon, MoveAccountIcon, PencilIcon, SearchIcon, TrashIcon } from '../../icons/SlothIcons'
import { bindingOf, isCapturingShortcut, matchShortcut } from '../../shortcuts'
import { getSettings, resolveAccountColor, useSettings } from '../settings/store'
import { FEATURE_UIS } from '../registry'
import { useUi, type Command, type FeatureUi, type UiCtx } from '../host'
import { fuzzyFilter, splitHighlight, type FuzzyMatch } from './fuzzy'
import { coreCommands, focusPaneTerminal } from './core-commands'
import './palette.css'

/**
 * Buscador de la barra superior. Es la paleta de comandos: Ctrl+K enfoca este mismo campo y la lista
 * se despliega debajo. Los comandos son los que ya registra cada función (FEATURE_UIS), más los
 * comandos de cada espacio (Tab sobre un resultado).
 */

/** Evento para que App abra el renombrado de un espacio (el panel ya está abierto). */
export const PALETTE_RENAME_EVENT = 'sloth:palette-rename'
/** Evento para que App pida quitar un espacio (con confirmación, como el botón de la barra lateral). */
export const PALETTE_REMOVE_EVENT = 'sloth:palette-remove'

/** Abre el buscador y le pone el foco. */
let focusField: (() => void) | null = null
export const openPalette = (): void => focusField?.()

// ---------- Recientes (preferencia de esta PC) ----------
const RECENT_KEY = 'sloth.palette.recent'
const MAX_RECENT = 5
const MAX_RENDER = 60
function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}
function pushRecent(id: string): void {
  const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, MAX_RECENT)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* sin espacio: no pasa nada */
  }
}

/**
 * Ejecuta un comando de una función por su id, con un contexto propio (por ejemplo, con otro espacio
 * enfocado). Así App y la paleta reutilizan los comandos reales en vez de duplicar la lógica.
 */
export function runFeatureCommand(id: string, ctx: UiCtx): void {
  for (const f of FEATURE_UIS) {
    if (!f.commands) continue
    let cmd: Command | undefined
    try {
      cmd = f.commands(ctx).find((c) => c.id === id)
    } catch (e) {
      console.error(`[paleta] comandos de ${f.name}:`, e)
      continue
    }
    if (!cmd) continue
    try {
      const r = cmd.run()
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch((e) => ctx.notifyError(cleanError(e)))
    } catch (e) {
      ctx.notifyError(cleanError(e))
    }
    return
  }
}

/** Todos los comandos de las funciones (cada función registra los suyos). */
function allCommands(ctx: UiCtx): Command[] {
  const out: Command[] = []
  const seen = new Set<string>()
  for (const f of FEATURE_UIS) {
    if (!f.commands) continue
    try {
      for (const c of f.commands(ctx)) {
        if (!c || typeof c.title !== 'string' || seen.has(c.id)) continue
        seen.add(c.id)
        out.push(c)
      }
    } catch (e) {
      console.error(`[paleta] comandos de ${f.name}:`, e)
    }
  }
  return out
}

// ---------- Elementos ----------
type Section = 'espacios' | 'acciones' | 'equipo'
type Filter = 'todo' | Section

interface Meta {
  label: string
  cls: string
}

interface Item {
  id: string
  section: Section
  /** Encabezado de grupo en la lista. */
  group: string
  title: string
  subtitle?: string
  keywords?: string
  icon?: ReactNode
  iconStyle?: CSSProperties
  meta?: Meta
  shortcut?: string
  danger?: boolean
  /** Si es un espacio: Tab abre sus acciones. */
  spaceId?: string
  run(): void
}

function stateMeta(ctx: UiCtx, ws: Workspace): Meta | undefined {
  const now = Date.now()
  if (ctx.permissions.some((p) => p.workspaceId === ws.id && p.expiresAt > now)) return { label: 'Pide permiso', cls: 'perm' }
  const ag = ctx.agents[ws.id]
  if (!ag) return undefined
  return { label: STATE_LABEL[ag.state], cls: ag.state }
}

function openSpace(ctx: UiCtx, id: string): void {
  ctx.openPane(id)
  focusPaneTerminal(id)
}

function spaceItem(ctx: UiCtx, ws: Workspace, colorOf: (accountId: string) => string): Item {
  const acc = ctx.accounts.find((a) => a.id === ws.accountId)
  return {
    id: `palette:go:${ws.id}`,
    section: 'espacios',
    group: 'Espacios',
    title: ws.name,
    subtitle: `${acc?.label ?? 'cuenta borrada'} · ${ws.branch ?? shortPath(ws.cwd)}`,
    keywords: [ws.ticket, ws.branch, ws.repoPath].filter(Boolean).join(' '),
    icon: <FolderIcon size={15} />,
    iconStyle: { color: colorOf(ws.accountId), background: `color-mix(in srgb, ${colorOf(ws.accountId)} 16%, transparent)` },
    meta: stateMeta(ctx, ws),
    spaceId: ws.id,
    run: () => openSpace(ctx, ws.id)
  }
}

/** Acciones de un espacio (Tab sobre un resultado de espacio). */
function spaceActions(ctx: UiCtx, ws: Workspace): Item[] {
  const id = ws.id
  const base = { section: 'acciones' as const, group: ws.name }
  const items: Item[] = [
    { ...base, id: 'x-abrir', title: 'Abrir en el panel activo', subtitle: 'Lo muestra y le pone el foco', icon: <FolderIcon size={15} />, run: () => openSpace(ctx, id) },
    {
      ...base,
      id: 'x-max',
      title: 'Abrir maximizado',
      subtitle: 'Un solo panel con este espacio',
      icon: <MaximizeIcon size={15} />,
      run: () => {
        ctx.openPane(id)
        ctx.setMaximized(id)
      }
    },
    {
      ...base,
      id: 'x-git',
      title: 'Ver cambios',
      subtitle: 'Git del espacio',
      icon: <ChangesIcon size={15} />,
      run: () => {
        ctx.openPane(id)
        runFeatureCommand('git:changes', { ...ctx, focused: id })
      }
    },
    {
      ...base,
      id: 'x-code',
      title: `Abrir en ${getSettings().settings.editor === 'Bloc de notas' ? 'carpeta' : getSettings().settings.editor}`,
      subtitle: ws.cwd,
      icon: <EditorIcon size={15} />,
      run: () => {
        api.revealWorkspace(id, 'vscode').catch((e) => ctx.notifyError(cleanError(e)))
      }
    },
    {
      ...base,
      id: 'x-ren',
      title: 'Renombrar',
      subtitle: 'Escribís el nombre nuevo en el panel',
      shortcut: 'F2',
      icon: <PencilIcon size={15} />,
      run: () => {
        ctx.openPane(id)
        window.dispatchEvent(new CustomEvent(PALETTE_RENAME_EVENT, { detail: id }))
      }
    }
  ]
  if (ctx.accounts.length >= 2)
    items.push({
      ...base,
      id: 'x-mover',
      title: 'Mover a otra cuenta',
      subtitle: 'La terminal se reinicia con la otra cuenta',
      icon: <MoveAccountIcon size={15} />,
      run: () => runFeatureCommand('move-account.focused', { ...ctx, focused: id })
    })
  items.push(
    {
      ...base,
      id: 'x-ocultar',
      title: 'Ocultar panel',
      subtitle: 'La terminal sigue corriendo',
      icon: <CloseIcon size={15} />,
      run: () => ctx.closePane(id)
    },
    {
      ...base,
      id: 'x-quitar',
      title: 'Quitar espacio',
      subtitle: 'Se cierra su terminal',
      icon: <TrashIcon size={15} />,
      danger: true,
      run: () => window.dispatchEvent(new CustomEvent(PALETTE_REMOVE_EVENT, { detail: id }))
    }
  )
  return items
}

function buildItems(ctx: UiCtx, colorOf: (accountId: string) => string): Item[] {
  const out: Item[] = ctx.workspaces.map((ws) => spaceItem(ctx, ws, colorOf))
  for (const c of allCommands(ctx)) {
    if (c.id.startsWith('palette:go:')) continue
    const section: Section = c.group === 'Espacios' ? 'espacios' : c.group === 'Equipo' ? 'equipo' : 'acciones'
    out.push({
      id: c.id,
      section,
      group: c.group,
      title: c.title,
      subtitle: c.subtitle,
      keywords: c.keywords,
      icon: c.icon,
      shortcut: c.shortcut,
      run: () => {
        void Promise.resolve()
          .then(() => c.run())
          .catch((e) => ctx.notifyError(cleanError(e)))
      }
    })
  }
  return out
}

const SECTION_LABEL: Record<Section, string> = { espacios: 'Espacios', acciones: 'Acciones', equipo: 'Equipo' }
const FILTERS: { id: Filter; label: string; prefix: string }[] = [
  { id: 'todo', label: 'Todo', prefix: '' },
  { id: 'espacios', label: 'Espacios', prefix: '' },
  { id: 'acciones', label: 'Acciones', prefix: '>' },
  { id: 'equipo', label: 'Equipo', prefix: '@' }
]

interface Row {
  item: Item
  match: FuzzyMatch
}

function Highlight({ text, pos }: { text: string; pos?: number[] }): React.JSX.Element {
  return (
    <>
      {splitHighlight(text, pos ?? []).map((p, i) =>
        p.hl ? (
          <mark key={i} className="pal-hl">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  )
}

/** Atajo como teclas («Ctrl+K» → Ctrl K). */
function Keys({ shortcut }: { shortcut: string }): React.JSX.Element {
  return (
    <span className="pal-keys" aria-label={`Atajo ${shortcut}`}>
      {shortcut.split('+').map((k, i) => (
        <kbd key={i}>{k.trim()}</kbd>
      ))}
    </span>
  )
}

/**
 * Buscador de la barra superior (siempre montado). Maneja Ctrl+K y Ctrl+Shift+P y la lista desplegable.
 */
export function PaletteBar(): React.JSX.Element {
  const ctx = useUi()
  const settings = useSettings()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('todo')
  const [scope, setScope] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx

  const accountIndex = useMemo(() => new Map(ctx.accounts.map((a, i) => [a.id, i])), [ctx.accounts])
  const colorOf = (accountId: string): string => resolveAccountColor(accountId, accountIndex.get(accountId) ?? 0, settings)

  // Los elementos se arman al abrir y cuando cambia el estado de la app (no en cada tecla).
  const items = useMemo(
    () => (open ? buildItems(ctx, colorOf) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, ctx.accounts, ctx.workspaces, ctx.statuses, ctx.agents, ctx.permissions, ctx.openPanes, ctx.focused, ctx.maximized, settings]
  )

  // Foco desde fuera (Ctrl+K, openPalette) y atajos globales.
  useEffect(() => {
    focusField = () => {
      setOpen(true)
      inputRef.current?.focus()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (isCapturingShortcut()) return
      // Ctrl+Shift+P es el alternativo fijo; el atajo principal es el de Configuración (por defecto Ctrl K).
      const alt = e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyP'
      if (!matchShortcut('palette', e) && !alt) return
      e.preventDefault()
      e.stopPropagation()
      focusField?.()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      focusField = null
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

  const close = (blur: boolean): void => {
    setOpen(false)
    setQuery('')
    setScope(null)
    setFilter('todo')
    setActive(0)
    if (blur) inputRef.current?.blur()
  }

  // Clic afuera cierra la lista.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) close(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // ---------- Filtrado ----------
  const scoped = scope ? ctx.workspaces.find((w) => w.id === scope) : undefined
  let kind: Filter = filter
  let q = query
  if (!scoped) {
    if (q.startsWith('>')) {
      kind = 'acciones'
      q = q.slice(1)
    } else if (q.startsWith('@')) {
      kind = 'equipo'
      q = q.slice(1)
    }
  }
  const nq = q.trim()
  const pool = scoped ? spaceActions(ctx, scoped) : items.filter((it) => kind === 'todo' || it.section === kind)
  const found = open ? fuzzyFilter(pool, nq) : []
  const byId = new Map(items.map((it) => [it.id, it]))
  // Recientes solo en la vista general, sin texto.
  const showRecent = !scoped && !nq && kind === 'todo'
  const recentRows: Row[] = showRecent
    ? readRecent()
        .map((id) => byId.get(id))
        .filter((it): it is Item => Boolean(it))
        .map((item) => ({ item, match: { score: 0, title: [], subtitle: [] } }))
    : []
  const recentIds = new Set(recentRows.map((r) => r.item.id))
  const rows: Row[] = found.map(({ item, match }) => ({ item, match })).filter((r) => !recentIds.has(r.item.id))
  const all: Row[] = [...recentRows, ...rows].slice(0, MAX_RENDER)
  // Grupos en el orden de aparición (Recientes primero).
  const groups: { label: string; rows: { row: Row; index: number }[] }[] = []
  all.forEach((row, index) => {
    const g = showRecent && recentIds.has(row.item.id) ? 'Recientes' : row.item.group
    let grp = groups.find((x) => x.label === g)
    if (!grp) groups.push((grp = { label: g, rows: [] }))
    grp.rows.push({ row, index })
  })
  if (showRecent) {
    // Recientes primero siempre, aunque el resto tenga otro orden.
    groups.sort((a, b) => (a.label === 'Recientes' ? -1 : b.label === 'Recientes' ? 1 : 0))
  }

  const safeActive = all.length ? Math.min(active, all.length - 1) : -1
  const sel = safeActive >= 0 ? all[safeActive].item : undefined

  useEffect(() => setActive(0), [query, filter, scope])

  useEffect(() => {
    if (safeActive < 0) return
    document.getElementById(`pal-opt-${safeActive}`)?.scrollIntoView({ block: 'nearest' })
  }, [safeActive])

  const run = (item: Item | undefined): void => {
    if (!item) return
    pushRecent(item.id)
    close(true)
    setTimeout(() => {
      try {
        item.run()
      } catch (e) {
        ctxRef.current.notifyError(cleanError(e))
      }
    }, 0)
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    const n = all.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) setOpen(true)
      if (n) setActive((a) => (Math.min(a, n - 1) + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(sel)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      if (!e.shiftKey && sel?.spaceId && !scoped) {
        setScope(sel.spaceId)
        setQuery('')
        setFilter('todo')
        setActive(0)
      }
    } else if (e.key === 'Backspace' && !e.currentTarget.value && scoped) {
      setScope(null)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (scoped) setScope(null)
      else close(true)
    }
  }

  const placeholder = scoped ? `Acción para ${scoped.name}…` : 'Buscar espacio, acción o persona'
  const count = all.length === 1 ? '1 resultado' : `${all.length} resultados`

  return (
    <div ref={wrapRef} className={`pal ${open ? 'open' : ''}`}>
      <label className="pal-field">
        <SearchIcon size={15} />
        {scoped && (
          <button
            type="button"
            className="pal-scope"
            onClick={() => {
              setScope(null)
              inputRef.current?.focus()
            }}
            title="Volver a la búsqueda (Retroceso)"
          >
            <span className="pal-scope-ico" style={{ background: colorOf(scoped.accountId) }} />
            <span className="pal-scope-name">{scoped.name}</span>
          </button>
        )}
        <input
          ref={inputRef}
          className="pal-input"
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          placeholder={placeholder}
          role="combobox"
          aria-label="Buscar espacio, acción o persona"
          aria-expanded={open}
          aria-controls="pal-list"
          aria-autocomplete="list"
          aria-activedescendant={safeActive >= 0 ? `pal-opt-${safeActive}` : undefined}
          spellCheck={false}
          autoComplete="off"
        />
        <kbd className="pal-hint">{open ? 'Esc' : bindingOf('palette')}</kbd>
      </label>

      {open && (
        <div className="pal-pop" role="dialog" aria-label="Resultados de la búsqueda">
          {!scoped && (
            <div className="pal-filters" role="group" aria-label="Filtrar por tipo">
              {FILTERS.map((f) => {
                const on = kind === f.id
                return (
                  <button
                    key={f.id}
                    type="button"
                    className="pal-filter"
                    aria-pressed={on}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setFilter(f.id)
                      inputRef.current?.focus()
                    }}
                  >
                    {f.label}
                    {f.prefix && <span className="pal-prefix">{f.prefix}</span>}
                  </button>
                )
              })}
            </div>
          )}

          <div id="pal-list" className="pal-list" role="listbox" aria-label="Resultados">
            {groups.map((g) => (
              <div key={g.label} role="group" aria-label={g.label}>
                <div className="pal-group" role="presentation">
                  {g.label}
                  <span className="pal-group-n">{nq ? g.rows.length : ''}</span>
                </div>
                {g.rows.map(({ row, index }) => {
                  const it = row.item
                  const on = index === safeActive
                  return (
                    <div
                      key={`${g.label}:${it.id}`}
                      id={`pal-opt-${index}`}
                      role="option"
                      aria-selected={on}
                      className={`pal-item ${on ? 'on' : ''} ${it.danger ? 'danger' : ''}`}
                      onMouseMove={() => !on && setActive(index)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => run(it)}
                    >
                      <span className="pal-ico" style={it.iconStyle}>
                        {it.icon}
                      </span>
                      <span className="pal-txt">
                        <span className="pal-title">
                          <Highlight text={it.title} pos={row.match.title} />
                        </span>
                        {it.subtitle && (
                          <span className="pal-sub">
                            <Highlight text={it.subtitle} pos={row.match.subtitle} />
                          </span>
                        )}
                      </span>
                      {it.meta && <span className={`pal-meta s-${it.meta.cls}`}>{it.meta.label}</span>}
                      {it.shortcut && !on && <Keys shortcut={it.shortcut} />}
                      {on && (
                        <span className="pal-enter">
                          {it.spaceId && !scoped ? 'Abrir · Tab acciones' : 'Ejecutar'}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
            {all.length === 0 && (
              <div className="pal-empty">
                <span className="pal-empty-title">
                  Nada coincide con «{nq}»
                </span>
                {nq && !scoped && (
                  <>
                    <span className="pal-empty-sub">Probá con otra palabra o creá un espacio con ese nombre.</span>
                    <button
                      type="button"
                      className="btn sm primary"
                      onClick={() => {
                        close(true)
                        ctx.openNewWorkspace('normal', { name: nq.slice(0, 80) })
                      }}
                    >
                      Crear espacio «{nq.slice(0, 40)}»
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="pal-foot">
            <span>
              <kbd>↑</kbd> <kbd>↓</kbd> moverse
            </span>
            <span>
              <kbd>Enter</kbd> abrir
            </span>
            {!scoped && (
              <span>
                <kbd>Tab</kbd> acciones del espacio
              </span>
            )}
            <span>
              <kbd>Esc</kbd> cerrar
            </span>
            <span className="pal-foot-n">{count}</span>
          </div>
        </div>
      )}
    </div>
  )
}

const ui: FeatureUi = {
  name: 'palette',
  commands: coreCommands
}

export default ui
