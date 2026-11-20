import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices, webkit, type ElectronApplication, type Page } from '@playwright/test'
import { test, expect } from './sloth'
import { shellReady } from './terminal'
import { elegirIp } from '../src/main/features/celular-core'
import { prenderCelular } from './celular-celu'

/**
 * Lo que el celu le manda a la entrada de la terminal de la PC, con celus simulados (sin capturas): la sonda corre
 * dentro del PTY real, pide lo mismo que Claude Code (posición del cursor, atributos, color, foco, mouse) y anota
 * byte por byte lo que le llega.
 */
test.use({ seed: { workspaces: [{ id: 'ws-web', name: 'web', open: true }] } })

const ip = elegirIp(networkInterfaces())

const CELUS = [
  { nombre: 'Galaxy S9+', motor: chromium, ficha: devices['Galaxy S9+'] },
  { nombre: 'iPhone 13', motor: webkit, ficha: devices['iPhone 13'] }
]

const SONDA = `
const fs = require('fs')
const log = process.argv[2]
const anotar = (o) => fs.appendFileSync(log, JSON.stringify(o) + '\\n')
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.setEncoding('latin1')
process.stdin.on('data', (d) => {
  anotar({ entra: d })
  if (d === 'q') process.stdout.write('\\x1b[6n' + 'consulta-enviada\\r\\n')
})
process.stdout.on('resize', () => anotar({ tam: [process.stdout.columns, process.stdout.rows] }))
anotar({ tam: [process.stdout.columns, process.stdout.rows] })
process.stdout.write('\\x1b[?1004h\\x1b[?1000h\\x1b[?1006h\\x1b[?2004h')
process.stdout.write('\\x1b[6n\\x1b[c\\x1b[>c\\x1b[?2004$p\\x1b]10;?\\x07\\x1b]11;?\\x1b\\\\')
process.stdout.write('sonda-lista\\r\\n')
`

const AUTOMATICA = /^\x1b\[\d+;\d+R$/

type Entrada = { entra: string }

function leerLog(ruta: string): { entra?: string; tam?: number[] }[] {
  if (!existsSync(ruta)) return []
  return readFileSync(ruta, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { entra?: string; tam?: number[] })
}

/** Prende el celu y corre la sonda en la terminal de la PC. `limpiar` borra lo que dejó en el disco. */
async function iniciarSonda(app: ElectronApplication, page: Page, puerto: number): Promise<{ url: string; log: string; limpiar: () => void }> {
  await shellReady(page)
  const url = await prenderCelular(app, page, ip as string, puerto)
  const carpeta = mkdtempSync(join(tmpdir(), 'sloth-sonda-'))
  const ruta = join(carpeta, 'sonda.cjs')
  const log = join(carpeta, 'entrada.jsonl')
  writeFileSync(ruta, SONDA)
  await page.locator('.terminal-host').first().click()
  await page.keyboard.type(`node '${ruta}' '${log}'`)
  await page.keyboard.press('Enter')
  await expect.poll(() => leerLog(log).length, { timeout: 15_000 }).toBeGreaterThan(0)
  await expect(page.locator('.terminal-host').first()).toContainText('sonda-lista')
  await page.waitForTimeout(1500)
  return { url, log, limpiar: () => rmSync(carpeta, { recursive: true, force: true }) }
}

test('Celular: lo que el celu escribe, toca y enfoca no le llega a la terminal de la PC como si lo tipeara el usuario', async ({ sloth: { app, page } }) => {
  test.skip(!ip, 'Esta PC no tiene una red privada: no hay dónde abrir el servidor.')
  test.setTimeout(240_000)
  const { url, log, limpiar } = await iniciarSonda(app, page, 47393)
  try {
    await probarEntrada(url, log)
  } finally {
    limpiar()
  }
})

async function probarEntrada(url: string, log: string): Promise<void> {
  for (const celu of CELUS) {
    const navegador = await celu.motor.launch()
    try {
      const ctx = await navegador.newContext(celu.ficha)
      const cel = await ctx.newPage()
      await cel.goto(url)
      await expect(cel.getByText('web', { exact: true })).toBeVisible()
      const antes = leerLog(log).length
      await cel.getByRole('button', { name: 'Abrir la terminal de web' }).click()
      const term = cel.getByRole('dialog', { name: 'web' })
      await expect(term.locator('.xterm-rows')).toContainText('sonda-lista', { timeout: 15_000 })
      await cel.waitForTimeout(1500)
      // Toques en la pantalla de la terminal (foco y mouse de xterm), el foco que se va (el teclado se cierra) y vuelve, y recién ahí se escribe.
      await term.locator('.xterm-screen').click()
      await term.locator('.xterm-screen').click({ position: { x: 40, y: 30 } })
      await cel.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await term.locator('.xterm-screen').click()
      await cel.keyboard.type('q')
      await expect.poll(() => leerLog(log).slice(antes).some((x) => x.entra === 'q'), { timeout: 10_000 }).toBe(true)
      await expect(term.locator('.xterm-rows')).toContainText('consulta-enviada')
      await cel.waitForTimeout(2000)
      await term.getByRole('button', { name: 'Volver a las sesiones' }).click()
      await cel.waitForTimeout(1000)

      const ventana = leerLog(log)
        .slice(antes)
        .filter((x): x is Entrada => x.entra !== undefined)
        .map((x) => x.entra)
      test.info().annotations.push({ type: `entrada en la PC (${celu.nombre})`, description: JSON.stringify(ventana) })
      // La PC contesta la consulta de posición una vez (su propio xterm); el celu no suma nada más que lo tecleado.
      const ver = (l: string[]): string[] => l.map((x) => x.replace(/\x1b/g, '<ESC>').replace(/\r/g, '<CR>'))
      const raras = ver(ventana.filter((x) => x !== 'q' && x !== '\r' && !AUTOMATICA.test(x)))
      expect(raras, `bytes que el celu (${celu.nombre}) metió en la entrada de la PC; todo lo que llegó: ${JSON.stringify(ver(ventana))}`).toEqual([])
      expect(ventana.filter((x) => AUTOMATICA.test(x)).length, `respuestas de posición que llegaron (${celu.nombre})`).toBeLessThanOrEqual(1)
      await ctx.close()
    } finally {
      await navegador.close()
    }
  }
}

// Eventos de composición como los de Gboard (predicción) y los de iOS (tecla muerta). Los arma el test sobre el textarea de xterm:
// no es un teclado real, pero ejercita el camino de composición de xterm y de la página sin duplicar ni perder caracteres.
const componer = ([pasos, final]: [string[], string]): void => {
  const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
  const base = ta.value
  const tecla = (tipo: string): void => void ta.dispatchEvent(new KeyboardEvent(tipo, { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true } as KeyboardEventInit))
  tecla('keydown')
  ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
  for (const p of pasos) {
    ta.value = base + p
    ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', data: p, isComposing: true, bubbles: true, cancelable: true }))
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: p, bubbles: true }))
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: p, isComposing: true, bubbles: true }))
  }
  ta.value = base + final
  ta.dispatchEvent(new CompositionEvent('compositionend', { data: final, bubbles: true }))
  tecla('keyup')
}

