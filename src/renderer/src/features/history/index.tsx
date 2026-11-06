import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { CircleNotch, FolderSimple, MagnifyingGlass, Robot, User, X } from '@phosphor-icons/react'
import { useUi, type FeatureUi } from '../host'
import { cleanError } from '../../format'
import './history.css'

/** Lo que manda main (ver src/main/features/history-core.ts). */
interface HistoryItem {
  accountId: string
  accountLabel: string
  sessionId: string
  cwd: string
  ts: number
  role: 'user' | 'assistant'
  before: string
  match: string
  after: string
}
interface DoneMsg {
  searchId: string
  items?: HistoryItem[]
  total?: number
  files?: number
  truncated?: boolean
  cancelled?: boolean
  error?: string
  ms?: number
}
interface OpenResult {
  wsId?: string
  needsConfirm?: boolean
  wsName?: string
  manualCommand?: string
}

const SHORTCUT = 'Ctrl+Shift+F'
const DEBOUNCE_MS = 250

// Abierto/cerrado, compartido entre el botón, el atajo, la paleta y el modal.
let isOpen = false
const listeners = new Set<() => void>()
const setOpen = (v: boolean): void => {
  isOpen = v
  for (const l of listeners) l()
}
const useOpen = (): boolean =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => isOpen
  )

const folderName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

function fmtDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const hm = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (d.toDateString() === now.toDateString()) return `hoy ${hm}`
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return `ayer ${hm}`
  return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

interface Group {
  key: string
  accountId: string
  accountLabel: string
  sessionId: string
  cwd: string
  ts: number
  items: HistoryItem[]
}

function group(items: HistoryItem[]): Group[] {
  const map = new Map<string, Group>()
  for (const it of items) {
    const key = `${it.accountId}:${it.sessionId}`
    let g = map.get(key)
    if (!g) {
      g = { key, accountId: it.accountId, accountLabel: it.accountLabel, sessionId: it.sessionId, cwd: it.cwd, ts: it.ts, items: [] }
      map.set(key, g)
    }
    g.items.push(it)
    if (it.ts > g.ts) g.ts = it.ts
    if (!g.cwd && it.cwd) g.cwd = it.cwd
  }
  const groups = [...map.values()]
  for (const g of groups) g.items.sort((a, b) => b.ts - a.ts)
  return groups.sort((a, b) => b.ts - a.ts)
}

