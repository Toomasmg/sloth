import { ACCIONES, CATEGORIAS, type Accion, type Categoria } from '../../../../shared/tickets'
import { PLACEHOLDERS } from '../../../../main/features/tickets/conector'
import { pareceDeLectura } from '../../../../main/features/tickets/propios'
import { ACCION_ETIQUETA, argsPorDefecto, FORMATOS, revisarId, type Borrador, type FormatoId, type Rol } from './borrador'
import type { Cambiar } from './Asistente'

const ROLES: { rol: Rol; etiqueta: string; lectura: boolean }[] = [
  { rol: 'lista', etiqueta: 'Lista', lectura: true },
  { rol: 'detalle', etiqueta: 'Detalle', lectura: true },
  { rol: 'apoyo', etiqueta: 'Apoyo', lectura: true },
  { rol: 'nada', etiqueta: 'Ninguna', lectura: false }
]

const CATEGORIA_ETIQUETA: Record<Categoria, string> = { pendiente: 'Pendiente', en_curso: 'En curso', revision: 'Revisión', bloqueado: 'Bloqueado', hecho: 'Hecho' }
const ESTADOS_MAX = 30

export function PasoHerramientas({ b, cambiar }: { b: Borrador; cambiar: Cambiar }): React.JSX.Element {
  const setRol = (nombre: string, rol: Rol): void => cambiar((x) => ({ ...x, herramientas: x.herramientas.map((h) => (h.nombre === nombre ? { ...h, rol } : h)) }))
  const deDetalle = b.herramientas.filter((h) => h.rol === 'detalle')

  return (
    <div className="f-tickets-asis-cuerpo">
      <table className="f-tickets-asis-tabla">
        <thead>
          <tr>
            <th scope="col">Herramienta</th>
            <th scope="col">Para qué</th>
          </tr>
        </thead>
        <tbody>
          {b.herramientas.map((h) => {
            const escribe = !pareceDeLectura(h.nombre)
            return (
              <tr key={h.nombre}>
                <td>
                  <code>{h.nombre}</code>
                </td>
                <td>
                  <select aria-label={`Para qué sirve ${h.nombre}`} value={h.rol} onChange={(e) => setRol(h.nombre, e.target.value as Rol)}>
                    {ROLES.map((r) => (
                      <option key={r.rol} value={r.rol} disabled={escribe && r.lectura} title={escribe && r.lectura ? 'No parece de lectura' : undefined}>
                        {r.etiqueta}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="f-tickets-ajustes-nota">Las que no marques ni elijas para una acción quedan bloqueadas. Solo se puede leer con las que parecen de lectura (es una heurística por el nombre).</p>

      {deDetalle.map((h) => (
        <label className="field" key={h.nombre}>
          <span>
            Argumento con el id en <code>{h.nombre}</code>
          </span>
          <input
            value={b.detalleArg[h.nombre] ?? 'id'}
            maxLength={41}
            spellCheck={false}
            onChange={(e) => cambiar((x) => ({ ...x, detalleArg: { ...x.detalleArg, [h.nombre]: e.target.value.trim() } }))}
          />
        </label>
      ))}

      {ACCIONES.map((a) => (
        <AccionCampos key={a} a={a} b={b} cambiar={cambiar} />
      ))}
    </div>
  )
}

function AccionCampos({ a, b, cambiar }: { a: Accion; b: Borrador; cambiar: Cambiar }): React.JSX.Element {
  const x = b.acciones[a]
  const opciones = b.herramientas.filter((h) => h.rol === 'nada' || h.nombre === x?.herramienta).map((h) => h.nombre)
  const set = (v: Borrador['acciones'][Accion]): void => cambiar((y) => ({ ...y, acciones: { ...y.acciones, [a]: v } }))
  const elegir = (herramienta: string): void => {
    if (!herramienta)
      return cambiar((y) => {
        const acciones = { ...y.acciones }
        delete acciones[a]
        return { ...y, acciones }
      })
    set({ herramienta, args: x?.args ?? argsPorDefecto(a), nota: x?.nota ?? '' })
  }

  return (
    <fieldset className="f-tickets-asis-accion">
      <legend>{ACCION_ETIQUETA[a]}</legend>
      <label className="field">
        <span>Herramienta</span>
        <select value={x?.herramienta ?? ''} onChange={(e) => elegir(e.target.value)}>
          <option value="">Ninguna</option>
          {opciones.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
      </label>
      {x &&
        PLACEHOLDERS[a].map((p) => (
          <label className="field" key={p}>
            <span>Argumento para {`{${p}}`}</span>
            <input
              value={x.args[p] ?? ''}
              maxLength={41}
              spellCheck={false}
              placeholder="Vacío: no va"
              onChange={(e) => set({ ...x, args: { ...x.args, [p]: e.target.value.trim() } })}
            />
          </label>
        ))}
      {x && (
        <label className="field">
          <span>Nota para Claude (opcional)</span>
          <input value={x.nota} maxLength={1000} onChange={(e) => set({ ...x, nota: e.target.value })} />
        </label>
      )}
    </fieldset>
  )
}

export function PasoFormato({ b, cambiar }: { b: Borrador; cambiar: Cambiar }): React.JSX.Element {
  const problema = revisarId(b)
  const elegir = (f: FormatoId): void => cambiar((x) => ({ ...x, formato: f, ejemploId: f === 'propio' ? x.ejemploId : FORMATOS[f].ejemplo }))
  const setEstado = (i: number, cambio: Partial<Borrador['estados'][number]>): void =>
    cambiar((x) => ({ ...x, estados: x.estados.map((e, j) => (j === i ? { ...e, ...cambio } : e)) }))

  return (
    <div className="f-tickets-asis-cuerpo">
      <fieldset className="f-tickets-asis-grupo">
        <legend>Formato del id de los tickets</legend>
        {(Object.keys(FORMATOS) as (keyof typeof FORMATOS)[]).map((k) => (
          <label key={k} className="f-tickets-asis-radio">
            <input type="radio" name="f-tickets-formato" checked={b.formato === k} onChange={() => elegir(k)} />
            {FORMATOS[k].etiqueta}
          </label>
        ))}
        <label className="f-tickets-asis-radio">
          <input type="radio" name="f-tickets-formato" checked={b.formato === 'propio'} onChange={() => elegir('propio')} />
          Otro (regex)
        </label>
        {b.formato === 'propio' && (
          <label className="field">
            <span>Regex, anclada con ^…$</span>
            <input value={b.regexPropia} maxLength={200} spellCheck={false} placeholder="^[a-z]{3}-\d+$" onChange={(e) => cambiar((x) => ({ ...x, regexPropia: e.target.value }))} />
          </label>
        )}
      </fieldset>
      <label className="field">
        <span>Un id de ejemplo</span>
        <input
          value={b.ejemploId}
          maxLength={20}
          spellCheck={false}
          aria-invalid={Boolean(problema)}
          aria-describedby="f-tickets-asis-ejemplo"
          onChange={(e) => cambiar((x) => ({ ...x, ejemploId: e.target.value.trim() }))}
        />
        <span id="f-tickets-asis-ejemplo" className={problema ? 'field-error' : 'field-help'}>
          {problema ?? 'Cumple el formato.'}
        </span>
      </label>

      <fieldset className="f-tickets-asis-grupo">
        <legend>Estados</legend>
        {b.estados.map((e, i) => (
          <div className="f-tickets-asis-estado" key={i}>
            <input aria-label={`Clave del estado ${i + 1}`} value={e.clave} maxLength={40} spellCheck={false} placeholder="en_curso" onChange={(ev) => setEstado(i, { clave: ev.target.value.trim() })} />
            <input aria-label={`Nombre del estado ${i + 1}`} value={e.nombre} maxLength={40} placeholder="En curso" onChange={(ev) => setEstado(i, { nombre: ev.target.value })} />
            <select aria-label={`Categoría del estado ${i + 1}`} value={e.categoria} onChange={(ev) => setEstado(i, { categoria: ev.target.value as Categoria })}>
              {CATEGORIAS.map((c) => (
                <option key={c} value={c}>
                  {CATEGORIA_ETIQUETA[c]}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="f-tickets-b f-tickets-b--xs"
              aria-label={`Quitar el estado ${e.nombre || i + 1}`}
              disabled={b.estados.length <= 1}
              onClick={() => cambiar((x) => ({ ...x, estados: x.estados.filter((_, j) => j !== i) }))}
            >
              Quitar
            </button>
          </div>
        ))}
        <div className="f-tickets-asis-acciones">
          <button
            type="button"
            className="f-tickets-b f-tickets-b--xs"
            disabled={b.estados.length >= ESTADOS_MAX}
            onClick={() => cambiar((x) => ({ ...x, estados: [...x.estados, { clave: '', nombre: '', categoria: 'pendiente' }] }))}
          >
            Agregar estado
          </button>
        </div>
        <label className="f-tickets-asis-radio">
          <input type="checkbox" checked={b.pistas.pedirEstados} onChange={(e) => cambiar((x) => ({ ...x, pistas: { ...x.pistas, pedirEstados: e.target.checked } }))} />
          Que Claude lea los estados del sistema
        </label>
      </fieldset>
    </div>
  )
}
