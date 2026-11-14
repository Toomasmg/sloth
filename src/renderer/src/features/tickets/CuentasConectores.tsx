import { useState } from 'react'
import { useUi } from '../host'
import { cleanError } from '../../format'
import type { Disponibilidad } from '../../../../shared/tickets'
import { setSnapshot, timeAgo, type Snapshot } from './model'
import { Button, Select } from '../../ui'

export function textoDisponibilidad(nombreConector: string, d: Disponibilidad | undefined): string {
  if (!d || d.tipo === 'sin_revisar') return 'sin revisar'
  if (d.tipo === 'falta') return `sin ${nombreConector}`
  if (d.tipo === 'elegir') return `${nombreConector}: elegí el servidor`
  if (d.estado === 'needs-auth') return `${nombreConector}: falta autenticar`
  if (d.estado === 'failed') return `${nombreConector}: no arranca`
  if (d.estado !== 'connected' || !d.verificado) return `${nombreConector}: sin confirmar`
  return `tiene ${nombreConector}${d.adaptado ? ` como «${d.nombre}»` : ''}`
}

type Tono = 'ok' | 'aviso' | 'falta'

function tonoDe(d: Disponibilidad | undefined): Tono {
  if (!d || d.tipo === 'sin_revisar' || d.tipo === 'elegir') return 'aviso'
  if (d.tipo === 'falta') return 'falta'
  if (d.estado === 'connected' && d.verificado) return 'ok'
  return d.estado === 'failed' ? 'falta' : 'aviso'
}

function queHacer(d: Disponibilidad | undefined): string | null {
  if (!d || d.tipo !== 'tiene') return null
  if (d.estado === 'needs-auth') return 'Abrí Claude Code con esa cuenta y corré /mcp para autenticarlo.'
  if (d.estado === 'failed') return 'El servidor no arranca: abrí Claude Code con esa cuenta, corré /mcp y mirá el error.'
  if (d.estado === 'pending') return 'Todavía se estaba conectando: volvé a revisar en un rato. Podés probar igual.'
  return null
}

/** Qué conectores tiene cada cuenta de Claude, y desde dónde volver a revisarlo. */
export function CuentasConectores({ snap }: { snap: Snapshot }): React.JSX.Element {
  const ui = useUi()
  const [err, setErr] = useState<string | null>(null)
  const [manual, setManual] = useState<boolean | null>(null)
  const cid = snap.config.conectorId
  const nombre = snap.conector.nombre
  const logueadas = ui.accounts.filter((a) => ui.statuses[a.id]?.loggedIn)
  const elegida = snap.config.queryAccountId
  const dElegida = elegida ? snap.cuentas[elegida]?.conectores[cid] : undefined
  const autoAbierto = (!!dElegida && dElegida.tipo !== 'tiene') || !logueadas.some((a) => snap.cuentas[a.id]?.revisadaEn)
  const ocupado = snap.revisando || snap.running

  const revisar = (id?: string): void => {
    setErr(null)
    void ui.invoke<Snapshot>('feat:tickets:revisarCuentas', id).then(setSnapshot, (e) => setErr(cleanError(e)))
  }

  const elegirServidor = (cuenta: string, prefijo: string): void => {
    setErr(null)
    void ui.invoke<Snapshot>('feat:tickets:setConfig', { servidor: { cuenta, conector: cid, prefijo } }).then(setSnapshot, (e) => setErr(cleanError(e)))
  }

  const conServidor = logueadas.filter((o) => snap.cuentas[o.id]?.conectores[cid]?.tipo === 'tiene').map((o) => o.label)

  return (
    <details className="f-tickets-cuentas" open={manual ?? autoAbierto} onToggle={(e) => setManual(e.currentTarget.open)}>
      <summary>Conectores por cuenta</summary>
      <div className="f-tickets-cuentas-cuerpo">
        {logueadas.length === 0 && <p className="f-tickets-cuentas-nota">Ninguna cuenta tiene la sesión iniciada.</p>}
        <ul className="f-tickets-cuentas-lista">
          {logueadas.map((a) => {
            const v = snap.cuentas[a.id]
            const d = v?.conectores[cid]
            const otros = Object.entries(v?.conectores ?? {}).filter(([id, x]) => id !== cid && x.tipo === 'tiene')
            const accion = queHacer(d)
            return (
              <li key={a.id} className="f-tickets-cuentas-item">
                <div className="f-tickets-cuentas-fila">
                  <strong>{a.label}</strong>
                  <span className={`f-tickets-cuentas-estado ${tonoDe(d)}`}>{textoDisponibilidad(nombre, d)}</span>
                  <span className="f-tickets-cuentas-nota">{v?.revisadaEn ? `revisada ${timeAgo(v.revisadaEn)}` : 'sin revisar'}</span>
                  <span className="f-tickets-grow" />
                  <Button size="sm" onClick={() => revisar(a.id)} disabled={ocupado} aria-label={`Revisar los conectores de ${a.label}`}>
                    Revisar
                  </Button>
                </div>
                {v?.error && <p className="f-tickets-cuentas-nota falta">{v.error}</p>}
                {accion && <p className="f-tickets-cuentas-nota">{accion}</p>}
                {d?.tipo === 'falta' && (
                  <p className="f-tickets-cuentas-nota">
                    {conServidor.length ? `Lo tienen: ${conServidor.join(', ')}.` : 'Ninguna cuenta lo tiene. Sumalo en Claude Code con /mcp.'}
                  </p>
                )}
                {d?.tipo === 'elegir' && (
                  <label className="field f-tickets-cuentas-elegir">
                    <span>Esta cuenta tiene más de un servidor posible. ¿Cuál usa Sloth?</span>
                    <Select value={snap.config.servidores?.[a.id]?.[cid] ?? ''} onChange={(e) => elegirServidor(a.id, e.target.value)} disabled={ocupado}>
                      <option value="">Elegí un servidor…</option>
                      {d.opciones.map((o) => (
                        <option key={o.prefijo} value={o.prefijo}>
                          {o.nombre} ({o.estado})
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
                {d?.tipo === 'tiene' && d.adaptado && (
                  <p className="f-tickets-cuentas-nota">
                    Sloth usa «{d.nombre}» como {nombre}: las herramientas son las mismas, con otro nombre de servidor.
                  </p>
                )}
                {otros.length > 0 && (
                  <p className="f-tickets-cuentas-nota">
                    También tiene: {otros.map(([id]) => snap.conectores.find((c) => c.id === id)?.nombre ?? id).join(', ')}.
                  </p>
                )}
              </li>
            )
          })}
        </ul>
        <div className="f-tickets-cuentas-pie">
          <Button size="sm" onClick={() => revisar()} disabled={ocupado}>
            Volver a revisar todas
          </Button>
          <span className="f-tickets-cuentas-nota" role="status">
            {snap.revisando
              ? 'Revisando…'
              : 'Abre Claude sin ventana con Haiku en cada cuenta para ver sus conectores, sin usar ninguno. Cuesta unos centavos por cuenta.'}
          </span>
        </div>
        {err && (
          <p className="form-error" role="alert">
            {err}
          </p>
        )}
      </div>
    </details>
  )
}
