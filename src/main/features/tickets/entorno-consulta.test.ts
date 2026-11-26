import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entornoConsulta } from './entorno-consulta'

test('un servidor de la cuenta (gruv-tomy) espera a que conecte antes del primer turno y deja afuera a los de claude.ai', () => {
  const r = entornoConsulta('mcp__gruv-tomy__')
  assert.equal(r.env.MCP_CONNECTION_NONBLOCKING, 'false')
  assert.equal(r.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false')
  assert.equal(r.sinClaudeAi, true)
  assert.equal(r.env.MCP_TIMEOUT, '30000')
  assert.equal(r.env.MAX_MCP_OUTPUT_TOKENS, '50000')
})

test('un conector de claude.ai no cambia cómo conecta ni se apagan los demás', () => {
  const r = entornoConsulta('mcp__claude_ai_Gruv__')
  assert.equal('MCP_CONNECTION_NONBLOCKING' in r.env, false)
  assert.equal('ENABLE_CLAUDEAI_MCP_SERVERS' in r.env, false)
  assert.equal(r.sinClaudeAi, false)
})

test('revisar y descubrir (sin prefijo) esperan la conexión para ver el estado final, con todos los de claude.ai', () => {
  const r = entornoConsulta()
  assert.equal(r.env.MCP_CONNECTION_NONBLOCKING, 'false')
  assert.equal('ENABLE_CLAUDEAI_MCP_SERVERS' in r.env, false)
  assert.equal(r.sinClaudeAi, false)
})
