import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mcpAjenos, servidorDePrefijo } from './mcp-ajenos'

const JIRA = 'mcp__claude_ai_Jira__'

test('servidorDePrefijo saca mcp__ y el __ final', () => {
  assert.equal(servidorDePrefijo(JIRA), 'claude_ai_Jira')
})

test('mcpAjenos: del allow se queda con los que no son del conector', () => {
  const settings = { permissions: { allow: ['mcp__claude_ai_Slack__slack_send_message', 'mcp__claude_ai_Jira__getJiraIssue', 'mcp__claude_ai_Jira', 'Bash(ls)'] } }
  assert.deepEqual(mcpAjenos(settings, {}, JIRA), ['mcp__claude_ai_Slack'])
})

test('mcpAjenos: mcpServers normaliza el nombre como Claude Code', () => {
  assert.deepEqual(mcpAjenos({}, { mcpServers: { 'mi server': {}, jira: {} } }, 'mcp__jira__'), ['mcp__mi_server'])
})

test('mcpAjenos: junta allow y mcpServers sin repetir y ordenado', () => {
  const settings = { permissions: { allow: ['mcp__zeta__x', 'mcp__alfa'] } }
  assert.deepEqual(mcpAjenos(settings, { mcpServers: { alfa: {}, medio: {} } }, JIRA), ['mcp__alfa', 'mcp__medio', 'mcp__zeta'])
})

test('mcpAjenos ignora comodines y entradas raras', () => {
  const settings = { permissions: { allow: ['mcp__*', 'mcp__*__algo', 'mcp__', 5, null] } }
  assert.deepEqual(mcpAjenos(settings, null, JIRA), [])
  assert.deepEqual(mcpAjenos('x', [], JIRA), [])
  assert.deepEqual(mcpAjenos({ permissions: { allow: 'mcp__a' } }, { mcpServers: [] }, JIRA), [])
})
