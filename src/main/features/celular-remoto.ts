import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import type { RemotoVista } from '../../shared/celular'
import {
  abrir,
  claveCelu,
  EVENTOS,
  sellar,
  topicCelu,
  validarDecision,
  validarHola,
  type Clave,
  type DatoEstado,
  type DatoResultado,
  type EventoCelu
} from '../../shared/celu-remoto'
import { celuActivo, debePublicar, huella, Nonces } from './celular-remoto-core'
import type { FuenteDeEstado, ProveedorDeEstado } from './celular-servidor'
import type { SesionChat } from './chat'

export interface CambioRemoto {
  estado: RemotoVista['estado']
  celuActivo: boolean
  error: string | null
}

export interface OpcionesRemota {
  proveedor: ProveedorDeEstado
  sesion: () => SesionChat | null
  secreto: () => string
  /** Las dos llaves: «Aprobar desde el celu» y «Aprobar desde fuera de casa». */
  puedeAprobar: () => boolean
  alCambiar: (e: CambioRemoto) => void
  log: (...a: unknown[]) => void
}

interface Canal {
  client: SupabaseClient
  ch: RealtimeChannel
  userId: string
  secreto: string
  topic: string
  clave: Promise<Clave>
}

const TICK_MS = 1000
const REINTENTO_MS = 30_000
const LOG_HOLA_MS = 60_000
const ERROR_CANAL = 'No pude conectar con el canal del celu. ¿Corriste la migración 0006_celu_remoto.sql?'
const APROBAR_APAGADO = 'Aprobar desde fuera de casa está apagado en Sloth.'

const msg = (e: unknown): string => (e instanceof Error ? e.message : 'Algo salió mal.')

/**
 * El celu fuera de casa: publica el mismo EstadoCelular que el Wi-Fi, cifrado, en `celu:<userId>` del
 * Supabase del chat, y solo mientras un celu manda `hola`. Nunca manda nada que no salga del proveedor.
 */
