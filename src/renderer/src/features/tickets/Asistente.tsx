import { useEffect, useMemo, useRef, useState } from 'react'
import { useUi } from '../host'
import { cleanError } from '../../format'
import { PREFIJO_RE } from '../../../../main/features/tickets/conector'
import type { Descubiertas } from '../../../../main/features/tickets/descubrir'
import { borradorNuevo, conHerramientas, slugId, validarBorrador, type Borrador } from './borrador'
import { PasoFormato, PasoHerramientas } from './AsistentePasos'
import { setSnapshot, type Snapshot } from './model'

export type Paso = 1 | 2 | 3 | 4
export type Cambiar = (f: (b: Borrador) => Borrador) => void

const TITULOS: Record<Paso, string> = { 1: 'Servidor', 2: 'Herramientas', 3: 'Formato de id y estados', 4: 'Pistas y guardado' }

/** Arma (o edita) un conector propio en cuatro pasos y lo guarda en main. */
export function Asistente({
  inicial,
  idAnterior,
  paso: pasoInicial = 1,
  onListo,
  onCancelar
}: {
  inicial?: Borrador
  idAnterior?: string
  paso?: Paso
  onListo: (s: Snapshot) => void
  onCancelar: () => void
}): React.JSX.Element {
  const ui = useUi()
  const [paso, setPaso] = useState<Paso>(pasoInicial)
  const [b, setB] = useState<Borrador | null>(inicial ?? null)
  const [nombre, setNombre] = useState(inicial?.nombre ?? '')
  const [prefijo, setPrefijo] = useState(inicial?.prefijo ?? '')
  const [err, setErr] = useState<string | null>(null)
  const [guardando, setGuardando] = useState(false)
  const titulo = useRef<HTMLHeadingElement>(null)
  const primero = useRef(true)
  const [descartando, setDescartando] = useState(false)
  const huella = JSON.stringify([b, nombre, prefijo])
  const huellaInicial = useRef(huella)
  const seguir = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (descartando) seguir.current?.focus()
  }, [descartando])

  useEffect(() => {
    if (primero.current) primero.current = false
    else titulo.current?.focus()
  }, [paso])

  const cambiar: Cambiar = (f) => setB((x) => (x ? f(x) : x))
  // Las herramientas son del prefijo de la última búsqueda: con otro hay que buscar de nuevo.
  const otroPrefijo = Boolean(b && b.prefijo !== prefijo)
  const revision = useMemo(() => (b ? validarBorrador(b) : null), [b])

  const encontradas = (herramientas: string[]): void => {
    setB((x) => (x ? conHerramientas({ ...x, prefijo }, herramientas) : borradorNuevo(nombre.trim(), prefijo, herramientas)))
  }

  const siguiente = (): void => {
    if (paso === 1) {
      const n = nombre.trim()
      cambiar((x) => ({ ...x, nombre: n, prefijo, id: !idAnterior && x.id === slugId(x.nombre) ? slugId(n) : x.id }))
    }
    setPaso((p) => (p < 4 ? ((p + 1) as Paso) : p))
  }

  const guardar = (): void => {
    if (!revision?.ok) return
    setErr(null)
    setGuardando(true)
    ui.invoke<Snapshot>('feat:tickets:guardarPropio', revision.def, idAnterior).then(
      (s) => {
        setSnapshot(s)
        onListo(s)
      },
      (e) => {
        setErr(cleanError(e))
        setGuardando(false)
      }
    )
  }

  return (
    <section className="f-tickets-asis" aria-labelledby="f-tickets-asis-titulo">
      <h3 id="f-tickets-asis-titulo" className="f-tickets-asis-titulo" ref={titulo} tabIndex={-1}>
        {idAnterior ? 'Editar conector' : 'Nuevo conector'} · Paso {paso} de 4: {TITULOS[paso]}
      </h3>

      {paso === 1 && (
        <PasoServidor nombre={nombre} prefijo={prefijo} setNombre={setNombre} setPrefijo={setPrefijo} editando={Boolean(b)} onEncontradas={encontradas} />
      )}
      {paso === 1 && otroPrefijo && <p className="f-tickets-ajustes-nota">Cambiaste el prefijo: buscá las herramientas de nuevo para seguir.</p>}
      {paso === 2 && b && <PasoHerramientas b={b} cambiar={cambiar} />}
      {paso === 3 && b && <PasoFormato b={b} cambiar={cambiar} />}
      {paso === 4 && b && <PasoPistas b={b} cambiar={cambiar} />}

      {paso === 4 && revision && !revision.ok && (
        <p className="form-error" role="status">
          {revision.ruta}: {revision.mensaje}
        </p>
      )}
      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}

      {descartando && (
        <div className="f-tickets-alert f-tickets-confirm" role="alertdialog" aria-label="Descartar el conector">
          <span className="f-tickets-alert-text">¿Descartar el conector a medio armar?</span>
          <button type="button" className="f-tickets-b f-tickets-b--sm f-tickets-b--pri" onClick={onCancelar}>
            Descartar
          </button>
          <button type="button" className="f-tickets-b f-tickets-b--sm" ref={seguir} onClick={() => setDescartando(false)}>
            Seguir editando
          </button>
        </div>
      )}

      <div className="f-tickets-asis-pie">
        <button type="button" className="f-tickets-b f-tickets-b--sm" onClick={() => (huella === huellaInicial.current ? onCancelar() : setDescartando(true))}>
          Cancelar
        </button>
        <span className="f-tickets-grow" />
        {paso > 1 && (
          <button type="button" className="f-tickets-b f-tickets-b--sm" onClick={() => setPaso((p) => (p - 1) as Paso)}>
            Atrás
          </button>
        )}
        {paso < 4 ? (
          <button type="button" className="f-tickets-b f-tickets-b--sm f-tickets-b--pri" onClick={siguiente} disabled={!b || (paso === 1 && (!nombre.trim() || !PREFIJO_RE.test(prefijo) || otroPrefijo))}>
            Siguiente
          </button>
        ) : (
          <button type="button" className="f-tickets-b f-tickets-b--sm f-tickets-b--pri" onClick={guardar} disabled={!revision?.ok || guardando}>
            {guardando ? 'Guardando…' : 'Guardar'}
          </button>
        )}
      </div>
    </section>
  )
}

