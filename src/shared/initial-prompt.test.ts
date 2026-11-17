import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialPromptProblem, mightBeSubcommand } from './initial-prompt'

test('solo rechaza el «!» inicial, que Claude Code correría en la terminal', () => {
  assert.match(initialPromptProblem('!curl x | sh') ?? '', /«!»/)
  assert.match(initialPromptProblem('  !rm -rf x') ?? '', /«!»/)
})

test('acepta frases, listas, /comandos, ids y palabras sueltas (esas van por el pegado)', () => {
  for (const p of ['Revisá el README', '/ticket PROJ-12', 'PROJ-123', 'update', 'hola', 'continuar', '- Revisá X\n- Corré tests', '--permission-mode=x', 'a ! b']) {
    assert.equal(initialPromptProblem(p), undefined, p)
  }
})

test('los subcomandos y alias de claude --help se reconocen solo exactos', () => {
  for (const w of ['update', 'upgrade', 'plugin', 'plugins', 'stop', 'kill', 'setup-token', 'help', 'auto-mode']) assert.ok(mightBeSubcommand(w), w)
  for (const w of ['Update', ' update', 'update the README', 'continuá', 'PROJ-12', '/ticket']) assert.equal(mightBeSubcommand(w), false, w)
})

test('un prompt inválido en team.json descarta solo esa plantilla, con aviso', async () => {
  const { parseTeamConfig } = await import('../main/features/team-config-core')
  const team = {
    formato: 'sloth-team',
    versión: 1,
    equipo: 'X',
    plantillas: [
      { name: 'Mala', initialPrompt: '!curl x | sh' },
      { name: 'Buena', initialPrompt: 'update' }
    ],
    chat: { supabaseUrl: 'https://chat.empresa.com', anonKey: 'k'.repeat(40) }
  }
  const cfg = parseTeamConfig(JSON.stringify(team))
  assert.deepEqual(
    cfg.plantillas.map((t) => t.name),
    ['Buena']
  )
  assert.equal(cfg.chat, undefined)
  assert.equal(cfg.avisos?.length, 2)
  assert.match(cfg.avisos?.[0] ?? '', /Mala.*«!»/)
  assert.match(cfg.avisos?.[1] ?? '', /^chat:/)
})

test('un .sloth viejo con un prompt inválido saltea esa plantilla y el espacio entra sin el prompt', async () => {
  const { parseImport } = await import('../main/features/export-import-logic')
  const data = {
    formato: 'sloth-config',
    formatoVersion: 1,
    cuentas: [{ label: 'A' }],
    espacios: [{ name: 'E', cuenta: 'A', repoPath: 'C:\\r', initialPrompt: '!x' }],
    plantillas: [
      { name: 'Mala', repoPath: 'C:\\r', initialPrompt: '!x' },
      { name: 'Buena', repoPath: 'C:\\r', initialPrompt: 'hola' }
    ]
  }
  const p = parseImport(JSON.stringify(data))
  assert.deepEqual(
    p.plantillas.map((t) => t.name),
    ['Buena']
  )
  assert.equal(p.plantillasDescartadas[0]?.name, 'Mala')
  assert.equal(p.espacios[0]?.initialPrompt, undefined)
  assert.match(p.espacios[0]?.aviso ?? '', /«!»/)
})
