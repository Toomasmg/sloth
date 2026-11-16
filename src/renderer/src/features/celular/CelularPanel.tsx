import { useEffect, useMemo, useState } from 'react'
import type { CelularVista } from '../../../../shared/celular'
import { qrComoCaminoSvg, qrDeTexto } from '../../../../shared/qr'
import { cleanError } from '../../format'
import { SidePanel } from '../../ui/SidePanel'
import { Button, InlineAlert, Input, Switch, toast } from '../../ui'
import { useUi } from '../host'
import { RemotoSeccion } from './RemotoSeccion'

const canal = (op: string): string => `feat:celular:${op}`

export function Qr({ texto }: { texto: string }): React.JSX.Element {
  const dibujo = useMemo(() => {
    try {
      return qrComoCaminoSvg(qrDeTexto(texto))
    } catch {
      return null
    }
  }, [texto])
  if (!dibujo) return <InlineAlert tone="warning">No se pudo dibujar el código. Copiá el enlace.</InlineAlert>
  const { path, lado } = dibujo
  return (
    <svg className="f-cel-qr" viewBox={`0 0 ${lado} ${lado}`} role="img" aria-label="Código QR para abrir Sloth en el celu" shapeRendering="crispEdges">
      <rect width={lado} height={lado} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}

/** Panel «Celular»: prender el servidor del Wi-Fi, el QR para el celu y lo que el celu puede hacer. */
export function CelularPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const ui = useUi()
  const [v, setV] = useState<CelularVista | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const [puerto, setPuerto] = useState('')
  const [tema, setTema] = useState('')
  const [confirmar, setConfirmar] = useState(false)

  useEffect(() => {
    let vivo = true
    void ui.invoke<CelularVista>(canal('vista')).then(
      (x) => {
        if (!vivo) return
        setV(x)
        setPuerto(String(x.puerto))
        setTema(x.ntfy.tema)
      },
      (e: unknown) => setErr(cleanError(e))
    )
    const off = ui.on(canal('changed'), (x: CelularVista) => setV(x))
    return () => {
      vivo = false
      off()
    }
  }, [ui])

  // Sin `disabled` mientras guarda: un botón con foco que se deshabilita le tira el foco al body.
  const hacer = async (op: string, ...args: unknown[]): Promise<boolean> => {
    if (ocupado) return false
    setErr(null)
    setOcupado(true)
    try {
      const x = await ui.invoke<CelularVista | undefined>(canal(op), ...args)
      if (x) setV(x)
      return true
    } catch (e) {
      setErr(cleanError(e))
      return false
    } finally {
      setOcupado(false)
    }
  }

  const copiar = async (texto: string, que: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(texto)
      toast({ tone: 'success', message: `${que} copiado.` })
    } catch {
      setErr('No se pudo copiar. Seleccionalo y copialo a mano.')
    }
  }

  const probar = async (): Promise<void> => {
    setErr(null)
    try {
      await ui.invoke(canal('probar-ntfy'))
      toast({ tone: 'success', message: 'Aviso de prueba enviado. Si no te llegó, revisá que estés suscripto al tema en ntfy.' })
    } catch (e) {
      setErr(cleanError(e))
    }
  }

  const puertoNum = Number(puerto)
  const puertoMal = !/^\d+$/.test(puerto) || puertoNum < 1024 || puertoNum > 65535
  const temaMal = !/^[A-Za-z0-9_-]{6,64}$/.test(tema)

  return (
    <SidePanel labelId="f-cel-title" title="Celular" onClose={onClose} width={420} className="f-cel">
      {!v ? (
        err ? <InlineAlert tone="danger">{err}</InlineAlert> : <p className="f-cel-nota">Cargando…</p>
      ) : (
        <div className="f-cel-body">
          <p className="f-cel-intro">Mirá desde el celu cómo van tus sesiones y cuánto te queda de cada límite, sin salir de lo que estés haciendo.</p>

          <section className="f-cel-sec" aria-labelledby="f-cel-srv">
            <h3 id="f-cel-srv" className="f-cel-h">En tu Wi-Fi</h3>
            <Switch checked={v.encendido} onChange={(on) => void hacer('encender', on)}>
              Ver Sloth en el celu
            </Switch>
            {v.ipCambio && (
              <InlineAlert
                tone="warning"
                action={
                  <Button size="xs" variant="ghost" onClick={() => void hacer('visto-ip')}>
                    Entendido
                  </Button>
                }
              >
                La IP de la PC cambió: el QR de antes ya no sirve. Escaneá este.
              </InlineAlert>
            )}
            {v.error && <InlineAlert tone="danger">{v.error}</InlineAlert>}
            {v.enlace ? (
              <div className="f-cel-qrbox">
                <Qr texto={v.enlace} />
                <div className="f-cel-qrtexto">
                  <p className="f-cel-ok">
                    Abierto en <span className="f-cel-mono">{`${v.ip}:${v.puerto}`}</span>
                  </p>
                  <p className="f-cel-nota">Escaneá el QR con la cámara del celu. Tiene que estar en el mismo Wi-Fi que la PC.</p>
                  <p className="f-cel-nota">Para tenerlo como app: en el navegador del celu, «Agregar a pantalla de inicio».</p>
                  <Button size="sm" variant="secondary" onClick={() => void copiar(v.enlace as string, 'Enlace')}>
                    Copiar enlace
                  </Button>
                </div>
              </div>
            ) : (
              !v.encendido && <p className="f-cel-nota">Apagado: nada se abre en la red hasta que lo prendas.</p>
            )}
            {v.encendido && <p className="f-cel-nota">Si Windows pregunta por el firewall, permití las redes privadas.</p>}

            <form
              className="f-cel-fila"
              onSubmit={(e) => {
                e.preventDefault()
                if (!puertoMal && puertoNum !== v.puerto) void hacer('puerto', puertoNum)
              }}
            >
              <label htmlFor="f-cel-puerto" className="f-cel-label">
                Puerto
              </label>
              <Input id="f-cel-puerto" size="sm" mono inputMode="numeric" value={puerto} onChange={(e) => setPuerto(e.target.value.trim())} error={puertoMal ? 'Entre 1024 y 65535.' : undefined} />
              <Button size="sm" variant="secondary" type="submit">
                Guardar
              </Button>
            </form>

            {confirmar ? (
              <div className="f-cel-confirm" role="group" aria-label="Regenerar el código">
                <p>Los celus conectados dejan de ver Sloth hasta que escaneen el QR nuevo.</p>
                <div className="f-cel-acciones">
                  <Button size="sm" variant="ghost" onClick={() => setConfirmar(false)}>
                    Cancelar
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      setConfirmar(false)
                      void hacer('regenerar').then(() => toast({ tone: 'success', message: 'Código nuevo. Los celus de antes quedaron afuera.' }))
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
            )}
          </section>

          <RemotoSeccion v={v} hacer={hacer} copiar={copiar} ocupado={ocupado} />

          <section className="f-cel-sec" aria-labelledby="f-cel-perm">
            <h3 id="f-cel-perm" className="f-cel-h">Permisos</h3>
            <Switch checked={v.aprobar} onChange={(on) => void hacer('aprobar', on)}>
              Aprobar o rechazar desde el celu
            </Switch>
            <p className={v.aprobar ? 'f-cel-aviso' : 'f-cel-nota'}>
              Cualquiera en tu Wi-Fi que tenga el enlace del QR podría aprobar comandos de Claude. Prendelo solo en una red de confianza. Apagado, el celu muestra el pedido pero lo respondés en la PC.
            </p>
          </section>

          <section className="f-cel-sec" aria-labelledby="f-cel-ntfy">
            <h3 id="f-cel-ntfy" className="f-cel-h">Avisos con el celu bloqueado</h3>
            <Switch checked={v.ntfy.encendido} onChange={(on) => void hacer('ntfy', { encendido: on })}>
              Avisarme por ntfy
            </Switch>
            <p className="f-cel-nota">
              Cuando una sesión termina, te necesita o pide permiso, y Sloth no está en primer plano. Usa ntfy.sh: el aviso (nombre del espacio y qué pasó) pasa por sus servidores. Respeta «No molestar».
            </p>
            <form
              className="f-cel-fila"
              onSubmit={(e) => {
                e.preventDefault()
                if (!temaMal && tema !== v.ntfy.tema) void hacer('ntfy', { tema })
              }}
            >
              <label htmlFor="f-cel-tema" className="f-cel-label">
                Tema
              </label>
              <Input id="f-cel-tema" size="sm" mono value={tema} onChange={(e) => setTema(e.target.value.trim())} error={temaMal ? 'De 6 a 64: letras, números, - o _.' : undefined} />
              <Button size="sm" variant="secondary" type="submit">
                Guardar
              </Button>
            </form>
            <p className="f-cel-nota">En la app ntfy del celu, suscribite a este tema. Cualquiera que sepa el nombre puede leerlo: dejalo largo y al azar.</p>
            <div className="f-cel-acciones f-cel-izq">
              <Button size="sm" variant="ghost" onClick={() => void copiar(v.ntfy.tema, 'Tema')}>
                Copiar tema
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void probar()}>
                Probar aviso
              </Button>
            </div>
          </section>

          {err && <InlineAlert tone="danger">{err}</InlineAlert>}

          <details className="f-cel-limites">
            <summary>Qué no hace todavía</summary>
            <ul>
              <li>Solo anda en el mismo Wi-Fi que la PC. Desde afuera, cuando haya cuentas.</li>
              <li>La página es http: no puede mantener la pantalla prendida. Configurala en el celu.</li>
              <li>Los relojes de límite se llenan cuando Claude responde en cada cuenta. Hasta entonces dicen «Sin datos».</li>
            </ul>
          </details>
        </div>
      )}
    </SidePanel>
  )
}
