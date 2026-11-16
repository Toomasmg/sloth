import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConectorMcp } from './conector'
import { conectorPorId } from './conectores'
import { buildDescubrirArgs } from './descubrir'
import { buildListaArgs } from './motor'
import type { CuentaRevisada, ServidorMcp } from '../../../shared/tickets'
import {
  buildRevisarPrompt,
  candidatos,
  conPrefijo,
  disponibilidad,
  elegibles,
  mensajeCuenta,
  prefijoDeServidor,
  porHerramientas,
  problemaEnSesion,
  REVISAR_SCHEMA,
  revisarCuenta,
  revisarTemprano,
  sanearCache,
  servidorDeLaLista,
  servidoresDeSalida,
  usable
} from './cuentas'

const mcp = (id: string): ConectorMcp => {
  const d = conectorPorId(id)
  if (d?.via !== 'mcp') throw new Error(`falta ${id}`)
  return d
}
const GRUV = mcp('gruv')
const JIRA = mcp('jira')
const GRUV_TOOLS = [...GRUV.herramientas.lista, ...GRUV.herramientas.detalle]
const ATL = 'mcp__claude_ai_Atlassian_MCP__'

const srv = (nombre: string, estado: ServidorMcp['estado'], herramientas?: string[]): ServidorMcp => {
  const prefijo = prefijoDeServidor(nombre)
  if (!prefijo) throw new Error(nombre)
  return { nombre, prefijo, estado, ...(herramientas ? { herramientas } : {}) }
}
const cuenta = (servidores: ServidorMcp[]): CuentaRevisada => ({ revisadaEn: 1, servidores })

/** Como el `system/init` de Cosmos-Fusion: gruv-tomy sin herramientas todavía. */
function salidaCosmos(result: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      type: 'system',
      subtype: 'init',
      mcp_servers: [
        { name: 'gruv-tomy', status: 'pending' },
        { name: 'claude.ai Atlassian MCP', status: 'connected' },
        { name: 'claude.ai Notion', status: 'needs-auth' },
        { name: 'raro', status: 'algo-nuevo' }
      ],
      tools: ['Bash', `${ATL}searchJiraIssuesUsingJql`, `${ATL}getJiraIssue`, `${ATL}mal nombre`, 'mcp__otro__x']
    },
    { type: 'assistant' },
    { type: 'result', subtype: 'success', is_error: false, ...result }
  ])
}

test('prefijoDeServidor pasa a _ lo que no es letra, número, _ o -', () => {
  assert.equal(prefijoDeServidor('claude.ai Atlassian MCP'), ATL)
  assert.equal(prefijoDeServidor('plugin:design:atlassian'), 'mcp__plugin_design_atlassian__')
  assert.equal(prefijoDeServidor('gruv-tomy'), 'mcp__gruv-tomy__')
  assert.equal(prefijoDeServidor('a'.repeat(80)), undefined)
  assert.equal(prefijoDeServidor(''), undefined)
})

test('servidoresDeSalida lee estados y herramientas de init, sin inventar servidores', () => {
  const sv = servidoresDeSalida(salidaCosmos({ structured_output: { herramientas: ['mcp__otro__x', 'mcp__gruv-tomy__listar_tickets', 'mcp__gruv-tomy__mal;rm'] } }))
  assert.deepEqual(sv, [
    { nombre: 'gruv-tomy', prefijo: 'mcp__gruv-tomy__', estado: 'pending', herramientas: ['listar_tickets'] },
    { nombre: 'claude.ai Atlassian MCP', prefijo: ATL, estado: 'connected', herramientas: ['getJiraIssue', 'searchJiraIssuesUsingJql'] },
    { nombre: 'claude.ai Notion', prefijo: 'mcp__claude_ai_Notion__', estado: 'needs-auth' },
    { nombre: 'raro', prefijo: 'mcp__raro__', estado: 'otro' }
  ])
  assert.equal(
    servidoresDeSalida(salidaCosmos())?.find((s) => s.nombre === 'gruv-tomy')?.herramientas,
    undefined
  )
})

