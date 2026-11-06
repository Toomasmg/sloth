/** Novedades de cada versión. Del más nuevo al más viejo. Lo usan «help» (main y UI) y el logo. */
export interface ChangelogEntry {
  version: string
  /** AAAA-MM-DD */
  date: string
  title: string
  items: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.5.0',
    date: '2026-11-06',
    title: 'Paneles, estilo nuevo y tema claro',
    items: [
      'Paneles en grilla o en pestañas (Ctrl+Tab). Reordenalos arrastrando el encabezado o con Ctrl+Alt+←/→.',
      'Redimensioná los paneles arrastrando los separadores.',
      'Estilo nuevo, más denso, con tema claro. Lo cambiás en Configuración.',
      'Configuración con Ctrl+, : apariencia, terminal, colores de cuenta y atajos.',
      'Chat del equipo (en configuración).',
      'Ícono por espacio, y renombrar con doble clic.',
      'Soltá una carpeta en la ventana para crear un espacio.',
      'Abrí un espacio en VS Code o en su carpeta desde el encabezado.',
      'Sonidos opcionales para avisos (desactivados por defecto).',
      'Reportá un problema desde el menú de ayuda (?), sin datos personales.'
    ]
  },
  {
    version: '0.4.0',
    date: '2026-11-06',
    title: 'Rotación, historial y paleta de comandos',
    items: [
      'Rotá de cuenta cuando se acaba el límite de una.',
      'Buscador del historial de conversaciones (Ctrl+Shift+F).',
      'Diff y PR desde el espacio.',
      'Limpieza de worktrees que ya no se usan.',
      'Paleta de comandos con Ctrl+K.',
      'Enviá un mensaje a varios espacios a la vez (Ctrl+Shift+B).',
      'Plantillas de mensajes.',
      'Tablero de Gruv.',
      'Bandeja del sistema y actualizaciones automáticas.',
      'Exportar e importar la configuración.'
    ]
  }
]
