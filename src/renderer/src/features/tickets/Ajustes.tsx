import { useState } from 'react'
import { useUi } from '../host'
import { cleanError } from '../../format'
import { CloseIcon } from '../../icons/SlothIcons'
import { SIN_CONECTOR, type ConectorPropioVista, type ConectorResumen, type UsoAcum } from '../../../../shared/tickets'
import { capacidadesDe, nombreProveedor, proveedorIdDe, TICKETS_EXPERIMENTAL } from '../../../../shared/proveedores'
import { diaLocal, VUELTAS_DEFECTO, VUELTAS_MAX } from '../../../../shared/tickets-uso'
import { fmtCosto, resumenUso, setSnapshot, type Snapshot } from './model'
import { CuentasConectores, textoDisponibilidad } from './CuentasConectores'
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

const ningunaLoTiene = (snap: Snapshot, c: ConectorResumen): boolean => {
  if (c.via !== 'mcp') return false
  const revisadas = Object.values(snap.cuentas).filter((v) => v.revisadaEn)
  return revisadas.length > 0 && revisadas.every((v) => v.conectores[c.id]?.tipo === 'falta')
}

function CampoTope({ etiqueta, valor, vacio, min, max, paso, nota, onGuardar }: {
  etiqueta: string
  valor: number | undefined
  vacio: string
  min: number
  max: number
  paso: number
  nota?: string
  onGuardar: (v: number | null) => void
}): React.JSX.Element {
  const [txt, setTxt] = useState(valor === undefined ? '' : String(valor))
  const [previo, setPrevio] = useState(valor)
  if (previo !== valor) {
    setPrevio(valor)
    setTxt(valor === undefined ? '' : String(valor))
  }
  const guardar = (): void => {
    const t = txt.trim().replace(',', '.')
    if (t === '') return valor === undefined ? undefined : onGuardar(null)
    const n = Number(t)
    if (!Number.isFinite(n) || n < min || n > max) return setTxt(valor === undefined ? '' : String(valor))
    if (n !== valor) onGuardar(n)
  }
  return (
    <label className="field f-tickets-ajustes-campo">
      <span>{etiqueta}</span>
      <input
        type="number"
        inputMode="decimal"
        value={txt}
        min={min}
        max={max}
        step={paso}
        placeholder={vacio}
        onChange={(e) => setTxt(e.target.value)}
        onBlur={guardar}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      {nota && <small className="f-tickets-ajustes-nota">{nota}</small>}
    </label>
  )
}

function resumenDeUso(snap: Snapshot): { total: ReturnType<typeof resumenUso>; porConector: { id: string; nombre: string; hoy: UsoAcum; semana: UsoAcum }[] } | null {
  const uso = snap.uso
  if (!uso || Object.keys(uso).length === 0) return null
  const hoy = diaLocal(Date.now())
  const ids = [...new Set(Object.values(uso).flatMap((d) => Object.keys(d)))]
  const porConector = ids.map((id) => ({ id, nombre: snap.conectores.find((c) => c.id === id)?.nombre ?? id, ...resumenUso(uso, hoy, id) }))
  return { total: resumenUso(uso, hoy), porConector: porConector.length > 1 ? porConector : [] }
}

