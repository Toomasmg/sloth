import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useUi } from '../host'
import { View } from '../../ui/View'
import { cleanError } from '../../format'
import { spaceStatus } from '../broadcast/state'
import { CloseIcon, SearchIcon, SettingsIcon, TicketIcon } from '../../icons/SlothIcons'
import { Button, EmptyState } from '../../ui'
import { openSettings } from '../settings/bus'
import type { Workspace } from '../../../../shared/types'
import { categoriaDe, SIN_CONECTOR, type FiltroVista } from '../../../../shared/tickets'
import { espacioDelTicket } from '../../../../shared/templates-shared'
import { VUELTAS_DEFECTO, VUELTAS_MAX } from '../../../../shared/tickets-uso'
import {
  consumirPedidoFiltro,
  etiquetaTablero,
  isMine,
  norm,
  prioRank,
  setBoardOpen,
  setSnapshot,
  textoUltimaConsulta,
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
import { TarjetaTicket, estadoKind } from './parts'
import { ListaVirtual, UMBRAL_VENTANA } from './ListaVirtual'
import { Detail } from './Detail'
import { FiltroBar, type CambioFiltro } from './FiltroBar'
import { Grupos } from './Grupos'
import { grupoDe, gruposDe, GRUPO_TODOS, hayFaltante, ordenarPorGrupo } from './filtro-vista'

type Modo = 'todo' | 'faltante' | 'personas'
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

const tabDe = (t: Ticket, me?: Snapshot['me']): Tab => (isMine(t, me) ? 'mios' : t.responsable ? 'equipo' : 'sin')

/** Id de la tarjeta de la lista que tiene el foco; sin `data-tid` (lista normal) se deduce por posición en `ids`. */
function tarjetaEnfocada(ids: readonly string[]): string | null {
  const li = document.activeElement?.closest<HTMLElement>('.f-tickets-rows > li')
  if (!li) return null
  if (li.dataset.tid) return li.dataset.tid
  return ids[Array.prototype.indexOf.call(li.parentElement?.children ?? [], li)] ?? null
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
  const [confirmModo, setConfirmModo] = useState<Modo>('todo')
  const [grupoSel, setGrupoSel] = useState(GRUPO_TODOS)
  const [filtroAbierto, setFiltroAbierto] = useState(consumirPedidoFiltro)
  /** Lo último que se pidió en el filtro, mientras main todavía responde: las casillas no esperan al viaje. */
  const [optimista, setOptimista] = useState<FiltroVista | null>(null)
  const [personasBusy, setPersonasBusy] = useState(false)
  const [errPersonas, setErrPersonas] = useState<string | null>(null)
  const [errPorPersona, setErrPorPersona] = useState<Record<string, string>>({})
  const [modoCorriendo, setModoCorriendo] = useState<Modo | null>(null)
  const colaFiltro = useRef<Promise<unknown>>(Promise.resolve())
  const filtrosEnViaje = useRef(0)
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
  const frescoRef = useRef(false)
  /** Candado sincrónico: evita dos escrituras en el mismo ticket aunque se clickee rápido. */
  const lock = useRef(new Set<string>())

  const close = (): void => setBoardOpen(false)
  const elegirConector = (): void => {
    close()
    openSettings('tickets', () => setBoardOpen(true))
  }

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
  // Lo que se ve: la lista del conector con los cambios optimistas encima.
  const tickets = useMemo(() => (snap?.tickets ?? []).map((t) => (over[t.id] ? { ...t, ...over[t.id] } : t)), [snap, over])
  const me = snap?.me
  const estados = useMemo(() => snap?.estados ?? [], [snap?.estados])
  const n = snap?.conector.nombre ?? 'el conector'
  const sinConector = snap?.conector.id === SIN_CONECTOR
  const unavailable = Boolean(snap) && !sinConector && !snap?.conector.disponible
  // Con gh no hay cuenta de Claude de por medio: se lee con la sesión de GitHub de la persona.
  const porGh = snap?.conector.via === 'gh'
  const kindOf = (k?: string): ReturnType<typeof estadoKind> => estadoKind(categoriaDe(k, estados, snap?.conector.estados ?? []))
  const ticketTpls = tpls.filter(usesTicket)
  // Una plantilla cuyo prompt arranca con un comando solo vale de comodín si es el del conector,
  // no la primera que haya.
  const sirveDeComodin = (x: TemplateLite): boolean => {
    const p = (x.initialPrompt ?? '').trim()
    return !p.startsWith('/') || p.split(/\s/)[0] === snap?.conector.comandoTicket
  }
  const ticketTpl = ticketTpls.find((x) => x.name.toLowerCase().includes(n.toLowerCase())) ?? ticketTpls.find(sirveDeComodin)
  const estadoName = (k?: string): string => estados.find((e) => e.clave === k)?.nombre ?? (k ? k.replace(/_/g, ' ') : 'Sin estado')
  const wsOf = (t: Ticket): Workspace | undefined => {
    return espacioDelTicket(ui.workspaces, t.id, snap?.carpetas?.[t.id], snap?.conector.via === 'gh')
  }
  const accLabel = (id?: string): string | undefined => ui.accounts.find((a) => a.id === id)?.label

  const isMineT = (t: Ticket): boolean => isMine(t, me)
  // Con un conector que filtra por personas, main ya mandó los tickets filtrados y los grupos reemplazan a las pestañas.
  const filtro: FiltroVista | undefined = snap?.filtro ? (optimista ?? snap.filtro) : undefined
  const grupos = useMemo(() => (filtro && snap ? gruposDe(filtro, snap.personas, me, tickets, snap.pendientes) : []), [filtro, snap, me, tickets])
  const grupoActivo = grupos.some((g) => g.clave === grupoSel) ? grupoSel : GRUPO_TODOS
  const grupoSinTraer = grupos.find((g) => g.clave === grupoActivo)?.sinTraer === true
  const errVigentes = useMemo(
    () => Object.fromEntries(Object.entries(errPorPersona).filter(([id]) => snap?.pendientes?.personas.includes(id))),
    [errPorPersona, snap?.pendientes]
  )
  const counts = useMemo<Record<Tab, number>>(() => {
    const c: Record<Tab, number> = { mios: 0, equipo: 0, sin: 0 }
    for (const t of tickets) c[tabDe(t, me)]++
    return c
  }, [tickets, me])

  const qn = norm(q.trim())
  const filtersOn = Boolean(qn) || stSel.length > 0 || prio !== 'todas'
  const visible = useMemo(
    () => {
      const lista = tickets
        .filter(
          (t) =>
            (filtro ? grupoActivo === GRUPO_TODOS || grupoDe(t, me) === grupoActivo : tabDe(t, me) === tab) &&
            (!stSel.length || stSel.includes(t.estado ?? '')) &&
            (prio === 'todas' || (t.prioridad ?? '') === prio) &&
            (!qn || norm(`${t.id} ${t.titulo}`).includes(qn))
        )
        .sort(byIdDesc)
      return filtro && grupoActivo === GRUPO_TODOS ? ordenarPorGrupo(lista, grupos, me) : lista
    },
    [tickets, me, tab, stSel, prio, qn, filtro, grupoActivo, grupos]
  )
  const ids = useMemo(() => visible.map((t) => t.id), [visible])
  const current = visible.find((t) => t.id === selId) ?? visible[0] ?? null
  const curId = current?.id

  // Detalle del ticket abierto: se pide al abrirlo (no en la lista).
  useEffect(() => {
    if (!curId || !snap?.conector.leeDetalle) return
    let alive = true
    setDet((d) => ({ ...d, [curId]: { ...d[curId], loading: true, error: undefined } }))
    // Al abrir un ticket sirve el detalle que ya se leyó; «Recargar» pide uno nuevo.
    const fresco = frescoRef.current
    frescoRef.current = false
    ui.invoke<Detalle>('feat:tickets:detail', curId, fresco).then(
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
  const estadoKeys = useMemo(
    () => [
      ...estados.filter((e) => tickets.some((t) => t.estado === e.clave)),
      ...[...new Set(tickets.map((t) => t.estado).filter((k): k is string => Boolean(k)))]
        .filter((k) => !estados.some((e) => e.clave === k))
        .map((k): EstadoBase => ({ clave: k, nombre: k.replace(/_/g, ' ') }))
    ],
    [estados, tickets]
  )
  const prioOpts = useMemo(
    () => [...new Set(tickets.map((t) => t.prioridad).filter((p): p is string => Boolean(p)))].sort((a, b) => prioRank(a) - prioRank(b) || a.localeCompare(b)),
    [tickets]
  )

  const countLabel = visible.length === 1 ? '1 ticket' : `${visible.length} tickets`

  // ---------- acciones ----------
  const refresh = async (vueltas?: number, modo: 'todo' | 'faltante' = 'todo'): Promise<void> => {
    const sinTraer = modo === 'faltante' ? (snap?.pendientes?.personas ?? []) : []
    setConfirming(false)
    setInfo(null)
    setErr(null)
    setErrPorPersona({})
    setBusy('refresh')
    setModoCorriendo(modo)
    try {
      const r = await ui.invoke<{ count: number }>('feat:tickets:refresh', undefined, vueltas, modo)
      setInfo(`${n} trajo ${r.count} ${r.count === 1 ? 'ticket' : 'tickets'}.`)
    } catch (e) {
      const msg = cleanError(e)
      // Lo que ya estaba sigue a la vista: el fallo se marca en las personas que se estaban trayendo.
      if (sinTraer.length) setErrPorPersona(Object.fromEntries(sinTraer.map((id) => [id, msg])))
      else setErr(msg)
    } finally {
      setBusy(null)
      setModoCorriendo(null)
    }
  }

  const traerPersonas = async (): Promise<void> => {
    setConfirming(false)
    setErrPersonas(null)
    setPersonasBusy(true)
    try {
      setSnapshot(await ui.invoke<Snapshot>('feat:tickets:personas'))
    } catch (e) {
      setErrPersonas(cleanError(e))
    } finally {
      setPersonasBusy(false)
    }
  }

  const ejecutar = (modo: Modo): void => void (modo === 'personas' ? traerPersonas() : refresh(undefined, modo))

  const pedir = (modo: Modo): void => {
    if (snap?.config.confirmRefresh && !porGh) {
      setConfirmModo(modo)
      setConfirming(true)
    } else ejecutar(modo)
  }
  const askRefresh = (): void => pedir('todo')

  /** Los cambios al filtro van de a uno y en orden; main solo los valida y los guarda (no consulta nada). */
  const aplicarFiltro = (c: CambioFiltro): void => {
    const base = optimista ?? snap?.filtro
    if (!base) return
    setErr(null)
    setOptimista({
      personasElegidas: c.personasElegidas ?? base.personasElegidas,
      incluirSinAsignar: c.incluirSinAsignar ?? base.incluirSinAsignar,
      estadosElegidos: c.estadosElegidos ?? base.estadosElegidos,
      ventanaDias: c.ventanaDias ?? base.ventanaDias
    })
    filtrosEnViaje.current++
    colaFiltro.current = colaFiltro.current
      .then(() => ui.invoke<Snapshot>('feat:tickets:setFiltro', c))
      .then(setSnapshot, (e: unknown) => setErr(cleanError(e)))
      .finally(() => {
        if (--filtrosEnViaje.current === 0) setOptimista(null)
      })
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

  /** «Empezar en Sloth»: con la plantilla de ticket si existe; si no, el flujo del conector. */
  const start = async (t: Ticket): Promise<void> => {
    setErr(null)
    const ws = wsOf(t)
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

  // ---------- estado de conexión (real: lo que dejó la última consulta) ----------
  const anyLogged = ui.accounts.some((a) => ui.statuses[a.id]?.loggedIn)
  type Tone = 'ok' | 'busy' | 'bad' | 'idle'
  let tone: Tone = 'idle'
  let connText = `Todavía no se consultó ${n}`
  if (!snap) connText = 'Cargando…'
  else if (sinConector) connText = 'Sin conector'
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
  const topeVueltas = Boolean(snap?.lastError) && !running && !unavailable && snap?.lastRun?.tope === 'vueltas'
  const offline = Boolean(snap?.lastError) && !running && !unavailable && !topeVueltas
  const vueltasActuales = snap?.lastRun?.maxTurns ?? VUELTAS_DEFECTO
  const ultimaConsulta = snap?.lastRun ? textoUltimaConsulta(snap.lastRun) : ''

  const bodyLoading = !snap || (running && tickets.length === 0)
  const showRows = !bodyLoading && visible.length > 0
  const virtual = visible.length > UMBRAL_VENTANA
  // Al cruzar el umbral se cambia de lista y la tarjeta enfocada se desmonta: se lee ahora, con el DOM viejo todavía puesto.
  const virtualPrevia = useRef(virtual)
  const idsPrevios = useRef(ids)
  const enfocadaAlCambiar = virtualPrevia.current !== virtual ? tarjetaEnfocada(idsPrevios.current) : null
  useLayoutEffect(() => {
    virtualPrevia.current = virtual
    if (virtual || enfocadaAlCambiar === null) return
    const i = ids.indexOf(enfocadaAlCambiar)
    document.querySelector<HTMLElement>(`.f-tickets-rows > li:nth-child(${i + 1}) button`)?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtual])
  useLayoutEffect(() => {
    idsPrevios.current = ids
  })

  const tarjeta = (t: Ticket, i?: number): React.JSX.Element => {
    const ws = wsOf(t)
    return (
      <TarjetaTicket
        key={t.id}
        id={t.id}
        titulo={t.titulo}
        estado={estadoName(t.estado)}
        estadoClase={kindOf(t.estado)}
        prioridad={t.prioridad}
        responsable={t.responsable}
        mine={isMineT(t)}
        sel={current?.id === t.id}
        espacio={ws?.name}
        espacioEstado={ws ? spaceStatus(ws.id, ui.agents, ui.permissions) : null}
        onSelect={setSelId}
        total={i === undefined ? undefined : visible.length}
        pos={i === undefined ? undefined : i + 1}
      />
    )
  }

  // Sin tickets que mostrar: la vista es solo un estado vacío con una acción (sin pestañas ni filtros en 0).
  const vacio = !bodyLoading && Boolean(snap) && tickets.length === 0
  const conBarra = Boolean(filtro && snap && !sinConector && !unavailable)
  const vacioNode = !snap ? null : sinConector ? (
    <EmptyState
      size="lg"
      icon={<TicketIcon size={28} />}
      title="Conectá tus tickets"
      description="Traé los tickets de Jira, GitHub, Linear u otro sistema y empezá a trabajarlos desde un espacio. Sloth funciona igual sin tickets."
      action={
        <Button variant="primary" onClick={elegirConector}>
          Elegir conector
        </Button>
      }
    />
  ) : unavailable ? (
    <EmptyState
      size="lg"
      icon={<TicketIcon size={28} />}
      title={`${n} no está disponible`}
      description={snap.lastError ?? 'Elegí otro conector para traer tus tickets.'}
      action={
        <Button variant="primary" onClick={elegirConector}>
          Elegir conector
        </Button>
      }
    />
  ) : snap.lastError ? (
    <EmptyState
      size="lg"
      icon={<TicketIcon size={28} />}
      title="No pudimos cargar los tickets"
      description={snap.lastError}
      action={
        <Button variant="primary" onClick={() => void refresh()} disabled={running}>
          Reintentar
        </Button>
      }
    />
  ) : snap.fetchedAt ? (
    <EmptyState
      size="lg"
      icon={<TicketIcon size={28} />}
      title={filtro ? 'No hay tickets con este filtro' : `No hay tickets activos en ${n}`}
      description={filtro ? 'Probá con otros estados o personas en el filtro de arriba, o actualizá.' : 'Cuando haya alguno asignado o del equipo, aparece acá.'}
      action={<Button onClick={askRefresh} disabled={running}>Actualizar</Button>}
    />
  ) : (
    <EmptyState
      size="lg"
      icon={<TicketIcon size={28} />}
      title={`Todavía no se consultó ${n}`}
      description="Actualizá para traer tus tickets y los del equipo."
      action={
        <Button variant="primary" onClick={askRefresh} disabled={running}>
          Actualizar
        </Button>
      }
    />
  )

  return (
    <View
      labelId="f-tickets-view-title"
      title="Tickets"
      onClose={close}
      className="f-tickets-page"
      actions={
        <>
          <span role="status" className="f-tickets-conn" data-tone={tone}>
            <span className="f-tickets-conn-dot" aria-hidden="true" />
            {connText}
          </span>
          {running ? (
            <button type="button" className="f-tickets-b f-tickets-b--sm" onClick={() => void ui.invoke('feat:tickets:cancel')}>
              <CloseIcon size={13} /> Cancelar consulta
            </button>
          ) : null}
          <button
            type="button"
            className="f-tickets-b f-tickets-b--sm"
            onClick={askRefresh}
            disabled={running || !snap || unavailable || sinConector}
            title={porGh ? `Lee los issues de ${n} con gh (solo lectura)` : `Lee los tickets de ${n} con la cuenta que la consulta (solo lectura)`}
          >
            <RefreshGlyph />
            {running ? 'Actualizando…' : 'Actualizar'}
          </button>
          <Button size="sm" onClick={elegirConector} disabled={!snap} icon={<SettingsIcon size={14} />} title="Conector, cuenta y carpeta de los tickets">
            Conector
          </Button>
        </>
      }
    >
      <div className="f-tickets-main">
        <div className="ui-intro">
          <h1 id="f-tickets-title" className="f-tickets-h1">
            {etiquetaTablero(snap)}
          </h1>
          <p className="f-tickets-lead">
            {filtro ? 'Tus tickets y los de las personas que elijas. Empezá uno y Sloth arma el espacio para trabajarlo.' : 'Tus tickets y los del equipo. Empezá uno y Sloth arma el espacio para trabajarlo.'}
          </p>
        </div>

        {confirming && (
          <div className="f-tickets-alert f-tickets-confirm" role="alertdialog" aria-label={`Confirmar consulta a ${n}`}>
            <span>
              Para leer {n} se abre Claude sin ventana con <b>{accLabel(snap?.config.queryAccountId) ?? 'una cuenta'}</b> (modelo{' '}
              {snap?.config.model}) y usa tokens de esa cuenta. Solo lee: no cambia nada en {n}.
              {confirmModo === 'faltante' && ' Trae solo lo que falta del filtro.'}
              {confirmModo === 'personas' && ' Pide la lista de personas del equipo.'}
            </span>
            <label className="check f-tickets-inline-check">
              <input type="checkbox" onChange={(e) => setConfirmRefresh(!e.target.checked)} />
              No volver a preguntar
            </label>
            <button type="button" className="f-tickets-b f-tickets-b--sm f-tickets-b--pri" autoFocus onClick={() => ejecutar(confirmModo)}>
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
        {info && !err && !offline && !topeVueltas && (
          <p className="f-tickets-ok" role="status">
            {info}
          </p>
        )}

        {conBarra && snap && filtro && (
          <FiltroBar
            snap={snap}
            filtro={filtro}
            grupos={grupos}
            running={running}
            abierto={filtroAbierto}
            onAbierto={setFiltroAbierto}
            aplicar={aplicarFiltro}
            onFaltante={() => pedir('faltante')}
            onPersonas={() => pedir('personas')}
            personasBusy={personasBusy}
            errPersonas={errPersonas}
            errPorPersona={errVigentes}
            nombreConector={n}
          />
        )}

        {vacio ? (
          <div className="f-tickets-vacio">
            {snap?.aviso && (
              <div className="f-tickets-alert f-tickets-aviso" role="status">
                <span className="f-tickets-alert-text">{snap.aviso}</span>
              </div>
            )}
            {vacioNode}
          </div>
        ) : (
          <div className="f-tickets-grid">
            {/* LISTA */}
            <section className="f-tickets-panel f-tickets-list" aria-labelledby="f-tickets-lista-t">
              <h2 id="f-tickets-lista-t" className="sr-only">
                Lista de tickets
              </h2>
              {filtro ? (
                <Grupos
                  grupos={grupos}
                  total={tickets.length}
                  sel={grupoActivo}
                  onSel={setGrupoSel}
                  trayendo={running && modoCorriendo !== 'personas' && hayFaltante(snap?.pendientes)}
                  errPorPersona={errVigentes}
                />
              ) : (
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
              )}

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
                {!filtro && (
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
                )}
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
                {ultimaConsulta && (
                  <span className="f-tickets-uso" title="Con suscripción de Claude no se paga por consulta: el número es nominal, para comparar.">
                    {ultimaConsulta}
                  </span>
                )}
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
                    <button type="button" className="f-tickets-b f-tickets-b--xs f-tickets-b--solid-danger" onClick={elegirConector}>
                      Elegir conector
                    </button>
                  </div>
                )}

                {topeVueltas && (
                  <div className="f-tickets-alert f-tickets-offline" role="alert">
                    <span className="f-tickets-alert-text">
                      Cortada por tope de vueltas
                      <span className="f-tickets-alert-detail">{snap?.lastError}</span>
                    </span>
                    <button
                      type="button"
                      className="f-tickets-b f-tickets-b--xs f-tickets-b--pri"
                      onClick={() => void refresh(Math.min(VUELTAS_MAX, 2 * vueltasActuales))}
                      disabled={running || vueltasActuales >= VUELTAS_MAX}
                    >
                      Continuar con más vueltas
                    </button>
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

                {showRows &&
                  (virtual ? (
                    <ListaVirtual ids={ids} abiertoId={curId} fila={(i) => tarjeta(visible[i], i)} enfocarAlMontar={enfocadaAlCambiar} />
                  ) : (
                    <ul className="f-tickets-rows">{visible.map((t) => tarjeta(t))}</ul>
                  ))}

                {!bodyLoading && snap && tickets.length > 0 && visible.length === 0 && (
                  <EmptyState
                    size="sm"
                    as="h3"
                    title={grupoSinTraer ? 'Todavía no se trajeron sus tickets' : 'Ningún ticket coincide'}
                    description={grupoSinTraer ? 'Tocá «Traer lo que falta» en el filtro de arriba.' : 'Probá con otra palabra o sacá algún filtro.'}
                    action={
                      <Button
                        onClick={() => {
                          setQ('')
                          setStSel([])
                          setPrio('todas')
                        }}
                      >
                        Limpiar filtros
                      </Button>
                    }
                  />
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
                  ws={wsOf(current)}
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
                  onReload={() => {
                    frescoRef.current = true
                    setDetTick((n) => n + 1)
                  }}
                />
              )}
            </section>
          </div>
        )}
      </div>

      {toast && (
        <div className="f-tickets-toast" role="status">
          {toast}
        </div>
      )}
    </View>
  )
}