test('servidoresDeSalida: sin init no hay nada, y dos servidores con el mismo prefijo se descartan', () => {
  assert.equal(servidoresDeSalida('no es json'), undefined)
  assert.equal(servidoresDeSalida(JSON.stringify([{ type: 'result' }])), undefined)
  const sv = servidoresDeSalida(
    JSON.stringify([
      {
        type: 'system',
        subtype: 'init',
        mcp_servers: [
          { name: 'a.b', status: 'connected' },
          { name: 'a:b', status: 'connected' },
          { name: 'gruv', status: 'connected' },
          { name: 'gruv__x', status: 'connected' },
          { name: 'con\nsalto', status: 'connected' },
          { name: 7, status: 'connected' }
        ],
        tools: ['mcp__a_b__t', 'mcp__gruv__listar_tickets', 'mcp__gruv__x__otra']
      }
    ])
  )
  assert.deepEqual(sv, [
    { nombre: 'gruv', prefijo: 'mcp__gruv__', estado: 'connected', herramientas: ['listar_tickets'] },
    { nombre: 'gruv__x', prefijo: 'mcp__gruv__x__', estado: 'connected', herramientas: ['otra'] }
  ])
})

test('revisarCuenta tira si no entendió la salida', () => {
  assert.throws(() => revisarCuenta('[]', 5), /No entendí la respuesta de Claude/)
  const r = revisarCuenta(salidaCosmos(), 5)
  assert.equal(r.revisadaEn, 5)
  assert.equal(r.servidores.length, 4)
})

test('el prompt y el schema de revisar son fijos', () => {
  assert.match(buildRevisarPrompt(), /^No llames a ninguna herramienta\./)
  assert.deepEqual((REVISAR_SCHEMA as { required: string[] }).required, ['herramientas'])
})

test('candidatos: exacto, por palabras y nada cuando no está', () => {
  assert.deepEqual(candidatos(GRUV, [srv('claude.ai Atlassian MCP', 'connected'), srv('gruv-tomy', 'pending')]).map((s) => s.nombre), ['gruv-tomy'])
  const personales = [srv('atlassian', 'connected', JIRA.herramientas.lista), srv('plugin:design:atlassian', 'connected'), srv('claude.ai Notion', 'needs-auth')]
  assert.deepEqual(candidatos(JIRA, personales).map((s) => s.nombre), ['atlassian', 'plugin:design:atlassian'])
  assert.deepEqual(candidatos(JIRA, [...personales, srv('claude.ai Atlassian MCP', 'connected')]).map((s) => s.nombre), [
    'claude.ai Atlassian MCP',
    'atlassian',
    'plugin:design:atlassian'
  ])
  assert.deepEqual(candidatos(GRUV, [srv('claude.ai Atlassian MCP', 'connected'), srv('context7', 'pending')]), [])
})

test('candidatos: uno con herramientas conocidas que no tiene las de la lista se descarta', () => {
  assert.deepEqual(candidatos(GRUV, [srv('gruv-tomy', 'connected', ['ver_mi_inicio'])]), [])
  assert.equal(candidatos(GRUV, [srv('gruv-tomy', 'connected', GRUV_TOOLS)]).length, 1)
})

test('disponibilidad en sus cuatro tipos', () => {
  assert.deepEqual(disponibilidad(GRUV, undefined), { tipo: 'sin_revisar' })
  assert.deepEqual(disponibilidad(GRUV, cuenta([srv('context7', 'connected')])), { tipo: 'falta' })
  assert.deepEqual(disponibilidad(GRUV, cuenta([srv('gruv-tomy', 'pending')])), {
    tipo: 'tiene',
    nombre: 'gruv-tomy',
    prefijo: 'mcp__gruv-tomy__',
    estado: 'pending',
    adaptado: true,
    verificado: false
  })
  assert.deepEqual(disponibilidad(GRUV, cuenta([srv('claude.ai Gruv', 'connected', GRUV_TOOLS)])), {
    tipo: 'tiene',
    nombre: 'claude.ai Gruv',
    prefijo: 'mcp__claude_ai_Gruv__',
    estado: 'connected',
    adaptado: false,
    verificado: true
  })
  const dos = cuenta([srv('atlassian', 'connected'), srv('plugin:design:atlassian', 'connected')])
  assert.deepEqual(disponibilidad(JIRA, dos), {
    tipo: 'elegir',
    opciones: [
      { nombre: 'atlassian', prefijo: 'mcp__atlassian__', estado: 'connected' },
      { nombre: 'plugin:design:atlassian', prefijo: 'mcp__plugin_design_atlassian__', estado: 'connected' }
    ]
  })
})

