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
    title: 'Estilo nuevo, paneles y chat del equipo',
    items: [
      'Estilo Minimal, más denso y limpio, con tema claro. Se elige en Configuración.',
      'Configuración (Ctrl+,): apariencia, terminal, colores de cuenta, comportamiento y atajos.',
      'Paneles en grilla o en pestañas (Ctrl+Tab): reordenalos arrastrando el encabezado o con Ctrl+Alt+flechas, y cambiales el tamaño arrastrando los separadores.',
      'Bienvenida nueva para arrancar, y configuración de equipo compartida en el repo (.sloth/team.json).',
      'Vista Equipo: en qué anda cada uno, con sus PR y tickets.',
      'Chat del equipo con mensajes directos, fotos de equipo e invitaciones. Usa un Supabase propio del equipo: hay que configurarlo antes (Configuración → Equipo y datos).',
      'Ayuda (?): atajos, novedades e invitar a alguien a Sloth.',
      'Reportá un problema desde la ayuda: el borrador sale sin datos personales y lo revisás antes de enviarlo.',
      'Renombrá un espacio con doble clic, ponele un ícono, abrilo en VS Code o en su carpeta, o soltá una carpeta en la ventana para crear uno.',
      'Mové un espacio a otra cuenta: la conversación se copia y Claude la retoma.',
      'Sonidos opcionales para los avisos (vienen apagados).',
      'Se sacó la rotación automática de cuentas: ahora elegís vos a qué cuenta mover cada espacio.'
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
