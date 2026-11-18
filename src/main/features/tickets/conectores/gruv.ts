import type { ConectorDef } from '../conector'

/** Gruv es un conector de claude.ai: sus herramientas son `mcp__claude_ai_Gruv__*`. */
export default {
  id: 'gruv',
  nombre: 'Gruv',
  via: 'mcp',
  verificado: true,
  idRegex: '^[A-Z][A-Z0-9]*-\\d{1,7}$',
  idMayusculas: true,
  comandoTicket: '/ticket',
  ejemplo: { id: 'TCK-1234', estado: 'en_revision', prioridad: 'severidad', proyecto: 'espacio o proyecto' },
  herramientas: {
    prefijo: 'mcp__claude_ai_Gruv__',
    lista: ['listar_tickets', 'ver_flujo_tickets', 'ver_mi_inicio', 'ver_mi_perfil', 'buscar_persona'],
    personas: 'buscar_persona',
    detalle: ['listar_comentarios_ticket', 'listar_criterios_ticket', 'ver_reloj', 'ver_ticket'],
    escritura: {
      estado: 'mover_ticket',
      tomar: 'asignar_ticket',
      soltar: 'asignar_ticket',
      comentar: 'comentar_ticket',
      criterio: 'tildar_criterio_ticket',
      horas: 'sumar_al_reloj'
    },
    // Todo lo que escribe en Gruv, por si la cuenta tiene permisos amplios en su settings.
    negar: [
      'mover_ticket',
      'comentar_ticket',
      'editar_ticket',
      'crear_ticket',
      'borrar_ticket',
      'archivar_ticket',
      'asignar_ticket',
      'pedir_ticket',
      'retirar_pedido_ticket',
      'pegar_pr_ticket',
      'tildar_criterio_ticket',
      'agregar_criterios_ticket',
      'borrar_criterio_ticket',
      'cambiar_severidad_ticket',
      'cambiar_talla_ticket',
      'estimar_ticket',
      'corregir_plazo_ticket',
      'pedir_prorroga_ticket',
      'ajustar_tiempo_ticket',
      'actualizar_tickets_en_tanda',
      'mover_ticket_de_espacio',
      'asignar_epica_ticket',
      'crear_vinculo_ticket',
      'borrar_vinculo_ticket',
      'mandar_ticket_al_chat',
      'mandar_mensaje',
      'sumar_al_reloj',
      'corregir_arranque_reloj',
      'cerrar_el_dia',
      'poner_veredicto_de_cierre',
      'guardar_borrador_flujo',
      'publicar_flujo',
      'quitar_estado_flujo'
    ]
  },
  estados: [
    { clave: 'abierto', nombre: 'Abierto', categoria: 'pendiente' },
    { clave: 'en_curso', nombre: 'En curso', categoria: 'en_curso' },
    { clave: 'bloqueado', nombre: 'Bloqueado', categoria: 'bloqueado' },
    { clave: 'en_revision', nombre: 'En revisión', categoria: 'revision' },
    { clave: 'pre_rtd', nombre: 'Pre RTD', categoria: 'revision' },
    { clave: 'en_qa', nombre: 'En QA', categoria: 'revision' },
    { clave: 'rechazado', nombre: 'Rechazado', categoria: 'bloqueado' },
    { clave: 'cerrado', nombre: 'Cerrado', categoria: 'hecho' }
  ],
  pistas: {
    yo: {
      conId: 'Tu id en Gruv es "{id}": usalo en yo.id.',
      sinId: 'Tu nombre y tu correo salen de ver_mi_perfil; tu id es el de la persona que devuelve buscar_persona con ese correo. No pongas el correo en la respuesta.'
    },
    lista:
      'Llamá a la herramienta de Gruv listar_tickets SIN filtrar por estado ni por asignado (quiero los tickets de todo el equipo), con limite: 50. Si vuelven 50, seguí con desplazamiento: 50, 100… hasta traer todos (como máximo 250).',
    listaPor:
      'Llamá a listar_tickets una vez por cada responsable de esta lista: {asignados}. Usá asignado: <ese id> (o "sin_asignar") y limite: 50, todas en paralelo. Si una vuelve con 50, pedí la página siguiente con desplazamiento: 50 (y 100 como máximo). Son los abiertos de cada uno y se leen enteros, sin cortar por fecha. "fecha" es created_at.',
    listaHechos:
      'Además, por cada responsable llamá a listar_tickets con estado: "cerrado", el mismo asignado y limite: 50, y leé también la página de desplazamiento: 50 (los cerrados no vienen ordenados por cierre). En esos, "fecha" es closed_at.',
    personas:
      'Armá la lista de las personas del equipo: llamá a buscar_persona en paralelo con una letra por llamada (a, e, i, o, u, s, n, r, l, m) como texto; cada una devuelve hasta 25. Juntalas sin repetir por id.',
    estados: 'Llamá a ver_flujo_tickets (sin tipo) y armá "estados" con las columnas en su orden, sin repetir claves, con la clave y el nombre que se ven.',
    detalle: [
      { herramienta: 'listar_comentarios_ticket', args: { id: '{ticket}' } },
      { herramienta: 'listar_criterios_ticket', args: { id: '{ticket}' } },
      { herramienta: 'ver_reloj', args: { entidad: 'ticket', id: '{ticket}' } },
      { herramienta: 'ver_ticket', args: { id: '{ticket}' } }
    ],
    descripcion:
      'Gruv no tiene un campo "descripcion": el texto del ticket sale de lo que devuelve ver_ticket en "ocurrido" (qué pasó), "esperado" (qué se esperaba) y "pasos". Armalo con los que tengan texto, en ese orden, cada uno en su renglón y encabezado por "Qué pasó:", "Qué se esperaba:" y "Pasos:". Ignorá el resto de los campos de ver_ticket.',
    acciones: {
      estado: { args: { id: '{ticket}', estado: '{estado}' }, nota: 'No pongas resolucion ni resolucion_nota.' },
      tomar: { args: { id: '{ticket}', persona: '{persona}' }, nota: 'Es tomar el ticket para esa persona.' },
      soltar: { args: { id: '{ticket}', persona: null }, nota: 'Es soltar el ticket (dejarlo sin dueño).' },
      comentar: { args: { id: '{ticket}', cuerpo: '{cuerpo}' }, nota: 'Publicá el cuerpo tal cual, sin agregar nada.' },
      criterio: { args: { criterio_id: '{criterioId}', hecho: '{hecho}' }, nota: 'El criterio pertenece al ticket {ticket}.' },
      horas: { args: { entidad: 'ticket', id: '{ticket}', minutos: '{minutos}', motivo: '{motivo}' } }
    }
  },
  faltaConector: {
    clave: 'sin_gruv',
    mensaje:
      'Conectá Gruv en claude.ai con esta cuenta (claude.ai → Configuración → Conectores) y probá de nuevo: Claude no encontró las herramientas de Gruv.'
  }
} satisfies ConectorDef