/** De qué sistema salen los tickets y, según la vía, con qué cuenta de Claude o qué repo de GitHub. */
export function Ajustes({ snap, onClose }: { snap: Snapshot; onClose?: () => void }): React.JSX.Element {
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

  const resumen = resumenDeUso(snap)
  const costo = (usd: number): string => (snap.motorExperimental && usd === 0 ? 'sin dato' : fmtCosto(usd))

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
                    {ningunaLoTiene(snap, c) ? ' (ninguna cuenta lo tiene)' : ''}
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
                {ui.accounts.map((a) => {
                  const logueada = !!ui.statuses[a.id]?.loggedIn
                  const d = snap.cuentas[a.id]?.conectores[snap.config.conectorId]
                  const sinTickets = capacidadesDe(a)?.ticketsHeadless !== true
                  const id = proveedorIdDe(a)
                  const experimental = id !== undefined && TICKETS_EXPERIMENTAL.includes(id)
                  return (
                    <option key={a.id} value={a.id} disabled={sinTickets || !logueada || d?.tipo === 'falta'}>
                      {a.label}
                      {sinTickets ? ` (${nombreProveedor(a)}: todavía no puede consultar tickets)` : logueada ? ` · ${textoDisponibilidad(snap.conector.nombre, d)}${experimental ? ' · experimental' : ''}` : ' (sin sesión)'}
                    </option>
                  )
                })}
              </Select>
            </label>
            <label className="field f-tickets-ajustes-campo">
              <span>Modelo</span>
              <Select value={snap.config.model} onChange={(e) => set({ model: e.target.value })}>
                <option value="haiku">Haiku (barato)</option>
                <option value="sonnet">Sonnet</option>
                <option value="opus">Opus</option>
              </Select>
              {snap.motorExperimental && <small className="f-tickets-experimental">Con Codex se usa el modelo de la cuenta.</small>}
            </label>
            {snap.motorExperimental && (
              <p className="f-tickets-experimental" role="note">
                <strong>Experimental.</strong> Las consultas con Codex todavía no se probaron con todas las versiones: si algo falla, el mensaje lo dice. Las acciones (escribir en el ticket) todavía no andan con Codex: es solo lectura. Durante la consulta Sloth le apaga a Codex el shell, la búsqueda web, las apps y los plugins, lo deja en solo lectura y corta si usa algo que no sea el conector; un servidor MCP de la cuenta con un nombre raro (con puntos o espacios) frena la consulta, y lo que configure un administrador de Codex no se puede apagar desde acá. El conector lo registrás vos en esa cuenta con «codex mcp add».
              </p>
            )}
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
        {onClose && (
          <Button size="sm" onClick={onClose} aria-label="Cerrar ajustes de tickets">
            <CloseIcon size={13} />
          </Button>
        )}
      </div>

      {via === 'mcp' && (
        <div className="f-tickets-ajustes-fila">
          <CampoTope
            etiqueta="Tope de vueltas por consulta"
            valor={snap.config.maxTurns}
            vacio={String(VUELTAS_DEFECTO)}
            min={1}
            max={VUELTAS_MAX}
            paso={1}
            onGuardar={(v) => set({ maxTurns: v })}
          />
          <CampoTope
            etiqueta="Tope de costo por consulta (US$)"
            valor={snap.config.maxCostUsd}
            vacio="Sin tope"
            min={0.01}
            max={100}
            paso={0.01}
            nota="Claude lo revisa entre vueltas: puede pasarse un poco."
            onGuardar={(v) => set({ maxCostUsd: v })}
          />
        </div>
      )}

      {via === 'mcp' && <CuentasConectores snap={snap} />}

      {resumen && (
        <div className="f-tickets-uso" aria-label="Uso estimado">
          <span title="Con suscripción de Claude no se paga por consulta: el número es nominal, para comparar.">
            Uso (costo estimado) · Hoy: {costo(resumen.total.hoy.costUsd)} en {resumen.total.hoy.corridas} {resumen.total.hoy.corridas === 1 ? 'consulta' : 'consultas'} · Últimos 7 días:{' '}
            {costo(resumen.total.semana.costUsd)}
          </span>
          {resumen.porConector.map((c) => (
            <span key={c.id}>
              {c.nombre}: hoy {costo(c.hoy.costUsd)} · 7 días {costo(c.semana.costUsd)}
            </span>
          ))}
          {snap.motorExperimental && <span>Con Codex el costo aparece como «sin dato» y el tope de costo no aplica; el tope de vueltas cuenta llamadas al conector.</span>}
        </div>
      )}

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
