import { useId, useMemo, useState } from 'react'
import { CaretDown, CaretRight, CircleNotch, Funnel, WarningCircle } from '@phosphor-icons/react'
import { SearchIcon } from '../../icons/SlothIcons'
import { categoriaDe, SIN_ASIGNAR, type FiltroVista, type PersonaEquipo } from '../../../../shared/tickets'
import { timeAgo, type Snapshot } from './model'
import { Av, estadoKind } from './parts'
import {
  alternarAtajo,
  alternarEstado,
  alternarPersona,
  atajoActivo,
  atajosDe,
  filtrarPersonas,
  hayFaltante,
  nombreSeguro,
  opcionesVentana,
  resumenFiltro,
  textoFaltante,
  textoNoLeidos,
  tieneHechos,
  todosLosEstados,
  type Grupo
} from './filtro-vista'
import './filtro.css'

export interface CambioFiltro {
  personasElegidas?: string[]
  incluirSinAsignar?: boolean
  estadosElegidos?: string[] | null
  ventanaDias?: number | null
}

interface Props {
  snap: Snapshot
  filtro: FiltroVista
  grupos: Grupo[]
  running: boolean
  abierto: boolean
  onAbierto: (v: boolean) => void
  aplicar: (c: CambioFiltro) => void
  onFaltante: () => void
  onPersonas: () => void
  /** La lista de personas se está pidiendo con su propio botón. */
  personasBusy: boolean
  errPersonas: string | null
  /** Lo que falló al traer, por persona (id → mensaje): lo demás sigue como estaba. */
  errPorPersona: Record<string, string>
  nombreConector: string
}

