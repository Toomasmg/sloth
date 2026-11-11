import { useEffect, useRef, useState } from 'react'
import { useUi } from '../host'
import { cleanError } from '../../format'
import { SPACE_CHIP, SPACE_LABEL, spaceStatus } from '../broadcast/state'
import { CloseIcon, SearchIcon, SpaceIcon } from '../../icons/SlothIcons'
import type { Workspace } from '../../../../shared/types'
import {
  isMine,
  norm,
  prioRank,
  setBoardOpen,
  setSnapshot,
  timeAgo,
  useSnapshot,
  type Accion,
  type DetView,
  type GruvDetalle,
  type GruvEstado,
  type Snapshot,
  type Ticket,
  type WriteOpt
} from './model'
import { Av, PrioGlyph, estadoKind, prioTone } from './parts'
import { Detail } from './Detail'

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

/** Mensaje del toast al terminar una escritura. */
const DONE: Record<Accion, string> = {
  estado: 'Estado actualizado en Gruv',
  tomar: 'Ticket tomado',
  soltar: 'Ticket soltado',
  comentar: 'Comentario publicado',
  criterio: 'Criterio actualizado',
  horas: 'Horas sumadas'
}

const byIdDesc = (a: Ticket, b: Ticket): number => {
  const na = Number(a.id.split('-').pop())
  const nb = Number(b.id.split('-').pop())
  return nb - na
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
  /** Detalle por ticket (criterios, comentarios, horas) leído al abrirlo. */
  const [det, setDet] = useState<Record<string, DetView>>({})
  /** Cambios optimistas en curso, por ticket: se muestran ya y se revierten si Gruv no los acepta. */
  const [over, setOver] = useState<Record<string, Partial<Ticket>>>({})
  /** Escritura en curso por ticket (una por ticket). */
  const [wbusy, setWbusy] = useState<Record<string, Accion>>({})
  const [toast, setToast] = useState<string | null>(null)
  const [detTick, setDetTick] = useState(0)
  /** Candado sincrónico: evita dos escrituras en el mismo ticket aunque se clickee rápido. */
  const lock = useRef(new Set<string>())
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

  useEffect(() => {
    if (toast === null) return
    const t = setTimeout(() => setToast(null), 3200)
    return () => clearTimeout(t)
  }, [toast])

  const running = Boolean(snap?.running) || busy === 'refresh'
  // Lo que se ve: la lista de Gruv con los cambios optimistas encima.
  const tickets = (snap?.tickets ?? []).map((t) => (over[t.id] ? { ...t, ...over[t.id] } : t))
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
  const curId = current?.id

  // Detalle del ticket abierto: se pide al abrirlo (no en la lista).
  useEffect(() => {
    if (!curId) return
    let alive = true
    setDet((d) => ({ ...d, [curId]: { ...d[curId], loading: true, error: undefined } }))
    ui.invoke<GruvDetalle>('feat:tickets:detail', curId).then(
      (data) => {
        if (alive) setDet((d) => ({ ...d, [curId]: { data } }))
      },
      (e: unknown) => {
        if (alive) setDet((d) => ({ ...d, [curId]: { error: cleanError(e) } }))
      }
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curId, detTick])

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
      const r = await ui.invoke<{ count: number }>('feat:tickets:refresh')
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

  /**
   * Una escritura en Gruv, pedida por un clic sobre un ticket. Aplica el cambio optimista, espera a
   * Gruv y, si no lo acepta, lo revierte con el error. Devuelve si salió bien.
   */
  const write = async (id: string, a: Accion, payload: Record<string, unknown>, opt: WriteOpt): Promise<boolean> => {
    if (lock.current.has(id)) return false
    lock.current.add(id)
    const prev = det[id]?.data
    setErr(null)
    setWbusy((b) => ({ ...b, [id]: a }))
    if (opt.ticket) setOver((o) => ({ ...o, [id]: { ...o[id], ...opt.ticket } }))
    if (opt.det && prev) setDet((d) => ({ ...d, [id]: { data: opt.det!(prev) } }))
    try {
      const r = await ui.invoke<{ detail: GruvDetalle | null }>('feat:tickets:accion', a, id, payload)
      if (r?.detail) setDet((d) => ({ ...d, [id]: { data: r.detail! } }))
      setToast(DONE[a])
      return true
    } catch (e) {
      if (opt.det && prev) setDet((d) => ({ ...d, [id]: { data: prev } }))
      setErr(cleanError(e))
      return false
    } finally {
      lock.current.delete(id)
      setOver((o) => {
        const n = { ...o }
        delete n[id]
        return n
      })
      setWbusy((b) => {
        const n = { ...b }
        delete n[id]
        return n
      })
    }
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
      if (!(await ui.invoke<boolean>('feat:tickets:hasRepo', t.id))) {
        // No hay carpeta para tomar (ni por defecto ni de un espacio anterior): se elige en «Nuevo espacio».
        close()
        ui.openNewWorkspace('ticket')
        return
      }
      await ui.invoke('feat:tickets:start', t.id)
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
    void ui.invoke<Snapshot>('feat:tickets:setConfig', { confirmRefresh: ask }).then(setSnapshot, (e) => setErr(cleanError(e)))
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
        <span role="status" className="f-gruv-conn" data-tone={tone}>
          <span className="f-gruv-conn-dot" aria-hidden="true" />
          {connText}
        </span>
        <span className="f-gruv-grow" />
        {running ? (
          <button type="button" className="f-gruv-b f-gruv-b--sm" onClick={() => void ui.invoke('feat:tickets:cancel')}>
            <CloseIcon size={13} /> Cancelar consulta
          </button>
        ) : null}
        <button
          type="button"
          className="f-gruv-b f-gruv-b--sm"
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
            <button type="button" className="f-gruv-b f-gruv-b--sm f-gruv-b--pri" autoFocus onClick={() => void refresh()}>
              Consultar
            </button>
            <button type="button" className="f-gruv-b f-gruv-b--sm" onClick={() => setConfirming(false)}>
              Cancelar
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
                <SearchIcon size={14} strokeWidth={1.9} />
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
                      className={`f-gruv-chipf f-gruv-st-${estadoKind(e.clave)} ${on ? 'on' : ''}`}
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
              {offline && (
                <div className="f-gruv-alert f-gruv-offline" role="alert">
                  <span className="f-gruv-alert-text">
                    No pudimos hablar con Gruv. Mostramos lo último que cargamos.
                    {snap?.lastError && <span className="f-gruv-alert-detail">{snap.lastError}</span>}
                  </span>
                  <button type="button" className="f-gruv-b f-gruv-b--xs f-gruv-b--solid-danger" onClick={() => void refresh()} disabled={running}>
                    Reintentar
                  </button>
                </div>
              )}

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
                      <button type="button" className="f-gruv-b f-gruv-b--sm f-gruv-b--pri" onClick={() => void refresh()} disabled={running}>
                        Reintentar
                      </button>
                    </>
                  ) : snap.fetchedAt ? (
                    <span className="f-gruv-empty-title">No hay tickets activos en Gruv.</span>
                  ) : (
                    <>
                      <span className="f-gruv-empty-title">Todavía no se consultó Gruv.</span>
                      <span className="f-gruv-muted">Actualizá para traer tus tickets y los del equipo.</span>
                      <button type="button" className="f-gruv-b f-gruv-b--sm f-gruv-b--pri" onClick={askRefresh} disabled={running}>
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
                                <SpaceIcon size={11} strokeWidth={2.2} />
                                <span className="f-gruv-ellipsis">
                                  {ws.name} · {SPACE_LABEL[st]}
                                </span>
                              </span>
                            )}
                          </span>
                          <span className="f-gruv-row-title">{t.titulo}</span>
                          <span className="f-gruv-row-meta">
                            <span className={`f-gruv-st f-gruv-st-${estadoKind(t.estado)}`}>{estadoName(t.estado)}</span>
                            {t.prioridad && (
                              <span className="f-gruv-prio" style={{ color: prioTone(t.prioridad) }}>
                                <PrioGlyph p={t.prioridad} />
                                {t.prioridad}
                              </span>
                            )}
                            {t.responsable ? (
                              <span className="f-gruv-who">
                                <Av name={t.responsable} size="sm" />
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
                    className="f-gruv-b f-gruv-b--sm"
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
                me={me}
                estados={estados}
                estadoName={estadoName}
                view={det[current.id]}
                wbusy={wbusy[current.id]}
                noDisp={snap?.noDisponible ?? {}}
                sinCuenta={!snap?.config.queryAccountId}
                startBusy={busy === `start:${current.id}`}
                disabledAll={Boolean(busy)}
                tplName={tpls.find((x) => usesTicket(x) && /gruv/i.test(x.name))?.name ?? tpls.find(usesTicket)?.name}
                onStart={() => void start(current)}
                onOpenSpace={openSpace}
                onWrite={(a, payload, opt) => write(current.id, a, payload, opt)}
                onReload={() => setDetTick((n) => n + 1)}
              />
            )}
          </section>
        </div>
      </main>

      {toast && (
        <div className="f-gruv-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}
