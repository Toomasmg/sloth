import type { ConectorDef } from '../conector'
import { ESTADO_EN_SNAKE, ESTADOS_COMUNES, faltaConector, PISTA_ESTADOS } from './comun'

/**
 * Sin probar. El id de página de Notion (32 hex) no entra en un id de ticket: se usa la propiedad
 * «ID único» de la base (TAREA-12) y la página se busca por ese valor. Solo comenta.
 */
export default {
  id: 'notion',
  nombre: 'Notion',
  via: 'mcp',
  verificado: false,
  idRegex: '^[A-Z][A-Z0-9]*-\\d{1,7}$',
  idMayusculas: true,
  ejemplo: { id: 'TAREA-12', estado: 'in_progress', prioridad: 'prioridad', proyecto: 'base de datos' },
  herramientas: {
    prefijo: 'mcp__claude_ai_Notion__',
    lista: ['notion-get-self', 'notion-search', 'notion-fetch'],
    detalle: ['notion-fetch', 'notion-get-comments'],
    apoyo: ['notion-search'],
    escritura: { comentar: 'notion-create-comment' },
    negar: [
      'notion-create-pages',
      'notion-update-page',
      'notion-create-comment',
      'notion-update-comment',
      'notion-delete-comment',
      'notion-set-discussion-resolved',
      'notion-set-comment-reaction',
      'notion-create-suggested-edit',
      'notion-resolve-suggested-edit',
      'notion-restore-version',
      'notion-restore-pages',
      'notion-move-pages',
      'notion-duplicate-page',
      'notion-create-database',
      'notion-update-database',
      'notion-update-data-source',
      'notion-create-view',
      'notion-update-view'
    ]
  },
  estados: ESTADOS_COMUNES,
  pistas: {
    yo: { conId: 'Tu id en Notion es "{id}": usalo en yo.id.', sinId: 'Tu id y tu nombre los sacás de notion-get-self.' },
    lista: `Con notion-search encontrá la base de datos de tareas del equipo y leela con notion-fetch: las tareas abiertas de todos, no solo las tuyas, de a 100 y como máximo 250. El "id" es SOLO el valor de la propiedad «ID único» de cada página (p. ej. TAREA-12), nunca el id de la página: descartá las páginas que no tengan esa propiedad. El estado sale de la propiedad Estado o Status. ${ESTADO_EN_SNAKE}`,
    estados: PISTA_ESTADOS,
    detalle: [
      { herramienta: 'notion-fetch', args: { id: '{ticket}' } },
      { herramienta: 'notion-get-comments', args: { page_id: '{ticket}' } }
    ],
    apoyo: '{ticket} es el «ID único» de la tarea, no el id de su página: buscá la página con notion-search por ese valor y usá su id de página en lugar de {ticket}',
    acciones: {
      comentar: { args: { page_id: '{ticket}', text: '{cuerpo}' }, nota: 'Publicá el cuerpo tal cual, sin agregar nada.' }
    }
  },
  faltaConector: faltaConector('notion', 'Notion')
} satisfies ConectorDef