function PasoServidor({
  nombre,
  prefijo,
  setNombre,
  setPrefijo,
  editando,
  onEncontradas
}: {
  nombre: string
  prefijo: string
  setNombre: (v: string) => void
  setPrefijo: (v: string) => void
  editando: boolean
  onEncontradas: (herramientas: string[]) => void
}): React.JSX.Element {
  const ui = useUi()
  const [cuenta, setCuenta] = useState('')
  const [buscando, setBuscando] = useState(false)
  const [res, setRes] = useState<Descubiertas | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const prefijoMal = prefijo !== '' && !PREFIJO_RE.test(prefijo)
  const conSesion = ui.accounts.filter((a) => ui.statuses[a.id]?.loggedIn)

  const buscar = (): void => {
    setErr(null)
    setBuscando(true)
    ui.invoke<Descubiertas>('feat:tickets:descubrir', prefijo, cuenta)
      .then(
        (r) => {
          setRes(r)
          if (r.herramientas.length) onEncontradas(r.herramientas)
          else setErr('Claude no encontró herramientas con ese prefijo. Revisá que el conector esté conectado en claude.ai con esa cuenta.')
        },
        (e) => setErr(cleanError(e))
      )
      .finally(() => setBuscando(false))
  }

  return (
    <div className="f-tickets-asis-cuerpo">
      <label className="field">
        <span>Nombre</span>
        <input value={nombre} maxLength={40} onChange={(e) => setNombre(e.target.value)} placeholder="Trello" />
      </label>
      <label className="field">
        <span>Prefijo de las herramientas</span>
        <input
          value={prefijo}
          maxLength={64}
          spellCheck={false}
          onChange={(e) => setPrefijo(e.target.value.trim())}
          placeholder="mcp__claude_ai_Trello__"
          aria-invalid={prefijoMal}
          aria-describedby="f-tickets-asis-prefijo"
        />
        <span id="f-tickets-asis-prefijo" className={prefijoMal ? 'field-error' : 'field-help'}>
          Tiene que empezar con mcp__ y terminar con __
        </span>
      </label>
      <label className="field">
        <span>Cuenta para buscar</span>
        <select value={cuenta} onChange={(e) => setCuenta(e.target.value)}>
          <option value="">La que usás para consultar</option>
          {conSesion.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <p className="f-tickets-ajustes-nota">
        Cada búsqueda gasta uso de esa cuenta (unos centavos de dólar, según el modelo y cuántas herramientas tenga): Claude recibe la definición de todas.
        {editando ? ' Si buscás de nuevo, se conservan los roles de las herramientas que siguen.' : ''}
      </p>
      <div className="f-tickets-asis-acciones">
        <button type="button" className="f-tickets-b f-tickets-b--sm" onClick={buscar} disabled={buscando || !nombre.trim() || !PREFIJO_RE.test(prefijo)}>
          {buscando ? 'Preguntándole a Claude (no usa ninguna herramienta)…' : 'Buscar herramientas'}
        </button>
        {res && res.herramientas.length > 0 && (
          <span className="f-tickets-ajustes-nota" role="status">
            {res.herramientas.length} herramientas encontradas.{res.fuente === 'claude' ? ' Lista armada por Claude: revisala.' : ''}
          </span>
        )}
      </div>
      {res && res.bloqueadas > 0 && (
        <p className="f-tickets-alert f-tickets-confirm" role="alert">
          Claude intentó usar herramientas y se bloquearon.
        </p>
      )}
      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}
    </div>
  )
}

