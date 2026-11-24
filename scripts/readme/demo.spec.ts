import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchSloth, closeSloth } from '../../e2e/sloth'

/**
 * Graba la demo del README: Sloth de verdad (el build de `out/`) con datos de ejemplo.
 * Nada de Claude corre de verdad: el estado, el permiso y el texto de las terminales se le mandan a la UI
 * por los mismos canales que usa main. Lo corre `npm run readme:demo`, nunca la CI.
 */

// Cuadros sueltos; `scripts/readme/gif.mjs` los arma en el GIF.
const DIR = 'test-results/readme-cuadros'
const ESC = '\x1b'
const gris = (s: string): string => `${ESC}[90m${s}${ESC}[0m`
const naranja = (s: string): string => `${ESC}[38;5;209m${s}${ESC}[0m`
const verde = (s: string): string => `${ESC}[32m${s}${ESC}[0m`
const negrita = (s: string): string => `${ESC}[1m${s}${ESC}[0m`

const seq = new Map<string, number>()

async function escribir(app: ElectronApplication, id: string, texto: string): Promise<void> {
  const n = (seq.get(id) ?? 1_000_000) + 1
  seq.set(id, n)
  await app.evaluate(({ BrowserWindow }, a) => BrowserWindow.getAllWindows()[0]!.webContents.send('pty:data', a.id, [{ seq: a.n, data: a.texto }]), { id, n, texto })
}

/** Escribe de a líneas, como un agente que va contando lo que hace. */
async function contar(app: ElectronApplication, page: Page, id: string, lineas: string[], pausa = 260): Promise<void> {
  for (const l of lineas) {
    await escribir(app, id, l + '\r\n')
    await page.waitForTimeout(pausa)
  }
}

async function estado(app: ElectronApplication, id: string, state: string, detail?: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, a) => BrowserWindow.getAllWindows()[0]!.webContents.send('agent:status', a.id, { state: a.state, detail: a.detail, at: Date.now() }), { id, state, detail })
}

function cabecera(pedido: string): string {
  return `${ESC}[2J${ESC}[3J${ESC}[H` + naranja('✻ ') + negrita('Claude Code') + gris('  ·  /help para ayuda') + '\r\n\r\n' + gris('> ') + pedido + '\r\n\r\n'
}

