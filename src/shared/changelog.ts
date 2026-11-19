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
    version: '0.7.4',
    date: '2026-11-19',
    title: 'La terminal del celu, ahora sí',
    items: ['En la 0.7.3, la terminal no cargaba en el celu con Sloth instalado. Ya anda.']
  },
  {
    version: '0.7.3',
    date: '2026-11-19',
    title: 'La terminal en el celu',
    items: [
      'Desde el celu ya podés abrir la terminal de cada espacio: ves lo que pasa en vivo y le escribís como si estuvieras en la PC. Prendelo en Celular › «Abrir las terminales desde el celu» (viene apagado) y tocá el botón >_ de la sesión.',
      'Tiene teclas rápidas (Esc, Tab, flechas, Ctrl C y Enter) y un campo para escribir cómodo con el teclado del celu.',
      'Se ve con el tamaño de la PC; con «Ajustar al celu» la terminal se acomoda a la pantalla del teléfono y, al volver, recupera el tamaño de la PC.',
      'Anda solo en el Wi-Fi de casa y va cifrado con la clave del QR. Quien tenga el QR puede correr comandos en tu PC: prendelo solo en una red de confianza.'
    ]
  },
  {
    version: '0.7.2',
    date: '2026-11-18',
    title: 'Gruv por personas, sin esperar a todo el equipo',
    items: [
      'Tickets y Equipo: «Actualizar» con Gruv ya no se cuelga con equipos grandes. Sloth trae siempre tus tickets y los de las personas que elijas, en vez de los de todo el equipo, y tarda unos 20 a 40 segundos en lugar de no terminar.',
      'Nuevo filtro en Tickets: elegí a quién ver (la lista de personas la trae Gruv), qué estados mostrar (En curso, Revisión y QA, Terminado, o todos) y cuántos días hacia atrás para lo terminado (4 por defecto). Lo tuyo y lo abierto de las personas que elijas se muestran siempre, aunque sea viejo.',
      'En Equipo, las personas que elegiste tienen su tarjeta con sus tickets, y «Traer de Gruv» trae lo tuyo más lo de ellas.',
      'El detalle de un ticket de Gruv vuelve a mostrar la descripción (Ocurrió, Esperado y Pasos).',
      'Si el servidor de Gruv todavía está arrancando, Sloth reintenta en vez de pedirte que lo autentiques, y los mensajes de error dicen qué pasó de verdad.'
    ]
  },
  {
    version: '0.7.1',
    date: '2026-11-18',
    title: 'Links que abren, Rendimiento y deslizar entre paneles',
    items: [
      'Los links de la terminal se abren en el navegador con un clic: los que arma Claude Code y también las direcciones escritas como texto.',
      'Nuevo en Configuración → Rendimiento: elegí cuánta RAM y cuántos núcleos pueden usar las terminales y lo que corre en ellas (Claude, npm, tests). En una notebook podés poner otros límites para cuando está a batería, y Sloth cambia solo al enchufarla o desenchufarla. Si las terminales llegan al tope de RAM, el programa que pide más se puede cerrar: dejá margen.',
      'Con un panel a la vista, deslizá dos dedos de costado en el touchpad para pasar al panel de al lado. Cambiar por pestaña o con Ctrl+Tab también se ve con una animación corta.',
      'Más liviano por dentro: el chat y el tablero de tickets gastan menos con listas largas.'
    ]
  },
  {
    version: '0.7.0',
    date: '2026-11-18',
    title: 'Perfiles, más agentes y el celu cifrado',
    items: [
      'Perfiles: separá tu trabajo (por ejemplo Trabajo y Personal) y cada perfil tiene sus espacios, tickets, chat y ajustes. Se manejan desde Configuración → Perfiles y, con dos o más, desde la barra de arriba. Cambiar de perfil reinicia Sloth. La primera vez que abrís esta versión, Sloth copia tus datos a «Mi perfil» y deja un respaldo; tu carpeta de antes queda intacta.',
      'Codex: si lo tenés instalado, al agregar una cuenta podés elegir el agente. Probá con cuidado, es nuevo: el medidor de límites y el aviso «terminó» son experimentales y vienen apagados, y los tickets con Codex son solo de consulta.',
      'Copilot: se puede agregar una cuenta de GitHub Copilot. Comparte el login del sistema (Sloth no guarda ninguna credencial), por eso hay una sola, y en Windows hace falta PowerShell 7.',
      'Celular por Wi-Fi: ahora va cifrado. Escaneá el QR de nuevo en cada celu que ya tenías emparejado.',
      'Nuevo en Ctrl+K: «Copiar diagnóstico», con versiones y errores recientes sin claves ni rutas tuyas. Si Sloth se cerró mal la vez anterior, te avisa al abrir.',
      'Tickets: cada consulta tiene un tope de vueltas y de costo estimado, y si se corta podés continuar con más vueltas. En Ajustes ves cuánto usaste.',
      'Teclado: F6 y Shift+F6 saltan entre la barra, el riel, la lateral y los paneles, y Tab vuelve a salir de la paleta.',
      'Más prolijo por dentro: el modelo de dictado se baja la primera vez que lo usás y el instalador pesa menos, git cancelado ya no deja procesos colgados, tus archivos de datos llevan versión y se respaldan antes de migrar, y Sloth pasa a Electron 45.3.',
      'Si algo de esto no anda como esperabas, copiá el diagnóstico y mandalo.'
    ]
  },
  {
    version: '0.6.28',
    date: '2026-11-17',
    title: 'Más seguro por dentro',
    items: [
      'Al actualizar, las terminales abiertas se cierran una sola vez: Sloth y su servicio de terminales ahora se verifican entre sí antes de hablar.',
      'El aviso de Windows solo ofrece «Permitir» cuando el comando es corto y se ve entero; si no, lo revisás en Sloth.',
      'Celular: el tema de ntfy tiene que ser largo (botón «Generar otro»), y podés usar tu propio servidor ntfy con token.',
      '«Claude en el chat» no ofrece «leer siempre» en cuentas que corren sin pedir permisos.',
      'Las imágenes pegadas se borran a las 24 horas, y el settings.json de cada cuenta se respalda antes de que Sloth lo toque.',
      'Chat: «Vaciar para mí» en un mensaje directo borra solo tu lado. Los códigos de invitación vencen a los 7 días o a los 50 usos, y quien sale del equipo deja de ver el chat al instante. Hace falta aplicar la migración 0008.'
    ]
  },
  {
    version: '0.6.27',
    date: '2026-11-17',
    title: 'Más seguro con repos ajenos',
    items: [
      'El primer mensaje de un espacio llega entero en PowerShell, cmd y Git Bash, con comillas, acentos o «/ticket», y no hay forma de que ejecute comandos.',
      'Los scripts de tu repo (por ejemplo .bat o gradlew) vuelven a correr normal en la terminal.',
      '«Permitir siempre ediciones en este repo» ya no sigue accesos directos que apunten afuera del repo.',
      'Sloth ya no ejecuta nada que venga en la configuración de git de un repo ajeno al mostrar cambios o el historial.',
      'Chat: sacar a alguien del equipo cambia el código en el mismo paso (hace falta aplicar la migración 0007). Si usás un servidor propio, se avisa y se pide confirmar al aceptar invitaciones.',
      'Celular: el panel avisa que por Wi-Fi la conexión no va cifrada.'
    ]
  },
  {
    version: '0.6.26',
    date: '2026-11-17',
    title: 'Más seguro con repos ajenos y sin perder tu configuración',
    items: [
      'Abrir un espacio sobre un repo que no es tuyo ya no puede ejecutar comandos en tu PC: ni por el prompt inicial, ni por la configuración de git del repo, ni por un claude.cmd en la carpeta.',
      '«Permitir siempre ediciones» ahora vale solo dentro del repo del espacio. Fuera de él, o en .git y .claude, Sloth vuelve a preguntar.',
      'Si un archivo de configuración se daña, Sloth lo guarda aparte y te avisa en vez de pisarlo. Si el archivo de estado trae una cuenta o un espacio roto, Sloth abre igual.',
      'Chat: sacar a alguien del equipo cambia el código de invitación, y te avisa si una invitación apunta a un servidor que no es de Supabase.',
      'El estado de cada espacio ya no queda en «listo» cuando la terminal se cerró.'
    ]
  },
  {
    version: '0.6.25',
    date: '2026-11-16',
    title: 'El QR del celu remoto',
    items: [
      'Celular: al prender «Verlo también fuera de tu Wi-Fi» el panel ya no se cae; el código QR ahora entra aunque el enlace sea largo.',
      'Si un código no se puede dibujar, el panel avisa y te deja copiar el enlace.'
    ]
  },
  {
    version: '0.6.24',
    date: '2026-11-16',
    title: 'El celu desde cualquier red',
    items: [
      'Celular: además del Wi-Fi de casa, ahora lo podés ver desde cualquier red. Prendé «Verlo también fuera de tu Wi-Fi» en el panel del celular, escaneá el QR y entrá con GitHub.',
      'Lo que viaja va cifrado con una clave que solo tienen tu PC y tu celu: nunca sale lo que pasa en la terminal ni tus prompts.',
      'En Android (Samsung o Chrome) la página se instala como app, con el ícono de Sloth y a pantalla completa.',
      '«Regenerar código» deja afuera de verdad a los celus de antes.'
    ]
  },
  {
    version: '0.6.23',
    date: '2026-11-16',
    title: 'Claude en el chat',
    items: [
      'Nuevo: Claude puede leer y mandar mensajes del chat desde tus terminales. Se prende en Configuración → Chat → «Claude en el chat» y elegís en qué cuentas de Claude.',
      'Cada mensaje que quiera mandar Claude te muestra el texto exacto y espera tu confirmación. Sale con tu nombre y la marca «vía Claude».',
      'Leer el chat también pide permiso por conversación, y lo podés revocar cuando quieras.'
    ]
  },
  {
    version: '0.6.22',
    date: '2026-11-16',
    title: '«Te necesita» solo cuando de verdad',
    items: [
      'Si Claude termina el turno con un shell corriendo en segundo plano (por ejemplo, una verificación), el espacio sigue en «trabajando · Shell en segundo plano» y no te avisa «terminó» ni «te necesita», ni en Windows ni en el celu. El aviso llega cuando termina el shell.',
      'Los pedidos de permiso y las preguntas de Claude te siguen llegando aunque haya un shell corriendo.'
    ]
  },
  {
    version: '0.6.21',
    date: '2026-11-16',
    title: 'Acciones del chat a mano',
    items: [
      'Chat: las acciones de un mensaje (reaccionar, responder, más) aparecen solo al hacer clic en él, pegadas a la burbuja y de a una. Al tocar otro mensaje, pasan a ese. Esc las cierra sin cerrar el chat.',
      'El aviso de actualización ya no flota sobre el chat ni el micrófono: se muestra en la píldora de versión de arriba.'
    ]
  },
  {
    version: '0.6.20',
    date: '2026-11-16',
    title: 'El celu sin la barra del navegador',
    items: [
      'Celular: en Android, tocá la página una vez y se ve en pantalla completa, sin la dirección ni las pestañas. Si salís, el botón de arriba la vuelve a poner.',
      'Celular: en iPhone, agregala a la pantalla de inicio (Compartir → «Agregar a inicio») y abrila desde ese ícono para verla sin la barra.'
    ]
  },
  {
    version: '0.6.19',
    date: '2026-11-16',
    title: 'Sloth en el celu',
    items: [
      'Nuevo: «Ver Sloth en el celular» (Ctrl+K). Escaneás un QR y en el celu ves cómo van tus sesiones, cuánto te queda del límite de 5 horas y del semanal de cada cuenta, y lo que llevás usado hoy. Acostado es un tablero; parado, la lista completa.',
      'Anda con el celu en el mismo Wi-Fi que la PC y está apagado hasta que lo prendas. «Regenerar código» deja afuera a los celus de antes.',
      'Opcional: aprobar o rechazar permisos desde el celu, y avisos con el celu bloqueado por ntfy. Los dos arrancan apagados.',
      'Los relojes de límite se llenan cuando Claude responde en cada cuenta. Para leer ese dato, Sloth envuelve tu statusline: lo que ves abajo de Claude no cambia.'
    ]
  },
  {
    version: '0.6.18',
    date: '2026-11-16',
    title: 'Panel de PRs y chat completo',
    items: [
      'Panel de PRs (Ctrl+Shift+6): tus PRs y los de tu equipo, con checks, revisiones y conflictos. Desde ahí abrís el PR, abrís una terminal en su rama, hacés rebase o mergeás con confirmación.',
      'Chat: editá y borrá tus mensajes, respondé citando, reaccioná con emojis, mencioná con @, buscá en el historial y mirá quién está escribiendo.',
      'Chat: la conversación que abriste queda abierta hasta que tocás la flecha de volver, y podés empezar a escribir sin hacer clic en el cuadro.',
      'Chat: cada equipo puede activar el borrado automático de mensajes (de 24 horas a 90 días) y vaciar una conversación. Hace falta aplicar la migración 0004 en Supabase.'
    ]
  },
  {
    version: '0.6.17',
    date: '2026-11-16',
    title: 'Más fluido y tickets más rápidos',
    items: [
      'Los diálogos, las pantallas, el panel lateral y los avisos se van con una animación corta en vez de desaparecer de golpe. Los menús y las ayudas aparecen suaves. Con «Efectos de animación» apagado en Windows, todo se cierra al instante.',
      'Tickets: un conector propio se reconoce por sus herramientas, aunque tenga otro nombre, y lo podés elegir aunque el de claude.ai esté caído. Si falta algo, el aviso te dice qué.',
      'Tickets: revisar las cuentas es más rápido, y un ticket que ya abriste vuelve a abrir al instante. «Recargar» trae el detalle de nuevo.',
      'Preparar un PR tarda menos.'
    ]
  },
  {
    version: '0.6.16',
    date: '2026-11-14',
    title: 'Pegar, conectores por cuenta y micrófono a mano',
    items: [
      'Ctrl+V pega siempre una sola vez y al instante, también dentro de Claude Code, tanto texto como imágenes.',
      'Tickets: en los ajustes del tablero ves qué conectores tiene cada cuenta y elegís con cuál trabajar. Si un conector no está conectado, Sloth te dice qué hacer en vez de mostrar el tablero vacío.',
      'El micrófono para dictar pasó a la barra de arriba de cada panel y ya no tapa la terminal. Ctrl+Shift+D empieza o corta el dictado.',
      'Chat: suena al recibir y al enviar mensajes, avisa cuando estás en otra conversación y el ícono muestra cuántos mensajes no leíste. Cada cosa se apaga por separado en Configuración → Notificaciones.',
      'Las notificaciones de Windows vuelven a aparecer.'
    ]
  },
  {
    version: '0.6.15',
    date: '2026-11-13',
    title: 'Sin barra que no se mueve',
    items: [
      'Con Claude Code, vim o nano abiertos, la terminal ya no muestra la barra de desplazamiento, que quedaba quieta mientras ellos movían la pantalla por su cuenta.',
      'En la PowerShell la barra sigue, pero ahora es una línea fina al borde que no se cruza con el micrófono.'
    ]
  },
  {
    version: '0.6.14',
    date: '2026-11-13',
    title: 'El micrófono se ve',
    items: [
      'El micrófono de cada terminal ahora tiene el color de acento y se ve siempre, no solo al pasar el mouse.',
      'La primera vez, al lado del micrófono aparece «Nuevo · Dictá con tu voz». Se va cuando lo usás o lo cerrás.'
    ]
  },
  {
    version: '0.6.13',
    date: '2026-11-13',
    title: 'El dictado ahora funciona en todas las PCs',
    items: [
      'El micrófono de cada terminal transcribe con Whisper en tu propia PC: no depende de Windows, anda sin internet y el audio no sale de tu computadora.',
      'Tocá el micrófono, hablá y tocalo de nuevo: en unos segundos el texto aparece en el prompt de Claude, sin mandarse.',
      'Entiende mejor las palabras de programación (commit, staging, pull request) y el voseo.',
      'Si no hay micrófono o Windows no deja usarlo, Sloth te avisa y te lleva a la pantalla que lo arregla.'
    ]
  },
  {
    version: '0.6.12',
    date: '2026-11-12',
    title: 'Dictado por voz en la terminal',
    items: [
      'Cada terminal tiene su micrófono abajo a la derecha: tocalo, hablá y tocalo de nuevo. El texto aparece en el prompt de Claude sin mandarse, para que lo revises. Usa el reconocimiento de voz de Windows.',
      'Si a Windows le falta algo para dictar (el reconocimiento de voz en línea, el micrófono o el idioma), Sloth te avisa y te lleva a la pantalla que lo arregla.',
      'Con el dictado de Windows (Win+H), la terminal ya no se corre de costado ni queda cortada a la izquierda.',
      'Chat: unite a un equipo pegando una invitación completa, y al invitar copiá la invitación con todo lo necesario.',
      'Chat: los mensajes llegan más rápido.',
      'Chat: si el inicio de sesión con GitHub no está habilitado, Sloth lo explica en vez de mostrar un error.'
    ]
  },
  {
    version: '0.6.11',
    date: '2026-11-12',
    title: 'Sin ventana negra al cerrar terminales',
    items: ['Cerrar o reiniciar una terminal ya no hace aparecer un instante una ventana negra.']
  },
  {
    version: '0.6.10',
    date: '2026-11-12',
    title: 'Copiar con Ctrl+C',
    items: [
      'En la terminal, Ctrl+C copia lo que tengas seleccionado. Si no hay nada seleccionado, corta el proceso como siempre.',
      'Ctrl+V pega texto e imágenes al instante.',
      'Los botones de la ventana tienen el mismo color que la barra de arriba en cada tema.',
      'Retoques de diseño en toda la app para que tamaños, esquinas y colores sean parejos.'
    ]
  },
  {
    version: '0.6.9',
    date: '2026-11-12',
    title: 'Sloth renovado',
    items: [
      'Diseño nuevo de punta a punta: letras, espacios y colores parejos, con buen contraste en tema claro y oscuro.',
      'Riel de navegación a la izquierda con Tickets, Equipo, Historial, Ramas y Chat. Llegás a cada uno con Ctrl+Shift+1 a 5, aunque estés en la terminal.',
      'Un solo menú por espacio: el de «…», el del clic derecho y el de la pestaña son el mismo.',
      'Tickets, Historial, Equipo, Ayuda y Configuración se abren como pantallas con «‹ volver» siempre a la vista. Chat y Git se abren al costado sin tapar los paneles.',
      'Nuevo espacio más simple, y la primera vez que abrís Sloth te recibe «Empecemos» en la pantalla principal.',
      'La vinculación de Equipo se guarda por conector y «Copiado» solo aparece si de verdad se copió.',
      'Al cerrar Sloth con terminales abiertas, se cierran de a una y en orden.'
    ]
  },
  {
    version: '0.6.8',
    date: '2026-11-11',
    title: 'Sloth para cualquier equipo',
    items: [
      'Sloth arranca sin conector de tickets: elegís el tuyo en los ajustes del tablero. Si ya usabas Gruv, seguís igual.',
      'La vista Equipo usa el conector que elegiste: sus tickets y personas junto a los PRs de GitHub. Sin conector, muestra solo los PRs.',
      '«Cerrar panel» ahora corta la terminal y pregunta si Claude está trabajando. «Ocultar panel» la deja corriendo.',
      'Todas las pantallas y diálogos se cierran con un botón visible, no solo con Esc, y el foco vuelve a donde estabas.',
      'Si escribiste algo en un diálogo, Sloth pregunta antes de descartarlo.',
      'La configuración se ve como una tuerca en toda la app.'
    ]
  },
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
      'Chat del equipo con mensajes directos, fotos de equipo e invitaciones. Usa un Supabase propio del equipo: hay que configurarlo antes (Configuración → Equipo y chat).',
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
