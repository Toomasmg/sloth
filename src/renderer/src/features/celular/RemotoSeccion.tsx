import { useState } from 'react'
import type { CelularVista } from '../../../../shared/celular'
import { Button, InlineAlert, Switch, toast } from '../../ui'
import { Qr } from './CelularPanel'

interface Props {
  v: CelularVista
  hacer: (op: string, ...args: unknown[]) => Promise<void>
  copiar: (texto: string, que: string) => Promise<void>
}

/** «Desde cualquier red»: el celu ve Sloth por el Supabase del chat, con todo cifrado de punta a punta. */
export function RemotoSeccion({ v, hacer, copiar }: Props): React.JSX.Element | null {
  const [confirmar, setConfirmar] = useState(false)
  const r = v.remoto
  if (!r) return null

  return (
    <section className="f-cel-sec" aria-labelledby="f-cel-remoto">
      <h3 id="f-cel-remoto" className="f-cel-h">
        Desde cualquier red
      </h3>
      <Switch checked={r.encendido} onChange={(on) => void hacer('remoto', { encendido: on })}>
        Ver Sloth en el celu aunque no estés en tu Wi-Fi
      </Switch>
      <p className="f-cel-nota">Va por el Supabase del chat, cifrado. Nunca viaja lo que pasa en las terminales.</p>

      {r.encendido && r.estado === 'sin-chat' && <InlineAlert tone="warning">Iniciá sesión en el chat de Sloth para usarlo.</InlineAlert>}
      {r.encendido && r.estado === 'conectando' && <p className="f-cel-nota">Conectando…</p>}
      {r.encendido && r.estado === 'error' && <InlineAlert tone="danger">{r.error ?? 'No se pudo conectar.'}</InlineAlert>}

      {r.encendido && r.estado === 'listo' && r.enlace && (
        <div className="f-cel-qrbox">
          <Qr texto={r.enlace} />
          <div className="f-cel-qrtexto">
            {r.celuActivo && (
              <p className="f-cel-ok f-cel-remoto-activo" role="status">
                Celu mirando ahora
              </p>
            )}
            <p className="f-cel-nota">Escaneá con la cámara y entrá con la misma cuenta de GitHub. Después podés instalarla como app.</p>
            <Button size="sm" variant="secondary" onClick={() => void copiar(r.enlace as string, 'Enlace')}>
              Copiar enlace
            </Button>
          </div>
        </div>
      )}

      {r.encendido && r.estado === 'listo' &&
        (confirmar ? (
          <div className="f-cel-confirm" role="group" aria-label="Regenerar el código del celu remoto">
            <p>Los celus que ya escanearon el código dejan de ver Sloth hasta que escaneen el nuevo.</p>
            <div className="f-cel-acciones">
              <Button size="sm" variant="ghost" onClick={() => setConfirmar(false)}>
                Cancelar
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  setConfirmar(false)
                  void hacer('remoto-regenerar').then(() => toast({ tone: 'success', message: 'Código nuevo. Los celus de antes quedaron afuera.' }))
                }}
              >
                Regenerar código
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirmar(true)}>
            Regenerar código…
          </Button>
        ))}

      {v.aprobar && (
        <div className="f-cel-remoto-aprobar">
          <Switch checked={r.aprobar} onChange={(on) => void hacer('remoto', { aprobar: on })}>
            También aprobar desde fuera de casa
          </Switch>
          <p className={r.aprobar ? 'f-cel-aviso' : 'f-cel-nota'}>
            Con esto, quien tenga tu celu desbloqueado y tu sesión de GitHub puede aprobar comandos de Claude.
          </p>
        </div>
      )}
    </section>
  )
}
