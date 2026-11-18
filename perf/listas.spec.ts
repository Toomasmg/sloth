import { mkdirSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, type Seed } from '../e2e/sloth'
import { armar, cobrar, contar, mutacionesEnReposo, scrollear, type Fila } from './medir'

const CHAT_N = [200, 2000, 10000]
const TABLERO_N = [50, 500, 2000]
const REPOSO_MS = 5000

const seed: Seed = { settings: { noMolestar: true, sounds: false } }
const filas: Fila[] = []
const CV = process.env.PERF_CV === '1'
const sufijo = CV ? '-cv' : ''
const CV_CSS = '.f-chat-scroll > ul > li, .f-tickets-rows > li { content-visibility: auto; contain-intrinsic-size: auto 70px }'

async function estilos(page: Page): Promise<void> {
  if (CV) await page.addStyleTag({ content: CV_CSS })
}

const riel = (page: Page, destino: string) => page.locator(`.sl-rail [data-nav="${destino}"]`)

function rng(semilla: number): () => number {
  let s = semilla
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

const LOGINS = ['tomas', 'ana', 'pablo', 'lu', 'mati', 'sofi', 'nico', 'vale']
const FRASES = [
  'Listo, lo subo ahora.',
  'Dale, miralo cuando puedas y me decís.',
  'Ojo que el webhook de pagos devuelve 502 cuando Mercado Pago se cae; hay que reintentar con backoff y no duplicar el cobro.',
  '@tomas ¿podés revisar el PR #214? Cambié la cola de mails y quiero que alguien más lo mire antes de mergear.',
  'https://github.com/acme/api/pull/214',
  'Ya está en staging',
  '```ts\nconst r = await fetch(url)\nif (!r.ok) throw new Error(r.statusText)\n```',
  'Che, ¿viste el error de ayer? Resulta que era el timeout del balanceador, no la base. Lo tuve que reproducir tres veces para darme cuenta y al final era una configuración vieja que nadie se acordaba.',
  'jaja buenísimo',
  'Mañana hago el deploy.'
]
const EMOJIS = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🙏', '👀']

function mensajes(n: number): unknown[] {
  const rnd = rng(n)
  const inicio = Date.now() - n * 90_000
  const perfiles = LOGINS.map((login, i) => ({ id: `u${i}`, login }))
  return Array.from({ length: n }, (_, i) => {
    const author = perfiles[Math.floor(rnd() * perfiles.length)]
    const reactions = rnd() < 0.15 ? [{ emoji: EMOJIS[Math.floor(rnd() * EMOJIS.length)], userIds: ['u1', 'u2'], logins: ['ana', 'pablo'] }] : undefined
    return {
      id: `m${String(i).padStart(6, '0')}`,
      clientId: `c${i}`,
      conv: { kind: 'team', id: 't1' },
      author,
      body: FRASES[Math.floor(rnd() * FRASES.length)],
      createdAt: inicio + i * 90_000,
      status: 'sent',
      reactions
    }
  })
}

async function emitir(app: ElectronApplication, canal: string, payloads: unknown[]): Promise<void> {
  for (let i = 0; i < payloads.length; i += 500) {
    await app.evaluate(
      ({ BrowserWindow }, [c, lote]) => {
        const wc = BrowserWindow.getAllWindows()[0].webContents
        for (const p of lote as unknown[]) wc.send(c as string, p)
      },
      [canal, payloads.slice(i, i + 500)] as const
    )
  }
}

function escribirReporte(): void {
  mkdirSync('perf', { recursive: true })
  const maquina = { cpu: cpus()[0]?.model ?? '?', nucleos: cpus().length, ramGB: Math.round(totalmem() / 2 ** 30), so: `${platform()} ${release()} ${arch()}`, fecha: new Date().toISOString() }
  writeFileSync(join('perf', `reporte${sufijo}.json`), JSON.stringify({ maquina, filas }, null, 2))
  const t = (caso: string): string =>
    filas
      .filter((f) => f.caso === caso)
      .map(
        (f) =>
          `| ${f.n} | ${f.nodosItem} | ${f.nodosTotal} | ${f.primerRenderMs} | ${f.scroll.ms} | ${f.scroll.frameMean} | ${f.scroll.frameP95} | ${f.scroll.lafCount} (${f.scroll.lafTotalMs} ms) | ${f.mutacionesPorSeg} | ${f.rerenderMs ?? f.desdeAvisoMs ?? '-'} |`
      )
      .join('\n')
  const cab =
    '| N | nodos de ítem | nodos totales | primer render (ms) | scroll (ms) | frame medio (ms) | frame p95 (ms) | LoAF | mutaciones/s en reposo | chat: re-render, tablero: desde el aviso (ms) |\n|---|---|---|---|---|---|---|---|---|---|'
  writeFileSync(
    join('perf', `reporte${sufijo}.md`),
    `# Reporte de perf\n\n${maquina.cpu} (${maquina.nucleos} núcleos), ${maquina.ramGB} GB, ${maquina.so}, ${maquina.fecha}\n\n## Chat (mensajes)\n\n${cab}\n${t('chat')}\n\n## Tablero (tarjetas)\n\n${cab}\n${t('tablero')}\n`
  )
  process.stdout.write(`reporte: perf/reporte${sufijo}.md y perf/reporte${sufijo}.json\n`)
}

test.describe.configure({ mode: 'serial' })
test.use({ seed })
test.afterAll(escribirReporte)

for (const n of CHAT_N) {
  test(`chat ${n} mensajes`, async ({ sloth: { app, page } }) => {
    await estilos(page)
    const snapshot = {
      auth: { status: 'signedIn', me: { id: 'u0', login: 'tomas' } },
      connection: 'live',
      teams: [{ id: 't1', name: 'Equipo de prueba', description: '', role: 'owner', memberCount: 8, unread: 0, retentionHours: 720 }],
      threads: [],
      invites: [],
      unreadTotal: 0,
      extras: true,
      dmClearForMe: true,
      listsLoaded: true
    }
    await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('feat:chat:snapshot', s), snapshot)
    await emitir(app, 'feat:chat:message', mensajes(n))
    await armar(page, '.f-chat-scroll [data-mid]')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('feat:chat:open', { kind: 'team', id: 't1' }))
    const primerRenderMs = await cobrar(page)
    const c = await contar(page, '.f-chat-scroll', '.f-chat-scroll [data-mid]')

    const muestras: number[] = []
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => new Promise((r) => setTimeout(r, 150)))
      await armar(page, 'body')
      await app.evaluate(({ BrowserWindow }, k) => BrowserWindow.getAllWindows()[0].webContents.send('feat:chat:typing', k), {
        conv: { kind: 'team', id: 't1' },
        userId: `u${i + 1}`,
        login: `escribe${i}`
      })
      muestras.push(await cobrar(page))
    }
    muestras.sort((a, b) => a - b)

    const scroll = await scrollear(page, '.f-chat-scroll')
    const mutacionesPorSeg = await mutacionesEnReposo(page, REPOSO_MS)
    filas.push({ caso: 'chat', n, nodosItem: c.item, nodosTotal: c.total, primerRenderMs, scroll, mutacionesPorSeg, rerenderMs: muestras[2] })
  })
}