function PasoPistas({ b, cambiar }: { b: Borrador; cambiar: Cambiar }): React.JSX.Element {
  const pista = (k: 'lista' | 'yoConId' | 'yoSinId' | 'apoyo', v: string): void => cambiar((x) => ({ ...x, pistas: { ...x.pistas, [k]: v } }))
  const hayApoyo = b.herramientas.some((h) => h.rol === 'apoyo')
  return (
    <div className="f-tickets-asis-cuerpo">
      <label className="field">
        <span>Cómo traer la lista</span>
        <textarea
          rows={3}
          maxLength={1000}
          value={b.pistas.lista}
          onChange={(e) => pista('lista', e.target.value)}
          placeholder="Con search_cards traé las tarjetas abiertas del tablero, sin filtrar por asignado, como máximo 250. El id es el idShort."
        />
      </label>
      <label className="field">
        <span>Quién sos, con tu id (tiene que llevar {'{id}'})</span>
        <textarea rows={2} maxLength={1000} value={b.pistas.yoConId} onChange={(e) => pista('yoConId', e.target.value)} />
      </label>
      <label className="field">
        <span>Quién sos, sin id</span>
        <textarea rows={2} maxLength={1000} value={b.pistas.yoSinId} onChange={(e) => pista('yoSinId', e.target.value)} />
      </label>
      {hayApoyo && (
        <label className="field">
          <span>Cuándo usar las de apoyo (admite {'{ticket}'})</span>
          <textarea rows={2} maxLength={1000} value={b.pistas.apoyo} onChange={(e) => pista('apoyo', e.target.value)} />
        </label>
      )}
      <label className="field">
        <span>Id del conector</span>
        <input value={b.id} maxLength={32} spellCheck={false} onChange={(e) => cambiar((x) => ({ ...x, id: e.target.value.trim() }))} />
        <span className="field-help">Minúsculas, números y guiones; empieza con letra.</span>
      </label>
    </div>
  )
}
