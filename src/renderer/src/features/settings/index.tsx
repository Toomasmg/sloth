import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { GearSix } from '@phosphor-icons/react'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
import { loginPaneId } from '../../../../shared/types'
import { onOpenSettings, openSettings, type SettingsTab } from './bus'
import { getSettings, updateSettings, useSettings } from './store'
import { SettingsModal } from './SettingsModal'
import './settings.css'

/** Engranaje en la barra de título. */
function GearButton(): React.JSX.Element {
  return (
    <button type="button" className="icon-btn f-settings-gear" onClick={() => openSettings()} aria-label="Configuración" title="Configuración (Ctrl+,)">
      <GearSix size={16} aria-hidden="true" />
    </button>
  )
}

/** Texto seguro dentro de un selector de atributo entre comillas. */
const cssStr = (s: string): string => s.replace(/[\\"]/g, '\\$&').replace(/[\n\r\f]/g, ' ')

/**
 * Colores de cuenta elegidos: el núcleo pone --acc en línea; una regla con !important gana.
 * Paneles por data-pane-id; en el sidebar, data-account-id (pedido al núcleo) y mientras tanto
 * los botones de «Quitar …» que ya llevan el nombre en su aria-label.
 */
function AccountColors(): React.JSX.Element | null {
  const ui = useUi()
  const { settings } = useSettings()
  const css = useMemo(() => {
    const rules: string[] = []
    for (const acc of ui.accounts) {
      const color = settings.accountColors[acc.id]
      if (!color) continue
      const sel = [
        `[data-account-id="${cssStr(acc.id)}"]`,
        `[data-pane-id="${cssStr(loginPaneId(acc.id))}"]`,
        `.account:has(button[aria-label="${cssStr(`Quitar cuenta ${acc.label}`)}"])`
      ]
      for (const ws of ui.workspaces) {
        if (ws.accountId !== acc.id) continue
        sel.push(`[data-pane-id="${cssStr(ws.id)}"]`, `.ws-li:has(> button[aria-label="${cssStr(`Quitar espacio ${ws.name}`)}"])`)
      }
      rules.push(`${sel.join(',\n')} { --acc: ${color} !important; }`)
    }
    return rules.join('\n')
  }, [ui.accounts, ui.workspaces, settings.accountColors])
  return css ? <style data-f-settings="account-colors">{css}</style> : null
}

/**
 * «Confirmar al cerrar paneles con agentes trabajando»: intercepta en captura los botones de
 * ocultar y reiniciar del header del panel (antes de que llegue a React).
 */
function useCloseGuard(): void {
  const ui = useUi()
  const ref = useRef(ui)
  ref.current = ui
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      if (!getSettings().settings.confirmClosePanes) return
      const btn = (e.target as Element | null)?.closest?.('button')
      const label = btn?.getAttribute('aria-label')
      if (label !== 'Ocultar panel' && label !== 'Reiniciar terminal') return
      const id = btn!.closest('[data-pane-id]')?.getAttribute('data-pane-id')
      if (!id || ref.current.agents[id]?.state !== 'working') return
      const name = ref.current.workspaces.find((w) => w.id === id)?.name ?? 'Este espacio'
      const msg =
        label === 'Reiniciar terminal'
          ? `«${name}» tiene a Claude trabajando. Reiniciar corta lo que está haciendo.\n\n¿Reiniciar igual?`
          : `«${name}» tiene a Claude trabajando. El panel se oculta y la terminal sigue corriendo.\n\n¿Ocultarlo?`
      if (!window.confirm(msg)) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])
}

function Global(): React.JSX.Element {
  const [tab, setTab] = useState<SettingsTab | null>(null)
  const prevFocus = useRef<HTMLElement | null>(null)
  const openRef = useRef(false)
  openRef.current = tab !== null
  useCloseGuard()

  useEffect(() => onOpenSettings((t) => setTab(t ?? 'apariencia')), [])

  // Ctrl+, en captura: anda aunque la terminal tenga el foco.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.code !== 'Comma') return
      e.preventDefault()
      e.stopPropagation()
      setTab((t) => (t ? null : 'apariencia'))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Al cerrar, el foco vuelve a donde estaba (la terminal, el botón…).
  useLayoutEffect(() => {
    if (tab) {
      if (!prevFocus.current) {
        const a = document.activeElement
        prevFocus.current = a instanceof HTMLElement && a !== document.body ? a : null
      }
    } else {
      const el = prevFocus.current
      prevFocus.current = null
      if (el?.isConnected) el.focus()
    }
  }, [tab])

  return (
    <>
      <AccountColors />
      {tab && <SettingsModal initialTab={tab} onClose={() => setTab(null)} />}
    </>
  )
}

const ui: FeatureUi = {
  name: 'settings',
  Titlebar: GearButton,
  Global,
  commands: () => {
    const dark = getSettings().dark
    return [
      {
        id: 'settings:open',
        title: 'Configuración',
        subtitle: 'Tema, densidad, terminal, colores de cuenta',
        group: 'Sloth',
        keywords: 'settings ajustes preferencias opciones configurar',
        shortcut: 'Ctrl+,',
        run: () => openSettings()
      },
      {
        id: 'settings:theme',
        title: dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro',
        group: 'Sloth',
        keywords: 'tema theme claro oscuro dark light modo',
        run: () => void updateSettings({ theme: dark ? 'claro' : 'oscuro' }).catch(() => {})
      },
      {
        id: 'settings:terminal',
        title: 'Configuración de la terminal',
        subtitle: 'Fuente, tamaño, altura de línea y cursor',
        group: 'Sloth',
        keywords: 'terminal fuente font cursor letra',
        run: () => openSettings('terminal')
      },
      {
        id: 'settings:shortcuts',
        title: 'Atajos de teclado',
        group: 'Sloth',
        keywords: 'atajos teclas shortcuts keyboard',
        run: () => openSettings('atajos')
      }
    ]
  }
}

export default ui
