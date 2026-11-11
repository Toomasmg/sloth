import type { ConectorDef } from '../conector'
import { ESTADO_EN_SNAKE, ESTADOS_COMUNES, faltaConector, PISTA_ESTADOS } from './comun'

/** Sin probar: Shortcut no publica sus herramientas; los nombres son los que reportan terceros. Solo lectura. */
export default {
  id: 'shortcut',
  nombre: 'Shortcut',
  via: 'mcp',
  verificado: false,
  idRegex: '^[1-9]\\d{0,8}$',
  idMayusculas: false,
  ejemplo: { id: '1234', estado: 'in_progress', prioridad: 'prioridad', proyecto: 'equipo' },
  herramientas: {
    prefijo: 'mcp__claude_ai_Shortcut__',
    lista: ['users-get-current', 'stories-search'],
    detalle: ['stories-get-by-id'],
    escritura: {},
    negar: [
      'stories-create',
      'stories-update',
      'stories-create-comment',
      'stories-assign-current-user',
      'stories-unassign-current-user',
      'stories-create-subtask',
      'stories-add-subtask',
      'stories-remove-subtask',
      'stories-add-task',
      'stories-update-task',
      'stories-add-relation',
      'stories-add-external-link',
      'stories-remove-external-link',
      'stories-set-external-links',
      'epics-create',
      'epics-update',
      'iterations-create',
      'documents-create',
      'documents-update',
      'objectives-create'
    ]
  },
  estados: ESTADOS_COMUNES,
  pistas: {
    yo: { conId: 'Tu id en Shortcut es "{id}": usalo en yo.id.', sinId: 'Tu id y tu nombre los sacás de users-get-current.' },
    lista: `Con stories-search traé las historias sin terminar del equipo, sin filtrar por dueño (no solo las tuyas), de a 100 y como máximo 250. El "id" es el número de la historia (sin sc-) y el estado, su workflow state. ${ESTADO_EN_SNAKE}`,
    estados: PISTA_ESTADOS,
    detalle: [{ herramienta: 'stories-get-by-id', args: { storyPublicId: '{ticket}' } }],
    acciones: {}
  },
  faltaConector: faltaConector('shortcut', 'Shortcut')
} satisfies ConectorDef