test('demo del README', async () => {
  test.setTimeout(120_000)
  const { app, page, userData } = await launchSloth({
    settings: { theme: 'oscuro' },
    accountLabel: 'Personal',
    extraAccounts: ['Trabajo'],
    workspaces: [
      { id: 'ws-web', name: 'web', open: true, branch: 'feat/checkout' },
      { id: 'ws-api', name: 'api-pagos', open: true, ticket: 'TCK-212', accountId: 'acc-extra-0' },
      { id: 'ws-docs', name: 'docs', open: true },
      { id: 'ws-infra', name: 'infra', accountId: 'acc-extra-0' }
    ]
  })
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  // Screencast de Chromium: recordVideo de Playwright no deja que la ventana llegue a ready-to-show.
  const cdp = await page.context().newCDPSession(page)
  const cuadros: { archivo: string; t: number }[] = []
  cdp.on('Page.screencastFrame', (f) => {
    const archivo = `${String(cuadros.length).padStart(5, '0')}.jpg`
    writeFileSync(join(DIR, archivo), Buffer.from(f.data, 'base64'))
    cuadros.push({ archivo, t: f.metadata.timestamp ?? Date.now() / 1000 })
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined)
  })
  try {
    await expect(page.locator('.xterm')).toHaveCount(3)
    // Las PowerShell reales imprimen la ruta de la PC y repintan su pantalla al cambiar de tamaño, encima
    // del texto de ejemplo: se cierran antes de grabar y el texto de cada panel lo pone la demo.
    await page.waitForTimeout(2000)
    await page.evaluate(() => Promise.all(['ws-web', 'ws-api', 'ws-docs'].map((id) => window.sloth.ptyKill(id))))
    // Las cuentas de ejemplo no tienen sesión: el aviso no aporta a la demo.
    await page.addStyleTag({ content: '.sl-acc-warn { display: none !important; }' })
    await page.waitForTimeout(1500)
    await escribir(app, 'ws-web', cabecera('Arreglá el botón Pagar que queda deshabilitado al volver atrás'))
    await escribir(app, 'ws-api', cabecera('/ticket TCK-212'))
    await escribir(app, 'ws-docs', cabecera('Resumí los cambios de esta semana para el changelog'))
    await estado(app, 'ws-web', 'working')
    await estado(app, 'ws-api', 'working')
    await estado(app, 'ws-docs', 'working')
    // Se graba recién acá: antes, los paneles muestran la terminal cerrada y la ruta de la PC.
    await page.waitForTimeout(400)
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1280, maxHeight: 800 })
    await page.waitForTimeout(900)

    await contar(app, page, 'ws-web', [naranja('● ') + 'Leyendo ' + negrita('src/checkout/PayButton.tsx'), naranja('● ') + 'Buscando dónde se guarda el estado del formulario…'])
    await contar(app, page, 'ws-api', [naranja('● ') + 'Leyendo el ticket TCK-212', naranja('● ') + 'El webhook no reintenta cuando Mercado Pago devuelve 502'])
    await contar(app, page, 'ws-docs', [naranja('● ') + 'git log --since="1 week ago"', gris('  ⎿ 23 commits')])
    await contar(app, page, 'ws-web', [naranja('● ') + 'Editando ' + negrita('PayButton.tsx'), verde('  + ') + gris("useEffect(() => setDisabled(!form.valid), [form.valid])")])
    await contar(app, page, 'ws-docs', [naranja('● ') + 'Escribiendo ' + negrita('CHANGELOG.md')])
    await contar(app, page, 'ws-api', [naranja('● ') + 'Agregando reintentos con espera creciente', naranja('● ') + 'Quiero correr los tests de pagos'])

    // api-pagos pide permiso: la tarjeta aparece en la app, sin ir a buscar la terminal.
    await estado(app, 'ws-api', 'waiting', 'Bash')
    const ahora = Date.now()
    await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0]!.webContents.send('permission:new', p), {
      id: 'perm-demo',
      workspaceId: 'ws-api',
      tool: 'Bash',
      input: { command: 'npm test -- webhooks' },
      at: ahora,
      expiresAt: ahora + 120_000
    })
    await contar(app, page, 'ws-web', [naranja('● ') + 'Corriendo los tests de checkout', verde('  ✓ 14 tests pasaron')], 400)
    await page.waitForTimeout(2200)

    // Se aprueba desde la tarjeta. No hay un pedido real atrás: la respuesta no llega a ningún Claude.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('permission:resolved', 'perm-demo'))
    await estado(app, 'ws-api', 'working')
    await contar(app, page, 'ws-api', [naranja('● ') + 'npm test -- webhooks', verde('  ✓ 9 tests pasaron')], 350)

    await escribir(app, 'ws-web', '\r\n' + verde('✓ ') + 'Listo: el botón se rehabilita al volver al formulario.\r\n')
    await estado(app, 'ws-web', 'done')
    await page.waitForTimeout(500)
    await escribir(app, 'ws-docs', '\r\n' + verde('✓ ') + 'CHANGELOG.md actualizado con 6 entradas.\r\n')
    await estado(app, 'ws-docs', 'done')
    await page.waitForTimeout(1500)

    // La paleta: todo a un Ctrl+K.
    await page.getByRole('combobox', { name: 'Buscar espacio, acción o persona' }).click()
    await page.waitForTimeout(500)
    await page.keyboard.type('nuevo esp', { delay: 90 })
    await page.waitForTimeout(1300)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1500)
    await cdp.send('Page.stopScreencast')
    writeFileSync(join(DIR, 'cuadros.json'), JSON.stringify(cuadros))
  } finally {
    await closeSloth(app, userData)
  }
})