function Personas({ snap, filtro, grupos, running, aplicar, onPersonas, personasBusy, errPersonas, nombreConector }: Props): React.JSX.Element {
  const [texto, setTexto] = useState('')
  const [nota, setNota] = useState('')
  const ids = useId()
  const me = snap.me
  const personas: PersonaEquipo[] | undefined = snap.personas
  const cargando = personasBusy || (running && !personas)
  const { lista, total } = useMemo(() => filtrarPersonas(personas ?? [], texto, filtro.personasElegidas, me), [personas, texto, filtro.personasElegidas, me])
  const cuenta = (clave: string): number | undefined => grupos.find((g) => g.clave === clave)?.n

  const alternar = (id: string): void => {
    const r = alternarPersona(id, filtro.personasElegidas, me)
    if (!r.ok) return setNota(r.motivo)
    setNota('')
    aplicar({ personasElegidas: r.ids })
  }

  return (
    <div className="f-tickets-fb-sec f-tickets-fb-personas">
      <h3 className="f-tickets-fb-h" id={`${ids}-h`}>
        Personas
        {personas && (
          <span className="f-tickets-fb-sub">
            {filtro.personasElegidas.length === 0 ? 'ninguna elegida' : `${filtro.personasElegidas.length} elegida${filtro.personasElegidas.length === 1 ? '' : 's'}`}
          </span>
        )}
      </h3>
      <ul className="f-tickets-fb-fijos" aria-label="Siempre">
        <li>
          <label className="f-tickets-fb-item is-fijo" title="Tus tickets siempre se traen: no se pueden sacar">
            <input type="checkbox" checked disabled />
            <span className="f-tickets-fb-name">Yo{me ? ` (${nombreSeguro(me.nombre)})` : ''}</span>
            <span className="f-tickets-fb-n">{cuenta('mios') ?? 0}</span>
          </label>
        </li>
        <li>
          <label className="f-tickets-fb-item">
            <input type="checkbox" checked={filtro.incluirSinAsignar} onChange={(e) => aplicar({ incluirSinAsignar: e.target.checked })} />
            <span className="f-tickets-fb-name">Sin asignar</span>
            {filtro.incluirSinAsignar && <span className="f-tickets-fb-n">{cuenta(SIN_ASIGNAR) ?? 0}</span>}
          </label>
        </li>
      </ul>

      {cargando ? (
        <p className="f-tickets-fb-load" role="status">
          <CircleNotch size={14} className="spin" aria-hidden="true" />
          <span>
            Trayendo la lista de personas de {nombreConector}… La primera vez tarda hasta un minuto. Mientras tanto podés seguir usando el tablero.
          </span>
        </p>
      ) : !personas ? (
        <div className="f-tickets-fb-vacia">
          <p>Todavía no se trajo la lista de personas de {nombreConector}. Con ella elegís de quién ver los tickets.</p>
          <button type="button" className="f-tickets-b f-tickets-b--sm" onClick={onPersonas} disabled={running}>
            Traer la lista de personas
          </button>
        </div>
      ) : (
        <>
          <label className="f-tickets-search f-tickets-fb-buscar">
            <SearchIcon size={14} strokeWidth={1.9} />
            <input
              type="search"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && texto) {
                  e.preventDefault()
                  e.stopPropagation()
                  setTexto('')
                }
              }}
              placeholder="Buscar persona"
              aria-label="Buscar persona"
              maxLength={60}
              autoComplete="off"
            />
          </label>
          <span role="status" className="sr-only">
            {texto ? `${total} ${total === 1 ? 'persona coincide' : 'personas coinciden'}` : ''}
          </span>
          {lista.length === 0 ? (
            <p className="f-tickets-muted f-tickets-fb-nada">{texto ? 'Nadie coincide con esa búsqueda.' : 'No hay otras personas en la lista.'}</p>
          ) : (
            <ul className="f-tickets-fb-lista" aria-labelledby={`${ids}-h`}>
              {lista.map((p) => {
                const on = filtro.personasElegidas.includes(p.id)
                const nombre = nombreSeguro(p.nombre)
                return (
                  <li key={p.id}>
                    <label className={`f-tickets-fb-item ${on ? 'on' : ''}`}>
                      <input type="checkbox" checked={on} onChange={() => alternar(p.id)} />
                      <Av name={nombre} size="sm" />
                      <span className="f-tickets-fb-name">{nombre}</span>
                      {on && <span className="f-tickets-fb-n">{cuenta(p.id) ?? 0}</span>}
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
          {total > lista.length && <p className="f-tickets-muted f-tickets-fb-nada">Se muestran {lista.length} de {total}: escribí para acotar.</p>}
          <p className="f-tickets-fb-pie">
            {snap.personasAt ? `Lista de ${timeAgo(snap.personasAt)}` : 'Lista de personas'} ·{' '}
            <button type="button" className="f-tickets-link" onClick={onPersonas} disabled={running} title={`Vuelve a pedirle a ${nombreConector} la lista de personas (usa tokens)`}>
              Actualizar lista
            </button>
          </p>
        </>
      )}
      {(nota || errPersonas) && (
        <p className="f-tickets-fb-aviso" role="alert">
          <WarningCircle size={14} weight="fill" aria-hidden="true" /> {nota || errPersonas}
        </p>
      )}
    </div>
  )
}

function Estados({ snap, filtro, aplicar }: Pick<Props, 'snap' | 'filtro' | 'aplicar'>): React.JSX.Element {
  const [nota, setNota] = useState('')
  const estados = snap.conector.estados
  const atajos = atajosDe(estados)
  const todos = todosLosEstados(estados, filtro.estadosElegidos)
  const porEstado = snap.conteos?.porEstado ?? {}
  const cambiar = (sigue: string[] | null): void => {
    if (!sigue) return setNota('Dejá al menos un estado elegido.')
    setNota('')
    aplicar({ estadosElegidos: sigue })
  }
  return (
    <div className="f-tickets-fb-sec">
      <h3 className="f-tickets-fb-h">Estados</h3>
      <div role="group" aria-label="Atajos de estado" className="f-tickets-fb-atajos">
        <button type="button" className={`f-tickets-chipf f-tickets-fb-atajo ${todos ? 'on' : ''}`} aria-pressed={todos} onClick={() => aplicar({ estadosElegidos: null })}>
          Todos
        </button>
        {atajos.map((a) => {
          const on = !todos && atajoActivo(a, filtro.estadosElegidos)
          return (
            <button key={a.id} type="button" className={`f-tickets-chipf f-tickets-fb-atajo ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => cambiar(alternarAtajo(a, filtro.estadosElegidos, todos))}>
              {a.nombre}
            </button>
          )
        })}
      </div>
      <div role="group" aria-label="Estados uno por uno" className="f-tickets-chips f-tickets-fb-estados">
        {estados.map((e) => {
          const on = filtro.estadosElegidos.includes(e.clave)
          return (
            <button
              key={e.clave}
              type="button"
              className={`f-tickets-chipf f-tickets-st-${estadoKind(categoriaDe(e.clave, estados))} ${on ? 'on' : ''}`}
              aria-pressed={on}
              onClick={() => cambiar(alternarEstado(e.clave, filtro.estadosElegidos))}
            >
              {e.nombre}
              {snap.conteos && <span className="f-tickets-fb-chipn"> {porEstado[e.clave] ?? 0}</span>}
            </button>
          )
        })}
      </div>
      <p className="f-tickets-fb-ayuda">
        {todos ? 'Se ve todo lo abierto y lo terminado dentro de la ventana. Los atajos sirven para acotar.' : 'Estás acotando por estado.'} Lo tuyo que está abierto se ve siempre.
      </p>
      {nota && (
        <p className="f-tickets-fb-aviso" role="alert">
          <WarningCircle size={14} weight="fill" aria-hidden="true" /> {nota}
        </p>
      )}
    </div>
  )
}

function Ventana({ snap, filtro, aplicar }: Pick<Props, 'snap' | 'filtro' | 'aplicar'>): React.JSX.Element {
  const id = useId()
  const conHechos = tieneHechos(snap.conector.estados, filtro.estadosElegidos)
  return (
    <div className="f-tickets-fb-sec">
      <label className="f-tickets-fb-h" htmlFor={`${id}-v`}>
        Terminados: ventana de días
      </label>
      <select id={`${id}-v`} className="f-tickets-fb-sel" value={filtro.ventanaDias} disabled={!conHechos} aria-describedby={`${id}-d`} onChange={(e) => aplicar({ ventanaDias: Number(e.target.value) })}>
        {opcionesVentana(filtro.ventanaDias).map((d) => (
          <option key={d} value={d}>
            {d === 1 ? 'Último día' : `Últimos ${d} días`}
          </option>
        ))}
      </select>
      <p id={`${id}-d`} className="f-tickets-fb-ayuda">
        {conHechos
          ? `Los terminados se muestran si se cerraron en ${filtro.ventanaDias === 1 ? 'el último día' : `los últimos ${filtro.ventanaDias} días`}. Lo abierto de las personas elegidas se muestra siempre, sin importar cuándo se creó.`
          : 'Se usa al elegir «Terminado». Lo abierto de las personas elegidas se muestra siempre, sin importar cuándo se creó.'}
      </p>
      {snap.conteos && snap.conteos.sinFecha > 0 && (
        <p className="f-tickets-fb-ayuda">
          {snap.conteos.sinFecha === 1 ? '1 ticket no trae fecha, así que la ventana no lo puede ocultar.' : `${snap.conteos.sinFecha} tickets no traen fecha, así que la ventana no los puede ocultar.`}
        </p>
      )}
    </div>
  )
}

export function FiltroBar(props: Props): React.JSX.Element {
  const { snap, filtro, running, abierto, onAbierto, onFaltante, errPorPersona, nombreConector } = props
  const cuerpoId = useId()
  const resumen = resumenFiltro(filtro, snap.personas, snap.conector.estados)
  const pend = snap.pendientes
  const falta = hayFaltante(pend)
  const errores = Object.entries(errPorPersona)
  const trayendo = running && hayFaltante(pend)
  return (
    <section className="f-tickets-fb" aria-label="Filtro de tickets">
      <div className="f-tickets-fb-head">
        <button type="button" className="f-tickets-fb-toggle" aria-expanded={abierto} aria-controls={abierto ? cuerpoId : undefined} onClick={() => onAbierto(!abierto)}>
          {abierto ? <CaretDown size={14} weight="bold" aria-hidden="true" /> : <CaretRight size={14} weight="bold" aria-hidden="true" />}
          <Funnel size={14} aria-hidden="true" />
          <span className="f-tickets-fb-tit">Filtro</span>
          <span className="f-tickets-fb-res" title={resumen}>
            {resumen}
          </span>
        </button>
        {!abierto && (
          <button type="button" className="f-tickets-b f-tickets-b--xs" onClick={() => onAbierto(true)}>
            Elegir personas
          </button>
        )}
      </div>

      {falta && pend && (
        <p className="f-tickets-fb-falta" role="status">
          {trayendo ? (
            <>
              <CircleNotch size={14} className="spin" aria-hidden="true" /> Trayendo lo que falta de {nombreConector}…
            </>
          ) : (
            <>
              <span>{textoFaltante(pend, filtro, snap.personas)}</span>
              <button type="button" className="f-tickets-b f-tickets-b--xs f-tickets-b--pri" onClick={onFaltante} disabled={running}>
                Traer lo que falta
              </button>
            </>
          )}
        </p>
      )}
      {snap.conteos?.noLeidos ? (
        <p className="f-tickets-fb-aviso" role="status">
          <WarningCircle size={14} weight="fill" aria-hidden="true" /> <span>{textoNoLeidos(snap.conteos.noLeidos, snap.tickets.length)}</span>
        </p>
      ) : null}
      {errores.length > 0 && !running && (
        <p className="f-tickets-fb-aviso f-tickets-fb-errpers" role="alert">
          <WarningCircle size={14} weight="fill" aria-hidden="true" />
          <span>
            No se pudo traer lo de{' '}
            {errores
              .slice(0, 3)
              .map(([id]) => props.grupos.find((g) => g.clave === id)?.nombre ?? 'una persona')
              .join(', ')}
            {errores.length > 3 ? ` y ${errores.length - 3} más` : ''}. Lo demás sigue como estaba; el motivo está más abajo. Podés volver a intentarlo.
          </span>
        </p>
      )}

      {abierto && (
        <div className="f-tickets-fb-body" id={cuerpoId}>
          <Personas {...props} />
          <div className="f-tickets-fb-col">
            <Estados snap={snap} filtro={filtro} aplicar={props.aplicar} />
            <Ventana snap={snap} filtro={filtro} aplicar={props.aplicar} />
          </div>
        </div>
      )}
    </section>
  )
}
