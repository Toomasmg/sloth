import type { ConectorDef } from '../conector'
import { ESTADO_EN_SNAKE, ESTADOS_COMUNES, faltaConector, PISTA_ESTADOS } from './comun'

/** Sin probar: los nombres salen de la doc de herramientas de monday.com; el prefijo y los argumentos no. Solo comenta. */
export default {
  id: 'monday',
  nombre: 'monday.com',
  via: 'mcp',
  verificado: false,
  idRegex: '^\\d{1,19}$',
  idMayusculas: false,
  ejemplo: { id: '1234567890', estado: 'in_progress', prioridad: 'prioridad', proyecto: 'tablero' },
  herramientas: {
    prefijo: 'mcp__claude_ai_monday_com__',
    lista: ['get_user_context', 'get_board_items_page'],
    detalle: ['get_updates'],
    escritura: { comentar: 'create_update' },
    negar: [
      'change_item_column_values',
      'create_update',
      'create_item',
      'create_board',
      'create_group',
      'create_column',
      'create_notification',
      'create_doc',
      'update_doc',
      'all_monday_api'
    ]
  },
  estados: ESTADOS_COMUNES,
  pistas: {
    yo: { conId: 'Tu id en monday.com es "{id}": usalo en yo.id.', sinId: 'Tu id y tu nombre los sacás de get_user_context.' },
    lista: `Con get_user_context ubicá el tablero de trabajo del equipo y traé sus ítems con get_board_items_page, sin filtrar por persona (no solo los tuyos) y sin los terminados, de a 100 y como máximo 250. El "id" es el id numérico del ítem y el estado, el valor de su columna de estado. ${ESTADO_EN_SNAKE}`,
    estados: PISTA_ESTADOS,
    detalle: [{ herramienta: 'get_updates', args: { item_id: '{ticket}' } }],
    acciones: {
      comentar: { args: { item_id: '{ticket}', body: '{cuerpo}' }, nota: 'Publicá el cuerpo tal cual, sin agregar nada.' }
    }
  },
  faltaConector: faltaConector('monday', 'monday.com')
} satisfies ConectorDef
