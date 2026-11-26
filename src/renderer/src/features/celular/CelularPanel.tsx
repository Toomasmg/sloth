import { useEffect, useState } from 'react'
import { textoEvento, type CelularVista } from '../../../../shared/celular'
import { cleanError } from '../../format'
import { SidePanel } from '../../ui/SidePanel'
import { Button, InlineAlert, Input, Switch, toast } from '../../ui'
import { useUi } from '../host'
import { Qr } from './Qr'
import { RemotoSeccion } from './RemotoSeccion'

const canal = (op: string): string => `feat:celular:${op}`
const hora = (ms: number): string => new Date(ms).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })

/** Panel «Celular»: prender el servidor del Wi-Fi, el QR para el celu y lo que el celu puede hacer. */
export function CelularPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const ui = useUi()
  const [v, setV] = useState<CelularVista | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const [puerto, setPuerto] = useState('')
  const [tema, setTema] = useState('')
  const [servidor, setServidor] = useState('')
  const [token, setToken] = useState('')
  const [confirmar, setConfirmar] = useState(false)

  useEffect(() => {
    let vivo = true
    void ui.invoke<CelularVista>(canal('vista')).then(
      (x) => {
        if (!vivo) return
        setV(x)
        setPuerto(String(x.puerto))
        setTema(x.ntfy.tema)
        setServidor(x.ntfy.servidor)
      },
      (e: unknown) => setErr(cleanError(e))
    )
    const off = ui.on(canal('changed'), (x: CelularVista) => setV(x))
    return () => {
      vivo = false
      off()
    }
  }, [ui])

  const temaVista = v?.ntfy.tema
  useEffect(() => {
    if (temaVista !== undefined) setTema(temaVista)
  }, [temaVista])

  const servidorVista = v?.ntfy.servidor
  useEffect(() => {
    if (servidorVista !== undefined) setServidor(servidorVista)
  }, [servidorVista])

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
  const temaMal = !/^[A-Za-z0-9_-]{20,64}$/.test(tema)

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
                  {v.terminal && <p className="f-cel-ok">Las terminales se abren con este QR.</p>}
                  <p className="f-cel-nota">Escaneá el QR con la cámara del celu. Tiene que estar en el mismo Wi-Fi que la PC. El QR contiene la clave: no lo compartas.</p>
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
                      void hacer('regenerar').then(() => toast({ tone: 'success', message: 'Código nuevo. Los celus de antes tienen que escanear el QR de nuevo.' }))
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

          {(v.escuchando || v.actividad.length > 0) && (
            <section className="f-cel-sec" aria-labelledby="f-cel-quien">
              <h3 id="f-cel-quien" className="f-cel-h">Celus conectados</h3>
              {v.celus.length ? (
                <ul className="f-cel-lista">
                  {v.celus.map((c) => (
                    <li key={`${c.ip}|${c.dispositivo}`}>
                      <span className="f-cel-quien">{c.dispositivo}</span>
                      <span className="f-cel-mono">{c.ip}</span>
                      <span>desde las {hora(c.desde)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="f-cel-nota">Ninguno ahora.</p>
              )}
              {v.actividad.length > 0 && (
                <>
                  <h4 className="f-cel-h">Actividad</h4>
                  <ul className="f-cel-lista" aria-label="Lo que hicieron los celus">
                    {v.actividad.map((e, i) => (
                      <li key={`${e.at}-${i}`}>
                        <span className="f-cel-hora">{hora(e.at)}</span>
                        <span className="f-cel-quien">{e.celu}</span>
                        <span>{textoEvento(e)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className="f-cel-nota">Desde que abriste Sloth. No guarda lo que se escribió ni los comandos. Si ves un celu que no es tuyo, regenerá el código.</p>
            </section>
          )}

          <RemotoSeccion v={v} hacer={hacer} copiar={copiar} ocupado={ocupado} />

          <section className="f-cel-sec" aria-labelledby="f-cel-perm">
            <h3 id="f-cel-perm" className="f-cel-h">Permisos</h3>
            <Switch checked={v.aprobar} onChange={(on) => void hacer('aprobar', on)}>
              Aprobar o rechazar desde el celu
            </Switch>
            <p className={v.aprobar ? 'f-cel-aviso' : 'f-cel-nota'}>
              Cualquiera con el QR (o la clave) podría aprobar comandos de Claude. Prendelo solo en una red de confianza. Apagado, el celu muestra el pedido pero lo respondés en la PC.
            </p>
            <Switch checked={v.terminal} onChange={(on) => void hacer('terminal', on)}>
              Abrir las terminales desde el celu
            </Switch>
            {v.terminal && (
              <p className="f-cel-ok" role="status">
                {v.enlace ? 'Prendido: el botón «Terminal» aparece en cada sesión al abrir la página con el QR de «En tu Wi-Fi». Con el de «Desde cualquier red» sale apagado.' : 'Prendido, pero «Ver Sloth en el celu» está apagado: no hay QR para abrirlas.'}
              </p>
            )}
            <p className={v.terminal ? 'f-cel-aviso' : 'f-cel-nota'}>
              Desde el celu vas a poder ver la terminal de cada espacio y escribir en ella como si estuvieras en la PC. Quien tenga el QR (o la clave) puede correr cualquier comando en esta PC. Solo anda en el Wi-Fi de casa: abrí la página con el QR de arriba, no con el de «Desde cualquier red». En cada sesión vas a ver el botón «Terminal».
            </p>
            <p className="f-cel-aviso" role="note">
              Lo que va entre el celu y la PC viaja cifrado en tu Wi-Fi, con una clave que está solo en el QR. Aun así la página no puede verificarse: alguien que manipule tu red a propósito podría robarte la clave. Usalo en una red propia; en una pública, de hotel o compartida, usá «Desde cualquier red», que va cifrado de punta a punta.
            </p>
          </section>

          <section className="f-cel-sec" aria-labelledby="f-cel-ntfy">
            <h3 id="f-cel-ntfy" className="f-cel-h">Avisos con el celu bloqueado</h3>
            <Switch checked={v.ntfy.encendido} onChange={(on) => void hacer('ntfy', { encendido: on })}>
              Avisarme por ntfy
            </Switch>
            <p className="f-cel-nota">
              Cuando una sesión termina, te necesita o pide permiso, y Sloth no está en primer plano. El aviso (nombre del espacio y qué pasó) pasa por el servidor de ntfy que elijas. Respeta «No molestar». Al tocarlo se abre la página del celu (la dirección va sin la clave).
            </p>
            <Switch checked={v.ntfy.privado} onChange={(on) => void hacer('ntfy', { privado: on })}>
              Avisos sin nombres
            </Switch>
            <p className="f-cel-nota">El aviso dice solo «Una sesión terminó» (o «te necesita», «pide permiso»): ni el nombre del espacio ni lo que dijo Claude pasan por ntfy.</p>
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
              <Input id="f-cel-tema" size="sm" mono value={tema} onChange={(e) => setTema(e.target.value.trim())} error={temaMal ? 'De 20 a 64: letras, números, - o _.' : undefined} />
              <Button size="sm" variant="secondary" type="submit">
                Guardar
              </Button>
            </form>
            {v.ntfy.temaRenovado && (
              <InlineAlert tone="warning">
                Tu tema era corto y cualquiera podía adivinarlo: generamos uno nuevo. Suscribite a este en la app ntfy y volvé a prender los avisos.
              </InlineAlert>
            )}
            <p className="f-cel-nota">En la app ntfy del celu, suscribite a este tema. Cualquiera que sepa el nombre puede leerlo: dejalo largo y al azar.</p>
            <div className="f-cel-acciones f-cel-izq">
              <Button size="sm" variant="ghost" onClick={() => void copiar(v.ntfy.tema, 'Tema')}>
                Copiar tema
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void hacer('ntfy', { generarTema: true })}>
                Generar otro
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void probar()}>
                Probar aviso
              </Button>
            </div>
            <div className="f-cel-fila">
              <label htmlFor="f-cel-servidor" className="f-cel-label">
                Servidor
              </label>
              <Input
                id="f-cel-servidor"
                size="sm"
                mono
                value={servidor}
                onChange={(e) => setServidor(e.target.value.trim())}
                onBlur={() => {
                  if (servidor !== v.ntfy.servidor) void hacer('ntfy', { servidor })
                }}
              />
            </div>
            {v.ntfy.conToken && <p className="f-cel-nota">El token guardado es de este servidor: si lo cambiás, se borra y hay que cargarlo de nuevo.</p>}
            <p className="f-cel-nota">Para que los avisos no pasen por ntfy.sh, podés poner tu propio servidor de ntfy (se instala en una PC o un servidor tuyo; ver docs.ntfy.sh) y cargar su dirección acá.</p>
            <form
              className="f-cel-fila"
              onSubmit={(e) => {
                e.preventDefault()
                if (token !== '') void hacer('ntfy', { token }).then((ok) => ok && setToken(''))
              }}
            >
              <label htmlFor="f-cel-token" className="f-cel-label">
                Token de acceso (opcional)
              </label>
              <Input id="f-cel-token" size="sm" mono type="password" autoComplete="off" value={token} placeholder={v.ntfy.conToken ? 'Guardado' : undefined} onChange={(e) => setToken(e.target.value.trim())} />
              <Button size="sm" variant="secondary" type="submit">
                Guardar
              </Button>
              {v.ntfy.conToken && (
                <Button size="sm" variant="ghost" onClick={() => void hacer('ntfy', { token: null })}>
                  Quitar
                </Button>
              )}
            </form>
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
