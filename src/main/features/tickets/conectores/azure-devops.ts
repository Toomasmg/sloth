import type { ConectorDef } from '../conector'
import { ESTADO_EN_SNAKE, ESTADOS_COMUNES, PISTA_ESTADOS } from './comun'

/**
 * Sin probar. Azure DevOps no tiene conector en claude.ai: su MCP remoto pide Entra ID y se suma a
 * Claude Code como servidor propio, con el nombre azure-devops. Los permisos van por herramienta,
 * no por `action`: wit_work_item solo lee. Solo comenta.
 */
export default {
  id: 'azure-devops',
  nombre: 'Azure DevOps',
  via: 'mcp',
  verificado: false,
  idRegex: '^\\d{1,19}$',
  idMayusculas: false,
  ejemplo: { id: '1234', estado: 'in_progress', prioridad: 'prioridad', proyecto: 'proyecto' },
  herramientas: {
    prefijo: 'mcp__azure-devops__',
    lista: ['wit_work_item', 'search_workitem'],
    detalle: ['wit_work_item'],
    escritura: { comentar: 'wit_work_item_comment_write' },
    negar: [
      'wit_work_item_write',
      'wit_work_item_comment_write',
      'wit_work_item_link_write',
      'wit_work_item_attachment_upload',
      'wit_work_item_attachment_link'
    ]
  },
  estados: ESTADOS_COMUNES,
  pistas: {
    yo: {
      conId: 'Tu id en Azure DevOps es "{id}": usalo en yo.id.',
      sinId: 'Tu nombre sale de los work items asignados a vos (wit_work_item con action: "my"); si no ves tu id, poné solo el nombre.'
    },
    lista: `Con search_workitem traé los work items abiertos del proyecto, sin filtrar por asignado (no solo los tuyos), de a 100 y como máximo 250. El "id" es el id numérico del work item y el estado, System.State. ${ESTADO_EN_SNAKE}`,
    estados: PISTA_ESTADOS,
    detalle: [
      { herramienta: 'wit_work_item', args: { action: 'get', id: '{ticket}' } },
      { herramienta: 'wit_work_item', args: { action: 'list_comments', id: '{ticket}' } }
    ],
    acciones: {
      comentar: { args: { action: 'add', id: '{ticket}', text: '{cuerpo}' }, nota: 'Publicá el cuerpo tal cual, sin agregar nada.' }
    }
  },
  faltaConector: {
    clave: 'sin_azure_devops',
    mensaje:
      'Sumá a Claude Code el servidor MCP de Azure DevOps (https://mcp.dev.azure.com/<organización>) con el nombre azure-devops en esta cuenta y probá de nuevo: Claude no encontró las herramientas de Azure DevOps.'
  }
} satisfies ConectorDef
