import type { ConectorDef } from '../conector'
import { ESTADO_EN_SNAKE, ESTADOS_COMUNES, faltaConector, PISTA_ESTADOS } from './comun'

/** Sin probar: los nombres salen de la referencia de herramientas de Asana; sus argumentos no. Solo comenta. */
export default {
  id: 'asana',
  nombre: 'Asana',
  via: 'mcp',
  verificado: false,
  idRegex: '^\\d{1,19}$',
  idMayusculas: false,
  ejemplo: { id: '1204567890123456', estado: 'in_progress', prioridad: 'prioridad', proyecto: 'proyecto' },
  herramientas: {
    prefijo: 'mcp__claude_ai_Asana__',
    lista: ['get_me', 'get_tasks', 'search_tasks'],
    detalle: ['get_task', 'get_task_stories'],
    escritura: { comentar: 'add_comment' },
    negar: [
      'update_tasks',
      'add_comment',
      'create_task',
      'create_tasks',
      'update_task',
      'delete_task',
      'create_project',
      'update_project',
      'create_project_status',
      'add_followers',
      'remove_followers',
      'set_parent_for_task',
      'add_task_to_project',
      'create_portfolio',
      'update_portfolio',
      'create_goal',
      'update_goal'
    ]
  },
  estados: ESTADOS_COMUNES,
  pistas: {
    yo: { conId: 'Tu gid en Asana es "{id}": usalo en yo.id.', sinId: 'Tu gid y tu nombre los sacás de get_me.' },
    lista: `Traé las tareas sin completar del proyecto del equipo con get_tasks (o con search_tasks si está disponible), sin filtrar por asignado (no solo las tuyas), con limit: 100. Si hay más, paginá hasta traer todas (como máximo 250). El "id" es el gid numérico de la tarea y el estado, la sección donde está. ${ESTADO_EN_SNAKE}`,
    estados: PISTA_ESTADOS,
    detalle: [
      { herramienta: 'get_task', args: { task_gid: '{ticket}' } },
      { herramienta: 'get_task_stories', args: { task_gid: '{ticket}' } }
    ],
    acciones: {
      comentar: { args: { task_gid: '{ticket}', text: '{cuerpo}' }, nota: 'Publicá el cuerpo tal cual, sin agregar nada.' }
    }
  },
  faltaConector: faltaConector('asana', 'Asana')
} satisfies ConectorDef