test('disponibilidad: el elegido manda, uno inválido se ignora, y el único verificado gana', () => {
  const dos = cuenta([srv('atlassian', 'connected'), srv('plugin:design:atlassian', 'connected')])
  const elegido = disponibilidad(JIRA, dos, 'mcp__plugin_design_atlassian__')
  assert.equal(elegido.tipo === 'tiene' && elegido.prefijo, 'mcp__plugin_design_atlassian__')
  assert.equal(disponibilidad(JIRA, dos, 'mcp__claude_ai_Gruv__').tipo, 'elegir')
  const uno = cuenta([srv('atlassian', 'connected', JIRA.herramientas.lista), srv('plugin:design:atlassian', 'pending')])
  const d = disponibilidad(JIRA, uno)
  assert.equal(d.tipo === 'tiene' && d.nombre, 'atlassian')
})

test('disponibilidad: con el de claude.ai sin autorizar y gruv-tomy andando, se adapta a gruv-tomy', () => {
  const d = disponibilidad(GRUV, cuenta([srv('claude.ai Gruv', 'needs-auth'), srv('gruv-tomy', 'connected', GRUV_TOOLS)]))
  assert.deepEqual(d, { tipo: 'tiene', nombre: 'gruv-tomy', prefijo: 'mcp__gruv-tomy__', estado: 'connected', adaptado: true, verificado: true })
  const exacto = disponibilidad(GRUV, cuenta([srv('claude.ai Gruv', 'connected', GRUV_TOOLS), srv('gruv-tomy', 'connected', GRUV_TOOLS)]))
  assert.equal(exacto.tipo === 'tiene' && exacto.prefijo, 'mcp__claude_ai_Gruv__')
  const solo = disponibilidad(GRUV, cuenta([srv('claude.ai Gruv', 'needs-auth'), srv('gruv-tomy', 'pending')]))
  assert.equal(solo.tipo === 'tiene' && solo.estado, 'needs-auth')
})

test('disponibilidad: un servidor de otro nombre con todas las herramientas se ofrece, no se adapta solo', () => {
  const c = cuenta([srv('mis-tickets', 'connected', GRUV_TOOLS)])
  assert.deepEqual(porHerramientas(GRUV, c.servidores).map((s) => s.nombre), ['mis-tickets'])
  assert.deepEqual(disponibilidad(GRUV, c), { tipo: 'elegir', opciones: [{ nombre: 'mis-tickets', prefijo: 'mcp__mis-tickets__', estado: 'connected' }] })
  const d = disponibilidad(GRUV, c, 'mcp__mis-tickets__')
  assert.equal(d.tipo === 'tiene' && d.prefijo, 'mcp__mis-tickets__')
  assert.match(mensajeCuenta(GRUV, disponibilidad(GRUV, c), 'Cosmos', []) ?? '', /^«mis-tickets» de la cuenta «Cosmos» tiene las herramientas de Gruv con otro nombre\./)
  assert.deepEqual(porHerramientas(GRUV, [srv('mis-tickets', 'pending')]), [])
  assert.deepEqual(porHerramientas(GRUV, [srv('gruv-tomy', 'connected', GRUV_TOOLS)]), [])
})

test('porHerramientas: con una lista de una sola herramienta no alcanza', () => {
  const uno = { ...GRUV, herramientas: { ...GRUV.herramientas, lista: ['listar_tickets'] } }
  assert.deepEqual(porHerramientas(uno, [srv('mis-tickets', 'connected', GRUV_TOOLS)]), [])
  assert.deepEqual(disponibilidad(uno, cuenta([srv('mis-tickets', 'connected', GRUV_TOOLS)])), { tipo: 'falta' })
})

test('disponibilidad: al parecido le faltan herramientas y el mensaje las nombra', () => {
  const sin = GRUV_TOOLS.filter((t) => t !== 'ver_mi_inicio')
  const d = disponibilidad(GRUV, cuenta([srv('gruv-tomy', 'connected', sin), srv('gruv-viejo', 'connected', ['ver_reloj'])]))
  assert.deepEqual(d, { tipo: 'falta', parecido: { nombre: 'gruv-tomy', faltan: ['ver_mi_inicio'] } })
  assert.equal(
    mensajeCuenta(GRUV, d, 'Cosmos', ['Personal']),
    'La cuenta «Cosmos» tiene «gruv-tomy», pero le faltan herramientas que usa Gruv: ver_mi_inicio. Copiá Gruv como conector propio y ajustá sus herramientas, o agregalas al servidor. Lo tiene: «Personal».'
  )
})

