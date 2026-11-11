import { useEffect, useState } from 'react'
import { useUi, type UiCtx } from '../host'
import { cleanError } from '../../format'
import { ACCIONES, type ConectorPropioVista, type HerramientasVista, type OrigenConector } from '../../../../shared/tickets'
import { ID_CONECTOR_RE, type ConectorDef } from '../../../../main/features/tickets/conector'
import { ACCION_ETIQUETA, deDef, herramientasVista, type Borrador } from './borrador'
import { Asistente, type Paso } from './Asistente'
import { setSnapshot, type Snapshot } from './model'

type Lista = { lista: ConectorPropioVista[]; avisos: string[] }
type Abierto = { inicial?: Borrador; idAnterior?: string; paso?: Paso }
type Importado = { def: ConectorDef; choca: 'incluido' | 'propio' | null }

export const etiquetaOrigen = (o: OrigenConector): string => (o.tipo === 'equipo' ? `Del equipo ${o.equipo}` : o.tipo === 'usuario' ? 'Tuyo' : 'Incluido')

export const deDondeViene = (o: OrigenConector): string => (o.tipo === 'equipo' ? `el equipo ${o.equipo} (${o.repo})` : o.tipo === 'usuario' ? 'vos' : 'Sloth')

/** Acepta la versión que la persona revisó y pasa a usarla. */
export async function aceptarYUsar(ui: UiCtx, v: ConectorPropioVista): Promise<void> {
  setSnapshot(await ui.invoke<Snapshot>('feat:tickets:aceptar', v.id, v.hash))
  setSnapshot(await ui.invoke<Snapshot>('feat:tickets:setConfig', { conectorId: v.id }))
}

