import { useEffect, useRef, useState } from 'react'
import { useUi } from '../host'
import { cleanError } from '../../format'
import { resolveAccountColor } from '../settings/store'
import { SPACE_CHIP, SPACE_LABEL, spaceStatus } from '../broadcast/state'
import { CloseIcon, DoneIcon, ErrorIcon, IdleIcon, TicketIcon, WorkingIcon } from '../../icons/SlothIcons'
import type { Workspace } from '../../../../shared/types'
import {
  isMine,
  norm,
  prioRank,
  setBoardOpen,
  setSnapshot,
  timeAgo,
  useSnapshot,
  type GruvEstado,
  type Snapshot,
  type Ticket
} from './model'

/** Lo que se escribe en Gruv: esta app solo lee Gruv, así que estas acciones van deshabilitadas. */
const WHERE = 'Se hace desde Gruv'

type Tab = 'mios' | 'equipo' | 'sin'
const TABS: { id: Tab; name: string }[] = [
  { id: 'mios', name: 'Míos' },
  { id: 'equipo', name: 'Del equipo' },
  { id: 'sin', name: 'Sin asignar' }
]

/** Lo que devuelve `feat:templates:list` (solo lo que usamos). */
interface TemplateLite {
  id: string
  name: string
  namePattern?: string
  initialPrompt?: string
  useWorktree?: { branchPattern: string }
}
const usesTicket = (t: TemplateLite): boolean =>
  [t.namePattern, t.initialPrompt, t.useWorktree?.branchPattern].some((s) => Boolean(s && /\{ticket(min)?\}/.test(s)))

const PRIO_PATH = {
  0: 'M12 5v9M12 18h.01',
  1: 'M6 14.5l6-6 6 6',
  2: 'M5 9.5h14M5 14.5h14',
  3: 'M6 9.5l6 6 6-6'
} as const
const prioPath = (p?: string): string => PRIO_PATH[(Math.min(prioRank(p), 3) as keyof typeof PRIO_PATH)]
const prioTone = (p?: string): string => (prioRank(p) === 0 ? 'var(--danger-fg)' : prioRank(p) === 1 ? 'var(--warn-fg)' : 'var(--fg-2)')

/** Clase de chip por estado de Gruv (color + texto; el color solo no alcanza). */
function estadoChip(k?: string): string {
  if (k === 'en_curso') return 'chip-working'
  if (k === 'en_revision' || k === 'en_qa' || k === 'pre_rtd') return 'chip-waiting'
  if (k === 'bloqueado' || k === 'rechazado') return 'chip-error'
  return 'chip-idle'
}

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?'

const byIdDesc = (a: Ticket, b: Ticket): number => {
  const na = Number(a.id.split('-').pop())
  const nb = Number(b.id.split('-').pop())
  return nb - na
}

/** Icono de prioridad (trazo, con texto al lado). */
function PrioGlyph({ p, size = 12 }: { p?: string; size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
      <path d={prioPath(p)} />
    </svg>
  )
}

function BackGlyph(): React.JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  )
}

function RefreshGlyph(): React.JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <path d="M19.5 12a7.5 7.5 0 0 1-13 5.1M4.5 12a7.5 7.5 0 0 1 13-5.1M17.5 3.5v3.4h-3.4M6.5 20.5v-3.4h3.4" />
    </svg>
  )
}

function ExternalGlyph(): React.JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 4h6v6M20 4l-8 8M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
    </svg>
  )
}

