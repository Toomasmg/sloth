import { useState } from 'react'
import { useUi } from '../host'
import { cleanError } from '../../format'
import { CloseIcon } from '../../icons/SlothIcons'
import { SIN_CONECTOR, type ConectorPropioVista, type ConectorResumen } from '../../../../shared/tickets'
import { setSnapshot, type Snapshot } from './model'
import { aceptarYUsar, AvisoHerramientas, deDondeViene, etiquetaOrigen, Propios } from './Propios'
import { Button, Select } from '../../ui'


function grupos(cs: readonly ConectorResumen[]): { etiqueta: string; conectores: ConectorResumen[] }[] {
  const out: { etiqueta: string; conectores: ConectorResumen[] }[] = []
  for (const c of cs) {
    const etiqueta = c.origen.tipo === 'incluido' ? 'Incluidos' : c.origen.tipo === 'usuario' ? 'Tuyos' : etiquetaOrigen(c.origen)
    const g = out.find((x) => x.etiqueta === etiqueta)
    if (g) g.conectores.push(c)
    else out.push({ etiqueta, conectores: [c] })
  }
  return out
}

/** De qué sistema salen los tickets y, según la vía, con qué cuenta de Claude o qué repo de GitHub. */
export function Ajustes({ snap, onClose }: { snap: Snapshot; onClose: () => void }): React.JSX.Element {
  const ui = useUi()
  const [err, setErr] = useState<string | null>(null)
  // Cambiar de conector borra la lista: si hay tickets, se confirma antes.
  const [pendiente, setPendiente] = useState<string | null>(null)
  const [revisar, setRevisar] = useState<ConectorPropioVista | null>(null)
  // Una vez abierto queda montado: así cerrar Ajustes o plegar no descarta un asistente a medias.
  const [propiosVistos, setPropiosVistos] = useState(false)
  const via = snap.conector.via

  const set = (p: Record<string, unknown>): void => {
    setErr(null)
    void ui.invoke<Snapshot>('feat:tickets:setConfig', p).then(setSnapshot, (e) => setErr(cleanError(e)))
  }

  const elegirConector = (id: string): void => {
    if (id === snap.config.conectorId) return setPendiente(null)
    if (snap.conectores.some((c) => c.id === id && c.origen.tipo === 'equipo' && !c.aceptado)) return pedirAceptar(id)
    if (snap.tickets.length) return setPendiente(id)
    set({ conectorId: id })
  }

  // Uno del equipo sin aceptar no se usa hasta que la persona vea qué herramientas toca.
  const pedirAceptar = (id: string): void => {
    setErr(null)
    setPendiente(null)
    void ui.invoke<{ lista: ConectorPropioVista[] }>('feat:tickets:propios').then(
      (r) => {
        const v = r.lista.find((x) => x.id === id)
        if (v) setRevisar(v)
        else setErr('Ese conector del equipo ya no está.')
      },
      (e) => setErr(cleanError(e))
    )
  }

  const aceptar = (v: ConectorPropioVista): void => {
    setRevisar(null)
    if (!snap.tickets.length) return void aceptarYUsar(ui, v).catch((e) => setErr(cleanError(e)))
    ui.invoke<Snapshot>('feat:tickets:aceptar', v.id, v.hash).then(
      (s) => {
        setSnapshot(s)
        setPendiente(v.id)
      },
      (e) => setErr(cleanError(e))
    )
  }

  const confirmar = (): void => {
    if (pendiente !== null) set({ conectorId: pendiente })
    setPendiente(null)
  }

  const elegirCarpeta = async (): Promise<void> => {
    const p = await window.sloth.pickFolder()
    if (p) set({ defaultRepo: p })
  }

  return (
    <section className="f-tickets-ajustes" aria-label="Ajustes de tickets">
      {snap.pendienteAceptar && (
        <div className="f-tickets-aviso" role="alert">
          <p>
            El equipo cambió el conector «{snap.conectores.find((c) => c.id === snap.pendienteAceptar)?.nombre ?? snap.pendienteAceptar}»: revisalo y aceptalo de nuevo.
          </p>
          <Button onClick={() => pedirAceptar(snap.pendienteAceptar as string)}>
            Revisar y aceptar
          </Button>
        </div>
      )}
      <div className="f-tickets-ajustes-fila">
        <label className="field f-tickets-ajustes-campo">
          <span>Conector</span>
          <Select value={pendiente ?? snap.config.conectorId} onChange={(e) => elegirConector(e.target.value)} disabled={snap.running}>
            <option value={SIN_CONECTOR}>Ninguno</option>
            {grupos(snap.conectores).map((g) => (
              <optgroup key={g.etiqueta} label={g.etiqueta}>
                {g.conectores.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                    {c.origen.tipo === 'equipo' && !c.aceptado ? ' (sin aceptar)' : c.verificado || c.origen.tipo !== 'incluido' ? '' : ' (sin probar: solo lectura)'}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </label>

        {via === 'mcp' ? (
          <>
            <label className="field f-tickets-ajustes-campo">
              <span>Cuenta para consultar</span>
              <Select value={snap.config.queryAccountId ?? ''} onChange={(e) => set({ queryAccountId: e.target.value })}>
                <option value="">La de menos uso</option>
                {ui.accounts.map((a) => (
                  <option key={a.id} value={a.id} disabled={!ui.statuses[a.id]?.loggedIn}>
                    {a.label}
                    {ui.statuses[a.id]?.loggedIn ? '' : ' (sin sesión)'}
                  </option>
                ))}
              </Select>
            </label>
            <label className="field f-tickets-ajustes-campo">
              <span>Modelo</span>
              <Select value={snap.config.model} onChange={(e) => set({ model: e.target.value })}>
                <option value="haiku">Haiku (barato)</option>
                <option value="sonnet">Sonnet</option>
                <option value="opus">Opus</option>
              </Select>
            </label>
          </>
        ) : (
          <div className="field f-tickets-ajustes-campo f-tickets-ajustes-repo">
            <span>Carpeta del repo</span>
            <div className="f-tickets-ajustes-ruta">
              <code title={snap.config.defaultRepo ?? snap.lastRepo}>{snap.config.defaultRepo ?? snap.lastRepo ?? 'Sin elegir'}</code>
              <Button size="sm" onClick={() => void elegirCarpeta()}>
                Elegir carpeta…
              </Button>
              {snap.config.defaultRepo && (
                <Button size="sm" onClick={() => set({ defaultRepo: '' })} title="Usar la carpeta del último espacio">
                  Usar la del último espacio
                </Button>
              )}
            </div>
          </div>
        )}

        <span className="f-tickets-grow" />
        <Button size="sm" onClick={onClose} aria-label="Cerrar ajustes de tickets">
          <CloseIcon size={13} />
        </Button>
      </div>

      <details className="f-tickets-propios" onToggle={(e) => e.currentTarget.open && setPropiosVistos(true)}>
        <summary>Conectores propios</summary>
        {propiosVistos && <Propios snap={snap} />}
      </details>

      {revisar && (
        <AvisoHerramientas
          origen={deDondeViene(revisar.origen)}
          herramientas={revisar.herramientas}
          aceptar="Aceptar y usar"
          onAceptar={() => aceptar(revisar)}
          onCancelar={() => setRevisar(null)}
        />
      )}

      {via === 'gh' && (
        <p className="f-tickets-ajustes-nota">
          Usa gh con tu sesión de GitHub: no gasta Claude.
          {!snap.config.defaultRepo && snap.lastRepo ? ' Sin carpeta elegida, usa la del último espacio.' : ''}
        </p>
      )}

      {pendiente !== null && (
        <div className="f-tickets-alert f-tickets-confirm" role="alertdialog" aria-label="Confirmar cambio de conector">
          <span className="f-tickets-alert-text">Cambiar de conector borra la lista actual. ¿Seguimos?</span>
          <Button variant="primary" size="sm" onClick={confirmar}>
            Cambiar
          </Button>
          <Button size="sm" autoFocus onClick={() => setPendiente(null)}>
            Cancelar
          </Button>
        </div>
      )}

      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}
    </section>
  )
}