test('revisarTemprano: solo con un init sin servidores pending', () => {
  const init = (servers: unknown[]): string => JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: servers, tools: ['mcp__gruv-tomy__listar_tickets'] })
  assert.deepEqual(revisarTemprano(init([{ name: 'gruv-tomy', status: 'connected' }]), 7), {
    revisadaEn: 7,
    servidores: [{ nombre: 'gruv-tomy', prefijo: 'mcp__gruv-tomy__', estado: 'connected', herramientas: ['listar_tickets'] }]
  })
  assert.equal(revisarTemprano(init([{ name: 'gruv-tomy', status: 'connected' }, { name: 'otro', status: 'pending' }]), 7), undefined)
  assert.equal(revisarTemprano('no es json', 7), undefined)
  assert.equal(revisarTemprano(JSON.stringify({ type: 'assistant' }), 7), undefined)
})

test('revisarCuenta entiende la salida de stream-json, una línea por mensaje', () => {
  const lineas = (JSON.parse(salidaCosmos()) as unknown[]).map((m) => JSON.stringify(m)).join('\n') + '\nbasura\n'
  assert.deepEqual(revisarCuenta(lineas, 5), revisarCuenta(salidaCosmos(), 5))
})

test('usable: solo lo que está y no pide autorización ni falló', () => {
  assert.equal(usable({ tipo: 'falta' }), false)
  assert.equal(usable({ tipo: 'sin_revisar' }), false)
  const tiene = { tipo: 'tiene', nombre: 'x', prefijo: 'mcp__x__', adaptado: true, verificado: false } as const
  assert.equal(usable({ ...tiene, estado: 'pending' }), true)
  assert.equal(usable({ ...tiene, estado: 'needs-auth' }), false)
  assert.equal(usable({ ...tiene, estado: 'failed' }), false)
})

test('conPrefijo cambia solo el prefijo y no toca el original', () => {
  const d = conPrefijo(GRUV, 'mcp__gruv-tomy__')
  assert.equal(d.herramientas.prefijo, 'mcp__gruv-tomy__')
  assert.equal(GRUV.herramientas.prefijo, 'mcp__claude_ai_Gruv__')
  assert.deepEqual({ ...d, herramientas: { ...d.herramientas, prefijo: GRUV.herramientas.prefijo } }, GRUV)
  assert.throws(() => conPrefijo(GRUV, 'mcp__x__ y más'), /prefijo/)
})

test('mensajeCuenta dice qué hacer', () => {
  assert.equal(
    mensajeCuenta(JIRA, { tipo: 'falta' }, 'Personal', []),
    'Conectá Jira en claude.ai con la cuenta «Personal» (claude.ai → Configuración → Conectores) y tocá «Volver a revisar».'
  )
  const propio = { ...GRUV, herramientas: { ...GRUV.herramientas, prefijo: 'mcp__gruv-tomy__' } }
  assert.equal(
    mensajeCuenta(propio, { tipo: 'falta' }, 'Personal', ['Cosmos', 'Otra']),
    'La cuenta «Personal» no tiene el servidor MCP de Gruv. Agregalo en esa cuenta y tocá «Volver a revisar». Lo tiene: «Cosmos», «Otra».'
  )
  const tiene = { tipo: 'tiene', adaptado: false, verificado: true } as const
  assert.equal(
    mensajeCuenta(GRUV, { ...tiene, nombre: 'claude.ai Gruv', prefijo: 'mcp__claude_ai_Gruv__', estado: 'needs-auth' }, 'Cosmos', []),
    'Gruv necesita que lo vuelvas a autorizar en claude.ai con la cuenta «Cosmos».'
  )
  assert.equal(
    mensajeCuenta(GRUV, { ...tiene, nombre: 'gruv-tomy', prefijo: 'mcp__gruv-tomy__', estado: 'needs-auth' }, 'Cosmos', []),
    'Abrí una terminal con la cuenta «Cosmos», corré /mcp y autenticá «gruv-tomy».'
  )
  assert.match(mensajeCuenta(GRUV, { ...tiene, nombre: 'gruv-tomy', prefijo: 'mcp__gruv-tomy__', estado: 'failed' }, 'Cosmos', []) ?? '', /no arrancó/)
  assert.match(mensajeCuenta(GRUV, { ...tiene, nombre: 'gruv-tomy', prefijo: 'mcp__gruv-tomy__', estado: 'pending', verificado: false }, 'Cosmos', []) ?? '', /no respondió a tiempo.*\/mcp/)
  assert.match(mensajeCuenta(JIRA, { tipo: 'elegir', opciones: [] }, 'Personal', []) ?? '', /más de un servidor que puede ser Jira/)
  assert.equal(mensajeCuenta(GRUV, { ...tiene, nombre: 'claude.ai Gruv', prefijo: 'mcp__claude_ai_Gruv__', estado: 'connected' }, 'Cosmos', []), undefined)
})

