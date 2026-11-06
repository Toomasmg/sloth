import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { GearSix } from '@phosphor-icons/react'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
import { onOpenSettings, openSettings, type SettingsTab } from './bus'
import { getSettings, updateSettings } from './store'
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

/**
 * «Confirmar al cerrar paneles con agentes trabajando»: guarda del núcleo (UiCtx.onBeforeClosePane),
 * se consulta antes de ocultar o reiniciar desde el header o la pestaña.
 */
function useCloseGuard(): void {
  const ui = useUi()
  const ref = useRef(ui)
  ref.current = ui
  const { onBeforeClosePane } = ui
  useEffect(
    () =>
      onBeforeClosePane((id, action) => {
        if (!getSettings().settings.confirmClosePanes) return true
        if (ref.current.agents[id]?.state !== 'working') return true
        const name = ref.current.workspaces.find((w) => w.id === id)?.name ?? 'Este espacio'
        return window.confirm(
          action === 'restart'
            ? `«${name}» tiene a Claude trabajando. Reiniciar corta lo que está haciendo.\n\n¿Reiniciar igual?`
            : `«${name}» tiene a Claude trabajando. El panel se oculta y la terminal sigue corriendo.\n\n¿Ocultarlo?`
        )
      }),
    [onBeforeClosePane]
  )
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
