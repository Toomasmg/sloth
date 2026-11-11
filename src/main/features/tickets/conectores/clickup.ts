import type { ConectorDef } from '../conector'
import { ESTADO_EN_SNAKE, ESTADOS_COMUNES, faltaConector, PISTA_ESTADOS } from './comun'

/** Sin probar: los nombres salen de la doc de herramientas de ClickUp; el prefijo y algunos argumentos no están confirmados. */
export default {
  id: 'clickup',
  nombre: 'ClickUp',
  via: 'mcp',
  verificado: false,
  idRegex: '^[A-Za-z0-9-]{1,20}$',
  idMayusculas: false,
  ejemplo: { id: '86c0abcd1', estado: 'in_progress', prioridad: 'prioridad', proyecto: 'lista' },
  herramientas: {
    prefijo: 'mcp__claude_ai_ClickUp__',
    lista: ['clickup_get_user', 'clickup_filter_tasks'],
    detalle: ['clickup_get_task', 'clickup_get_task_comments'],
    // En clickup_update_task, assignees reemplaza la lista entera: tomar y soltar quedan afuera.
    escritura: { estado: 'clickup_update_task', comentar: 'clickup_create_task_comment' },
    negar: [
      'clickup_create_task',
      'clickup_update_task',
      'clickup_delete_task',
      'clickup_move_task',
      'clickup_add_task_to_list',
      'clickup_remove_task_from_list',
      'clickup_merge_tasks',
      'clickup_add_task_dependency',
      'clickup_remove_task_dependency',
      'clickup_add_task_link',
      'clickup_remove_task_link',
      'clickup_create_space_tag',
      'clickup_create_comment',
      'clickup_create_task_comment',
      'clickup_update_comment',
      'clickup_delete_comment',
      'clickup_update_list',
      'clickup_update_folder',
      'clickup_execute_operator',
      'clickup_add_tag_to_task',
      'clickup_remove_tag_from_task',
      'clickup_create_list',
      'clickup_create_list_in_folder',
      'clickup_create_folder',
      'clickup_create_document',
      'clickup_create_document_page',
      'clickup_update_document_page',
      'clickup_start_time_tracking',
      'clickup_stop_time_tracking',
      'clickup_add_time_entry',
      'clickup_send_chat_message',
      'clickup_create_reminder',
      'clickup_update_reminder'
    ]
  },
  estados: ESTADOS_COMUNES,
  pistas: {
    yo: { conId: 'Tu id en ClickUp es "{id}": usalo en yo.id.', sinId: 'Tu id y tu nombre los sacás de clickup_get_user.' },
    lista: `Llamá a clickup_filter_tasks sin filtrar por asignado (quiero las tareas abiertas de todo el equipo, sin las cerradas), de a 100. Si hay más, seguí con la página siguiente hasta traer todas (como máximo 250). El "id" es el task_id. ${ESTADO_EN_SNAKE}`,
    estados: PISTA_ESTADOS,
    detalle: [
      { herramienta: 'clickup_get_task', args: { task_id: '{ticket}' } },
      { herramienta: 'clickup_get_task_comments', args: { task_id: '{ticket}' } }
    ],
    acciones: {
      estado: {
        args: { task_id: '{ticket}', status: '{estado}' },
        nota: 'En status va el nombre real del estado de la lista que, en minúsculas y snake_case, es {estado}. No cambies nada más.'
      },
      comentar: { args: { task_id: '{ticket}', comment_text: '{cuerpo}' }, nota: 'Publicá el cuerpo tal cual, sin agregar nada.' }
    }
  },
  faltaConector: faltaConector('clickup', 'ClickUp')
} satisfies ConectorDef
