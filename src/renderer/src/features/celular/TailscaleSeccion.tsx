import { useEffect, useState } from 'react'
import type { CelularVista } from '../../../../shared/celular'
import { Button, InlineAlert, Input, Switch } from '../../ui'
import { Qr } from './Qr'

interface Props {
  v: CelularVista
  hacer: (op: string, ...args: unknown[]) => Promise<boolean>
  copiar: (texto: string, que: string) => Promise<void>
}

/** La misma página por Tailscale: fuera de casa sin abrir nada a internet y, con `tailscale serve`, por HTTPS para instalarla. */
export function TailscaleSeccion({ v, hacer, copiar }: Props): React.JSX.Element | null {
  const t = v.tailscale
  const [https, setHttps] = useState(t.https ?? '')
  useEffect(() => setHttps(t.https ?? ''), [t.https])
  if (!v.encendido) return null
  const comando = `tailscale serve --bg ${v.puerto}`

  return (
    <section className="f-cel-sec" aria-labelledby="f-cel-ts">
      <h3 id="f-cel-ts" className="f-cel-h">
        Fuera de casa, con Tailscale
      </h3>
      <Switch checked={t.encendido} onChange={(on) => void hacer('tailscale', on)}>
        También por Tailscale
      </Switch>
      <p className="f-cel-nota">
        Si tenés Tailscale en la PC y en el celu, con la misma cuenta, la página se abre desde cualquier lado sin exponer nada a internet: solo la ven tus equipos. Igual que en el Wi-Fi, cada celu tiene que pedir entrar y lo dejás desde acá.
      </p>
      {t.encendido && (
        <>
          {t.error && <InlineAlert tone="warning">{t.error}</InlineAlert>}
          {t.enlace && (
            <div className="f-cel-qrbox">
              <Qr texto={t.enlace} />
              <div className="f-cel-qrtexto">
                <p className="f-cel-ok">
                  Abierto en <span className="f-cel-mono">{`${t.ip}:${v.puerto}`}</span>
                </p>
                <p className="f-cel-nota">Escaneá este QR con el celu conectado a Tailscale.</p>
                <Button size="sm" variant="secondary" onClick={() => void copiar(t.enlace as string, 'Enlace')}>
                  Copiar enlace
                </Button>
              </div>
            </div>
          )}

          <h4 className="f-cel-h">Para instalarla como app</h4>
          <p className="f-cel-nota">
            Por http el celu no deja instalarla. Con HTTPS sí: en la PC, abrí una terminal y corré <span className="f-cel-mono">{comando}</span> (queda andando aunque reinicies). Pegá acá la dirección https que te muestra.
          </p>
          <div className="f-cel-acciones f-cel-izq">
            <Button size="sm" variant="secondary" onClick={() => void copiar(comando, 'Comando')}>
              Copiar comando
            </Button>
          </div>
          <form
            className="f-cel-fila"
            onSubmit={(e) => {
              e.preventDefault()
              void hacer('tailscale-https', https.trim())
            }}
          >
            <label htmlFor="f-cel-ts-https" className="f-cel-label">
              Dirección
            </label>
            <Input id="f-cel-ts-https" size="sm" mono placeholder="https://tu-pc.tu-tailnet.ts.net" value={https} onChange={(e) => setHttps(e.target.value)} />
            <Button size="sm" variant="secondary" type="submit">
              Guardar
            </Button>
          </form>
          {t.enlaceHttps && (
            <div className="f-cel-qrbox">
              <Qr texto={t.enlaceHttps} />
              <div className="f-cel-qrtexto">
                <p className="f-cel-nota">Escaneá este QR y, en el navegador del celu, «Instalar app» o «Agregar a pantalla de inicio».</p>
                <Button size="sm" variant="secondary" onClick={() => void copiar(t.enlaceHttps as string, 'Enlace')}>
                  Copiar enlace
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
