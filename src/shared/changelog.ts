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
    version: '0.6.7',
    date: '2026-11-11',
    title: 'Conectores de tickets propios',
    items: [
      'Armá tu propio conector de tickets con un asistente de cuatro pasos, o editá uno que ya tengas.',
      'En los ajustes del tablero de Tickets están tus conectores propios: importalos, exportalos o borralos.',
      'Los conectores del equipo viven en .sloth/conectores.json del repo y el team.json puede traerlos. Antes de usar uno del equipo lo aceptás, después de ver qué herramientas toca.',
      'Un conector propio solo lee tickets con herramientas de lectura. Al revisarlo ves qué herramientas usa en cada acción, y si no valida queda apartado sin romper los demás.'
    ]
  },
  {
    version: '0.6.6',
    date: '2026-11-11',
    title: 'Zoom con Ctrl y +',
    items: [
      'Ctrl y + vuelve a agrandar la ventana también con el teclado en español y con el numérico. Ctrl y - la achica y Ctrl y 0 la deja al 100 %.'
    ]
  },
  {
    version: '0.6.5',
    date: '2026-11-11',
    title: 'Tickets de cualquier servicio, y fotos y archivos en la terminal',
    items: [
      'Tickets: además de Gruv, conectá GitHub Issues, Jira, Linear, Asana, Notion, ClickUp, monday.com, Azure DevOps, GitLab, Shortcut o YouTrack, y elegí conector, cuenta y modelo desde el tablero.',
      'Pegá con Ctrl+V archivos copiados en el Explorador (un .zip, fotos, carpetas) o una captura de pantalla: se pegan sus rutas y Claude adjunta las imágenes. También podés arrastrarlos sobre la terminal.',
      'Los recuadros de Claude se ven sin cortes: la altura de línea de la terminal vuelve a 1, como en Windows Terminal.',
      'El cursor ya no salta por la pantalla mientras Claude escribe.',
      'Dormir espacios inactivos (Configuración › General): libera memoria y los despertás con un clic, con la conversación como estaba.',
      'Al cerrar con la X, Sloth pregunta si cerrar o seguir en la bandeja.',
      'Los menús se despliegan hacia abajo desde su botón.'
    ]
  },
  {
    version: '0.6.4',
    date: '2026-11-11',
    title: 'Un solo lugar para escribir',
    items: [
      'Cada panel tiene un solo campo para escribirle a Claude: el de Claude Code, con comandos con «/», varias líneas, autocompletado e imágenes. Se sacó el campo de abajo, que lo repetía.'
    ]
  },
  {
    version: '0.6.3',
    date: '2026-11-08',
    title: 'Ruta clickeable y arreglos en los paneles',
    items: [
      'La ruta «cuenta › espacio» de arriba de los paneles se puede tocar: elegí otro espacio y te lleva ahí.',
      'Vuelve «Limpiar ramas que ya no se usan» a la barra lateral, con la cantidad de ramas para limpiar.',
      'El botón «Cambios» del encabezado de cada panel ya no se encima con el número de archivos.',
      'El menú «más» de cada panel se ve completo, sin textos encimados.',
      'Todo a la vista: menú de Sloth en el logo (ayuda, novedades, actualizaciones, reportar, exportar e importar), sección «Herramientas» en la barra lateral y más opciones en el menú «más» de cada panel.',
      'Configuración: nueva sección «Copia de seguridad» para exportar e importar.',
      'La barra lateral se agranda o achica arrastrando su borde.',
      'Nueva distribución «Tres»: tres paneles a la vista (Ctrl+Alt+3).'
    ]
  },
  {
    version: '0.6.2',
    date: '2026-11-08',
    title: 'Todo lo del diseño, funcionando',
    items: [
      'Tickets de Gruv: cambiá el estado, tomá o soltá el ticket, tildá criterios, comentá y cargá horas desde Sloth. Cada acción se hace solo cuando la tocás.',
      'Ramas aparte: tamaño en disco de cada una, cuánto libera la limpieza y página propia.',
      'Historial: «Borrar» manda la conversación a la Papelera de Windows (se puede recuperar).',
      'Atajos nuevos: F1 ayuda, Ctrl+1 a Ctrl+4 para ir a cada panel y Ctrl+Shift+Enter para enviar a todos.',
      '«Probar conexión» del chat prueba de verdad, y al importar ves la apariencia que trae el archivo.',
      'Reportar un problema: botón «Ver en GitHub» al terminar.'
    ]
  },
  {
    version: '0.6.1',
    date: '2026-11-08',
    title: 'Igual al diseño',
    items: [
      'Toda la app ajustada al diseño: barra superior limpia con el buscador centrado, barra lateral por cuenta y área vacía nueva.',
      'Las opciones de cada cuenta (usar mi setup, iniciar sesión, quitar, uso) pasaron a Configuración › Cuentas.',
      'Git queda acoplado a la derecha y la terminal sigue a la vista.',
      'Bienvenida, Nuevo espacio, Plantillas, Ramas aparte, Historial, Tickets, Permisos, Enviar a varios, Actualizaciones, Ayuda, Reportar y Exportar con las medidas, textos y colores del diseño.',
      'Colores ajustados en oscuro y en claro.'
    ]
  },
  {
    version: '0.6.0',
    date: '2026-11-08',
    title: 'Rediseño completo estilo Mac',
    items: [
      'Diseño nuevo: paleta oscura del logo del perezoso, letra Inter, íconos propios y modo claro. Elegí el color de acento en Configuración.',
      'El buscador de arriba es la paleta de comandos (Ctrl+K): espacios, acciones y equipo, con Tab para las acciones de cada espacio.',
      'Barra lateral dividida por cuenta, con plan, color por espacio y filtro. Distribución Uno, Dos o Cuatro paneles.',
      'Pedidos de permiso a pantalla completa, reglas «Permitir siempre» por espacio y avisos de Windows con No molestar.',
      'Git integrado: preparar archivos, ver diferencias, confirmar, abrir PR, historial y ramas.',
      'Nuevo espacio rediseñado, plantillas, ramas aparte, historial de sesiones, tickets de Gruv y enviar a varios espacios con cola.',
      'Configuración nueva: atajos editables, terminal (fuente, cursor, shell), editor preferido, reabrir espacios y más.',
      'Exportar e importar la configuración con contraseña. Las reglas de permiso importadas se revisan una por una.',
      'Modo liviano para PCs con pocos recursos (Configuración › Apariencia).',
      'Mover un espacio a otra cuenta sigue copiando la conversación: Claude continúa donde estaba.'
    ]
  },
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
