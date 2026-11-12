import { useEffect, useId, useState } from 'react'
import { useUi, type UiCtx } from '../host'
import { cleanError } from '../../format'
import { ACCIONES, type ConectorPropioVista, type HerramientasVista, type OrigenConector } from '../../../../shared/tickets'
import { ID_CONECTOR_RE, type ConectorDef, type ConectorMcp } from '../../../../main/features/tickets/conector'
import { vistaHerramientas } from '../../../../main/features/tickets/propios'
import { ACCION_ETIQUETA, deDef, seEditaSinPerder, type Borrador } from './borrador'
import { Asistente } from './Asistente'
import { setSnapshot, type Snapshot } from './model'
import { Button, Input } from '../../ui'

type Lista = { lista: ConectorPropioVista[]; avisos: string[] }
type Abierto = { inicial?: Borrador; idAnterior?: string }
type Choca = 'incluido' | 'propio' | 'equipo' | null
type Importado = { def: ConectorDef; choca: Choca }
/** Un conector que no armó la persona y se va a guardar como suyo (importado o copiado del equipo): se revisa antes. */
type ComoMio = { def: ConectorMcp; origen: string; choca: Choca; idInicial: string }

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
  const [comoMio, setComoMio] = useState<ComoMio | null>(null)
  const [nota, setNota] = useState<string | null>(null)

  const fallo = (e: unknown): void => setErr(cleanError(e))
  const recargar = (): void => {
    ui.invoke<Lista>('feat:tickets:propios').then(setDatos, fallo)
  }
  // Al abrir y cuando cambia qué conectores hay o cuáles están aceptados. No depende del snapshot entero:
  // `propios` relee los archivos y avisa un snapshot nuevo, y eso sería un bucle.
  const huella = snap.conectores.map((c) => `${c.id}:${c.aceptado}`).join()
  useEffect(recargar, [huella])

  const listo = (): void => {
    setAbierto(null)
    recargar()
  }

  const traer = (id: string, f: (def: ConectorMcp) => void): void => {
    setErr(null)
    setNota(null)
    ui.invoke<ConectorDef>('feat:tickets:propio', id).then((def) => {
      if (def.via === 'mcp') f(def)
    }, fallo)
  }

  const editar = (id: string): void =>
    traer(id, (def) => {
      if (seEditaSinPerder(def)) return setAbierto({ inicial: deDef(def), idAnterior: id })
      setNota(
        `${def.nombre} tiene partes que el asistente no sabe editar (por ejemplo, una herramienta con dos roles) y se perderían. Exportalo, cambiá el archivo e importalo: con el mismo id reemplaza al tuyo.`
      )
    })

  const copiar = (c: ConectorPropioVista): void =>
    traer(c.id, (def) => setComoMio({ def, origen: deDondeViene(c.origen), choca: 'equipo', idInicial: `${c.id.slice(0, 28)}-mio` }))

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
    setNota(null)
    ui.invoke<Importado | null>('feat:tickets:importarPropio').then((r) => {
      if (r?.def.via !== 'mcp') return
      const otroId = r.choca === 'incluido' || r.choca === 'equipo'
      setComoMio({ def: r.def, origen: 'un archivo', choca: r.choca, idInicial: otroId ? `${r.def.id.slice(0, 28)}-imp` : r.def.id })
    }, fallo)
  }

  const guardarComoMio = (def: ConectorMcp, id: string, reemplaza: boolean): void => {
    setErr(null)
    ui.invoke<Snapshot>('feat:tickets:guardarPropio', { ...def, id }, reemplaza ? id : undefined).then((s) => {
      setSnapshot(s)
      setComoMio(null)
      setNota(`Guardado como «${id}».`)
      recargar()
    }, fallo)
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
        <Button size="sm" onClick={() => setAbierto({})}>
          Nuevo conector…
        </Button>
        <Button size="sm" onClick={importar}>
          Importar…
        </Button>
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
                  <Button size="xs" onClick={() => editar(c.id)}>
                    Editar
                  </Button>
                ) : (
                  <>
                    {!c.aceptado && (
                      <Button variant="primary" size="xs" onClick={() => setRevisar(c)}>
                        Revisar y aceptar
                      </Button>
                    )}
                    <Button size="xs" onClick={() => copiar(c)}>
                      Copiar como mío
                    </Button>
                  </>
                )}
                <Button size="xs" onClick={() => exportar(c.id)}>
                  Exportar
                </Button>
                {mio && (
                  <Button size="xs" onClick={() => setBorrar(c.id)} aria-label={`Borrar ${c.nombre}`}>
                    Borrar
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {aBorrar && (
        <div className="f-tickets-alert f-tickets-confirm" role="alertdialog" aria-label={`Confirmar borrar ${aBorrar.nombre}`}>
          <span className="f-tickets-alert-text">¿Borrar {aBorrar.nombre}? Si es el que usás, Tickets queda sin conector.</span>
          <Button variant="danger" size="sm" onClick={() => confirmarBorrar(aBorrar.id)}>
            Borrar
          </Button>
          <Button size="sm" autoFocus onClick={() => setBorrar(null)}>
            Cancelar
          </Button>
        </div>
      )}

      {revisar && (
        <AvisoHerramientas
          origen={deDondeViene(revisar.origen)}
          herramientas={revisar.herramientas}
          aceptar="Aceptar y usar"
          onAceptar={() => aceptar(revisar)}
          onCancelar={() => setRevisar(null)}
        />
      )}

      {comoMio && <GuardarComoMio key={`${comoMio.origen}:${comoMio.def.id}`} {...comoMio} onGuardar={guardarComoMio} onCancelar={() => setComoMio(null)} />}

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

function GuardarComoMio({
  def,
  origen,
  choca,
  idInicial,
  onGuardar,
  onCancelar
}: ComoMio & { onGuardar: (def: ConectorMcp, id: string, reemplaza: boolean) => void; onCancelar: () => void }): React.JSX.Element {
  const [id, setId] = useState(idInicial)
  const reemplaza = choca === 'propio' && id === def.id
  const idOk = ID_CONECTOR_RE.test(id) && (choca === null || reemplaza || id !== def.id)
  const etiqueta =
    choca === 'propio' ? `Ya tenés un conector «${def.id}». Con el mismo id lo reemplaza; si no, elegí otro:` : choca ? `Ya hay un conector «${def.id}». Elegí otro id:` : 'Id'
  return (
    <AvisoHerramientas
      origen={origen}
      herramientas={vistaHerramientas(def)}
      aceptar={reemplaza ? 'Reemplazar el mío' : 'Guardar como mío'}
      listo={idOk}
      onAceptar={() => onGuardar(def, id, reemplaza)}
      onCancelar={onCancelar}
    >
      <label className="field">
        <span>{etiqueta}</span>
        <Input value={id} maxLength={32} spellCheck={false} aria-invalid={!idOk} onChange={(e) => setId(e.target.value.trim())} />
      </label>
    </AvisoHerramientas>
  )
}

function Herramientas({ prefijo, xs }: { prefijo: string; xs: readonly string[] }): React.JSX.Element {
  return (
    <ul className="f-tickets-aviso-h-lista">
      {xs.map((t) => (
        <li key={t}>
          <code>{prefijo + t}</code>
        </li>
      ))}
    </ul>
  )
}

/** Lo que puede leer y cambiar un conector que no armó la persona, antes de usarlo: por consulta y por acción, lo mismo que va a --allowedTools. */
export function AvisoHerramientas({
  origen,
  herramientas: h,
  aceptar,
  listo = true,
  onAceptar,
  onCancelar,
  children
}: {
  origen: string
  herramientas: HerramientasVista
  aceptar: string
  listo?: boolean
  onAceptar: () => void
  onCancelar: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  const tituloId = useId()
  const p = h.pistas
  const libres: [string, string | undefined][] = [
    ['Quién sos, con tu id', p.yoConId],
    ['Quién sos, sin tu id', p.yoSinId],
    ['Estados', p.estados],
    ['Antes de abrir un ticket o de una acción', p.apoyo],
    ['Pasos al abrir un ticket', p.detalle.length ? p.detalle.join('\n') : undefined]
  ]
  return (
    <div className="f-tickets-alert f-tickets-confirm f-tickets-aviso-h" role="alertdialog" aria-labelledby={tituloId}>
      <p id={tituloId} className="f-tickets-aviso-h-titulo">
        Este conector viene de {origen}. Revisá qué puede usar Claude en cada caso:
      </p>
      <div>
        <strong>Al actualizar la lista, lee con</strong>
        <Herramientas prefijo={h.prefijo} xs={h.lista} />
      </div>
      {h.detalle.length > 0 && (
        <div>
          <strong>Al abrir un ticket, lee con</strong>
          <Herramientas prefijo={h.prefijo} xs={h.detalle} />
        </div>
      )}
      {ACCIONES.map((a) => {
        const xs = h.acciones[a]
        const escribe = h.escritura[a]
        if (!xs || !escribe) return null
        const lee = xs.filter((t) => t !== escribe)
        const pista = p.acciones[a]
        return (
          <div key={a} className="f-tickets-aviso-h-escribe">
            <strong>{ACCION_ETIQUETA[a]}</strong>: cambia el ticket con <code>{h.prefijo + escribe}</code>
            {lee.length > 0 && (
              <>
                {' '}
                y además lee con
                <Herramientas prefijo={h.prefijo} xs={lee} />
              </>
            )}
            {pista && (
              <ul className="f-tickets-aviso-h-lista">
                <li>
                  Argumentos: <code>{pista.args}</code>
                </li>
                {pista.nota && <li>Nota para Claude: «{pista.nota}»</li>}
              </ul>
            )}
          </div>
        )
      })}
      <p className="f-tickets-ajustes-nota">Bloquea {h.negar} herramientas.</p>
      <pre className="f-tickets-aviso-h-pista" tabIndex={0} aria-label="Pista para traer la lista">
        {p.lista}
      </pre>
      <details>
        <summary>Las demás pistas que van al prompt</summary>
        {libres.map(([t, v]) =>
          v === undefined ? null : (
            <div key={t}>
              <strong>{t}</strong>
              <pre className="f-tickets-aviso-h-pista" tabIndex={0} aria-label={t}>
                {v}
              </pre>
            </div>
          )
        )}
      </details>
      {children}
      <div className="f-tickets-asis-acciones">
        <Button variant="primary" size="sm" onClick={onAceptar} disabled={!listo}>
          {aceptar}
        </Button>
        <Button size="sm" autoFocus onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}
