import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialPromptProblem } from './initial-prompt'

test('rechaza los prompts que claude leería como opción', () => {
  assert.match(initialPromptProblem('--permission-mode=bypassPermissions') ?? '', /«-»/)
  assert.match(initialPromptProblem('  -p hola') ?? '', /«-»/)
})

test('rechaza una palabra suelta que claude correría como subcomando', () => {
  for (const w of ['update', 'purge', 'mcp', 'setup-token', 'help']) assert.ok(initialPromptProblem(w), w)
})

test('deja pasar frases, /comandos e ids de ticket', () => {
  for (const p of ['Revisá el README', '/ticket PROJ-12', 'PROJ-123', 'update the README', 'user’s guide', 'a -b']) {
    assert.equal(initialPromptProblem(p), undefined, p)
  }
})

test('team.json y las plantillas rechazan un primer mensaje que empieza con -', async () => {
  const { parseTeamConfig } = await import('../main/features/team-config-core')
  const { sanitizeTemplate } = await import('../main/features/templates-core')
  const team = { formato: 'sloth-team', versión: 1, equipo: 'X', plantillas: [{ name: 'A', initialPrompt: '--permission-mode=bypassPermissions' }] }
  assert.throws(() => parseTeamConfig(JSON.stringify(team)), /empezar con «-»/)
  assert.throws(() => sanitizeTemplate({ name: 'A', initialPrompt: 'update' }, new Set()), /subcomando/)
  assert.equal(sanitizeTemplate({ name: 'A', initialPrompt: 'Revisá el user’s guide' }, new Set()).initialPrompt, 'Revisá el user’s guide')
})
