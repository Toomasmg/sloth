import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './sloth'
import { shellReady, termText } from './terminal'

/**
 * Pegar y soltar en la terminal: además de texto, las rutas de archivos copiados (un .zip, una foto)
 * y una imagen copiada, que se guarda como PNG para que Claude Code la adjunte.
 * El portapapeles se carga con PowerShell, igual que lo deja el Explorador de Windows.
 * Ojo: estas pruebas pisan el portapapeles de la PC.
 */
const ps = (script: string): void => {
  execFileSync('powershell.exe', ['-NoProfile', '-Sta', '-Command', `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ${script}`])
}
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
