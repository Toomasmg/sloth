import type { ConectorDef } from '../conector'
import { ESTADO_EN_SNAKE, ESTADOS_COMUNES, faltaConector, PISTA_ESTADOS } from './comun'

/** Sin probar: Linear no publica la lista de herramientas de su MCP; los nombres son los que reportan terceros. Solo lectura. */
export default {
  id: 'linear',
  nombre: 'Linear',
  via: 'mcp',
  verificado: false,
  idRegex: '^[A-Z][A-Z0-9]*-\\d{1,7}$',
  idMayusculas: true,
  ejemplo: { id: 'ENG-123', estado: 'in_progress', prioridad: 'prioridad', proyecto: 'equipo o proyecto' },
  herramientas: {
    prefijo: 'mcp__claude_ai_Linear__',
    lista: ['get_user', 'list_issues'],
    detalle: ['get_issue', 'list_comments'],
    escritura: {},
    negar: ['save_issue', 'save_comment', 'create_comment']
  },
  estados: ESTADOS_COMUNES,
  pistas: {
    yo: { conId: 'Tu id en Linear es "{id}": usalo en yo.id.', sinId: 'Tu id y tu nombre los sacás de get_user (vos mismo).' },
    lista: `Llamá a list_issues sin filtrar por asignado (quiero las tareas abiertas de todo el equipo, sin las terminadas ni canceladas), con limit: 100. Si hay más, paginá hasta traer todas (como máximo 250). El "id" es el identificador (ENG-123). ${ESTADO_EN_SNAKE}`,
    estados: PISTA_ESTADOS,
    detalle: [
      { herramienta: 'get_issue', args: { id: '{ticket}' } },
      { herramienta: 'list_comments', args: { issueId: '{ticket}' } }
    ],
    acciones: {}
  },
  faltaConector: faltaConector('linear', 'Linear')
} satisfies ConectorDef
