import { useState, type KeyboardEvent } from 'react'
import { useUi } from '../host'
import { resolveAccountColor } from '../settings/store'
import { SPACE_CHIP, SPACE_LABEL, spaceStatus } from '../broadcast/state'
import { SpaceIcon } from '../../icons/SlothIcons'
import type { Workspace } from '../../../../shared/types'
import { fmtHoras, tintFor, type Accion, type DetView, type GruvEstado, type Ticket, type WriteOpt } from './model'
import { Av, ExternalGlyph, PrioGlyph, prioTone } from './parts'

/** Lo que no se puede hacer desde la app: se dice en voz clara al lado del control. */
const SIN_CUENTA = 'Actualizá Gruv primero para elegir la cuenta que lo conecta.'

export interface DetailProps {
  t: Ticket
  ws?: Workspace
  mine: boolean
  me?: { id?: string; nombre: string }
  estados: GruvEstado[]
  estadoName: (k?: string) => string
  view?: DetView
  /** Acción en curso para este ticket (una por ticket). */
  wbusy?: Accion
  noDisp: Partial<Record<Accion, string>>
  sinCuenta: boolean
  startBusy: boolean
  disabledAll: boolean
  tplName?: string
  onStart: () => void
  onOpenSpace: (ws: Workspace) => void
  onWrite: (a: Accion, payload: Record<string, unknown>, opt: WriteOpt) => Promise<boolean>
  onReload: () => void
}

const fechaCorta = (f?: string): string => {
  if (!f) return ''
  const d = new Date(f)
  return Number.isNaN(d.getTime()) ? f : d.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })
}