/** Lo que se lista de la sección: los propios, los del equipo y sus acciones. */
export function Propios({ snap }: { snap: Snapshot }): React.JSX.Element {
  const ui = useUi()
  const [datos, setDatos] = useState<Lista>({ lista: [], avisos: [] })
  const [err, setErr] = useState<string | null>(null)
  const [borrar, setBorrar] = useState<string | null>(null)
  const [abierto, setAbierto] = useState<Abierto | null>(null)
  const [revisar, setRevisar] = useState<ConectorPropioVista | null>(null)
  const [importado, setImportado] = useState<Importado | null>(null)
  const [nota, setNota] = useState<string | null>(null)

  const fallo = (e: unknown): void => setErr(cleanError(e))
  const recargar = (): void => {
    ui.invoke<Lista>('feat:tickets:propios').then(setDatos, fallo)
  }
  // Solo al abrir: `propios` relee los archivos y avisa un snapshot nuevo, que vuelve a pintar esto.
  useEffect(recargar, [])

  const listo = (): void => {
    setAbierto(null)
    recargar()
  }

  const editar = (id: string, mio: boolean): void => {
    setErr(null)
    ui.invoke<ConectorDef>('feat:tickets:propio', id).then((def) => {
      if (def.via !== 'mcp') return
      const b = deDef(def)
      setAbierto(mio ? { inicial: b, idAnterior: id } : { inicial: { ...b, id: `${id.slice(0, 28)}-mio` }, paso: 4 })
    }, fallo)
  }

  const confirmarBorrar = (id: string): void => {
    setBorrar(null)
    ui.invoke<Snapshot>('feat:tickets:borrarPropio', id).then((s) => {
      setSnapshot(s)
      recargar()
    }, fallo)
  }

  const exportar = (id: string): void => {
    setErr(null)
    setNota(null)
    ui.invoke<{ path: string } | null>('feat:tickets:exportarPropio', id).then((r) => setNota(r ? `Guardado en ${r.path}` : null), fallo)
  }

  const importar = (): void => {
    setErr(null)
    ui.invoke<Importado | null>('feat:tickets:importarPropio').then((r) => setImportado(r), fallo)
  }

  const aceptar = (v: ConectorPropioVista): void => {
    setRevisar(null)
    aceptarYUsar(ui, v).then(recargar, fallo)
  }

  if (abierto) return <Asistente {...abierto} onListo={listo} onCancelar={() => setAbierto(null)} />

  const avisos = [...new Set([...datos.avisos, ...(snap.avisosPropios ?? [])])]
  const aBorrar = datos.lista.find((c) => c.id === borrar)

  return (
    <div className="f-tickets-propios-cuerpo">
      <div className="f-tickets-asis-acciones">
        <button type="button" className="f-tickets-b f-tickets-b--sm" onClick={() => setAbierto({})}>
          Nuevo conector…
        </button>
        <button type="button" className="f-tickets-b f-tickets-b--sm" onClick={importar}>
          Importar…
        </button>
      </div>

      {datos.lista.length === 0 ? (
        <p className="f-tickets-ajustes-nota">Todavía no tenés conectores propios ni del equipo.</p>
      ) : (
        <ul className="f-tickets-propios-lista">
          {datos.lista.map((c) => {
            const mio = c.origen.tipo === 'usuario'
            return (
              <li key={c.id} className="f-tickets-propios-item">
                <span className="f-tickets-propios-nombre">{c.nombre}</span>
                <span className="f-tickets-propios-origen">
                  {etiquetaOrigen(c.origen)}
                  {c.origen.tipo === 'equipo' && !c.aceptado ? ' · sin aceptar' : ''}
                </span>
                <span className="f-tickets-grow" />
                {mio ? (
                  <button type="button" className="f-tickets-b f-tickets-b--xs" onClick={() => editar(c.id, true)}>
                    Editar
                  </button>
                ) : (
                  <>
                    {!c.aceptado && (
                      <button type="button" className="f-tickets-b f-tickets-b--xs f-tickets-b--pri" onClick={() => setRevisar(c)}>
                        Revisar y aceptar
                      </button>
                    )}
                    <button type="button" className="f-tickets-b f-tickets-b--xs" onClick={() => editar(c.id, false)}>
                      Copiar como mío
                    </button>
                  </>
                )}
                <button type="button" className="f-tickets-b f-tickets-b--xs" onClick={() => exportar(c.id)}>
                  Exportar
                </button>
                {mio && (
                  <button type="button" className="f-tickets-b f-tickets-b--xs" onClick={() => setBorrar(c.id)} aria-label={`Borrar ${c.nombre}`}>
                    Borrar
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {aBorrar && (
        <div className="f-tickets-alert f-tickets-confirm" role="alertdialog" aria-label={`Confirmar borrar ${aBorrar.nombre}`}>
          <span className="f-tickets-alert-text">¿Borrar {aBorrar.nombre}? Si es el que usás, volvés a Gruv.</span>
          <button type="button" className="f-tickets-b f-tickets-b--sm f-tickets-b--solid-danger" onClick={() => confirmarBorrar(aBorrar.id)}>
            Borrar
          </button>
          <button type="button" className="f-tickets-b f-tickets-b--sm" autoFocus onClick={() => setBorrar(null)}>
            Cancelar
          </button>
        </div>
      )}

      {revisar && (
        <AvisoHerramientas
          origen={deDondeViene(revisar.origen)}
          herramientas={revisar.herramientas}
          pistaLista={revisar.pistaLista}
          aceptar="Aceptar y usar"
          onAceptar={() => aceptar(revisar)}
          onCancelar={() => setRevisar(null)}
        />
      )}

      {importado && importado.def.via === 'mcp' && (
        <Importar
          def={importado.def}
          choca={importado.choca}
          onSeguir={(b) => {
            setImportado(null)
            setAbierto({ inicial: b, paso: 4 })
          }}
          onCancelar={() => setImportado(null)}
        />
      )}

      {avisos.length > 0 && (
        <ul className="f-tickets-propios-avisos">
          {avisos.map((a) => (
            <li key={a} className="f-tickets-ajustes-nota">
              {a}
            </li>
          ))}
        </ul>
      )}

      {nota && (
        <p className="f-tickets-ajustes-nota" role="status">
          {nota}
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

function Importar({
  def,
  choca,
  onSeguir,
  onCancelar
}: {
  def: Extract<ConectorDef, { via: 'mcp' }>
  choca: Importado['choca']
  onSeguir: (b: Borrador) => void
  onCancelar: () => void
}): React.JSX.Element {
  const [id, setId] = useState(choca ? `${def.id.slice(0, 28)}-imp` : def.id)
  const idOk = ID_CONECTOR_RE.test(id) && (!choca || id !== def.id)
  return (
    <AvisoHerramientas
      origen="un archivo"
      herramientas={herramientasVista(def)}
      pistaLista={def.pistas.lista}
      aceptar="Revisar y guardar"
      listo={idOk}
      onAceptar={() => onSeguir({ ...deDef(def), id })}
      onCancelar={onCancelar}
    >
      {choca && (
        <label className="field">
          <span>Ya hay un conector «{def.id}». Elegí otro id:</span>
          <input value={id} maxLength={32} spellCheck={false} aria-invalid={!idOk} onChange={(e) => setId(e.target.value.trim())} />
        </label>
      )}
    </AvisoHerramientas>
  )
}

/** Lo que puede leer y cambiar un conector que no armó la persona, antes de usarlo. */
export function AvisoHerramientas({
  origen,
  herramientas: h,
  pistaLista,
  aceptar,
  listo = true,
  onAceptar,
  onCancelar,
  children
}: {
  origen: string
  herramientas: HerramientasVista
  pistaLista: string
  aceptar: string
  listo?: boolean
  onAceptar: () => void
  onCancelar: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  const lee = [...h.lista, ...h.detalle, ...h.apoyo]
  const escribe = ACCIONES.flatMap((a) => (h.escritura[a] ? [[a, h.escritura[a]] as const] : []))
  return (
    <div className="f-tickets-alert f-tickets-confirm f-tickets-aviso-h" role="alertdialog" aria-labelledby="f-tickets-aviso-h-titulo">
      <p id="f-tickets-aviso-h-titulo" className="f-tickets-aviso-h-titulo">
        Este conector viene de {origen}. Revisá qué puede usar Claude:
      </p>
      <div>
        <strong>Lee con</strong>
        <ul className="f-tickets-aviso-h-lista">
          {lee.map((t) => (
            <li key={t}>
              <code>{h.prefijo + t}</code>
            </li>
          ))}
        </ul>
      </div>
      {escribe.length > 0 && (
        <div className="f-tickets-aviso-h-escribe">
          <strong>Puede cambiar tickets con</strong>
          <ul className="f-tickets-aviso-h-lista">
            {escribe.map(([a, t]) => (
              <li key={a}>
                {ACCION_ETIQUETA[a]}: <code>{h.prefijo + t}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="f-tickets-ajustes-nota">Bloquea {h.negar} herramientas.</p>
      <pre className="f-tickets-aviso-h-pista" tabIndex={0} aria-label="Pista para traer la lista">
        {pistaLista}
      </pre>
      {children}
      <div className="f-tickets-asis-acciones">
        <button type="button" className="f-tickets-b f-tickets-b--sm f-tickets-b--pri" onClick={onAceptar} disabled={!listo}>
          {aceptar}
        </button>
        <button type="button" className="f-tickets-b f-tickets-b--sm" autoFocus onClick={onCancelar}>
          Cancelar
        </button>
      </div>
    </div>
  )
}
