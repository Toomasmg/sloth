import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices, webkit } from '@playwright/test'
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

test('Celular: lo que el celu escribe, toca y enfoca no le llega a la terminal de la PC como si lo tipeara el usuario', async ({ sloth: { app, page } }) => {
  test.skip(!ip, 'Esta PC no tiene una red privada: no hay dónde abrir el servidor.')
  test.setTimeout(240_000)
  await shellReady(page)
  const url = await prenderCelular(app, page, ip as string, 47393)

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
})
