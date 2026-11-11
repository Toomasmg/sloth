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
      'wit_work_item_attachment_link',
      'wit_create_work_item',
      'wit_update_work_item',
      'wit_update_work_items_batch',
      'wit_add_work_item_comment',
      'wit_update_work_item_comment',
      'wit_add_child_work_items',
      'wit_work_items_link',
      'wit_work_item_unlink',
      'wit_link_work_item_to_pull_request',
      'wit_add_artifact_link',
      'repo_create_pull_request',
      'repo_update_pull_request',
      'repo_update_pull_request_reviewers',
      'repo_create_branch',
      'repo_create_pull_request_thread',
      'repo_update_pull_request_thread',
      'repo_reply_to_comment',
      'repo_resolve_comment',
      'repo_vote_pull_request',
      'pipelines_run_pipeline',
      'pipelines_create_pipeline',
      'pipelines_update_build_stage',
      'wiki_create_or_update_page',
      'work_create_iterations',
      'work_assign_iterations',
      'work_update_team_capacity',
      'testplan_create_test_plan',
      'testplan_create_test_suite',
      'testplan_create_test_case',
      'testplan_add_test_cases_to_suite',
      'testplan_update_test_case_steps'
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
