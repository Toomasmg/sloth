import { LogoMark } from '../Logo'
import { comboLabel } from '../shortcuts'
import { runFeatureCommand } from '../features/palette'
import type { UiCtx } from '../features/host'
import { openReport } from '../features/report/bus'
import { request as requestExportImport } from '../features/export-import/bus'
import { openHelp } from '../features/help/bus'
import { openSettings } from '../features/settings/bus'
import { ActionMenu, type ActionMenuItem } from './ActionMenu'

/**
 * Menú de la app: el logo + «Sloth» con un chevron. Lo global (ayuda, novedades, actualizaciones,
 * copia de seguridad, configuración) vive acá; lo de cada espacio, en el «más» de su panel.
 * Todo sale de los mismos buses y comandos que la paleta: no hay lógica duplicada.
 */
export function AppMenu({ ctx }: { ctx: UiCtx }): React.JSX.Element {
  const items: ActionMenuItem[] = [
    { id: 'ayuda', label: 'Ayuda y atajos', hint: comboLabel('help'), onSelect: () => openHelp('ayuda') },
    { id: 'novedades', label: 'Novedades', onSelect: () => openHelp('whatsnew') },
    { id: 'asistente', label: 'Asistente de bienvenida', onSelect: () => runFeatureCommand('onboarding:open', ctx) },
    { id: 'invitar', label: 'Invitar a un compañero', onSelect: () => openHelp('invite') },
    { id: 'actualizar', label: 'Buscar actualizaciones', onSelect: () => runFeatureCommand('updater:check', ctx) },
    { id: 'reportar', label: 'Reportar un problema', onSelect: () => openReport() },
    { id: 'exportar', label: 'Exportar configuración…', onSelect: () => requestExportImport({ kind: 'export' }) },
    { id: 'importar', label: 'Importar configuración…', onSelect: () => requestExportImport({ kind: 'import' }) },
    { id: 'config', label: 'Configuración', hint: comboLabel('settings'), sepBefore: true, onSelect: () => openSettings() },
    { id: 'acerca', label: 'Acerca de Sloth', onSelect: () => openSettings('about') }
  ]
  return (
    <ActionMenu
      label="Menú de Sloth"
      items={items}
      triggerClassName="sl-top-brand"
      wrapClassName="app-menu-wrap"
      menuClassName="pane-menu app-menu"
      trigger={
        <>
          <LogoMark size={34} />
          <span className="sl-top-name">Sloth</span>
          <svg className="sl-top-chev" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </>
      }
    />
  )
}
