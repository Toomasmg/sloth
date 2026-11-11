import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Accion } from '../../../shared/tickets'
import { validarConector, type ConectorMcp } from './conector'
import { CONECTORES, conectorPorId } from './conectores'
import { accionesSoportadas, buildAccionArgs, buildAccionPrompt, buildDetalleArgs, buildDetallePrompt, buildListaArgs, buildPrompt, type AccionInput } from './motor'

const IDS = ['gruv', 'github', 'jira', 'linear', 'asana', 'notion', 'clickup', 'monday', 'azure-devops', 'gitlab', 'shortcut', 'youtrack']

function flag(args: string[], nombre: string): string[] {
  const v = args[args.indexOf(nombre) + 1]
  return v ? v.split(',') : []
}

const entrada = (a: Accion, ticket: string): AccionInput =>
  ({
    estado: { ticket, estado: 'in_progress' },
    tomar: { ticket, persona: '557058:abc' },
    soltar: { ticket, persona: null },
    comentar: { ticket, cuerpo: 'Listo para revisar' },
    criterio: { ticket, criterioId: '00000000-0000-4000-8000-000000000000', hecho: true },
    horas: { ticket, minutos: 30, motivo: 'pruebas' }
  })[a]

const SIN_REEMPLAZAR = /\{(ticket|estado|persona|cuerpo)\}/

const mcp = CONECTORES.filter((d): d is ConectorMcp => d.via === 'mcp')

test('el registro trae todos los presets, en orden y sin repetir', () => {
  assert.deepEqual(
    CONECTORES.map((c) => c.id),
    IDS
  )
  for (const d of CONECTORES) assert.deepEqual(validarConector(d), d, d.id)
})

test('solo Gruv, GitHub y Jira están verificados', () => {
  assert.deepEqual(
    CONECTORES.filter((c) => c.verificado).map((c) => c.id),
    ['gruv', 'github', 'jira']
  )
})

for (const def of mcp) {
  test(`${def.id}: lo permitido es del conector y nunca está negado`, () => {
    const corridas = [buildListaArgs(def, 'haiku'), buildDetalleArgs(def, 'haiku'), ...accionesSoportadas(def).map((a) => buildAccionArgs(def, 'haiku', a))]
    for (const args of corridas) {
      const negadas = flag(args, '--disallowedTools')
      for (const t of flag(args, '--allowedTools')) {
        assert.ok(t.startsWith(def.herramientas.prefijo), t)
        assert.ok(!negadas.includes(t), t)
      }
    }
  })

  test(`${def.id}: los prompts no dejan placeholders y llevan el id de ejemplo`, () => {
    const id = def.ejemplo.id
    const prompts = [buildPrompt(def, ''), buildDetallePrompt(def, id), ...accionesSoportadas(def).map((a) => buildAccionPrompt(def, a, entrada(a, id)))]
    for (const p of prompts) {
      assert.doesNotMatch(p, SIN_REEMPLAZAR)
      assert.ok(p.includes(id), p)
    }
  })
}

const jira = conectorPorId('jira') as ConectorMcp
const A = 'mcp__claude_ai_Atlassian_MCP__'

test('Jira: lista y estado con las herramientas justas', () => {
  assert.deepEqual(flag(buildListaArgs(jira, 'haiku'), '--allowedTools'), [`${A}atlassianUserInfo`, `${A}getAccessibleAtlassianResources`, `${A}searchJiraIssuesUsingJql`])
  const estado = buildAccionArgs(jira, 'haiku', 'estado')
  assert.deepEqual(flag(estado, '--allowedTools'), [`${A}transitionJiraIssue`, `${A}getAccessibleAtlassianResources`, `${A}executeRead`])
  assert.ok(flag(estado, '--disallowedTools').includes(`${A}executeWrite`))
  assert.deepEqual(flag(buildDetalleArgs(jira, 'haiku'), '--allowedTools'), [`${A}getJiraIssue`, `${A}listJiraIssueComments`, `${A}getAccessibleAtlassianResources`])
})

test('Jira: executeRead solo se habilita para cambiar el estado', () => {
  for (const a of ['tomar', 'soltar', 'comentar'] as const) {
    assert.ok(!flag(buildAccionArgs(jira, 'haiku', a), '--allowedTools').includes(`${A}executeRead`), a)
    assert.ok(buildAccionPrompt(jira, a, entrada(a, 'PROJ-1')).includes('Podés usar antes getAccessibleAtlassianResources solo para leer'), a)
  }
})

test('Jira: tomar y soltar van en fields.assignee', () => {
  assert.ok(buildAccionPrompt(jira, 'tomar', entrada('tomar', 'PROJ-1')).includes('"fields":{"assignee":{"accountId":"557058:abc"}}'))
  assert.ok(buildAccionPrompt(jira, 'soltar', entrada('soltar', 'PROJ-1')).includes('{"issueIdOrKey":"PROJ-1","fields":{"assignee":null}}'))
})

test('Jira: la nota del estado lleva el estado en JSON y el apoyo va antes de la escritura', () => {
  const p = buildAccionPrompt(jira, 'estado', entrada('estado', 'PROJ-1'))
  assert.ok(p.includes('sea "in_progress"'), p)
  assert.ok(p.includes('Podés usar antes getAccessibleAtlassianResources, executeRead solo para leer'), p)
  assert.ok(p.includes('UNA sola llamada de escritura sobre el ticket PROJ-1'), p)
  assert.ok(buildDetallePrompt(jira, 'PROJ-1').includes('\nAntes: El cloudId sale de getAccessibleAtlassianResources'))
})
