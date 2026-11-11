import { useEffect, useRef, useState } from 'react'
import { useUi } from '../host'
import { cleanError } from '../../format'
import { SPACE_CHIP, SPACE_LABEL, spaceStatus } from '../broadcast/state'
import { CloseIcon, SearchIcon, SettingsIcon, SpaceIcon } from '../../icons/SlothIcons'
import type { Workspace } from '../../../../shared/types'
import { categoriaDe } from '../../../../shared/tickets'
import {
  etiquetaTablero,
  isMine,
  norm,
  prioRank,
  setBoardOpen,
  setSnapshot,
  timeAgo,
  useSnapshot,
  type Accion,
  type DetView,
  type Detalle,
  type EstadoBase,
  type Snapshot,
  type Ticket,
  type WriteOpt
} from './model'
import { Av, PrioGlyph, estadoKind, prioTone } from './parts'
import { Detail } from './Detail'
import { Ajustes } from './Ajustes'

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
const doneMessage = (a: Accion, nombre: string): string =>
  ({
    estado: `Estado actualizado en ${nombre}`,
    tomar: 'Ticket tomado',
    soltar: 'Ticket soltado',
    comentar: 'Comentario publicado',
    criterio: 'Criterio actualizado',
    horas: 'Horas sumadas'
  })[a]

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
  const [ajustes, setAjustes] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [tpls, setTpls] = useState<TemplateLite[]>([])
  /** Detalle por ticket (criterios, comentarios, horas) leído al abrirlo. */
  const [det, setDet] = useState<Record<string, DetView>>({})
  /** Cambios optimistas en curso, por ticket: se muestran ya y se revierten si el conector no los acepta. */
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
      else if (ajustes) setAjustes(false)
      else close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [confirming, ajustes])

  useEffect(() => {
    if (toast === null) return
    const t = setTimeout(() => setToast(null), 3200)
    return () => clearTimeout(t)
  }, [toast])

  const running = Boolean(snap?.running) || busy === 'refresh'
  // Lo que se ve: la lista del conector con los cambios optimistas encima.
  const tickets = (snap?.tickets ?? []).map((t) => (over[t.id] ? { ...t, ...over[t.id] } : t))
  const me = snap?.me
  const estados = snap?.estados ?? []
  const n = snap?.conector.nombre ?? 'el conector'
  const unavailable = Boolean(snap) && !snap?.conector.disponible
  const porDefecto = snap?.porDefecto
  // Con gh no hay cuenta de Claude de por medio: se lee con la sesión de GitHub de la persona.
  const porGh = snap?.conector.via === 'gh'
  const kindOf = (k?: string): ReturnType<typeof estadoKind> => estadoKind(categoriaDe(k, estados, snap?.conector.estados ?? []))
  const ticketTpls = tpls.filter(usesTicket)
  const ticketTpl = ticketTpls.find((x) => x.name.toLowerCase().includes(n.toLowerCase())) ?? ticketTpls[0]
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
    if (!curId || !snap?.conector.leeDetalle) return
    let alive = true
    setDet((d) => ({ ...d, [curId]: { ...d[curId], loading: true, error: undefined } }))
    ui.invoke<Detalle>('feat:tickets:detail', curId).then(
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
  }, [curId, detTick, snap?.conector.leeDetalle])

  // Chips de estado: los del flujo del conector que tienen tickets (y los que no estén en el flujo).
  const estadoKeys = [
    ...estados.filter((e) => tickets.some((t) => t.estado === e.clave)),
    ...[...new Set(tickets.map((t) => t.estado).filter((k): k is string => Boolean(k)))]
      .filter((k) => !estados.some((e) => e.clave === k))
      .map((k): EstadoBase => ({ clave: k, nombre: k.replace(/_/g, ' ') }))
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
      setInfo(`${n} trajo ${r.count} ${r.count === 1 ? 'ticket' : 'tickets'}.`)
    } catch (e) {
      setErr(cleanError(e))
    } finally {
      setBusy(null)
    }
  }

  const askRefresh = (): void => {
    if (snap?.config.confirmRefresh && !porGh) setConfirming(true)
    else void refresh()
  }

  /**
   * Una escritura en el conector, pedida por un clic sobre un ticket. Aplica el cambio optimista, espera
   * a que responda y, si no lo acepta, lo revierte con el error. Devuelve si salió bien.
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
      const r = await ui.invoke<{ detail: Detalle | null }>('feat:tickets:accion', a, id, payload)
      if (r?.detail) setDet((d) => ({ ...d, [id]: { data: r.detail! } }))
      setToast(doneMessage(a, n))
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
      if (ticketTpl) {
        await ui.invoke('feat:templates:create', ticketTpl.id, { ticket: t.id })
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

  const usarConector = (conectorId: string): void => {
    setErr(null)
    void ui.invoke<Snapshot>('feat:tickets:setConfig', { conectorId }).then(setSnapshot, (e) => setErr(cleanError(e)))
  }

  // ---------- estado de conexión (real: lo que dejó la última consulta) ----------
  const anyLogged = ui.accounts.some((a) => ui.statuses[a.id]?.loggedIn)
  type Tone = 'ok' | 'busy' | 'bad' | 'idle'
  let tone: Tone = 'idle'
  let connText = `Todavía no se consultó ${n}`
  if (!snap) connText = 'Cargando…'
  else if (running) {
    tone = 'busy'
    connText = porGh ? `Consultando ${n} con gh…` : `Consultando ${n} con ${accLabel(snap.config.queryAccountId) ?? 'una cuenta'}…`
  } else if (unavailable) {
    tone = 'bad'
    connText = `${n} no está disponible`
  } else if (snap.lastError) {
    tone = 'bad'
    connText = `Sin conexión con ${n}`
  } else if (!anyLogged && !porGh) {
    tone = 'bad'
    connText = 'Ninguna cuenta tiene sesión iniciada'
  } else if (snap.fetchedAt) {
    tone = 'ok'
    connText = `Conectado con ${porGh ? 'gh' : (accLabel(snap.fetchedBy) ?? 'una cuenta')} · actualizado ${timeAgo(snap.fetchedAt)}`
  }
  const offline = Boolean(snap?.lastError) && !running && !unavailable

  const bodyLoading = !snap || (running && tickets.length === 0)
  const showRows = !bodyLoading && visible.length > 0

  return (
    <div className="f-tickets-page" role="dialog" aria-modal="true" aria-labelledby="f-tickets-title">
      <header className="f-tickets-bar">
        <button ref={backRef} type="button" className="f-tickets-back" onClick={close}>
          <BackGlyph />
          Espacios
        </button>
        <span className="f-tickets-sep" aria-hidden="true" />
        <span role="status" className="f-tickets-conn" data-tone={tone}>
          <span className="f-tickets-conn-dot" aria-hidden="true" />
          {connText}
        </span>
        <span className="f-tickets-grow" />
        {running ? (
          <button type="button" className="f-tickets-b f-tickets-b--sm" onClick={() => void ui.invoke('feat:tickets:cancel')}>
            <CloseIcon size={13} /> Cancelar consulta
          </button>
        ) : null}
        <button
          type="button"
          className="f-tickets-b f-tickets-b--sm"
          onClick={askRefresh}
          disabled={running || !snap || unavailable}
          title={porGh ? `Lee los issues de ${n} con gh (solo lectura)` : `Lee los tickets de ${n} con la cuenta que la consulta (solo lectura)`}
        >
          <RefreshGlyph />
          {running ? 'Actualizando…' : 'Actualizar'}
        </button>
        <button
          type="button"
          className="f-tickets-b f-tickets-b--sm"
          onClick={() => setAjustes((v) => !v)}
          disabled={!snap}
          aria-label="Ajustes de tickets"
          aria-expanded={ajustes}
          title="Ajustes de tickets"
        >
          <SettingsIcon size={14} />
        </button>
      </header>

      <main className="f-tickets-main">
        <div>
          <h1 id="f-tickets-title" className="f-tickets-h1">
            {etiquetaTablero(snap)}
          </h1>
          <p className="f-tickets-lead">Tus tickets y los del equipo. Empezá uno y Sloth arma el espacio para trabajarlo.</p>
        </div>

        {ajustes && snap && <Ajustes snap={snap} onClose={() => setAjustes(false)} />}

        {confirming && (
          <div className="f-tickets-alert f-tickets-confirm" role="alertdialog" aria-label={`Confirmar consulta a ${n}`}>
            <span>
              Para leer {n} se abre Claude sin ventana con <b>{accLabel(snap?.config.queryAccountId) ?? 'una cuenta'}</b> (modelo{' '}
              {snap?.config.model}) y usa tokens de esa cuenta. Solo lee: no cambia nada en {n}.
            </span>
            <label className="check f-tickets-inline-check">
              <input type="checkbox" onChange={(e) => setConfirmRefresh(!e.target.checked)} />
              No volver a preguntar
            </label>
            <button type="button" className="f-tickets-b f-tickets-b--sm f-tickets-b--pri" autoFocus onClick={() => void refresh()}>
              Consultar
            </button>
            <button type="button" className="f-tickets-b f-tickets-b--sm" onClick={() => setConfirming(false)}>
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
          <p className="f-tickets-ok" role="status">
            {info}
          </p>
        )}

        <div className="f-tickets-grid">
          {/* LISTA */}
          <section className="f-tickets-panel f-tickets-list" aria-labelledby="f-tickets-lista-t">
            <h2 id="f-tickets-lista-t" className="sr-only">
              Lista de tickets
            </h2>
            <div role="tablist" aria-label="Qué tickets ver" className="f-tickets-tabs">
              {TABS.map((t) => {
                const on = tab === t.id
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    tabIndex={on ? 0 : -1}
                    className={`f-tickets-tab ${on ? 'on' : ''}`}
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
                    <span className="f-tickets-badge">{counts[t.id]}</span>
                  </button>
                )
              })}
            </div>

            <div className="f-tickets-filters">
              <label className="f-tickets-search">
                <SearchIcon size={14} strokeWidth={1.9} />
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Buscar por código o título"
                  aria-label="Buscar por código o título"
                />
              </label>
              <div role="group" aria-label="Filtrar por estado" className="f-tickets-chips">
                {estadoKeys.map((e) => {
                  const on = stSel.includes(e.clave)
                  return (
                    <button
                      key={e.clave}
                      type="button"
                      className={`f-tickets-chipf f-tickets-st-${kindOf(e.clave)} ${on ? 'on' : ''}`}
                      aria-pressed={on}
                      onClick={() => setStSel((s) => (on ? s.filter((x) => x !== e.clave) : [...s, e.clave]))}
                    >
                      {e.nombre}
                    </button>
                  )
                })}
              </div>
              <div className="f-tickets-filter-row">
                <label className="f-tickets-prio-field">
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
                <span className="f-tickets-grow" />
                {filtersOn && (
                  <button
                    type="button"
                    className="f-tickets-link"
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

            <div className="f-tickets-countbar">
              <span role="status">{snap ? countLabel : ''}</span>
            </div>

            <div aria-busy={running} className="f-tickets-body">
              {snap?.aviso && (
                <div className="f-tickets-alert f-tickets-aviso" role="status">
                  <span className="f-tickets-alert-text">{snap.aviso}</span>
                </div>
              )}

              {unavailable && (
                <div className="f-tickets-alert f-tickets-offline" role="alert">
                  <span className="f-tickets-alert-text">{snap?.lastError}</span>
                  {porDefecto && (
                    <button type="button" className="f-tickets-b f-tickets-b--xs f-tickets-b--solid-danger" onClick={() => usarConector(porDefecto.id)}>
                      Usar {porDefecto.nombre}
                    </button>
                  )}
                </div>
              )}

              {offline && (
                <div className="f-tickets-alert f-tickets-offline" role="alert">
                  <span className="f-tickets-alert-text">
                    No pudimos hablar con {n}. Mostramos lo último que cargamos.
                    {snap?.lastError && <span className="f-tickets-alert-detail">{snap.lastError}</span>}
                  </span>
                  <button type="button" className="f-tickets-b f-tickets-b--xs f-tickets-b--solid-danger" onClick={() => void refresh()} disabled={running}>
                    Reintentar
                  </button>
                </div>
              )}

              {bodyLoading && (
                <div role="status" className="f-tickets-skel">
                  <div />
                  <div />
                  <div />
                  <div />
                  <span>{snap ? `Cargando tickets de ${n}…` : 'Cargando tickets…'}</span>
                </div>
              )}

              {!bodyLoading && snap && !unavailable && tickets.length === 0 && (
                <div className="f-tickets-empty">
                  {snap.lastError ? (
                    <>
                      <span className="f-tickets-empty-title">No pudimos cargar los tickets.</span>
                      <button type="button" className="f-tickets-b f-tickets-b--sm f-tickets-b--pri" onClick={() => void refresh()} disabled={running}>
                        Reintentar
                      </button>
                    </>
                  ) : snap.fetchedAt ? (
                    <span className="f-tickets-empty-title">No hay tickets activos en {n}.</span>
                  ) : (
                    <>
                      <span className="f-tickets-empty-title">Todavía no se consultó {n}.</span>
                      <span className="f-tickets-muted">Actualizá para traer tus tickets y los del equipo.</span>
                      <button type="button" className="f-tickets-b f-tickets-b--sm f-tickets-b--pri" onClick={askRefresh} disabled={running}>
                        Actualizar
                      </button>
                    </>
                  )}
                </div>
              )}

              {showRows && (
                <ul className="f-tickets-rows">
                  {visible.map((t) => {
                    const ws = wsOf(t.id)
                    const sel = current?.id === t.id
                    const mine = isMineT(t)
                    const st = ws ? spaceStatus(ws.id, ui.agents, ui.permissions) : null
                    return (
                      <li key={t.id}>
                        <button
                          type="button"
                          className={`f-tickets-row ${sel ? 'sel' : ''}`}
                          aria-current={sel ? 'true' : undefined}
                          onClick={() => setSelId(t.id)}
                        >
                          <span className="f-tickets-row-top">
                            <span className="f-tickets-code mono">{t.id}</span>
                            {ws && st && (
                              <span className={`chip f-tickets-space ${SPACE_CHIP[st]}`}>
                                <SpaceIcon size={11} strokeWidth={2.2} />
                                <span className="f-tickets-ellipsis">
                                  {ws.name} · {SPACE_LABEL[st]}
                                </span>
                              </span>
                            )}
                          </span>
                          <span className="f-tickets-row-title">{t.titulo}</span>
                          <span className="f-tickets-row-meta">
                            <span className={`f-tickets-st f-tickets-st-${kindOf(t.estado)}`}>{estadoName(t.estado)}</span>
                            {t.prioridad && (
                              <span className="f-tickets-prio" style={{ color: prioTone(t.prioridad) }}>
                                <PrioGlyph p={t.prioridad} />
                                {t.prioridad}
                              </span>
                            )}
                            {t.responsable ? (
                              <span className="f-tickets-who">
                                <Av name={t.responsable} size="sm" />
                                {mine ? 'Vos' : t.responsable}
                              </span>
                            ) : (
                              <span className="f-tickets-muted">Sin asignar</span>
                            )}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}

              {!bodyLoading && snap && tickets.length > 0 && visible.length === 0 && (
                <div className="f-tickets-empty">
                  <span className="f-tickets-empty-title">Ningún ticket coincide con los filtros.</span>
                  <span className="f-tickets-muted">Probá con otra palabra o sacá algún filtro.</span>
                  <button
                    type="button"
                    className="f-tickets-b f-tickets-b--sm"
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
          <section className="f-tickets-panel f-tickets-det" aria-labelledby="f-tickets-det-t">
            {!current || !snap ? (
              <p className="f-tickets-muted">{snap ? 'Elegí un ticket de la lista.' : 'Cargando…'}</p>
            ) : (
              <Detail
                t={current}
                ws={wsOf(current.id)}
                mine={isMineT(current)}
                me={me}
                estados={estados}
                conector={snap.conector}
                estadoName={estadoName}
                view={det[current.id]}
                wbusy={wbusy[current.id]}
                noDisp={snap.noDisponible ?? {}}
                sinCuenta={!porGh && !snap.config.queryAccountId}
                startBusy={busy === `start:${current.id}`}
                disabledAll={Boolean(busy)}
                tplName={ticketTpl?.name}
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
        <div className="f-tickets-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}