export function crearFuenteRemota(o: OpcionesRemota): FuenteDeEstado {
  let timer: NodeJS.Timeout | null = null
  let canal: Canal | null = null
  let estado: RemotoVista['estado'] = 'apagado'
  let error: string | null = null
  let reintentarEn = 0
  let ultimoHola: number | null = null
  let holaNuevo = false
  let ultimoEnvio: number | null = null
  let ultimaHuella: string | null = null
  let n = 0
  let ocupado = false
  let avisado: CambioRemoto | null = null
  let ultimoLogHola = 0
  const nonces = new Nonces()

  function avisar(): void {
    const ahora: CambioRemoto = { estado, celuActivo: celuActivo(ultimoHola, Date.now()), error }
    if (avisado && avisado.estado === ahora.estado && avisado.celuActivo === ahora.celuActivo && avisado.error === ahora.error) return
    avisado = ahora
    o.alCambiar(ahora)
  }

  function fijar(e: RemotoVista['estado'], err: string | null): void {
    estado = e
    error = err
    avisar()
  }

  async function cerrar(): Promise<void> {
    const c = canal
    canal = null
    ultimoHola = null
    holaNuevo = false
    ultimoEnvio = null
    ultimaHuella = null
    if (c) await c.client.removeChannel(c.ch).catch((e: unknown) => o.log('celu remoto: no se pudo cerrar el canal:', msg(e)))
  }

  async function mandar(c: Canal, evento: EventoCelu, dato: unknown): Promise<boolean> {
    const payload = await sellar(await c.clave, c.topic, evento, dato)
    const r = await c.ch.send({ type: 'broadcast', event: evento, payload })
    if (r !== 'ok') o.log(`celu remoto: no se pudo mandar ${evento} (${r})`)
    return r === 'ok'
  }

  async function alHola(c: Canal, payload: unknown): Promise<void> {
    if (canal !== c) return
    const d = validarHola(await abrir(await c.clave, c.topic, EVENTOS.hola, payload), Date.now())
    if (!d || canal !== c) {
      // Un celu con el código viejo o con el reloj corrido manda uno cada 30 s: basta con un aviso por minuto.
      if (canal === c && Date.now() - ultimoLogHola >= LOG_HOLA_MS) {
        ultimoLogHola = Date.now()
        o.log('celu remoto: hola inválido (¿código viejo o reloj del celu corrido?), se descarta')
      }
      return
    }
    ultimoHola = Date.now()
    holaNuevo = true
  }

  async function alDecision(c: Canal, payload: unknown): Promise<void> {
    if (canal !== c) return
    const d = validarDecision(await abrir(await c.clave, c.topic, EVENTOS.decision, payload), Date.now())
    if (!d || canal !== c) return o.log('celu remoto: decisión inválida, se descarta')
    if (!nonces.usar(d.nonce)) return o.log('celu remoto: decisión repetida, se descarta')
    let res: DatoResultado
    if (!o.puedeAprobar()) res = { id: d.id, ok: false, error: APROBAR_APAGADO }
    else
      try {
        o.proveedor.decidir(d.id, d.decision)
        res = { id: d.id, ok: true }
      } catch (e) {
        res = { id: d.id, ok: false, error: msg(e) }
      }
    await mandar(c, EVENTOS.resultado, res)
  }

  async function abrirCanal(s: SesionChat, secreto: string): Promise<void> {
    if (!timer) return
    const topic = topicCelu(s.userId)
    const ch = s.client.channel(topic, { config: { private: true, broadcast: { self: false } } })
    const c: Canal = { client: s.client, ch, userId: s.userId, secreto, topic, clave: claveCelu(secreto, s.userId) }
    c.clave.catch((e: unknown) => o.log('celu remoto: no se pudo armar la clave:', msg(e)))
    const enFondo = (p: Promise<void>): void => void p.catch((e: unknown) => o.log('celu remoto:', msg(e)))
    ch.on('broadcast', { event: EVENTOS.hola }, (m: { payload?: unknown }) => enFondo(alHola(c, m?.payload)))
    ch.on('broadcast', { event: EVENTOS.decision }, (m: { payload?: unknown }) => enFondo(alDecision(c, m?.payload)))
    canal = c
    fijar('conectando', null)
    // El token del chat puede haber rotado desde que se abrió la conexión realtime.
    await s.client.realtime.setAuth().catch((e: unknown) => o.log('celu remoto: no se pudo pasar la sesión a realtime:', msg(e)))
    if (canal !== c) {
      await s.client.removeChannel(ch).catch((e: unknown) => o.log('celu remoto: no se pudo cerrar el canal:', msg(e)))
      return
    }
    ch.subscribe((st: string) => {
      if (canal !== c) return
      if (st === 'SUBSCRIBED') fijar('listo', null)
      else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') {
        reintentarEn = Date.now() + REINTENTO_MS
        fijar('error', ERROR_CANAL)
      }
    })
  }

  async function publicar(c: Canal): Promise<void> {
    const ahora = Date.now()
    const ritmo = { ahora, ultimoHola, ultimoEnvio, holaNuevo }
    // Si ni con un cambio tocaría publicar, no hace falta leer el estado (escanea el uso de cada cuenta).
    if (!debePublicar({ ...ritmo, cambio: true })) return
    const e = await o.proveedor.estado()
    if (canal !== c) return
    const h = huella(e)
    if (!debePublicar({ ...ritmo, cambio: h !== ultimaHuella })) return
    holaNuevo = false
    const dato: DatoEstado = { estado: { ...e, aprobar: e.aprobar && o.puedeAprobar(), terminal: false }, n: ++n }
    if (await mandar(c, EVENTOS.estado, dato)) {
      ultimoEnvio = ahora
      ultimaHuella = h
    }
  }

  async function tick(): Promise<void> {
    if (ocupado) return
    ocupado = true
    try {
      const s = o.sesion()
      const secreto = o.secreto()
      if (!s) {
        if (canal) await cerrar()
        fijar('sin-chat', null)
      } else if (!canal || canal.client !== s.client || canal.userId !== s.userId || canal.secreto !== secreto) {
        await cerrar()
        await abrirCanal(s, secreto)
      } else if (estado === 'error' && Date.now() >= reintentarEn) {
        await cerrar()
        await abrirCanal(s, secreto)
      }
      if (canal && estado === 'listo') await publicar(canal)
    } catch (e) {
      o.log('celu remoto:', msg(e))
    } finally {
      ocupado = false
      avisar()
    }
  }

  return {
    nombre: 'remota',
    async iniciar() {
      if (timer) return
      timer = setInterval(() => void tick(), TICK_MS)
      timer.unref()
      await tick()
    },
    async detener() {
      if (timer) clearInterval(timer)
      timer = null
      await cerrar()
      estado = 'apagado'
      error = null
    }
  }
}
