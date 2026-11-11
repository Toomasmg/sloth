import type { ConectorDef } from '../conector'
import { ESTADO_EN_SNAKE, ESTADOS_COMUNES, faltaConector, PISTA_ESTADOS } from './comun'

/** Sin probar: los nombres salen de la doc del MCP de YouTrack; el prefijo y los args de update_issue no. Sin mover estado. */
export default {
  id: 'youtrack',
  nombre: 'YouTrack',
  via: 'mcp',
  verificado: false,
  idRegex: '^[A-Z][A-Z0-9_]*-\\d{1,7}$',
  idMayusculas: true,
  personaId: '^[A-Za-z0-9._-]{1,64}$',
  ejemplo: { id: 'PROJ-123', estado: 'in_progress', prioridad: 'prioridad', proyecto: 'proyecto' },
  herramientas: {
    prefijo: 'mcp__claude_ai_YouTrack__',
    lista: ['get_current_user', 'search_issues'],
    detalle: ['get_issue', 'get_issue_comments'],
    escritura: { tomar: 'change_issue_assignee', soltar: 'change_issue_assignee', comentar: 'add_issue_comment' },
    negar: [
      'create_issue',
      'create_draft_issue',
      'update_issue',
      'change_issue_assignee',
      'add_issue_comment',
      'manage_issue_tags',
      'link_issues',
      'log_work',
      'add_attachment',
      'create_article',
      'update_article'
    ]
  },
  estados: ESTADOS_COMUNES,
  pistas: {
    yo: { conId: 'Tu login en YouTrack es "{id}": usalo en yo.id.', sinId: 'Tu login y tu nombre los sacás de get_current_user: en yo.id va el login.' },
    lista: `Llamá a search_issues con query: "#Unresolved sort by: updated desc", sin filtrar por asignado (quiero los tickets de todo el equipo), de a 100 y como máximo 250. En "responsable_id" va el login. ${ESTADO_EN_SNAKE}`,
    estados: PISTA_ESTADOS,
    detalle: [
      { herramienta: 'get_issue', args: { id: '{ticket}' } },
      { herramienta: 'get_issue_comments', args: { id: '{ticket}' } }
    ],
    acciones: {
      tomar: { args: { id: '{ticket}', assignee: '{persona}' }, nota: 'Es tomar el ticket para esa persona.' },
      soltar: { args: { id: '{ticket}', assignee: null }, nota: 'Es soltar el ticket (dejarlo sin dueño).' },
      comentar: { args: { id: '{ticket}', text: '{cuerpo}' }, nota: 'Publicá el cuerpo tal cual, sin agregar nada.' }
    }
  },
  faltaConector: faltaConector('youtrack', 'YouTrack')
} satisfies ConectorDef