test('problemaEnSesion: sin el servidor o sin sus herramientas, la lista vacía no es «no hay tickets»', () => {
  const cosmos = servidoresDeSalida(salidaCosmos())
  assert.deepEqual(problemaEnSesion(GRUV, 'mcp__claude_ai_Gruv__', cosmos), { tipo: 'falta' })
  const p = problemaEnSesion(GRUV, 'mcp__gruv-tomy__', cosmos)
  assert.equal(p?.tipo === 'tiene' && p.estado, 'pending')
  assert.equal(problemaEnSesion(GRUV, 'mcp__claude_ai_Gruv__', [srv('claude.ai Gruv', 'connected', GRUV_TOOLS)]), undefined)
  assert.deepEqual(problemaEnSesion(GRUV, 'mcp__claude_ai_Gruv__', [srv('claude.ai Gruv', 'connected', ['ver_reloj'])]), {
    tipo: 'falta',
    parecido: { nombre: 'claude.ai Gruv', faltan: ['buscar_persona', 'listar_tickets', 'ver_flujo_tickets', 'ver_mi_inicio'] }
  })
  assert.equal(problemaEnSesion(GRUV, 'mcp__claude_ai_Gruv__', undefined), undefined)
})

test('sanearCache descarta lo inválido', () => {
  assert.equal(sanearCache('x'), null)
  assert.equal(sanearCache({ version: 2, cuentas: {} }), null)
  const r = sanearCache({
    version: 1,
    cuentas: {
      ok: {
        revisadaEn: 3,
        error: 'falló',
        servidores: [
          { nombre: 'gruv-tomy', prefijo: 'mcp__gruv-tomy__', estado: 'pending' },
          { nombre: 'x', prefijo: 'mcp__x y__', estado: 'connected' },
          { nombre: 'y', prefijo: 'mcp__y__', estado: 'raro' },
          { nombre: 'z'.repeat(129), prefijo: 'mcp__z__', estado: 'connected' },
          { nombre: 'w', prefijo: 'mcp__w__', estado: 'connected', herramientas: ['bien', 'mal;rm', 7] }
        ]
      },
      sinFecha: { servidores: [] },
      basura: 'no'
    }
  })
  assert.deepEqual(r, {
    ok: {
      revisadaEn: 3,
      error: 'falló',
      servidores: [
        { nombre: 'gruv-tomy', prefijo: 'mcp__gruv-tomy__', estado: 'pending' },
        { nombre: 'w', prefijo: 'mcp__w__', estado: 'connected', herramientas: ['bien'] }
      ]
    }
  })
})

test('con la cuenta de Cosmos, la lista pide solo las herramientas del preset con el prefijo de gruv-tomy', () => {
  const d = disponibilidad(GRUV, revisarCuenta(salidaCosmos(), 1))
  assert.ok(d.tipo === 'tiene' && d.adaptado)
  const a = buildListaArgs(conPrefijo(GRUV, d.prefijo), 'haiku')
  const permitidas = a[a.indexOf('--allowedTools') + 1].split(',')
  assert.deepEqual(permitidas, GRUV.herramientas.lista.map((t) => `mcp__gruv-tomy__${t}`))
  assert.ok(a[a.indexOf('--disallowedTools') + 1].split(',').every((t) => t.startsWith('mcp__gruv-tomy__')))
  assert.ok(!a.join(' ').includes('mcp__claude_ai_Gruv__'))
})

