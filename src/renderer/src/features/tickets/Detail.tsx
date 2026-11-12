import { useState, type KeyboardEvent } from 'react'
import { useUi } from '../host'
import { resolveAccountColor } from '../settings/store'
import { SPACE_CHIP, SPACE_LABEL, spaceStatus } from '../broadcast/state'
import { SpaceIcon } from '../../icons/SlothIcons'
import type { Workspace } from '../../../../shared/types'
import { fmtHoras, tintFor, type Accion, type ConectorInfo, type Detalle, type DetView, type Estado, type EstadoBase, type Ticket, type WriteOpt } from './model'
import { Av, ExternalGlyph, PrioGlyph, prioTone } from './parts'
import { Button, Select } from '../../ui'

/** Lo que no se puede hacer desde la app: se dice en voz clara al lado del control. */
const sinCuentaMsg = (nombre: string): string => `Actualizá ${nombre} primero para elegir la cuenta que lo conecta.`

export interface DetailProps {
  t: Ticket
  ws?: Workspace
  mine: boolean
  me?: { id?: string; nombre: string }
  estados: Estado[]
  conector: ConectorInfo
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

function CommentList({ det, loading }: { det?: Detalle; loading?: boolean }): React.JSX.Element {
  if (!det) return <p className="f-tickets-muted">{loading ? 'Cargando comentarios…' : 'Sin comentarios cargados.'}</p>
  if (det.comentarios.length === 0) return <p className="f-tickets-muted">Todavía no hay comentarios.</p>
  return (
    <ul className="f-tickets-comments">
      {det.comentarios.map((c, i) => (
        <li key={i} className="f-tickets-comment">
          <Av name={c.autor} size="sm" />
          <div className="f-tickets-comment-body">
            <div className="f-tickets-comment-head">
              <span className="f-tickets-strong">{c.autor}</span>
              {c.fecha && <span className="f-tickets-muted">{fechaCorta(c.fecha)}</span>}
            </div>
            <p>{c.cuerpo}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}

export function Detail(props: DetailProps): React.JSX.Element {
  const ui = useUi()
  const { t, ws, mine, me, estados, conector, view, wbusy, noDisp } = props
  const n = conector.nombre
  const can = (a: Accion): boolean => conector.acciones.includes(a)
  const st = ws ? spaceStatus(ws.id, ui.agents, ui.permissions) : null
  const resp = t.responsable
  const tint = resp ? tintFor(resp) : null
  const wsAcc = ws ? ui.accounts.findIndex((a) => a.id === ws.accountId) : -1
  const det = view?.data
  const crit = det?.criterios ?? []
  const done = crit.filter((c) => c.hecho).length
  const selectOpts: EstadoBase[] =
    estados.some((e) => e.clave === t.estado) || !t.estado ? estados : [...estados, { clave: t.estado, nombre: props.estadoName(t.estado) }]
  const [draft, setDraft] = useState('')
  const [horas, setHoras] = useState('')
  const [horasErr, setHorasErr] = useState<string | null>(null)

  /** Por qué este control no se puede usar (null = sí se puede). */
  const why = (a: Accion): string | null => {
    if (noDisp[a]) return noDisp[a]!
    if (props.sinCuenta) return sinCuentaMsg(n)
    if (a === 'tomar' && !me?.id) return `Falta tu id de ${n}: actualizá la lista para poder tomarlo.`
    if (conector.leeDetalle && (a === 'criterio' || a === 'horas') && !det) return view?.loading ? 'Cargando el detalle…' : 'No hay detalle para editar: reintentá.'
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
      <div className="f-tickets-det-head">
        <span className="f-tickets-code mono f-tickets-code-lg">{t.id}</span>
        <h2 id="f-tickets-det-t" className="f-tickets-det-title">
          {t.titulo}
        </h2>
        <div className="f-tickets-fields">
          {can('estado') ? (
            <div className="f-tickets-field">
              <label htmlFor="f-tickets-estado">Estado</label>
              <Select id="f-tickets-estado" value={t.estado ?? ''} disabled={Boolean(estadoWhy) || anyBusy} aria-describedby="f-tickets-w-estado" onChange={(e) => void props.onWrite('estado', { estado: e.target.value }, { ticket: { estado: e.target.value } })}
              >
                {!t.estado && <option value="">Sin estado</option>}
                {selectOpts.map((e) => (
                  <option key={e.clave} value={e.clave}>
                    {e.nombre}
                  </option>
                ))}
              </Select>
              <span id="f-tickets-w-estado" className="f-tickets-why" role={busy('estado') ? 'status' : undefined}>
                {busy('estado') ? 'Guardando…' : estadoWhy ?? ''}
              </span>
            </div>
          ) : (
            <div className="f-tickets-field">
              <span className="f-tickets-lbl">Estado</span>
              <span className="f-tickets-val">{props.estadoName(t.estado)}</span>
            </div>
          )}
          <div className="f-tickets-field">
            <span className="f-tickets-lbl">Prioridad</span>
            <span className="f-tickets-val" style={{ color: prioTone(t.prioridad) }}>
              <PrioGlyph p={t.prioridad} size={13} />
              {t.prioridad ?? 'Sin prioridad'}
            </span>
          </div>
        </div>
      </div>

      <div className="f-tickets-assign">
        {resp && tint ? (
          <Av name={resp} size="lg" />
        ) : (
          <span className="f-tickets-av lg" style={{ background: 'var(--btn-2)', color: 'var(--text-3)' }} aria-hidden="true">
            ?
          </span>
        )}
        <div className="f-tickets-assign-text">
          <div className="f-tickets-muted">Asignado a</div>
          <div className="f-tickets-strong">{resp ? (mine ? `${resp} (vos)` : resp) : 'Sin asignar'}</div>
        </div>
        {!resp && can('tomar') && (
          <>
            <Button variant="primary" disabled={Boolean(takeWhy) || anyBusy} aria-describedby="f-tickets-w-take" onClick={() =>
                void props.onWrite('tomar', {}, { ticket: { responsable: me!.nombre, responsableId: me!.id } })
              }
            >
              {busy('tomar') ? 'Guardando…' : 'Tomarlo'}
            </Button>
            <span id="f-tickets-w-take" className="f-tickets-why">
              {takeWhy ?? ''}
            </span>
          </>
        )}
        {mine && can('soltar') && (
          <>
            <Button disabled={Boolean(why('soltar')) || anyBusy} aria-describedby="f-tickets-w-drop" onClick={() => void props.onWrite('soltar', {}, { ticket: { responsable: undefined, responsableId: undefined } })}
            >
              {busy('soltar') ? 'Guardando…' : 'Soltar'}
            </Button>
            <span id="f-tickets-w-drop" className="f-tickets-why">
              {why('soltar') ?? ''}
            </span>
          </>
        )}
        {resp && !mine && <span className="f-tickets-owner">Lo tiene {resp}</span>}
      </div>

      <div className="f-tickets-actions">
        <div className="f-tickets-actions-row">
          {ws && st ? (
            <>
              <span className={`chip ${SPACE_CHIP[st]} f-tickets-space-lg`}>
                <span className="f-tickets-ellipsis">
                  {ws.name} · {SPACE_LABEL[st]}
                </span>
              </span>
              <Button variant="primary" onClick={() => props.onOpenSpace(ws)}>
                Abrir espacio
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={props.onStart} disabled={props.startBusy || props.disabledAll}>
              <SpaceIcon size={14} strokeWidth={2} />
              {props.startBusy ? 'Creando…' : 'Empezar en Sloth'}
            </Button>
          )}
          {t.url ? (
            <a className="f-tickets-b" href={t.url} target="_blank" rel="noreferrer" aria-label={`Abrir ${t.id} en ${n}`}>
              <ExternalGlyph />
              Abrir en {n}
            </a>
          ) : (
            <Button disabled title={`${n} no dio el link de este ticket`}>
              <ExternalGlyph />
              Abrir en {n}
            </Button>
          )}
          {ws && wsAcc >= 0 && (
            <span className="f-tickets-acc">
              <span className="f-tickets-dot" style={{ background: resolveAccountColor(ws.accountId, wsAcc) }} aria-hidden="true" />
              {ui.accounts[wsAcc].label}
            </span>
          )}
        </div>
        {!(ws && st) && (
          <p className="f-tickets-help">
            {props.tplName ? `Crea un espacio con la plantilla «${props.tplName}».` : `Crea el espacio ${t.id} y arranca Claude con /ticket ${t.id}.`}
          </p>
        )}
      </div>

      {view?.error && (
        <p className="form-error" role="alert">
          No pudimos leer el detalle de {t.id}: {view.error}{' '}
          <Button size="xs" onClick={props.onReload}>
            Reintentar
          </Button>
        </p>
      )}

      <section className="f-tickets-sec" aria-labelledby="f-tickets-d-t">
        <h3 id="f-tickets-d-t">Descripción</h3>
        <p className="f-tickets-desc">{t.descripcion ?? `${n} no trajo la descripción de este ticket.`}</p>
      </section>

      {conector.leeDetalle && (
        <section className="f-tickets-sec" aria-labelledby="f-tickets-c-t">
          <div className="f-tickets-sec-head">
            <h3 id="f-tickets-c-t">Criterios de aceptación</h3>
            {det && crit.length > 0 && (
              <span className="f-tickets-prog-label">
                {done} de {crit.length}
              </span>
            )}
          </div>
          {!det ? (
            <p className="f-tickets-muted">{view?.loading ? 'Cargando criterios…' : 'Sin criterios cargados.'}</p>
          ) : crit.length === 0 ? (
            <p className="f-tickets-muted">Este ticket no tiene criterios de aceptación.</p>
          ) : (
            <>
              <div className="f-tickets-progress" role="progressbar" aria-label="Criterios cumplidos" aria-valuemin={0} aria-valuemax={crit.length} aria-valuenow={done}>
                <span style={{ width: `${Math.round((done / crit.length) * 100)}%` }} />
              </div>
              <ul className="f-tickets-crit">
                {crit.map((c, i) => {
                  const cWhy = c.id ? why('criterio') : `Este criterio no tiene id en ${n}: hacelo desde ${n}.`
                  return (
                    <li key={c.id ?? i}>
                      <label>
                        <input
                          type="checkbox"
                          checked={c.hecho}
                          disabled={!can('criterio') || Boolean(cWhy) || anyBusy}
                          aria-describedby={can('criterio') ? 'f-tickets-w-crit' : undefined}
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
          {can('criterio') && (
            <span id="f-tickets-w-crit" className="f-tickets-why" role={busy('criterio') ? 'status' : undefined}>
              {busy('criterio') ? 'Guardando…' : why('criterio') ?? ''}
            </span>
          )}
        </section>
      )}

      {(conector.leeDetalle || can('comentar')) && (
        <section className="f-tickets-sec" aria-labelledby="f-tickets-co-t">
          <h3 id="f-tickets-co-t">Comentarios</h3>
          {conector.leeDetalle && <CommentList det={det} loading={view?.loading} />}
          {can('comentar') && (
            <>
              <div className="f-tickets-inline">
                <input
                  className="f-tickets-input"
                  value={draft}
                  maxLength={2000}
                  disabled={Boolean(why('comentar')) || anyBusy}
                  placeholder="Escribí un comentario"
                  aria-label={`Comentar en ${t.id}`}
                  aria-describedby="f-tickets-w-com"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      void submitComment()
                    }
                  }}
                />
                <Button disabled={!draft.trim() || Boolean(why('comentar')) || anyBusy} onClick={() => void submitComment()}>
                  {busy('comentar') ? 'Guardando…' : 'Publicar'}
                </Button>
              </div>
              <span id="f-tickets-w-com" className="f-tickets-why" role={busy('comentar') ? 'status' : undefined}>
                {busy('comentar') ? 'Guardando…' : why('comentar') ?? ''}
              </span>
            </>
          )}
        </section>
      )}

      {(conector.leeDetalle || can('horas')) && (
        <section className="f-tickets-sec" aria-labelledby="f-tickets-h-t">
          <h3 id="f-tickets-h-t">Horas cargadas</h3>
          {conector.leeDetalle && <p className="f-tickets-strong">{det ? fmtHoras(det.minutos ?? 0) : view?.loading ? 'Cargando…' : '—'}</p>}
          {can('horas') && (
            <>
              <div className="f-tickets-hours">
                <label className="f-tickets-hours-field">
                  <span>Horas a sumar</span>
                  <input
                    className="f-tickets-input narrow"
                    inputMode="decimal"
                    placeholder="Ej.: 2 o 1,5"
                    value={horas}
                    disabled={Boolean(why('horas')) || anyBusy}
                    aria-label={`Horas a sumar en ${t.id}`}
                    aria-describedby="f-tickets-w-hr"
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
                <Button disabled={!horas.trim() || Boolean(why('horas')) || anyBusy} onClick={() => void submitHoras()}>
                  {busy('horas') ? 'Guardando…' : 'Sumar horas'}
                </Button>
              </div>
              {horasErr && (
                <p className="form-error" role="alert">
                  {horasErr}
                </p>
              )}
              <p className="f-tickets-muted f-tickets-hours-help">Más de 0 y hasta 12 horas por carga. Podés usar coma o punto.</p>
              <span id="f-tickets-w-hr" className="f-tickets-why" role={busy('horas') ? 'status' : undefined}>
                {busy('horas') ? 'Guardando…' : why('horas') ?? ''}
              </span>
            </>
          )}
        </section>
      )}
    </>
  )
}
