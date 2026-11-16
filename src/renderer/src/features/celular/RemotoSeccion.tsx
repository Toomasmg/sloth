import { useState } from 'react'
import type { CelularVista } from '../../../../shared/celular'
import { Button, InlineAlert, Switch, toast } from '../../ui'
import { Qr } from './CelularPanel'

interface Props {
  v: CelularVista
  hacer: (op: string, ...args: unknown[]) => Promise<boolean>
  copiar: (texto: string, que: string) => Promise<void>
  ocupado: boolean
}

/** «Desde cualquier red»: el celu ve Sloth por el Supabase del chat, con todo cifrado de punta a punta. */
export function RemotoSeccion({ v, hacer, copiar, ocupado }: Props): React.JSX.Element | null {
  const [confirmar, setConfirmar] = useState(false)
  const [cerrarOtras, setCerrarOtras] = useState(true)
  const r = v.remoto
  if (!r) return null
  const enlace = r.enlace

  const regenerar = async (): Promise<void> => {
    if (ocupado) {
      toast({ tone: 'danger', message: 'Sloth está terminando otro cambio. Probá regenerar de nuevo en un momento.' })
      return
    }
    setConfirmar(false)
    if (await hacer('remoto-regenerar', { cerrarOtras }))
      toast({
        tone: 'success',
        message: cerrarOtras ? 'Código nuevo y sesiones de los otros dispositivos cerradas. Los celus de antes quedaron afuera.' : 'Código nuevo. Los celus de antes ya no pueden ver ni aprobar nada.'
      })
  }

  return (
    <section className="f-cel-sec" aria-labelledby="f-cel-remoto">
      <h3 id="f-cel-remoto" className="f-cel-h">
        Desde cualquier red
      </h3>
      <Switch checked={r.encendido} onChange={(on) => void hacer('remoto', { encendido: on })}>
        Verlo también fuera de tu Wi-Fi
      </Switch>
      <p className="f-cel-nota">Va por el Supabase del chat, cifrado. Nunca viaja lo que pasa en las terminales.</p>

      {r.encendido && r.estado === 'sin-chat' && <InlineAlert tone="warning">Iniciá sesión en el chat de Sloth para usarlo.</InlineAlert>}
      {r.encendido && r.estado === 'conectando' && <p className="f-cel-nota">Conectando…</p>}
      {r.encendido && r.estado === 'error' && <InlineAlert tone="danger">{r.error ?? 'No se pudo conectar.'}</InlineAlert>}

      {r.encendido && r.estado === 'listo' && enlace && (
        <div className="f-cel-qrbox">
          <Qr texto={enlace} />
          <div className="f-cel-qrtexto">
            {r.celuActivo && (
              <p className="f-cel-ok f-cel-remoto-activo" role="status">
                Celu mirando ahora
              </p>
            )}
            <p className="f-cel-nota">Escaneá con la cámara y entrá con la misma cuenta de GitHub. Después podés instalarla como app.</p>
            <Button size="sm" variant="secondary" onClick={() => void copiar(enlace, 'Enlace')}>
              Copiar enlace
            </Button>
            <p className="f-cel-nota">El enlace lleva el código: no lo pegues en chats ni lo dejes en el portapapeles.</p>
          </div>
        </div>
      )}

      {r.encendido && r.estado === 'listo' &&
        (confirmar ? (
          <div className="f-cel-confirm" role="group" aria-label="Regenerar el código del celu remoto">
            <p>Los celus que ya escanearon el código dejan de ver Sloth y de poder aprobar hasta que escaneen el nuevo.</p>
            <Switch checked={cerrarOtras} onChange={setCerrarOtras}>
              Cerrar también la sesión de GitHub en los otros dispositivos
            </Switch>
            <p className="f-cel-nota">Si perdiste el celu, dejalo prendido. Sloth sigue con su sesión en esta PC; en otras PCs con esta cuenta vas a tener que volver a entrar al chat.</p>
            <div className="f-cel-acciones">
              <Button size="sm" variant="ghost" onClick={() => setConfirmar(false)}>
                Cancelar
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => void regenerar()}
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
