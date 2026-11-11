import type { ConectorDef } from '../conector'
import { ESTADO_EN_SNAKE, ESTADOS_COMUNES, faltaConector, PISTA_ESTADOS } from './comun'

/**
 * Sin probar: los nombres salen de la doc del servidor MCP de GitLab; el conector de claude.ai y el
 * prefijo no están confirmados. El id es el iid, que solo es único dentro de un proyecto. Solo comenta.
 */
export default {
  id: 'gitlab',
  nombre: 'GitLab',
  via: 'mcp',
  verificado: false,
  idRegex: '^[1-9]\\d{0,6}$',
  idMayusculas: false,
  ejemplo: { id: '42', estado: 'in_progress', prioridad: 'etiqueta', proyecto: 'grupo/proyecto' },
  herramientas: {
    prefijo: 'mcp__claude_ai_GitLab__',
    lista: ['get_user', 'list_work_items'],
    detalle: ['get_work_item'],
    apoyo: ['list_work_items'],
    escritura: { comentar: 'save_note' },
    negar: [
      'save_note',
      'save_work_item',
      'link_work_items',
      'save_merge_request',
      'save_merge_request_review',
      'accept_merge_request',
      'save_project',
      'add_commit',
      'add_branch',
      'fork_repository',
      'save_pipeline',
      'save_vulnerability',
      'attach_scan_profile'
    ]
  },
  estados: ESTADOS_COMUNES,
  pistas: {
    yo: { conId: 'Tu id en GitLab es "{id}": usalo en yo.id.', sinId: 'Tu id y tu nombre los sacás de get_user con me: true.' },
    lista: `Trabajá con UN solo proyecto, el del equipo. Con list_work_items traé sus work items abiertos, sin filtrar por asignado (no solo los tuyos), de a 100 y como máximo 250. El "id" es el iid (el número dentro del proyecto) y en "proyecto" va la ruta del proyecto. ${ESTADO_EN_SNAKE}`,
    estados: PISTA_ESTADOS,
    detalle: [{ herramienta: 'get_work_item', args: { work_item_iid: '{ticket}' } }],
    apoyo: 'El ticket {ticket} es el iid de un work item del proyecto del equipo: el project_id sale de list_work_items y va en cada llamada; en get_work_item pedí include con notes para traer los comentarios',
    acciones: {
      comentar: { args: { work_item_iid: '{ticket}', body: '{cuerpo}' }, nota: 'Publicá el cuerpo tal cual, sin agregar nada.' }
    }
  },
  faltaConector: faltaConector('gitlab', 'GitLab')
} satisfies ConectorDef