export function Detail(props: DetailProps): React.JSX.Element {
  const ui = useUi()
  const { t, ws, mine, me, estados, view, wbusy, noDisp } = props
  const st = ws ? spaceStatus(ws.id, ui.agents, ui.permissions) : null
  const resp = t.responsable
  const tint = resp ? tintFor(resp) : null
  const wsAcc = ws ? ui.accounts.findIndex((a) => a.id === ws.accountId) : -1
  const det = view?.data
  const crit = det?.criterios ?? []
  const done = crit.filter((c) => c.hecho).length
  const selectOpts =
    estados.some((e) => e.clave === t.estado) || !t.estado ? estados : [...estados, { clave: t.estado, nombre: props.estadoName(t.estado) }]
  const [draft, setDraft] = useState('')
  const [horas, setHoras] = useState('')
  const [horasErr, setHorasErr] = useState<string | null>(null)

  /** Por qué este control no se puede usar (null = sí se puede). */
  const why = (a: Accion): string | null => {
    if (noDisp[a]) return noDisp[a]!
    if (props.sinCuenta) return SIN_CUENTA
    if (a === 'tomar' && !me?.id) return 'Falta tu id de Gruv: actualizá la lista para poder tomarlo.'
    if ((a === 'criterio' || a === 'horas') && !det) return view?.loading ? 'Cargando el detalle…' : 'No hay detalle para editar: reintentá.'
    return null
  }
  const busy = (a: Accion): boolean => wbusy === a
  const anyBusy = Boolean(wbusy)

  const submitComment = async (): Promise<void> => {
    const cuerpo = draft.trim()
    if (!cuerpo) return
    setDraft('')
    const ok = await props.onWrite('comentar', { cuerpo }, {
      det: (d) => ({ ...d, comentarios: [...d.comentarios, { autor: me?.nombre ?? 'Vos', cuerpo, fecha: new Date().toISOString() }] })
    })
    if (!ok) setDraft(cuerpo)
  }

  const submitHoras = async (): Promise<void> => {
    const h = Number(horas.trim().replace(',', '.'))
    if (!Number.isFinite(h) || h <= 0 || h > 12) {
      setHorasErr('Ingresá más de 0 y hasta 12 horas.')
      return
    }
    setHorasErr(null)
    const ok = await props.onWrite('horas', { horas: h }, {
      det: (d) => ({ ...d, minutos: (d.minutos ?? 0) + Math.round(h * 60) })
    })
    if (ok) setHoras('')
  }

  const takeWhy = why('tomar')
  const estadoWhy = why('estado')

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
            <select
              id="f-gruv-estado"
              value={t.estado ?? ''}
              disabled={Boolean(estadoWhy) || anyBusy}
              aria-describedby="f-gruv-w-estado"
              onChange={(e) => void props.onWrite('estado', { estado: e.target.value }, { ticket: { estado: e.target.value } })}
            >
              {!t.estado && <option value="">Sin estado</option>}
              {selectOpts.map((e) => (
                <option key={e.clave} value={e.clave}>
                  {e.nombre}
                </option>
              ))}
            </select>
            <span id="f-gruv-w-estado" className="f-gruv-why" role={busy('estado') ? 'status' : undefined}>
              {busy('estado') ? 'Guardando…' : estadoWhy ?? ''}
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
        {resp && tint ? (
          <Av name={resp} size="lg" />
        ) : (
          <span className="f-gruv-av lg" style={{ background: 'var(--btn-2)', color: 'var(--fg-muted)' }} aria-hidden="true">
            ?
          </span>
        )}
        <div className="f-gruv-assign-text">
          <div className="f-gruv-muted">Asignado a</div>
          <div className="f-gruv-strong">{resp ? (mine ? `${resp} (vos)` : resp) : 'Sin asignar'}</div>
        </div>
        {!resp && (
          <>
            <button
              type="button"
              className="f-gruv-b f-gruv-b--md f-gruv-b--pri"
              disabled={Boolean(takeWhy) || anyBusy}
              aria-describedby="f-gruv-w-take"
              onClick={() =>
                void props.onWrite('tomar', {}, { ticket: { responsable: me!.nombre, responsableId: me!.id } })
              }
            >
              {busy('tomar') ? 'Guardando…' : 'Tomarlo'}
            </button>
            <span id="f-gruv-w-take" className="f-gruv-why">
              {takeWhy ?? ''}
            </span>
          </>
        )}
        {mine && (
          <>
            <button
              type="button"
              className="f-gruv-b f-gruv-b--md"
              disabled={Boolean(why('soltar')) || anyBusy}
              aria-describedby="f-gruv-w-drop"
              onClick={() => void props.onWrite('soltar', {}, { ticket: { responsable: undefined, responsableId: undefined } })}
            >
              {busy('soltar') ? 'Guardando…' : 'Soltar'}
            </button>
            <span id="f-gruv-w-drop" className="f-gruv-why">
              {why('soltar') ?? ''}
            </span>
          </>
        )}
        {resp && !mine && <span className="f-gruv-owner">Lo tiene {resp}</span>}
      </div>

      <div className="f-gruv-actions">
        <div className="f-gruv-actions-row">
          {ws && st ? (
            <>
              <span className={`chip ${SPACE_CHIP[st]} f-gruv-space-lg`}>
                <span className="f-gruv-ellipsis">
                  {ws.name} · {SPACE_LABEL[st]}
                </span>
              </span>
              <button type="button" className="f-gruv-b f-gruv-b--pri" onClick={() => props.onOpenSpace(ws)}>
                Abrir espacio
              </button>
            </>
          ) : (
            <button type="button" className="f-gruv-b f-gruv-b--pri" onClick={props.onStart} disabled={props.startBusy || props.disabledAll}>
              <SpaceIcon size={14} strokeWidth={2} />
              {props.startBusy ? 'Creando…' : 'Empezar en Sloth'}
            </button>
          )}
          {t.url ? (
            <a className="f-gruv-b" href={t.url} target="_blank" rel="noreferrer" aria-label={`Abrir ${t.id} en Gruv`}>
              <ExternalGlyph />
              Abrir en Gruv
            </a>
          ) : (
            <button type="button" className="f-gruv-b" disabled title="Gruv no dio el link de este ticket">
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
        {!(ws && st) && (
          <p className="f-gruv-help">
            {props.tplName ? `Crea un espacio con la plantilla «${props.tplName}».` : `Crea el espacio ${t.id} y arranca Claude con /ticket ${t.id}.`}
          </p>
        )}
      </div>

      {view?.error && (
        <p className="form-error" role="alert">
          No pudimos leer el detalle de {t.id}: {view.error}{' '}
          <button type="button" className="f-gruv-b f-gruv-b--xs" onClick={props.onReload}>
            Reintentar
          </button>
        </p>
      )}

      <section className="f-gruv-sec" aria-labelledby="f-gruv-d-t">
        <h3 id="f-gruv-d-t">Descripción</h3>
        <p className="f-gruv-desc">{t.descripcion ?? 'Gruv no trajo la descripción de este ticket.'}</p>
      </section>

      <section className="f-gruv-sec" aria-labelledby="f-gruv-c-t">
        <div className="f-gruv-sec-head">
          <h3 id="f-gruv-c-t">Criterios de aceptación</h3>
          {det && crit.length > 0 && (
            <span className="f-gruv-prog-label">
              {done} de {crit.length}
            </span>
          )}
        </div>
        {!det ? (
          <p className="f-gruv-muted">{view?.loading ? 'Cargando criterios…' : 'Sin criterios cargados.'}</p>
        ) : crit.length === 0 ? (
          <p className="f-gruv-muted">Este ticket no tiene criterios de aceptación.</p>
        ) : (
          <>
            <div className="f-gruv-progress" role="progressbar" aria-label="Criterios cumplidos" aria-valuemin={0} aria-valuemax={crit.length} aria-valuenow={done}>
              <span style={{ width: `${Math.round((done / crit.length) * 100)}%` }} />
            </div>
            <ul className="f-gruv-crit">
              {crit.map((c, i) => {
                const cWhy = c.id ? why('criterio') : 'Este criterio no tiene id en Gruv: hacelo desde Gruv.'
                return (
                  <li key={c.id ?? i}>
                    <label>
                      <input
                        type="checkbox"
                        checked={c.hecho}
                        disabled={Boolean(cWhy) || anyBusy}
                        aria-describedby="f-gruv-w-crit"
                        onChange={(e) => {
                          const hecho = e.target.checked
                          void props.onWrite('criterio', { criterioId: c.id, hecho }, {
                            det: (d) => ({ ...d, criterios: d.criterios.map((x) => (x.id === c.id ? { ...x, hecho } : x)) })
                          })
                        }}
                      />
                      <span>{c.texto}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </>
        )}
        <span id="f-gruv-w-crit" className="f-gruv-why" role={busy('criterio') ? 'status' : undefined}>
          {busy('criterio') ? 'Guardando…' : why('criterio') ?? ''}
        </span>
      </section>

      <section className="f-gruv-sec" aria-labelledby="f-gruv-co-t">
        <h3 id="f-gruv-co-t">Comentarios</h3>
        {!det ? (
          <p className="f-gruv-muted">{view?.loading ? 'Cargando comentarios…' : 'Sin comentarios cargados.'}</p>
        ) : det.comentarios.length === 0 ? (
          <p className="f-gruv-muted">Todavía no hay comentarios.</p>
        ) : (
          <ul className="f-gruv-comments">
            {det.comentarios.map((c, i) => (
              <li key={i} className="f-gruv-comment">
                <Av name={c.autor} size="sm" />
                <div className="f-gruv-comment-body">
                  <div className="f-gruv-comment-head">
                    <span className="f-gruv-strong">{c.autor}</span>
                    {c.fecha && <span className="f-gruv-muted">{fechaCorta(c.fecha)}</span>}
                  </div>
                  <p>{c.cuerpo}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="f-gruv-inline">
          <input
            className="f-gruv-input"
            value={draft}
            maxLength={2000}
            disabled={Boolean(why('comentar')) || anyBusy}
            placeholder="Escribí un comentario"
            aria-label={`Comentar en ${t.id}`}
            aria-describedby="f-gruv-w-com"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submitComment()
              }
            }}
          />
          <button type="button" className="f-gruv-b" disabled={!draft.trim() || Boolean(why('comentar')) || anyBusy} onClick={() => void submitComment()}>
            {busy('comentar') ? 'Guardando…' : 'Publicar'}
          </button>
        </div>
        <span id="f-gruv-w-com" className="f-gruv-why" role={busy('comentar') ? 'status' : undefined}>
          {busy('comentar') ? 'Guardando…' : why('comentar') ?? ''}
        </span>
      </section>

      <section className="f-gruv-sec" aria-labelledby="f-gruv-h-t">
        <h3 id="f-gruv-h-t">Horas cargadas</h3>
        <p className="f-gruv-strong">{det ? fmtHoras(det.minutos ?? 0) : view?.loading ? 'Cargando…' : '—'}</p>
        <div className="f-gruv-hours">
          <label className="f-gruv-hours-field">
            <span>Horas a sumar</span>
            <input
              className="f-gruv-input narrow"
              inputMode="decimal"
              placeholder="Ej.: 2 o 1,5"
              value={horas}
              disabled={Boolean(why('horas')) || anyBusy}
              aria-label={`Horas a sumar en ${t.id}`}
              aria-describedby="f-gruv-w-hr"
              aria-invalid={horasErr ? true : undefined}
              onChange={(e) => {
                setHoras(e.target.value)
                setHorasErr(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void submitHoras()
                }
              }}
            />
          </label>
          <button type="button" className="f-gruv-b" disabled={!horas.trim() || Boolean(why('horas')) || anyBusy} onClick={() => void submitHoras()}>
            {busy('horas') ? 'Guardando…' : 'Sumar horas'}
          </button>
        </div>
        {horasErr && (
          <p className="form-error" role="alert">
            {horasErr}
          </p>
        )}
        <p className="f-gruv-muted f-gruv-hours-help">Más de 0 y hasta 12 horas por carga. Podés usar coma o punto.</p>
        <span id="f-gruv-w-hr" className="f-gruv-why" role={busy('horas') ? 'status' : undefined}>
          {busy('horas') ? 'Guardando…' : why('horas') ?? ''}
        </span>
      </section>
    </>
  )
}