function SearchModal(): React.JSX.Element {
  const ui = useUi()
  const [query, setQuery] = useState('')
  const [accountId, setAccountId] = useState('')
  const [items, setItems] = useState<HistoryItem[]>([])
  const [searching, setSearching] = useState(false)
  const [info, setInfo] = useState<DoneMsg | null>(null)
  const [active, setActive] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ item: HistoryItem; wsName: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const currentId = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => setOpen(false), [])

  // Resultados progresivos de la búsqueda vigente.
  useEffect(() => {
    const offR = ui.on('feat:history:results', (m: { searchId: string; items: HistoryItem[] }) => {
      if (m.searchId !== currentId.current) return
      setItems((prev) => [...prev, ...m.items])
    })
    const offD = ui.on('feat:history:done', (m: DoneMsg) => {
      if (m.searchId !== currentId.current) return
      if (m.items) setItems(m.items)
      setInfo(m)
      setSearching(false)
      if (m.error) setErr(m.error)
    })
    return () => {
      offR()
      offD()
      if (currentId.current) void ui.invoke('feat:history:cancel', currentId.current).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounce de 250 ms; cada búsqueda nueva cancela la anterior.
  useEffect(() => {
    const q = query.trim()
    const prev = currentId.current
    if (prev) void ui.invoke('feat:history:cancel', prev).catch(() => undefined)
    currentId.current = null
    setErr(null)
    if (q.length < 2) {
      setItems([])
      setInfo(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const t = setTimeout(() => {
      const id = crypto.randomUUID()
      currentId.current = id
      setItems([])
      setInfo(null)
      setActive(0)
      void ui.invoke('feat:history:search', id, q, { accountId: accountId || undefined }).catch((e) => {
        if (currentId.current !== id) return
        setErr(cleanError(e))
        setSearching(false)
      })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, accountId])

  useEffect(() => inputRef.current?.focus(), [])

  const groups = useMemo(() => group(items), [items])
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const activeItem = flat[Math.min(active, flat.length - 1)]

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, flat.length])

  const openItem = async (it: HistoryItem, confirmRestart = false): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const r = await ui.invoke<OpenResult>('feat:history:open', {
        accountId: it.accountId,
        sessionId: it.sessionId,
        cwd: it.cwd,
        confirmRestart
      })
      if (r.needsConfirm) {
        setConfirm({ item: it, wsName: r.wsName ?? 'ese espacio' })
        return
      }
      setConfirm(null)
      if (r.manualCommand) {
        setNotice(`«${r.wsName}» no arranca Claude solo. Para retomar esta conversación corré en su terminal: ${r.manualCommand}`)
        return
      }
      close()
    } catch (e) {
      setErr(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (confirm) setConfirm(null)
      else close()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, Math.max(flat.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter' && !confirm && activeItem && (e.target as HTMLElement).tagName !== 'BUTTON') {
      e.preventDefault()
      void openItem(activeItem)
    }
  }

  const loggedAccounts = ui.accounts
  const nSessions = groups.length
  let status: string
  if (query.trim().length < 2) status = 'Escribí al menos 2 letras. No distingue mayúsculas ni acentos.'
  else if (searching) status = items.length ? `Buscando… ${items.length} hasta ahora` : 'Buscando…'
  else if (err) status = ''
  else if (!items.length) status = 'Sin resultados.'
  else
    status = `${items.length} ${items.length === 1 ? 'resultado' : 'resultados'} en ${nSessions} ${nSessions === 1 ? 'conversación' : 'conversaciones'}${info?.truncated ? ' (se muestran los primeros 200)' : ''}`

  let idx = -1
  return (
    <div className="modal-backdrop f-history-backdrop" onMouseDown={close}>
      <div
        className="modal f-history-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="f-history-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <header className="modal-head">
          <MagnifyingGlass size={18} aria-hidden="true" className="f-history-head-icon" />
          <h2 id="f-history-title">Buscar en el historial</h2>
          <span className="f-history-kbd" aria-hidden="true">
            {SHORTCUT}
          </span>
          <button type="button" className="icon-btn" onClick={close} aria-label="Cerrar">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="f-history-bar">
          <label htmlFor="f-history-q" className="sr-only">
            Texto a buscar
          </label>
          <input
            id="f-history-q"
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscá en todas las conversaciones de todas las cuentas…"
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls="f-history-list"
            aria-activedescendant={activeItem ? `f-history-it-${flat.indexOf(activeItem)}` : undefined}
            maxLength={200}
          />
          <label htmlFor="f-history-acc" className="sr-only">
            Cuenta
          </label>
          <select id="f-history-acc" className="f-history-acc" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Todas las cuentas</option>
            {loggedAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>

        <div className="f-history-status" role="status" aria-live="polite">
          {searching && <CircleNotch size={13} className="f-history-spin" aria-hidden="true" />}
          <span>{status}</span>
        </div>

        {err && (
          <p className="form-error" role="alert">
            {err}
          </p>
        )}
        {notice && (
          <p className="f-history-notice" role="note">
            {notice}
          </p>
        )}
        {confirm && (
          <div className="f-history-confirm" role="alertdialog" aria-labelledby="f-history-confirm-t">
            <p id="f-history-confirm-t">
              «{confirm.wsName}» tiene la terminal abierta: se cierra y Claude retoma esta conversación ahí.
            </p>
            <span className="btn-group">
              <button type="button" className="btn sm ghost" onClick={() => setConfirm(null)}>
                Cancelar
              </button>
              <button type="button" className="btn sm primary" disabled={busy} onClick={() => void openItem(confirm.item, true)} autoFocus>
                Retomar ahí
              </button>
            </span>
          </div>
        )}

        <div className="f-history-list" id="f-history-list" role="listbox" aria-label="Resultados" ref={listRef}>
          {groups.map((g) => (
            <section key={g.key} className="f-history-group" aria-label={`${folderName(g.cwd)}, ${g.accountLabel}`}>
              <header className="f-history-ghead">
                <FolderSimple size={14} aria-hidden="true" />
                <span className="f-history-gname" title={g.cwd}>
                  {folderName(g.cwd) || 'Sin carpeta'}
                </span>
                <span className="tag">{g.accountLabel}</span>
                <span className="f-history-gdate">{fmtDate(g.ts)}</span>
                <span className="mono f-history-gid" title={`Conversación ${g.sessionId}`}>
                  {g.sessionId.slice(0, 8)}
                </span>
              </header>
              {g.items.map((it) => {
                idx++
                const i = idx
                const on = activeItem === it
                return (
                  <Fragment key={`${g.key}:${i}`}>
                    <div
                      id={`f-history-it-${i}`}
                      role="option"
                      aria-selected={on}
                      data-active={on}
                      className={`f-history-item ${on ? 'on' : ''}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => void openItem(it)}
                    >
                      <span className={`f-history-role ${it.role}`} title={it.role === 'user' ? 'Vos' : 'Claude'}>
                        {it.role === 'user' ? <User size={12} aria-hidden="true" /> : <Robot size={12} aria-hidden="true" />}
                        <span className="sr-only">{it.role === 'user' ? 'Vos:' : 'Claude:'}</span>
                      </span>
                      <span className="f-history-snip">
                        {it.before}
                        <mark>{it.match}</mark>
                        {it.after}
                      </span>
                      <span className="f-history-date">{fmtDate(it.ts)}</span>
                    </div>
                  </Fragment>
                )
              })}
            </section>
          ))}
        </div>
        <footer className="f-history-foot hint">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> moverse
          </span>
          <span>
            <kbd>Enter</kbd> retomar la conversación
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
  // Fase de captura: funciona aunque la terminal (xterm) tenga el foco.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'F' || e.key === 'f' || e.code === 'KeyF')) {
        e.preventDefault()
        e.stopPropagation()
        setOpen(!isOpen)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return open ? <SearchModal /> : null
}

function TitlebarButton(): React.JSX.Element {
  return (
    <button
      type="button"
      className="icon-btn f-history-tb"
      onClick={() => setOpen(true)}
      aria-label="Buscar en el historial"
      title={`Buscar en el historial (${SHORTCUT})`}
    >
      <MagnifyingGlass size={15} aria-hidden="true" />
    </button>
  )
}

const ui: FeatureUi = {
  name: 'history',
  Titlebar: TitlebarButton,
  Global,
  commands() {
    return [
      {
        id: 'history:search',
        title: 'Buscar en el historial',
        subtitle: 'Todas las conversaciones de todas las cuentas',
        group: 'Historial',
        keywords: 'buscar historial conversaciones transcript sesion resume',
        shortcut: SHORTCUT,
        run: () => setOpen(true)
      }
    ]
  }
}

export default ui
