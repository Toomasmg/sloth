import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useUi } from '../host'
import { cleanError } from '../../format'
import { getSettings } from '../settings/store'
import { CheckIcon, DoneIcon, IdleIcon, PermissionIcon } from '../../icons/SlothIcons'
import { PageShell } from '../help/PageShell'
import { marks, wordsOf } from '../help/text'
import { SessionDetail } from './SessionDetail'
import {
  filterRows,
  fmtTime,
  groupRows,
  plural,
  RANGES,
  rowKey,
  spaceColor,
  spaceOptions,
  statusOf,
  STATUS_LABEL,
  type Filters,
  type Range
} from './model'
import type { ListReply, PrefsReply, SessionRow, TextHit } from './types'
import './history.css'

/** Valores por defecto de los filtros (30 días; en modo liviano, 7 días). */
const DEFAULTS: Omit<Filters, 'q' | 'range'> = { space: 'todos', acc: 'todas', showHidden: false }
const defaultRange = (): Range => (getSettings().settings.lightMode ? '7' : '30')

export function HistoryPage({ onClose, initialSpace }: { onClose: () => void; initialSpace?: string }): React.JSX.Element {
  const ui = useUi()
  const inv = useRef(ui.invoke)
  inv.current = ui.invoke

  const [rows, setRows] = useState<SessionRow[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [pinned, setPinned] = useState<Set<string>>(new Set())
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [space, setSpace] = useState(initialSpace ?? DEFAULTS.space)
  const [acc, setAcc] = useState(DEFAULTS.acc)
  const [range, setRange] = useState<Range>(defaultRange)
  const [showHidden, setShowHidden] = useState(DEFAULTS.showHidden)
  const [sel, setSel] = useState<string | null>(null)
  const [textHits, setTextHits] = useState<Record<string, TextHit>>({})
  const [searching, setSearching] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const toastTimer = useRef<number | undefined>(undefined)
  const searchId = useRef<string | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)

  const say = (m: string): void => {
    setToast(m)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2400)
  }

  const load = async (): Promise<void> => {
    setLoadErr(null)
    try {
      const r = await inv.current<ListReply>('feat:history:list')
      setRows(r.sessions)
      setPinned(new Set(r.pinned))
      setHidden(new Set(r.hidden))
    } catch (e) {
      setLoadErr(cleanError(e))
      setRows((cur) => cur ?? [])
    }
  }

  useEffect(() => {
    void load()
    searchInput.current?.focus()
    return () => window.clearTimeout(toastTimer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Búsqueda de texto dentro de las conversaciones (sin tildes), con debounce; cada una cancela la anterior.
  useEffect(() => {
    const term = q.trim()
    setTextHits({})
    if (term.length < 2) {
      setSearching(false)
      return
    }
    const id = crypto.randomUUID()
    const t = window.setTimeout(() => {
      searchId.current = id
      setSearching(true)
      inv.current('feat:history:search', id, term, { accountId: acc !== 'todas' ? acc : undefined }).catch(() => {
        if (searchId.current === id) setSearching(false)
      })
    }, 300)
    return () => {
      window.clearTimeout(t)
      if (searchId.current === id) {
        searchId.current = null
        void inv.current('feat:history:cancel', id).catch(() => undefined)
      }
    }
  }, [q, acc])

  useEffect(() => {
    const offR = ui.on('feat:history:results', (m: { searchId: string; items: (TextHit & { ts?: number })[] }) => {
      if (m.searchId !== searchId.current) return
      setTextHits((prev) => {
        const next = { ...prev }
        for (const it of m.items) {
          const k = `${it.accountId}:${it.sessionId}`
          if (!next[k]) next[k] = it
        }
        return next
      })
    })
    const offD = ui.on('feat:history:done', (m: { searchId: string }) => {
      if (m.searchId !== searchId.current) return
      setSearching(false)
    })
    return () => {
      offR()
      offD()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const livePerm = useMemo(() => new Set(ui.permissions.map((p) => p.workspaceId)), [ui.permissions])
  const textKeys = useMemo(() => new Set(Object.keys(textHits)), [textHits])
  const all = rows ?? []
  const total = all.filter((r) => !hidden.has(rowKey(r))).length
  const filters: Filters = { q, space, acc, range, showHidden }
  const visible = useMemo(
    () => (rows ? filterRows(rows, filters, hidden, textKeys) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, q, space, acc, range, showHidden, hidden, textKeys]
  )
  const groups = useMemo(() => groupRows(visible, pinned), [visible, pinned])
  const spaces = useMemo(() => spaceOptions(all, { acc, range, showHidden }, hidden), [all, acc, range, showHidden, hidden])

  const filtersOn = q.trim() !== '' || space !== 'todos' || acc !== 'todas' || range !== defaultRange()
  const countLabel = !rows
    ? ''
    : filtersOn
      ? `${visible.length} de ${total} ${total === 1 ? 'sesión' : 'sesiones'}`
      : plural(total, 'sesión', 'sesiones')

  // La sesión elegida; si ya no está en la lista (filtros, ocultar), la primera visible.
  const flat = [...groups.pins, ...groups.days.flatMap((d) => d.items)]
  const effSel = flat.some((r) => rowKey(r) === sel) ? sel : flat[0] ? rowKey(flat[0]) : null
  const selRow = flat.find((r) => rowKey(r) === effSel) ?? null
  const words = wordsOf(q)

  const clearFilters = (): void => {
    setQ('')
    setSpace(DEFAULTS.space)
    setAcc(DEFAULTS.acc)
    setRange(defaultRange())
    say('Filtros limpios')
  }

  const applyPrefs = (p: PrefsReply): void => {
    setPinned(new Set(p.pinned))
    setHidden(new Set(p.hidden))
  }

  /** Tras borrar: la conversación sale de la lista y se deselecciona. */
  const onDeleted = (key: string, p: PrefsReply): void => {
    applyPrefs(p)
    setRows((cur) => (cur ? cur.filter((r) => rowKey(r) !== key) : cur))
    setSel(null)
    setNotice(null)
    say('Conversación enviada a la Papelera')
  }

  const card = (r: SessionRow): React.ReactNode => {
    const key = rowKey(r)
    const on = key === effSel
    const hit = textHits[key]
    const st = statusOf(r, livePerm)
    const isHidden = hidden.has(key)
    return (
      <button
        key={key}
        type="button"
        className={`hist-card ${on ? 'on' : ''} ${isHidden ? 'is-hidden' : ''}`}
        aria-current={on ? 'true' : undefined}
        onClick={() => {
          setSel(key)
          setNotice(null)
        }}
      >
        <span className="hist-title">
          {marks(r.title, words).map((p, i) =>
            p.hit ? (
              <mark key={i} className="hist-mark">
                {p.t}
              </mark>
            ) : (
              <Fragment key={i}>{p.t}</Fragment>
            )
          )}
        </span>
        {hit && (
          <span className="hist-snip">
            {hit.before}
            <mark className="hist-mark">{hit.match}</mark>
            {hit.after}
          </span>
        )}
        <span className="hist-line">
          <span className="hist-space">
            <span className="hist-dot" style={{ background: spaceColor(r.spaceKey) }} aria-hidden="true" />
            {r.spaceName}
          </span>
          <span className="hist-sep" aria-hidden="true">·</span>
          <span>{r.accountLabel}</span>
          <span className="hist-sep" aria-hidden="true">·</span>
          <span>{fmtTime(r.start)}</span>
        </span>
        <span className="hist-line hist-line-2">
          <span>{plural(r.messages, 'mensaje', 'mensajes')}</span>
          <span>{plural(r.files.length, 'archivo', 'archivos')}</span>
          <span className="hist-grow" />
          {isHidden && <span className="chip chip-idle">Oculta</span>}
          <StatusChip s={st} />
        </span>
      </button>
    )
  }

  const renderList = (): React.ReactNode => {
    if (!rows) return <p className="hist-loading">Leyendo las conversaciones…</p>
    if (visible.length === 0) {
      // Si la lectura falló, el error ya se muestra arriba: no decir «no hay sesiones».
      if (loadErr) return null
      if (all.length === 0) {
        return (
          <div className="hist-empty">
            <span className="hist-empty-title">Todavía no hay sesiones guardadas</span>
            <span className="hint">Cada vez que trabajes con Claude en un espacio, la sesión aparece acá.</span>
          </div>
        )
      }
      return (
        <div className="hist-empty">
          <span className="hist-empty-title">No hay sesiones con estos filtros</span>
          <span className="hint">Probá con otra palabra o ampliá el rango de fechas.</span>
          {filtersOn && (
            <button type="button" className="btn primary" onClick={clearFilters}>
              Limpiar filtros
            </button>
          )}
        </div>
      )
    }
    return (
      <div className="hist-groups">
        {groups.pins.length > 0 && (
          <section className="hist-group" aria-label="Fijadas">
            <h3 className="hist-ghead">
              Fijadas <span>{groups.pins.length}</span>
            </h3>
            {groups.pins.map(card)}
          </section>
        )}
        {groups.days.map((d) => (
          <section key={d.label} className="hist-group" aria-label={d.label}>
            <h3 className="hist-ghead">
              {d.label} <span>{d.n}</span>
            </h3>
            {d.items.map(card)}
          </section>
        ))}
      </div>
    )
  }

  return (
    <PageShell
      labelId="hist-title"
      title="Historial"
      onClose={onClose}
      right={<span className="hist-head-count">{rows ? plural(total, 'sesión guardada', 'sesiones guardadas') : ''}</span>}
    >
      <div className="hist-wrap">
        <div className="hist-intro">
          <h1 id="hist-title">Historial de sesiones</h1>
          <p>Cada vez que trabajaste con Claude en un espacio queda una sesión. Retomala cuando quieras.</p>
        </div>

        <div className="hist-cols">
          <aside className="hist-aside" aria-label="Filtros">
            <label className="hist-field">
              <span>Buscar</span>
              <input
                ref={searchInput}
                className="hist-search"
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Título, espacio o archivo"
                aria-describedby="hist-search-status"
                autoComplete="off"
              />
              <span id="hist-search-status" className="hint" role="status">
                {q.trim().length >= 2 && searching
                  ? 'Buscando en los mensajes…'
                  : q.trim().length >= 2
                    ? `Coincide en ${Object.keys(textHits).length} ${Object.keys(textHits).length === 1 ? 'conversación' : 'conversaciones'} por texto`
                    : 'No distingue mayúsculas ni tildes.'}
              </span>
            </label>

            <fieldset className="hist-fs">
              <legend>Espacio</legend>
              <button type="button" className="hist-opt" aria-pressed={space === 'todos'} onClick={() => setSpace('todos')}>
                <span className="hist-dot" style={{ background: 'var(--placeholder)' }} aria-hidden="true" />
                <span className="hist-opt-name">Todos los espacios</span>
                <span className="hist-opt-n">{spaces.reduce((n, s) => n + s.n, 0)}</span>
              </button>
              {spaces.map((s) => (
                <button key={s.key} type="button" className="hist-opt" aria-pressed={space === s.key} onClick={() => setSpace(s.key)}>
                  <span className="hist-dot" style={{ background: s.color }} aria-hidden="true" />
                  <span className="hist-opt-name">{s.name}</span>
                  <span className="hist-opt-n">{s.n}</span>
                </button>
              ))}
            </fieldset>

            <div className="hist-field">
              <span>Cuenta</span>
              <div className="seg hist-seg" role="group" aria-label="Cuenta">
                <button type="button" aria-pressed={acc === 'todas'} onClick={() => setAcc('todas')}>
                  Todas
                </button>
                {ui.accounts.map((a) => (
                  <button key={a.id} type="button" aria-pressed={acc === a.id} onClick={() => setAcc(a.id)}>
                    {a.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="hist-field">
              <span>Rango</span>
              <div className="seg hist-seg" role="group" aria-label="Rango">
                {RANGES.filter((g) => !getSettings().settings.lightMode || g.id !== '30').map((g) => (
                  <button key={g.id} type="button" aria-pressed={range === g.id} onClick={() => setRange(g.id)}>
                    {g.name}
                  </button>
                ))}
              </div>
            </div>

            {filtersOn && (
              <button type="button" className="btn hist-clear" onClick={clearFilters}>
                Limpiar filtros
              </button>
            )}
          </aside>

          <section className="hist-list" aria-label="Sesiones">
            <div className="hist-list-head">
              <span className="hist-list-count">{countLabel}</span>
              <span className="hist-grow" />
              {hidden.size > 0 && (
                <button type="button" className="btn sm ghost" aria-pressed={showHidden} onClick={() => setShowHidden((v) => !v)}>
                  {showHidden ? 'Ocultar las ocultas' : `Mostrar ocultas (${hidden.size})`}
                </button>
              )}
              <button type="button" className="btn sm ghost" onClick={() => void load()}>
                Actualizar
              </button>
            </div>
            {loadErr && (
              <p className="form-error" role="alert">
                {loadErr}
              </p>
            )}
            {notice && (
              <p className="hist-notice" role="note">
                {notice}
              </p>
            )}
            {renderList()}
          </section>

          <section className="hist-detail" aria-label="Detalle de la sesión">
            {selRow ? (
              <SessionDetail
                key={rowKey(selRow)}
                row={selRow}
                isPinned={pinned.has(rowKey(selRow))}
                isHidden={hidden.has(rowKey(selRow))}
                status={statusOf(selRow, livePerm)}
                onPrefs={applyPrefs}
                onResumed={onClose}
                onDeleted={(p) => onDeleted(rowKey(selRow), p)}
                onNotice={setNotice}
                say={say}
              />
            ) : (
              <div className="hist-nosel">
                  <span className="hist-empty-title">Elegí una sesión</span>
                <span className="hint">Vas a ver la conversación y los archivos que tocó.</span>
              </div>
            )}
          </section>
        </div>
      </div>

      {toast && (
        <div className="hist-toast" role="status">
          <CheckIcon size={15} strokeWidth={2.2} className="hist-toast-ico" />
          {toast}
        </div>
      )}
    </PageShell>
  )
}

function StatusChip({ s }: { s: 'perm' | 'ok' | 'int' }): React.JSX.Element {
  if (s === 'perm')
    return (
      <span className="chip chip-perm">
        <PermissionIcon size={12} />
        {STATUS_LABEL.perm}
      </span>
    )
  if (s === 'ok')
    return (
      <span className="chip chip-done">
        <DoneIcon size={12} />
        {STATUS_LABEL.ok}
      </span>
    )
  return (
    <span className="chip chip-idle">
      <IdleIcon size={12} />
      {STATUS_LABEL.int}
    </span>
  )
}
