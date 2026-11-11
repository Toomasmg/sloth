import type { ConectorDef } from '../conector'
import { ESTADO_EN_SNAKE, ESTADOS_COMUNES, faltaConector, PISTA_ESTADOS } from './comun'

/** Jira por el conector de Atlassian de claude.ai: toda herramienta pide el cloudId del sitio. */
export default {
  id: 'jira',
  nombre: 'Jira',
  via: 'mcp',
  verificado: true,
  idRegex: '^[A-Z][A-Z0-9_]*-\\d{1,7}$',
  idMayusculas: true,
  personaId: '^[A-Za-z0-9:-]{1,128}$',
  ejemplo: { id: 'PROJ-123', estado: 'in_progress', prioridad: 'prioridad', proyecto: 'proyecto' },
  herramientas: {
    prefijo: 'mcp__claude_ai_Atlassian_MCP__',
    lista: ['atlassianUserInfo', 'getAccessibleAtlassianResources', 'searchJiraIssuesUsingJql'],
    detalle: ['getJiraIssue', 'listJiraIssueComments'],
    apoyo: ['getAccessibleAtlassianResources'],
    // executeRead corre cualquier operación por nombre: solo hace falta para listJiraIssueTransitions.
    apoyoEn: { estado: ['executeRead'] },
    escritura: {
      estado: 'transitionJiraIssue',
      tomar: 'editJiraIssue',
      soltar: 'editJiraIssue',
      comentar: 'addOrEditJiraIssueComment'
    },
    negar: [
      'transitionJiraIssue',
      'editJiraIssue',
      'addOrEditJiraIssueComment',
      'createJiraIssue',
      'addOrEditJiraIssueWorklog',
      'createJiraIssueLink',
      'manageJiraProjectVersion',
      'manageJiraProjectVersionRelatedWork',
      'manageJiraSprint',
      'createJiraBoard',
      'watchJiraIssue',
      'uploadAttachmentToJiraIssue',
      'editJiraEntityProperty',
      'createJiraIssueRemoteIssueLink',
      'convertJiraIssueHierarchy',
      'executeWrite',
      'executeDestructive',
      'createConfluenceContent',
      'updateConfluenceContent',
      'addGraphContext'
    ]
  },
  estados: ESTADOS_COMUNES,
  pistas: {
    yo: { conId: 'Tu accountId en Jira es "{id}": usalo en yo.id.', sinId: 'Tu accountId y tu nombre los sacás de atlassianUserInfo.' },
    lista: `Sacá el cloudId con getAccessibleAtlassianResources (el primero). Llamá a searchJiraIssuesUsingJql con ese cloudId, jql: "statusCategory != Done ORDER BY updated DESC" y maxResults: 100, sin filtrar por asignado (quiero los tickets de todo el equipo). Si no es la última página, seguí con nextPageToken hasta traer todos (como máximo 250). ${ESTADO_EN_SNAKE}`,
    estados: PISTA_ESTADOS,
    detalle: [
      { herramienta: 'getJiraIssue', args: { issueIdOrKey: '{ticket}' } },
      { herramienta: 'listJiraIssueComments', args: { issueIdOrKey: '{ticket}' } }
    ],
    apoyo: 'El cloudId sale de getAccessibleAtlassianResources (el primero); pasalo en cada llamada.',
    acciones: {
      estado: {
        args: { issueIdOrKey: '{ticket}' },
        nota: 'Usá la transición del ticket {ticket} cuyo estado destino, en minúsculas y snake_case, sea {estado}: su transitionId sale de executeRead con name listJiraIssueTransitions (con el cloudId y issueIdOrKey en inputs). Pasalo en transitionId.'
      },
      tomar: { args: { issueIdOrKey: '{ticket}', fields: { assignee: { accountId: '{persona}' } } }, nota: 'Es tomar el ticket para esa persona.' },
      soltar: { args: { issueIdOrKey: '{ticket}', fields: { assignee: null } }, nota: 'Es soltar el ticket (dejarlo sin dueño).' },
      comentar: { args: { issueIdOrKey: '{ticket}', commentBody: '{cuerpo}' }, nota: 'Publicá el cuerpo tal cual, sin agregar nada.' }
    }
  },
  faltaConector: faltaConector('jira', 'Atlassian (Jira)')
} satisfies ConectorDef