test('revisar usa los args de descubrir con su propio schema', () => {
  const a = buildDescubrirArgs(REVISAR_SCHEMA)
  assert.equal(a[a.indexOf('--json-schema') + 1], JSON.stringify(REVISAR_SCHEMA))
  assert.equal(a[a.indexOf('--allowedTools') + 1], '')
})

test('elegibles: lo que se ofrece para elegir se puede guardar, sea por nombre o por herramientas', () => {
  const c = cuenta([srv('mis-tickets', 'connected', GRUV_TOOLS), srv('gruv-tomy', 'pending'), srv('context7', 'connected')])
  const d = disponibilidad(GRUV, cuenta([srv('mis-tickets', 'connected', GRUV_TOOLS)]))
  assert.ok(d.tipo === 'elegir')
  for (const o of d.opciones) assert.ok(elegibles(GRUV, c.servidores).some((s) => s.prefijo === o.prefijo))
  assert.deepEqual(elegibles(GRUV, c.servidores).map((s) => s.nombre), ['gruv-tomy', 'mis-tickets'])
})

test('disponibilidad: con el exacto caído y un servidor de otro nombre andando, se ofrece elegir', () => {
  const c = cuenta([srv('claude.ai Gruv', 'needs-auth'), srv('mis-tickets', 'connected', GRUV_TOOLS)])
  assert.deepEqual(disponibilidad(GRUV, c), {
    tipo: 'elegir',
    opciones: [
      { nombre: 'claude.ai Gruv', prefijo: 'mcp__claude_ai_Gruv__', estado: 'needs-auth' },
      { nombre: 'mis-tickets', prefijo: 'mcp__mis-tickets__', estado: 'connected' }
    ]
  })
  const elegido = disponibilidad(GRUV, c, 'mcp__claude_ai_Gruv__')
  assert.equal(elegido.tipo === 'tiene' && elegido.estado, 'needs-auth')
  const caido = disponibilidad(GRUV, cuenta([srv('claude.ai Gruv', 'needs-auth'), srv('mis-tickets', 'failed', GRUV_TOOLS)]))
  assert.equal(caido.tipo === 'tiene' && caido.prefijo, 'mcp__claude_ai_Gruv__')
})

test('disponibilidad: con el exacto caído y dos del mismo nombre andando, se elige entre los tres', () => {
  const c = cuenta([srv('claude.ai Gruv', 'failed'), srv('gruv-a', 'connected', GRUV_TOOLS), srv('gruv-b', 'connected', GRUV_TOOLS)])
  const d = disponibilidad(GRUV, c)
  assert.deepEqual(d.tipo === 'elegir' && d.opciones.map((o) => o.nombre), ['claude.ai Gruv', 'gruv-a', 'gruv-b'])
})

test('disponibilidad: un parecido sin ninguna herramienta en común no cuenta', () => {
  const d = disponibilidad(GRUV, cuenta([srv('gruv-viejo', 'connected', ['ver_reloj']), srv('plugin:gruv', 'connected', [])]))
  assert.deepEqual(d, { tipo: 'falta' })
})

test('servidorDeLaLista: solo con el mismo servidor con que se leyó la lista', () => {
  const adaptado = conPrefijo(GRUV, 'mcp__mis-tickets__')
  assert.equal(servidorDeLaLista('mcp__mis-tickets__', adaptado), adaptado)
  assert.throws(() => servidorDeLaLista(GRUV.herramientas.prefijo, adaptado), /cambió desde que se leyó la lista\. Actualizá Gruv/)
  assert.throws(() => servidorDeLaLista(undefined, GRUV), /Actualizá Gruv/)
})

test('mensajeCuenta: el pending de claude.ai no habla de servidores propios', () => {
  const base = { tipo: 'tiene' as const, adaptado: false, verificado: false, estado: 'pending' as const }
  const ai = mensajeCuenta(GRUV, { ...base, nombre: 'claude.ai Gruv', prefijo: 'mcp__claude_ai_Gruv__' }, 'Cosmos', []) ?? ''
  assert.doesNotMatch(ai, /\/mcp|tarda en arrancar/)
  const propio = mensajeCuenta(GRUV, { ...base, nombre: 'mis-tickets', prefijo: 'mcp__mis-tickets__' }, 'Cosmos', []) ?? ''
  assert.match(propio, /tarda en arrancar/)
})