for (const n of TABLERO_N) {
  test(`tablero ${n} tarjetas`, async ({ sloth: { app, page } }) => {
    await estilos(page)
    await riel(page, 'tickets').click()
    type Estado = { conectores?: { id?: string; nombre?: string }[]; conector?: Record<string, unknown>; config?: Record<string, unknown> }
    const s = (await page.evaluate(() => window.sloth.feat.invoke('feat:tickets:state'))) as Estado
    const c = s.conectores?.[0]
    const estados = [
      { clave: 'todo', nombre: 'Por hacer', categoria: 'pendiente' },
      { clave: 'doing', nombre: 'En curso', categoria: 'curso' },
      { clave: 'review', nombre: 'En revisión', categoria: 'revision' },
      { clave: 'done', nombre: 'Hecho', categoria: 'hecho' }
    ]
    const rnd = rng(n)
    const prio = ['Crítica', 'Alta', 'Media', 'Baja']
    const proyectos = ['api-pagos', 'web', 'infra', 'admin']
    const tickets = Array.from({ length: n }, (_, i) => ({
      id: `TCK-${1000 + i}`,
      titulo: `${FRASES[Math.floor(rnd() * FRASES.length)].slice(0, 90)} (${i})`,
      estado: estados[Math.floor(rnd() * estados.length)].clave,
      prioridad: prio[Math.floor(rnd() * prio.length)],
      proyecto: proyectos[Math.floor(rnd() * proyectos.length)],
      responsable: 'Tomás',
      responsableId: 'u1'
    }))
    const fake = {
      ...s,
      conector: { ...s.conector, id: c?.id ?? 'github', nombre: c?.nombre ?? 'GitHub Issues', disponible: true, verificado: true, estados, acciones: s.conector?.acciones ?? [] },
      config: { ...s.config, conectorId: c?.id ?? 'github' },
      estados,
      me: { id: 'u1', nombre: 'Tomás' },
      fetchedAt: Date.now(),
      running: false,
      tickets
    }
    await page.evaluate((total) => {
      const w = window as unknown as { __aviso?: number }
      window.sloth.feat.on('feat:tickets:changed', (snap) => {
        if (w.__aviso === undefined && (snap as { tickets?: unknown[] } | undefined)?.tickets?.length === total) w.__aviso = performance.now()
      })
    }, n)
    await armar(page, '.f-tickets-row')
    await app.evaluate(({ BrowserWindow }, snap) => BrowserWindow.getAllWindows()[0].webContents.send('feat:tickets:changed', snap), fake)
    const primerRenderMs = await cobrar(page)
    const desdeAvisoMs = await page.evaluate((ms) => {
      const w = window as unknown as { __aviso: number; __t0: number }
      return Math.round((w.__t0 + ms - w.__aviso) * 10) / 10
    }, primerRenderMs)
    await page.evaluate(() => {
      let el = document.querySelector('.f-tickets-rows')?.parentElement ?? null
      while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement
      el?.setAttribute('data-perf-scroll', '1')
    })
    const sc = '[data-perf-scroll]'
    const k = await contar(page, sc, '.f-tickets-row')
    const scroll = await scrollear(page, sc)
    const mutacionesPorSeg = await mutacionesEnReposo(page, REPOSO_MS)
    filas.push({ caso: 'tablero', n, nodosItem: k.item, nodosTotal: k.total, primerRenderMs, scroll, mutacionesPorSeg, desdeAvisoMs })
  })
}
