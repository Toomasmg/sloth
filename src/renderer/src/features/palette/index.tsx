import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Command as CommandIcon, MagnifyingGlass } from '@phosphor-icons/react'
import { useUi, type Command, type FeatureUi, type UiCtx } from '../host'
import { cleanError } from '../../format'
import { FEATURE_UIS } from '../registry'
import { fuzzyFilter, splitHighlight, type FuzzyMatch } from './fuzzy'
import { coreCommands } from './core-commands'
import './palette.css'

// ---------- Estado abierto/cerrado (lo comparten el botón del titlebar y el modal) ----------
let isOpen = false
const subs = new Set<() => void>()
const setOpen = (v: boolean): void => {
  if (isOpen === v) return
  isOpen = v
  subs.forEach((f) => f())
}
const useOpen = (): boolean =>
  useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => isOpen
  )
/** Para que otras funciones puedan abrir la paleta si lo necesitan. */
export const openPalette = (): void => setOpen(true)

// ---------- Recientes ----------
const RECENT_KEY = 'sloth.palette.recent'
const MAX_RECENT = 5
const MAX_RENDER = 50
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

/** Todos los comandos: los de cada función del registro (se lee en runtime: evita el import circular). */
function allCommands(ctx: UiCtx): Command[] {
  const out: Command[] = []
  const seen = new Set<string>()
  const list: FeatureUi[] = FEATURE_UIS ?? []
  for (const f of list) {
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

interface Row {
  cmd: Command
  match?: FuzzyMatch
  group: string
}

function buildRows(cmds: Command[], query: string): Row[] {
  if (!query.trim()) {
    const byId = new Map(cmds.map((c) => [c.id, c]))
    const recent = readRecent()
      .map((id) => byId.get(id))
      .filter((c): c is Command => Boolean(c))
    const recentIds = new Set(recent.map((c) => c.id))
    const rows: Row[] = recent.map((cmd) => ({ cmd, group: 'Recientes' }))
    // Resto agrupado por grupo, en el orden en que aparecen.
    const groups = new Map<string, Command[]>()
    for (const c of cmds) {
      if (recentIds.has(c.id)) continue
      const g = groups.get(c.group)
      if (g) g.push(c)
      else groups.set(c.group, [c])
    }
    for (const [group, list] of groups) for (const cmd of list) rows.push({ cmd, group })
    return rows.slice(0, MAX_RENDER)
  }
  const found = fuzzyFilter(cmds, query)
  // Agrupar manteniendo el orden por puntaje: los grupos salen en el orden de su mejor resultado.
  const groups = new Map<string, Row[]>()
  for (const { item, match } of found) {
    const g = groups.get(item.group)
    const row = { cmd: item, match, group: item.group }
    if (g) g.push(row)
    else groups.set(item.group, [row])
  }
  return [...groups.values()].flat().slice(0, MAX_RENDER)
}

function Highlight({ text, pos }: { text: string; pos?: number[] }): React.JSX.Element {
  return (
    <>
      {splitHighlight(text, pos ?? []).map((p, i) =>
        p.hl ? (
          <mark key={i} className="f-palette-hl">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  )
}

function Keys({ shortcut }: { shortcut: string }): React.JSX.Element {
  return (
    <span className="f-palette-keys" aria-label={`Atajo ${shortcut}`}>
      {shortcut.split('+').map((k, i) => (
        <kbd key={i}>{k.trim()}</kbd>
      ))}
    </span>
  )
}

function Palette({ onClose }: { onClose: (restore: boolean) => void }): React.JSX.Element {
  const ctx = useUi()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx

  // Los comandos se arman al abrir y cuando cambia el estado de la app (no en cada tecla).
  const cmds = useMemo(
    () => allCommands(ctx),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx.accounts, ctx.workspaces, ctx.statuses, ctx.agents, ctx.permissions, ctx.openPanes, ctx.focused, ctx.maximized]
  )
  const rows = useMemo(() => buildRows(cmds, query), [cmds, query])
  const safeActive = rows.length ? Math.min(active, rows.length - 1) : -1

  useEffect(() => setActive(0), [query])
  useEffect(() => inputRef.current?.focus(), [])

  useLayoutEffect(() => {
    if (safeActive < 0) return
    listRef.current?.querySelector(`#f-palette-opt-${safeActive}`)?.scrollIntoView({ block: 'nearest' })
  }, [safeActive])

  const run = (row: Row | undefined): void => {
    if (!row) return
    pushRecent(row.cmd.id)
    onClose(true)
    // Después de cerrar y devolver el foco: el comando puede mover el foco a otro lado.
    setTimeout(() => {
      try {
        const r = row.cmd.run()
        if (r && typeof (r as Promise<void>).catch === 'function')
          (r as Promise<void>).catch((e) => ctxRef.current.notifyError(cleanError(e)))
      } catch (e) {
        ctxRef.current.notifyError(cleanError(e))
      }
    }, 0)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    const n = rows.length
    const move = (d: number): void => {
      e.preventDefault()
      if (n) setActive((a) => (Math.min(a, n - 1) + d + n) % n)
    }
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) move(1)
    else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) move(-1)
    else if (e.key === 'PageDown') move(Math.min(8, Math.max(1, n - 1 - safeActive)))
    else if (e.key === 'PageUp') move(-Math.min(8, Math.max(1, safeActive)))
    else if (e.key === 'Enter') {
      e.preventDefault()
      run(rows[safeActive])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
    }
  }

  let lastGroup = ''
  return (
    <div className="f-palette-backdrop" onMouseDown={() => onClose(true)}>
      <div className="f-palette" role="dialog" aria-modal="true" aria-label="Paleta de comandos" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="f-palette-search">
          <MagnifyingGlass size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscá un comando, un espacio, una plantilla…"
            role="combobox"
            aria-expanded="true"
            aria-controls="f-palette-list"
            aria-autocomplete="list"
            aria-activedescendant={safeActive >= 0 ? `f-palette-opt-${safeActive}` : undefined}
            aria-label="Buscar comando"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="f-palette-esc">Esc</kbd>
        </div>
        <div className="f-palette-list" id="f-palette-list" role="listbox" ref={listRef} aria-label="Comandos">
          {rows.length === 0 && <p className="f-palette-empty">Nada coincide con «{query}».</p>}
          {rows.map((row, i) => {
            const head = row.group !== lastGroup ? row.group : null
            lastGroup = row.group
            return (
              <div key={`${row.group}:${row.cmd.id}`} role="presentation">
                {head && (
                  <div className="f-palette-group" role="presentation">
                    {head}
                  </div>
                )}
                <div
                  id={`f-palette-opt-${i}`}
                  role="option"
                  aria-selected={i === safeActive}
                  className={`f-palette-item ${i === safeActive ? 'active' : ''}`}
                  onMouseMove={() => i !== safeActive && setActive(i)}
                  onClick={() => run(row)}
                >
                  {row.cmd.icon && (
                    <span className="f-palette-ico" aria-hidden="true">
                      {row.cmd.icon}
                    </span>
                  )}
                  <span className="f-palette-text">
                    <span className="f-palette-title">
                      <Highlight text={row.cmd.title} pos={row.match?.title} />
                    </span>
                    {row.cmd.subtitle && (
                      <span className="f-palette-sub">
                        <Highlight text={row.cmd.subtitle} pos={row.match?.subtitle} />
                      </span>
                    )}
                  </span>
                  {row.cmd.shortcut && <Keys shortcut={row.cmd.shortcut} />}
                </div>
              </div>
            )
          })}
        </div>
        <footer className="f-palette-foot" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> moverse
          </span>
          <span>
            <kbd>Enter</kbd> ejecutar
          </span>
          <span>
            <kbd>Esc</kbd> cerrar
          </span>
        </footer>
      </div>
    </div>
  )
}

function Global(): React.JSX.Element | null {
  const open = useOpen()
  const prevFocus = useRef<HTMLElement | null>(null)

  // Fase de captura en window: funciona aunque xterm tenga el foco. Solo Ctrl+K y Ctrl+Shift+P.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return
      const k = e.code === 'KeyK' && !e.shiftKey
      const p = e.code === 'KeyP' && e.shiftKey
      if (!k && !p) return
      e.preventDefault()
      e.stopPropagation()
      setOpen(!isOpen)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useLayoutEffect(() => {
    if (open) {
      const a = document.activeElement
      prevFocus.current = a instanceof HTMLElement && a !== document.body ? a : null
    } else {
      const el = prevFocus.current
      prevFocus.current = null
      if (el && el.isConnected) el.focus()
    }
  }, [open])

  if (!open) return null
  return <Palette onClose={() => setOpen(false)} />
}

function Titlebar(): React.JSX.Element {
  return (
    <button type="button" className="f-palette-tb" onClick={() => setOpen(true)} title="Paleta de comandos (Ctrl+K)" aria-label="Abrir paleta de comandos (Ctrl+K)">
      <CommandIcon size={13} aria-hidden="true" />
      <span className="f-palette-tb-label">Buscar o ejecutar…</span>
      <span className="f-palette-tb-keys" aria-hidden="true">
        Ctrl K
      </span>
    </button>
  )
}

const ui: FeatureUi = {
  name: 'palette',
  Titlebar,
  Global,
  commands: coreCommands
}

export default ui
