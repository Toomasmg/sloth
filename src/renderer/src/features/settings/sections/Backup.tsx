import { request as requestExportImport } from '../../export-import/bus'
import { Group, SectionHint } from '../ui'
import { goAfterClose, ToggleLikeButton } from './comunes'
/* ---------- Copia de seguridad ---------- */

export function BackupSection({ onClose }: { onClose(): void }): React.JSX.Element {
  return (
    <>
      <Group id="g-bk" title="Exportar e importar">
        <ToggleLikeButton
          title="Exportar configuración…"
          hint="Un archivo .sloth con espacios, plantillas, apariencia, atajos y reglas de permisos. Sirve para pasarla a otra PC o guardarla."
          onClick={goAfterClose(onClose, () => requestExportImport({ kind: 'export' }))}
        />
        <ToggleLikeButton
          title="Importar configuración…"
          hint="Desde un archivo .sloth de otra PC. Antes te muestra qué va a agregar, y las reglas de permisos una por una."
          onClick={goAfterClose(onClose, () => requestExportImport({ kind: 'import' }))}
        />
      </Group>
      <SectionHint>
        Se lleva: espacios, plantillas, apariencia, atajos y reglas de permisos. Las sesiones de Claude nunca se exportan: en la otra PC vas a iniciar sesión de nuevo, y las credenciales de las cuentas tampoco viajan.
      </SectionHint>
    </>
  )
}
