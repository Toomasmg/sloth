import { app, dialog, Menu, nativeImage, Tray, type BrowserWindow, type NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import type { TerminalBackend } from '../daemon-client'
import { readTraySettings, writeTraySettings, type TraySettings } from './tray-settings'
import { amberDot } from './tray-dot'

/**
 * Bandeja del sistema + badge en la barra de tareas.
 * Sin timers: todo se recalcula al llegar un hook, un permiso, una salida de terminal o al enfocar.
 */

let tray: Tray | null = null
let quitting = false

function appIcon(): NativeImage | null {
  const p = [join(process.resourcesPath, 'icon.png'), join(__dirname, '../../build/icon.png')].find((x) => existsSync(x))
  if (!p) return null
  const base = nativeImage.createFromPath(p)
  if (base.isEmpty()) return null
  const img = nativeImage.createEmpty()
  img.addRepresentation({ scaleFactor: 1, buffer: base.resize({ width: 16, height: 16, quality: 'best' }).toPNG() })
  img.addRepresentation({ scaleFactor: 2, buffer: base.resize({ width: 32, height: 32, quality: 'best' }).toPNG() })
  return img
}

const plural = (n: number, uno: string, varios: string): string => `${n} ${n === 1 ? uno : varios}`

const feature: Feature = {
  name: 'tray',
  register(ctx: FeatureContext) {
    let settings: TraySettings = readTraySettings()
    const attached = new WeakSet<TerminalBackend>()
    let needing = new Set<string>()
    let working = 0
    let lastSig = ''

    const show = (): void => {
      const win = ctx.window()
      if (!win) return
      if (!win.isVisible()) win.show()
      if (win.isMinimized()) win.restore()
      win.focus()
    }

    const quitAll = async (): Promise<void> => {
      const b = ctx.terminal()
      const running = b ? (await b.list().catch(() => [])).filter((s) => s.running).length : 0
      const win = ctx.window()
      const opts = {
        type: 'warning' as const,
        title: 'Sloth',
        message: 'Apagar todas las terminales y salir',
        detail: running
          ? `Se van a cerrar ${plural(running, 'terminal', 'terminales')} (y el Claude que corre en cada una). Lo que no esté guardado se pierde.`
          : 'No hay terminales corriendo. Sloth se cierra.',
        buttons: ['Apagar y salir', 'Cancelar'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      }
      const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      if (r.response !== 0) return
      try {
        if (b) await Promise.race([b.shutdown(), new Promise((res) => setTimeout(res, 5000))])
      } catch (e) {
        ctx.log('no se pudo apagar el daemon:', (e as Error).message)
      }
      quitting = true
      app.quit()
    }

    const quit = (): void => {
      quitting = true
      app.quit()
    }

    function buildMenu(): Menu {
      const first = [...needing][0]
      return Menu.buildFromTemplate([
        { label: 'Mostrar Sloth', click: show },
        ...(needing.size
          ? [
              {
                label: `${needing.size} ${needing.size === 1 ? 'espacio te necesita' : 'espacios te necesitan'}`,
                click: () => {
                  show()
                  if (first) ctx.ui({ type: 'open-pane', id: first })
                }
              }
            ]
          : []),
        { type: 'separator' },
        { label: 'Apagar todas las terminales y salir…', click: () => void quitAll() },
        { label: 'Salir (las terminales siguen corriendo)', click: quit }
      ])
    }

    function attach(b: TerminalBackend | undefined): void {
      if (!b || attached.has(b)) return
      attached.add(b)
      b.on('permission', () => setImmediate(refresh))
      b.on('permission-resolved', () => setImmediate(refresh))
    }

    /** Recalcula contadores; solo toca tray/badge si algo cambió. */
    function refresh(): void {
      const b = ctx.terminal()
      attach(b)
      const exists = (id: string): boolean => Boolean(ctx.store.workspace(id))
      const next = new Set<string>()
      let w = 0
      for (const [id, st] of ctx.agents()) {
        if (!exists(id)) continue
        if (st.state === 'working') w++
        else if (st.state === 'waiting') next.add(id)
      }
      for (const p of b?.pendingPermissions() ?? []) if (exists(p.ws)) next.add(p.ws)

      const win = ctx.window()
      const fresh = [...next].some((id) => !needing.has(id))
      if (fresh && win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true)
      needing = next
      working = w

      const sig = `${working}|${[...needing].sort().join(',')}`
      if (sig === lastSig) return
      lastSig = sig
      if (tray && !tray.isDestroyed()) {
        tray.setToolTip(`Sloth · ${working} trabajando · ${needing.size} te necesitan`)
        tray.setContextMenu(buildMenu())
      }
      if (win && !win.isDestroyed()) {
        win.setOverlayIcon(needing.size ? amberDot() : null, needing.size ? `${needing.size} espacios te necesitan` : '')
      }
    }

    const icon = appIcon()
    if (icon) {
      try {
        tray = new Tray(icon)
        tray.setToolTip('Sloth · 0 trabajando · 0 te necesitan')
        tray.setContextMenu(buildMenu())
        tray.on('click', show)
      } catch (e) {
        ctx.log('no se pudo crear el ícono de la bandeja:', (e as Error).message)
      }
    } else ctx.log('no se encontró icon.png: sin ícono en la bandeja')

    ctx.onHook(() => setImmediate(refresh))
    ctx.onPtyExit(() => setImmediate(refresh))
    void ctx.backend().then((b) => {
      attach(b)
      refresh()
    }, () => {})

    app.on('before-quit', () => {
      quitting = true
    })
    // Con la ventana oculta en la bandeja, abrir Sloth otra vez la muestra.
    app.on('second-instance', show)

    ctx.onWindow((win: BrowserWindow) => {
      lastSig = ''
      win.on('focus', () => {
        win.flashFrame(false)
        refresh()
      })
      win.on('close', (e) => {
        if (quitting || !settings.closeToTray || !tray || tray.isDestroyed()) return
        e.preventDefault()
        win.hide()
      })
      win.webContents.once('did-finish-load', refresh)
    })

    ctx.handle('get', () => ({ ...settings }))
    ctx.handle('set', (patch: unknown) => {
      if (!patch || typeof patch !== 'object') throw new Error('Configuración inválida.')
      const v = (patch as Record<string, unknown>).closeToTray
      if (typeof v !== 'boolean') throw new Error('closeToTray tiene que ser true o false.')
      settings = { ...settings, closeToTray: v }
      writeTraySettings(settings)
      return { ...settings }
    })
  },
  dispose() {
    quitting = true
    tray?.destroy()
    tray = null
  }
}

export default feature
