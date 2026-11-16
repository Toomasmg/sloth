import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EstadoCelular } from '../../shared/celular'
import { abrir, claveCelu, EVENTOS, sellar, topicCelu, type EventoCelu } from '../../shared/celu-remoto'
import { crearFuenteRemota } from './celular-remoto'
import type { SesionChat } from './chat'

const USER = '00000000-0000-4000-8000-000000000001'
const TOPIC = topicCelu(USER)
const VIEJO = 'a'.repeat(43)
const NUEVO = 'b'.repeat(43)
const ESTADO: EstadoCelular = { ahora: 1, aprobar: true, cuentas: [], sesiones: [], pedidos: [] }

interface Enviado {
  event: EventoCelu
  payload: unknown
}

class CanalFalso {
  handlers = new Map<string, (m: { payload?: unknown }) => void>()
  enviados: Enviado[] = []
  on(_tipo: string, filtro: { event: string }, fn: (m: { payload?: unknown }) => void): this {
    this.handlers.set(filtro.event, fn)
    return this
  }
  subscribe(fn: (st: string) => void): this {
    fn('SUBSCRIBED')
    return this
  }
  async send(m: Enviado): Promise<string> {
    this.enviados.push(m)
    return 'ok'
  }
  recibir(evento: EventoCelu, payload: unknown): void {
    this.handlers.get(evento)?.({ payload })
  }
}

const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('al regenerar, la PC deja de publicar con la clave vieja y rechaza las decisiones selladas con ella', async () => {
  const canales: CanalFalso[] = []
  const client = {
    channel: () => {
      const c = new CanalFalso()
      canales.push(c)
      return c
    },
    removeChannel: async () => 'ok',
    realtime: { setAuth: async () => undefined }
  } as unknown as SupabaseClient
  const sesion: SesionChat = { client, userId: USER, supabaseUrl: 'https://x.supabase.co', anonKey: 'k' }
  let secreto = VIEJO
  const decididas: string[] = []
  const fuente = crearFuenteRemota({
    proveedor: { estado: async () => ESTADO, decidir: (id, d) => void decididas.push(`${id}:${d}`), puedeAprobar: () => true, token: () => 'x', icono: () => null },
    sesion: () => sesion,
    secreto: () => secreto,
    puedeAprobar: () => true,
    alCambiar: () => undefined,
    log: () => undefined
  })
  const viejo = await claveCelu(VIEJO, USER)
  const nuevo = await claveCelu(NUEVO, USER)
  const decision = async (clave: CryptoKey, id: string): Promise<unknown> =>
    sellar(clave, TOPIC, EVENTOS.decision, { id, decision: 'allow', at: Date.now(), nonce: `nonce-${id}-0123456789` })

  try {
    await fuente.iniciar()
    canales[0].recibir(EVENTOS.hola, await sellar(viejo, TOPIC, EVENTOS.hola, { at: Date.now() }))
    await esperar(1200)
    const estadoViejo = canales[0].enviados.find((e) => e.event === EVENTOS.estado)
    assert.ok(estadoViejo, 'con la clave vieja publicaba')
    assert.ok(await abrir(viejo, TOPIC, EVENTOS.estado, estadoViejo.payload))

    secreto = NUEVO
    await esperar(1200)
    assert.equal(canales.length, 2, 'reabrió el canal con la clave nueva')
    const ch = canales[1]
    ch.recibir(EVENTOS.hola, await sellar(viejo, TOPIC, EVENTOS.hola, { at: Date.now() }))
    ch.recibir(EVENTOS.decision, await decision(viejo, 'p1'))
    await esperar(1200)
    assert.deepEqual(decididas, [])
    assert.equal(ch.enviados.length, 0, 'no publica nada para un celu con la clave vieja')

    ch.recibir(EVENTOS.decision, await decision(nuevo, 'p2'))
    await esperar(50)
    assert.deepEqual(decididas, ['p2:allow'])
    for (const e of ch.enviados) assert.equal(await abrir(viejo, TOPIC, e.event, e.payload), null)
  } finally {
    await fuente.detener()
  }
})