export function Board(): React.JSX.Element {
  const ui = useUi()
  const snap = useSnapshot()
  const [tab, setTab] = useState<Tab>('mios')
  const [q, setQ] = useState('')
  const [stSel, setStSel] = useState<string[]>([])
  const [prio, setPrio] = useState('todas')
  const [selId, setSelId] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [tpls, setTpls] = useState<TemplateLite[]>([])
  const backRef = useRef<HTMLButtonElement>(null)

  const close = (): void => setBoardOpen(false)

  // Foco al abrir y vuelta a lo que tenía el foco al cerrar.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    backRef.current?.focus()
    return () => prev?.focus?.()
  }, [])

  useEffect(() => {
    void ui.invoke<TemplateLite[]>('feat:templates:list').then((l) => setTpls(Array.isArray(l) ? l : []), () => setTpls([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (confirming) setConfirming(false)
      else close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [confirming])

  const running = Boolean(snap?.running) || busy === 'refresh'
  const tickets = snap?.tickets ?? []
  const me = snap?.me
  const estados = snap?.estados ?? []
  const estadoName = (k?: string): string => estados.find((e) => e.clave === k)?.nombre ?? (k ? k.replace(/_/g, ' ') : 'Sin estado')
  const wsOf = (id: string): Workspace | undefined => ui.workspaces.find((w) => w.ticket?.toUpperCase() === id)
  const accLabel = (id?: string): string | undefined => ui.accounts.find((a) => a.id === id)?.label

  const isMineT = (t: Ticket): boolean => isMine(t, me)
  const inTab = (t: Ticket, tb: Tab): boolean => (tb === 'mios' ? isMineT(t) : tb === 'equipo' ? Boolean(t.responsable) && !isMineT(t) : !t.responsable)
  const counts: Record<Tab, number> = {
    mios: tickets.filter((t) => inTab(t, 'mios')).length,
    equipo: tickets.filter((t) => inTab(t, 'equipo')).length,
    sin: tickets.filter((t) => inTab(t, 'sin')).length
  }

  const qn = norm(q.trim())
  const filtersOn = Boolean(qn) || stSel.length > 0 || prio !== 'todas'
  const visible = tickets
    .filter(
      (t) =>
        inTab(t, tab) &&
        (!stSel.length || stSel.includes(t.estado ?? '')) &&
        (prio === 'todas' || (t.prioridad ?? '') === prio) &&
        (!qn || norm(`${t.id} ${t.titulo}`).includes(qn))
    )
    .sort(byIdDesc)
  const current = visible.find((t) => t.id === selId) ?? visible[0] ?? null

  // Chips de estado: los del flujo de Gruv que tienen tickets (y los que no estén en el flujo).
  const estadoKeys = [
    ...estados.filter((e) => tickets.some((t) => t.estado === e.clave)),
    ...[...new Set(tickets.map((t) => t.estado).filter((k): k is string => Boolean(k)))]
      .filter((k) => !estados.some((e) => e.clave === k))
      .map((k): GruvEstado => ({ clave: k, nombre: k.replace(/_/g, ' ') }))
  ]
  const prioOpts = [...new Set(tickets.map((t) => t.prioridad).filter((p): p is string => Boolean(p)))].sort(
    (a, b) => prioRank(a) - prioRank(b) || a.localeCompare(b)
  )

  const countLabel = visible.length === 1 ? '1 ticket' : `${visible.length} tickets`

  // ---------- acciones ----------
  const refresh = async (): Promise<void> => {
    setConfirming(false)
    setInfo(null)
    setErr(null)
    setBusy('refresh')
    try {
      const r = await ui.invoke<{ count: number }>('feat:gruv:refresh')
      setInfo(`Gruv trajo ${r.count} ${r.count === 1 ? 'ticket' : 'tickets'}.`)
    } catch (e) {
      setErr(cleanError(e))
    } finally {
      setBusy(null)
    }
  }

  const askRefresh = (): void => {
    if (snap?.config.confirmRefresh) setConfirming(true)
    else void refresh()
  }

  /** «Empezar en Sloth»: con la plantilla de ticket si existe; si no, el flujo de siempre (`/ticket`). */
  const start = async (t: Ticket): Promise<void> => {
    setErr(null)
    const ws = wsOf(t.id)
    if (ws) {
      ui.openPane(ws.id)
      close()
      return
    }
    setBusy(`start:${t.id}`)
    try {
      const tpl = tpls.find((x) => usesTicket(x) && /gruv/i.test(x.name)) ?? tpls.find(usesTicket)
      if (tpl) {
        await ui.invoke('feat:templates:create', tpl.id, { ticket: t.id })
        close()
        return
      }
      if (!(await ui.invoke<boolean>('feat:gruv:hasRepo', t.id))) {
        // No hay carpeta para tomar (ni por defecto ni de un espacio anterior): se elige en «Nuevo espacio».
        close()
        ui.openNewWorkspace('ticket')
        return
      }
      await ui.invoke('feat:gruv:start', t.id)
      close()
    } catch (e) {
      setErr(cleanError(e))
    } finally {
      setBusy(null)
    }
  }

  const openSpace = (ws: Workspace): void => {
    ui.openPane(ws.id)
    close()
  }

  const setConfirmRefresh = (ask: boolean): void => {
    void ui.invoke<Snapshot>('feat:gruv:setConfig', { confirmRefresh: ask }).then(setSnapshot, (e) => setErr(cleanError(e)))
  }

  // ---------- estado de conexión (real: lo que dejó la última consulta) ----------
  const anyLogged = ui.accounts.some((a) => ui.statuses[a.id]?.loggedIn)
  type Tone = 'ok' | 'busy' | 'bad' | 'idle'
  let tone: Tone = 'idle'
  let connText = 'Gruv todavía no se consultó'
  if (!snap) connText = 'Cargando…'
  else if (running) {
    tone = 'busy'
    connText = `Consultando Gruv con ${accLabel(snap.config.queryAccountId) ?? 'una cuenta'}…`
  } else if (snap.lastError) {
    tone = 'bad'
    connText = 'Sin conexión con Gruv'
  } else if (!anyLogged) {
    tone = 'bad'
    connText = 'Ninguna cuenta tiene sesión iniciada'
  } else if (snap.fetchedAt) {
    tone = 'ok'
    connText = `Conectado con ${accLabel(snap.fetchedBy) ?? 'una cuenta'} · actualizado ${timeAgo(snap.fetchedAt)}`
  }
  const ConnIcon = tone === 'busy' ? WorkingIcon : tone === 'bad' ? ErrorIcon : tone === 'ok' ? DoneIcon : IdleIcon
  const connClass = tone === 'busy' ? 'chip-working' : tone === 'bad' ? 'chip-error' : tone === 'ok' ? 'chip-done' : 'chip-idle'

  const offline = Boolean(snap?.lastError) && !running

  const bodyLoading = !snap || (running && tickets.length === 0)
  const showRows = !bodyLoading && visible.length > 0

  return (
    <div className="f-gruv-page" role="dialog" aria-modal="true" aria-labelledby="f-gruv-title">
      <header className="f-gruv-bar">
        <button ref={backRef} type="button" className="f-gruv-back" onClick={close}>
          <BackGlyph />
          Espacios
        </button>
        <span className="f-gruv-sep" aria-hidden="true" />
        <span role="status" className={`chip ${connClass} f-gruv-conn`}>
          <ConnIcon size={12} />
          {connText}
        </span>
        <span className="f-gruv-grow" />
        {running ? (
          <button type="button" className="btn sm" onClick={() => void ui.invoke('feat:gruv:cancel')}>
            <CloseIcon size={13} /> Cancelar consulta
          </button>
        ) : null}
        <button
          type="button"
          className="btn sm"
          onClick={askRefresh}
          disabled={running || !snap}
          title="Lee los tickets de Gruv con la cuenta que la consulta (solo lectura)"
        >
          <RefreshGlyph />
          {running ? 'Actualizando…' : 'Actualizar'}
        </button>
      </header>

      <main className="f-gruv-main">
        <div>
          <h1 id="f-gruv-title" className="f-gruv-h1">
            Tickets de Gruv
          </h1>
          <p className="f-gruv-lead">Tus tickets y los del equipo. Empezá uno y Sloth arma el espacio para trabajarlo.</p>
        </div>

        {confirming && (
          <div className="f-gruv-alert f-gruv-confirm" role="alertdialog" aria-label="Confirmar consulta a Gruv">
            <span>
              Para leer Gruv se abre Claude sin ventana con <b>{accLabel(snap?.config.queryAccountId) ?? 'una cuenta'}</b> (modelo{' '}
              {snap?.config.model}) y usa tokens de esa cuenta. Solo lee: no cambia nada en Gruv.
            </span>
            <label className="check f-gruv-inline-check">
              <input type="checkbox" onChange={(e) => setConfirmRefresh(!e.target.checked)} />
              No volver a preguntar
            </label>
            <button type="button" className="btn sm primary" autoFocus onClick={() => void refresh()}>
              Consultar
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setConfirming(false)}>
              Cancelar
            </button>
          </div>
        )}

        {offline && (
          <div className="f-gruv-alert f-gruv-offline" role="alert">
            <span className="f-gruv-alert-text">
              No pudimos hablar con Gruv. Mostramos lo último que cargamos.
              <span className="f-gruv-alert-detail">{snap?.lastError}</span>
            </span>
            <button type="button" className="btn sm primary" onClick={() => void refresh()} disabled={running}>
              Reintentar
            </button>
          </div>
        )}
        {err && (
          <p className="form-error" role="alert">
            {err}
          </p>
        )}
        {info && !err && !offline && (
          <p className="f-gruv-ok" role="status">
            {info}
          </p>
        )}

        <div className="f-gruv-grid">
          {/* LISTA */}
          <section className="f-gruv-panel f-gruv-list" aria-labelledby="f-gruv-lista-t">
            <h2 id="f-gruv-lista-t" className="sr-only">
              Lista de tickets
            </h2>
            <div role="tablist" aria-label="Qué tickets ver" className="f-gruv-tabs">
              {TABS.map((t) => {
                const on = tab === t.id
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    tabIndex={on ? 0 : -1}
                    className={`f-gruv-tab ${on ? 'on' : ''}`}
                    onClick={() => setTab(t.id)}
                    onKeyDown={(e) => {
                      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
                      e.preventDefault()
                      const i = TABS.findIndex((x) => x.id === tab)
                      const j = (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length
                      setTab(TABS[j].id)
                    }}
                  >
                    {t.name}
                    <span className="f-gruv-badge">{counts[t.id]}</span>
                  </button>
                )
              })}
            </div>

            <div className="f-gruv-filters">
              <label className="f-gruv-search">
                <svg width={14} height={14} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round">
                  <path d="M4.5 10.5a6 6 0 1 0 12 0a6 6 0 1 0 -12 0M15 15l5 5" />
                </svg>
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Buscar por código o título"
                  aria-label="Buscar por código o título"
                />
              </label>
              <div role="group" aria-label="Filtrar por estado" className="f-gruv-chips">
                {estadoKeys.map((e) => {
                  const on = stSel.includes(e.clave)
                  return (
                    <button
                      key={e.clave}
                      type="button"
                      className={`f-gruv-chipf ${on ? 'on' : ''}`}
                      aria-pressed={on}
                      onClick={() => setStSel((s) => (on ? s.filter((x) => x !== e.clave) : [...s, e.clave]))}
                    >
                      {e.nombre}
                    </button>
                  )
                })}
              </div>
              <div className="f-gruv-filter-row">
                <label className="f-gruv-prio-field">
                  Prioridad
                  <select value={prio} onChange={(e) => setPrio(e.target.value)}>
                    <option value="todas">Todas</option>
                    {prioOpts.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="f-gruv-grow" />
                {filtersOn && (
                  <button
                    type="button"
                    className="f-gruv-link"
                    onClick={() => {
                      setQ('')
                      setStSel([])
                      setPrio('todas')
                    }}
                  >
                    Limpiar filtros
                  </button>
                )}
              </div>
            </div>

            <div className="f-gruv-countbar">
              <span role="status">{snap ? countLabel : ''}</span>
            </div>

            <div aria-busy={running} className="f-gruv-body">
              {bodyLoading && (
                <div role="status" className="f-gruv-skel">
                  <div />
                  <div />
                  <div />
                  <div />
                  <span>Cargando tickets de Gruv…</span>
                </div>
              )}

              {!bodyLoading && snap && tickets.length === 0 && (
                <div className="f-gruv-empty">
                  {snap.lastError ? (
                    <>
                      <span className="f-gruv-empty-title">No pudimos cargar los tickets.</span>
                      <button type="button" className="btn sm primary" onClick={() => void refresh()} disabled={running}>
                        Reintentar
                      </button>
                    </>
                  ) : snap.fetchedAt ? (
                    <span className="f-gruv-empty-title">No hay tickets activos en Gruv.</span>
                  ) : (
                    <>
                      <span className="f-gruv-empty-title">Todavía no se consultó Gruv.</span>
                      <span className="f-gruv-muted">Actualizá para traer tus tickets y los del equipo.</span>
                      <button type="button" className="btn sm primary" onClick={askRefresh} disabled={running}>
                        Actualizar
                      </button>
                    </>
                  )}
                </div>
              )}

              {showRows && (
                <ul className="f-gruv-rows">
                  {visible.map((t) => {
                    const ws = wsOf(t.id)
                    const sel = current?.id === t.id
                    const mine = isMineT(t)
                    const st = ws ? spaceStatus(ws.id, ui.agents, ui.permissions) : null
                    return (
                      <li key={t.id}>
                        <button
                          type="button"
                          className={`f-gruv-row ${sel ? 'sel' : ''}`}
                          aria-current={sel ? 'true' : undefined}
                          onClick={() => setSelId(t.id)}
                        >
                          <span className="f-gruv-row-top">
                            <span className="f-gruv-code mono">{t.id}</span>
                            {ws && st && (
                              <span className={`chip f-gruv-space ${SPACE_CHIP[st]}`}>
                                <TicketIcon size={11} />
                                <span className="f-gruv-ellipsis">
                                  {ws.name} · {SPACE_LABEL[st]}
                                </span>
                              </span>
                            )}
                          </span>
                          <span className="f-gruv-row-title">{t.titulo}</span>
                          <span className="f-gruv-row-meta">
                            <span className={`chip ${estadoChip(t.estado)}`}>{estadoName(t.estado)}</span>
                            {t.prioridad && (
                              <span className="f-gruv-prio" style={{ color: prioTone(t.prioridad) }}>
                                <PrioGlyph p={t.prioridad} />
                                {t.prioridad}
                              </span>
                            )}
                            {t.responsable ? (
                              <span className="f-gruv-who">
                                <span className="f-gruv-av sm" aria-hidden="true" data-mine={mine ? 'true' : undefined}>
                                  {initials(t.responsable)}
                                </span>
                                {mine ? 'Vos' : t.responsable}
                              </span>
                            ) : (
                              <span className="f-gruv-muted">Sin asignar</span>
                            )}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}

              {!bodyLoading && snap && tickets.length > 0 && visible.length === 0 && (
                <div className="f-gruv-empty">
                  <span className="f-gruv-empty-title">Ningún ticket coincide con los filtros.</span>
                  <span className="f-gruv-muted">Probá con otra palabra o sacá algún filtro.</span>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      setQ('')
                      setStSel([])
                      setPrio('todas')
                    }}
                  >
                    Limpiar filtros
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* DETALLE */}
          <section className="f-gruv-panel f-gruv-det" aria-labelledby="f-gruv-det-t">
            {!current ? (
              <p className="f-gruv-muted">{snap ? 'Elegí un ticket de la lista.' : 'Cargando…'}</p>
            ) : (
              <Detail
                t={current}
                ws={wsOf(current.id)}
                mine={isMineT(current)}
                meName={me?.nombre}
                estados={estados}
                estadoName={estadoName}
                busy={busy === `start:${current.id}`}
                disabledAll={Boolean(busy)}
                tplName={tpls.find((x) => usesTicket(x) && /gruv/i.test(x.name))?.name ?? tpls.find(usesTicket)?.name}
                onStart={() => void start(current)}
                onOpenSpace={openSpace}
              />
            )}
          </section>
        </div>
      </main>

      <div className="f-gruv-foot">
        Solo se lee Gruv. Estado, asignación, comentarios y horas se cambian desde Gruv.
      </div>
    </div>
  )
}

function Detail(props: {
  t: Ticket
  ws?: Workspace
  mine: boolean
  meName?: string
  estados: GruvEstado[]
  estadoName: (k?: string) => string
  busy: boolean
  disabledAll: boolean
  tplName?: string
  onStart: () => void
  onOpenSpace: (ws: Workspace) => void
}): React.JSX.Element {
  const ui = useUi()
  const { t, ws, mine, estados } = props
  const st = ws ? spaceStatus(ws.id, ui.agents, ui.permissions) : null
  const resp = t.responsable
  const avBg = mine ? 'var(--accent-soft)' : resp ? 'var(--team-soft)' : 'var(--hover)'
  const avFg = mine ? 'var(--accent)' : resp ? 'var(--team-fg)' : 'var(--fg-muted)'
  const wsAcc = ws ? ui.accounts.findIndex((a) => a.id === ws.accountId) : -1
  const crit = t.criterios ?? []
  const done = crit.filter((c) => c.hecho).length
  const selectOpts = estados.some((e) => e.clave === t.estado) || !t.estado
    ? estados
    : [...estados, { clave: t.estado, nombre: props.estadoName(t.estado) }]

  return (
    <>
      <div className="f-gruv-det-head">
        <span className="f-gruv-code mono f-gruv-code-lg">{t.id}</span>
        <h2 id="f-gruv-det-t" className="f-gruv-det-title">
          {t.titulo}
        </h2>
        <div className="f-gruv-fields">
          <div className="f-gruv-field">
            <label htmlFor="f-gruv-estado">Estado</label>
            <select id="f-gruv-estado" value={t.estado ?? ''} disabled aria-describedby="f-gruv-w-estado">
              {!t.estado && <option value="">Sin estado</option>}
              {selectOpts.map((e) => (
                <option key={e.clave} value={e.clave}>
                  {e.nombre}
                </option>
              ))}
            </select>
            <span id="f-gruv-w-estado" className="f-gruv-why">
              {WHERE}
            </span>
          </div>
          <div className="f-gruv-field">
            <span className="f-gruv-lbl">Prioridad</span>
            <span className="f-gruv-prio-val" style={{ color: prioTone(t.prioridad) }}>
              <PrioGlyph p={t.prioridad} size={13} />
              {t.prioridad ?? 'Sin prioridad'}
            </span>
          </div>
        </div>
      </div>

      <div className="f-gruv-assign">
        <span className="f-gruv-av lg" style={{ background: avBg, color: avFg }} aria-hidden="true">
          {resp ? initials(resp) : '?'}
        </span>
        <div className="f-gruv-assign-text">
          <div className="f-gruv-muted">Asignado a</div>
          <div className="f-gruv-strong">{resp ? (mine ? `${resp} (vos)` : resp) : 'Sin asignar'}</div>
        </div>
        {!resp && (
          <>
            <button type="button" className="btn sm" disabled aria-describedby="f-gruv-w-take">
              Tomarlo
            </button>
            <span id="f-gruv-w-take" className="f-gruv-why">
              {WHERE}
            </span>
          </>
        )}
        {mine && (
          <>
            <button type="button" className="btn sm" disabled aria-describedby="f-gruv-w-drop">
              Soltar
            </button>
            <span id="f-gruv-w-drop" className="f-gruv-why">
              {WHERE}
            </span>
          </>
        )}
        {resp && !mine && <span className="f-gruv-muted">Lo tiene {resp}</span>}
      </div>

      <div className="f-gruv-actions">
        {ws && st ? (
          <>
            <span className={`chip ${SPACE_CHIP[st]} f-gruv-space-lg`}>
              <span className="f-gruv-ellipsis">
                {ws.name} · {SPACE_LABEL[st]}
              </span>
            </span>
            <button type="button" className="btn primary" onClick={() => props.onOpenSpace(ws)}>
              Abrir espacio
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn primary" onClick={props.onStart} disabled={props.busy || props.disabledAll}>
              {props.busy ? 'Creando…' : 'Empezar en Sloth'}
            </button>
            <span className="f-gruv-why-block">
              {props.tplName
                ? `Crea un espacio con la plantilla «${props.tplName}».`
                : `Crea el espacio ${t.id} y arranca Claude con /ticket ${t.id}.`}
            </span>
          </>
        )}
        {t.url ? (
          <a className="btn" href={t.url} target="_blank" rel="noreferrer" aria-label={`Abrir ${t.id} en Gruv`}>
            <ExternalGlyph />
            Abrir en Gruv
          </a>
        ) : (
          <button type="button" className="btn" disabled title="Gruv no dio el link de este ticket">
            <ExternalGlyph />
            Abrir en Gruv
          </button>
        )}
        {ws && wsAcc >= 0 && (
          <span className="f-gruv-acc">
            <span className="f-gruv-dot" style={{ background: resolveAccountColor(ws.accountId, wsAcc) }} aria-hidden="true" />
            {ui.accounts[wsAcc].label}
          </span>
        )}
      </div>

      <section className="f-gruv-sec" aria-labelledby="f-gruv-d-t">
        <h3 id="f-gruv-d-t">Descripción</h3>
        <p className="f-gruv-desc">{t.descripcion ?? 'Gruv no trajo la descripción de este ticket.'}</p>
      </section>

      {crit.length > 0 && (
        <section className="f-gruv-sec" aria-labelledby="f-gruv-c-t">
          <div className="f-gruv-sec-head">
            <h3 id="f-gruv-c-t">Criterios de aceptación</h3>
            <span className="f-gruv-strong">
              {done} de {crit.length}
            </span>
          </div>
          <div className="f-gruv-progress" role="progressbar" aria-label="Criterios cumplidos" aria-valuemin={0} aria-valuemax={crit.length} aria-valuenow={done}>
            <span style={{ width: `${Math.round((done / crit.length) * 100)}%` }} />
          </div>
          <ul className="f-gruv-crit">
            {crit.map((c, i) => (
              <li key={i}>
                <label>
                  <input type="checkbox" checked={c.hecho} disabled aria-describedby="f-gruv-w-crit" />
                  <span>{c.texto}</span>
                </label>
              </li>
            ))}
          </ul>
          <span id="f-gruv-w-crit" className="f-gruv-why">
            {WHERE}
          </span>
        </section>
      )}

      <section className="f-gruv-sec" aria-labelledby="f-gruv-co-t">
        <h3 id="f-gruv-co-t">Comentarios</h3>
        <div className="f-gruv-inline">
          <input className="f-gruv-input" disabled placeholder="Escribí un comentario" aria-label={`Comentar en ${t.id}`} aria-describedby="f-gruv-w-com" />
          <button type="button" className="btn" disabled>
            Publicar
          </button>
        </div>
        <div className="f-gruv-inline-foot">
          <span id="f-gruv-w-com" className="f-gruv-why">
            {WHERE}
          </span>
          {t.url ? (
            <a className="f-gruv-link" href={t.url} target="_blank" rel="noreferrer">
              Abrir en Gruv
            </a>
          ) : null}
        </div>
      </section>

      <section className="f-gruv-sec" aria-labelledby="f-gruv-h-t">
        <h3 id="f-gruv-h-t">Horas</h3>
        <div className="f-gruv-inline">
          <input
            className="f-gruv-input narrow"
            disabled
            inputMode="decimal"
            placeholder="Ej.: 2 o 1,5"
            aria-label={`Horas a sumar en ${t.id}`}
            aria-describedby="f-gruv-w-hr"
          />
          <button type="button" className="btn" disabled>
            Sumar horas
          </button>
        </div>
        <span id="f-gruv-w-hr" className="f-gruv-why">
          {WHERE}
        </span>
      </section>
    </>
  )
}
