import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SettingsIcon } from '../../icons/SlothIcons'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
import { bindingOf, matchShortcut, isCapturingShortcut } from '../../shortcuts'
import { UpdateDot } from '../updater'
import { onOpenSettings, openSettings, type SettingsTab } from './bus'
import { getSettings } from './store'
import { SettingsModal } from './SettingsModal'
import './settings-page.css'

/** «Ctrl Shift K» → «Ctrl+Shift+K» para mostrar. */
const showCombo = (c: string): string => c.split(' ').join('+')

/** Engranaje en la barra de título. Lleva el punto de «versión pendiente» (updater). */
function GearButton(): React.JSX.Element {
  const label = showCombo(bindingOf('settings'))
  return (
    <button type="button" className="icon-btn f-settings-gear" onClick={() => openSettings()} aria-label="Configuración" title={`Configuración (${label})`}>
      <SettingsIcon size={16} />
      <UpdateDot />
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
  useCloseGuard()

  useEffect(() => onOpenSettings((t) => setTab(t ?? 'apariencia')), [])

  // El atajo de Configuración (por defecto Ctrl+,) en captura: anda aunque la terminal tenga el foco.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isCapturingShortcut() || !matchShortcut('settings', e)) return
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

  return <>{tab && <SettingsModal initialTab={tab} onClose={() => setTab(null)} />}</>
}

const ui: FeatureUi = {
  name: 'settings',
  Titlebar: GearButton,
  Global,
  commands: () => [
    {
      id: 'settings:open',
      title: 'Configuración',
      subtitle: 'Tema, cuentas, terminal, atajos y notificaciones',
      group: 'Sloth',
      keywords: 'settings ajustes preferencias opciones configurar',
      shortcut: showCombo(bindingOf('settings')),
      run: () => openSettings()
    },
    {
      id: 'settings:theme',
      title: 'Cambiar el tema',
      subtitle: 'Oscuro, más oscuro o según Windows',
      group: 'Sloth',
      keywords: 'tema theme claro oscuro dark light modo',
      run: () => openSettings('apariencia')
    },
    {
      id: 'settings:terminal',
      title: 'Configuración de la terminal',
      subtitle: 'Fuente, tamaño, cursor y shell',
      group: 'Sloth',
      keywords: 'terminal fuente font cursor letra shell',
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

export default ui