test('Celular: lo que llega por composición (predicción, acentos, teclas muertas) se escribe una vez y en orden', async ({ sloth: { app, page } }) => {
  test.skip(!ip, 'Esta PC no tiene una red privada: no hay dónde abrir el servidor.')
  test.setTimeout(240_000)
  const { url, log, limpiar } = await iniciarSonda(app, page, 47395)
  try {
    for (const celu of CELUS) {
      const navegador = await celu.motor.launch()
      try {
        const ctx = await navegador.newContext(celu.ficha)
        const cel = await ctx.newPage()
        await cel.goto(url)
        await expect(cel.getByText('web', { exact: true })).toBeVisible()
        const antes = leerLog(log).length
        await cel.getByRole('button', { name: 'Abrir la terminal de web' }).click()
        const term = cel.getByRole('dialog', { name: 'web' })
        await expect(term.locator('.xterm-rows')).toContainText('sonda-lista', { timeout: 15_000 })
        await term.locator('.xterm-screen').click()
        await cel.evaluate(componer, [['h', 'ho', 'hol', 'hola'], 'hola'])
        await cel.waitForTimeout(300)
        await cel.evaluate(componer, [['`', 'é'], 'é'])
        await cel.waitForTimeout(300)
        await cel.evaluate(componer, [['n', 'ñ'], 'ñ'])
        await cel.waitForTimeout(300)
        await cel.keyboard.press('Enter')
        await expect.poll(() => leerLog(log).slice(antes).some((x) => x.entra === '\r'), { timeout: 10_000 }).toBe(true)
        await cel.waitForTimeout(500)
        const llego = leerLog(log)
          .slice(antes)
          .filter((x): x is Entrada => x.entra !== undefined)
          .map((x) => x.entra)
          .filter((x) => !AUTOMATICA.test(x))
          .join('')
        const esperado = Buffer.from('holaéñ', 'utf8').toString('latin1') + '\r'
        expect(JSON.stringify(llego), `lo que llegó a la PC desde ${celu.nombre} (bytes en latin1)`).toBe(JSON.stringify(esperado))
        await ctx.close()
      } finally {
        await navegador.close()
      }
    }
  } finally {
    limpiar()
  }
})
