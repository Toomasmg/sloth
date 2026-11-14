import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './sloth'
import { hasSelection, recordInput, recorded, selectAll, shellReady, termText } from './terminal'

/**
 * Pegar y soltar en la terminal: además de texto, las rutas de archivos copiados (un .zip, una foto)
 * y una imagen copiada, que se guarda como PNG para que Claude Code la adjunte.
 * El portapapeles se carga con PowerShell, igual que lo deja el Explorador de Windows.
 * Ojo: estas pruebas pisan el portapapeles de la PC.
 */
const ps = (script: string): void => {
  execFileSync('powershell.exe', ['-NoProfile', '-Sta', '-Command', `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ${script}`])
}
const clipboardText = (): string =>
  execFileSync('powershell.exe', ['-NoProfile', '-Sta', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::GetText()'], { encoding: 'utf8' })
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`

async function pasteInTerminal(page: Page): Promise<void> {
  await page.locator('.terminal-host').click()
  await page.keyboard.press('Control+V')
}

test.describe('pegar en la terminal', () => {
  test.skip(process.platform !== 'win32', 'El portapapeles se carga con PowerShell')
  test.use({ seed: { workspaces: [{ id: 'ws-pegar', name: 'web', open: true }] } })

  let dir = ''
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sloth-pegar-'))
  })
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('Ctrl+V pega el texto una sola vez', async ({ sloth: { page } }) => {
    await shellReady(page)
    ps(`[Windows.Forms.Clipboard]::SetText('texto-pegado-123')`)
    await pasteInTerminal(page)
    await expect.poll(() => termText(page)).toContain('texto-pegado-123')
    await page.waitForTimeout(500)
    expect((await termText(page)).split('texto-pegado-123').length - 1).toBe(1)
  })

  test('en la pantalla alternativa (como Claude Code) Ctrl+V pega una vez y no manda ^V', async ({ sloth: { page } }) => {
    await shellReady(page)
    // Pasa a la pantalla alternativa y se queda leyendo, como hace Claude Code al dibujar su interfaz.
    await page.keyboard.type("[Console]::Write([char]27 + '[?1049h'); $null = Read-Host")
    await page.keyboard.press('Enter')
    ps(`[Windows.Forms.Clipboard]::SetText('alt-pegado-456')`)
    await page.locator('.terminal-host').click()
    await recordInput(page)
    await page.keyboard.press('Control+V')
    await expect.poll(async () => (await recorded(page)).sent.some((s) => s.data.includes('alt-pegado-456'))).toBe(true)
    await page.waitForTimeout(500)
    const rec = await recorded(page)
    expect(rec.sent.filter((s) => s.data.includes('alt-pegado-456'))).toHaveLength(1)
    expect(rec.sent.some((s) => s.data.includes('\x16'))).toBe(false)
    expect((rec.sent.find((s) => s.data.includes('alt-pegado-456'))?.at ?? Infinity) - rec.keyAt).toBeLessThan(300)
  })

  test('Ctrl+V manda 2.000 caracteres a la shell en menos de 300 ms', async ({ sloth: { page } }) => {
    await shellReady(page)
    ps(`[Windows.Forms.Clipboard]::SetText('${'x'.repeat(1990)}FIN-PEGADO')`)
    await page.locator('.terminal-host').click()
    await recordInput(page)
    await page.keyboard.press('Control+V')
    await expect.poll(async () => (await recorded(page)).sent.some((s) => s.data.includes('FIN-PEGADO'))).toBe(true)
    const rec = await recorded(page)
    const sent = rec.sent.find((s) => s.data.includes('FIN-PEGADO'))
    // Se mide de la tecla a los bytes que salen hacia la shell: lo que tarda la shell en dibujarlos no es de Sloth.
    expect((sent?.at ?? Infinity) - rec.keyAt).toBeLessThan(300)
    expect(rec.sent.filter((s) => s.data.includes('FIN-PEGADO'))).toHaveLength(1)
  })

  test('Ctrl+C con texto seleccionado lo copia, limpia la selección y no interrumpe', async ({ sloth: { page } }) => {
    await shellReady(page)
    ps(`[Windows.Forms.Clipboard]::SetText('sin-copiar')`)
    await page.locator('.terminal-host').click()
    await selectAll(page)
    await recordInput(page)
    await page.keyboard.press('Control+C')
    await expect.poll(clipboardText).toContain('shell-lista')
    expect(await hasSelection(page)).toBe(false)
    expect((await recorded(page)).sent.map((s) => s.data).join('')).not.toContain('\x03')
  })

  test('Ctrl+Shift+C copia la selección', async ({ sloth: { page } }) => {
    await shellReady(page)
    ps(`[Windows.Forms.Clipboard]::SetText('sin-copiar')`)
    await page.locator('.terminal-host').click()
    await selectAll(page)
    await page.keyboard.press('Control+Shift+C')
    await expect.poll(clipboardText).toContain('shell-lista')
  })

  test('Ctrl+C sin selección le manda ^C a la terminal', async ({ sloth: { page } }) => {
    await shellReady(page)
    await page.locator('.terminal-host').click()
    await recordInput(page)
    await page.keyboard.press('Control+C')
    await expect.poll(async () => (await recorded(page)).sent.map((s) => s.data).join('')).toContain('\x03')
  })

  test('archivos copiados en el Explorador pegan sus rutas, entre comillas si tienen espacios', async ({ sloth: { page } }) => {
    const zip = join(dir, 'proyecto.zip')
    const foto = join(dir, 'mi foto.png')
    writeFileSync(zip, 'zip')
    writeFileSync(foto, 'png')
    await shellReady(page)
    ps(
      `$c = New-Object System.Collections.Specialized.StringCollection; [void]$c.Add(${psQuote(zip)}); [void]$c.Add(${psQuote(foto)}); [Windows.Forms.Clipboard]::SetFileDropList($c)`
    )
    await pasteInTerminal(page)
    // La línea larga puede partirse en el ancho de la terminal: se compara sin saltos.
    await expect.poll(async () => (await termText(page)).replace(/\n/g, '')).toContain(`${zip} "${foto}"`)
  })

  test('una imagen copiada se guarda como PNG y se pega su ruta', async ({ sloth: { page } }) => {
    await shellReady(page)
    ps(`$b = New-Object System.Drawing.Bitmap 40,30; [Windows.Forms.Clipboard]::SetImage($b)`)
    await pasteInTerminal(page)
    let pasted = ''
    await expect
      .poll(async () => {
        pasted = /\S*pegados\\imagen-\S+\.png/.exec((await termText(page)).replace(/\n/g, ''))?.[0] ?? ''
        return pasted
      })
      .not.toBe('')
    expect(existsSync(pasted.replace(/^"/, ''))).toBe(true)
  })

  test('una captura de 1920×1080 se pega una sola vez y en menos de 800 ms', async ({ sloth: { page } }) => {
    await shellReady(page)
    // Una captura de verdad de la pantalla (no un lienzo vacío, que se comprime en nada).
    ps(
      `$b = New-Object System.Drawing.Bitmap 1920,1080; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(0, 0, 0, 0, $b.Size); [Windows.Forms.Clipboard]::SetImage($b)`
    )
    await page.locator('.terminal-host').click()
    await recordInput(page)
    await page.keyboard.press('Control+V')
    const isImage = (d: string): boolean => /pegados\\imagen-\S+\.png/.test(d)
    await expect.poll(async () => (await recorded(page)).sent.some((s) => isImage(s.data)), { timeout: 10_000 }).toBe(true)
    const rec = await recorded(page)
    const sent = rec.sent.filter((s) => isImage(s.data))
    expect(sent).toHaveLength(1)
    const ms = sent[0].at - rec.keyAt
    test.info().annotations.push({ type: 'latencia', description: `${Math.round(ms)} ms` })
    expect(ms).toBeLessThan(800)
    const file = /[A-Za-z]:\\\S+?\.png/.exec(sent[0].data)?.[0] ?? ''
    const png = readFileSync(file)
    // Cabecera IHDR: ancho y alto en los bytes 16 a 23.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1920, 1080])
  })
})

test.describe('soltar sobre la terminal', () => {
  test.use({ seed: { workspaces: [{ id: 'ws-soltar', name: 'web', open: true }] } })

  test('no ofrece crear un espacio y marca la terminal', async ({ sloth: { page } }) => {
    await expect(page.locator('.terminal-host')).toHaveCount(1)
    const files = await page.evaluateHandle(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['x'], 'proyecto.zip', { type: 'application/zip' }))
      return dt
    })
    const host = page.locator('.terminal-host')
    await host.dispatchEvent('dragenter', { dataTransfer: files })
    await host.dispatchEvent('dragover', { dataTransfer: files })
    await expect(host).toHaveClass(/drop-on/)
    await expect(page.locator('.folder-drop')).toHaveCount(0)
    await host.dispatchEvent('drop', { dataTransfer: files })
    await expect(host).not.toHaveClass(/drop-on/)
    // No abre el diálogo de espacio nuevo ni muestra el aviso de «soltá una carpeta».
    await expect(page.getByText('Para crear un espacio soltá una carpeta')).toHaveCount(0)
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(0)
  })
})
