import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { envolverStatusline, LIMITES_ARCHIVO, STATUSLINE_MARKER, STATUSLINE_SCRIPT } from './statusline-core'

const SCRIPT = 'C:\\Users\\yo\\AppData\\Roaming\\Sloth\\sloth-statusline.cjs'

test('envuelve la statusline del usuario: node, el script y el original en base64url', () => {
  const r = envolverStatusline({ type: 'command', command: 'bash ~/.claude/statusline-command.sh', padding: 0 }, SCRIPT) as { command: string; padding: number }
  assert.equal(r.padding, 0)
  const [node, ruta, b64, ...resto] = r.command.split(' ')
  assert.equal(node, 'node')
  assert.equal(ruta, '"C:/Users/yo/AppData/Roaming/Sloth/sloth-statusline.cjs"')
  assert.equal(Buffer.from(b64, 'base64url').toString('utf8'), 'bash ~/.claude/statusline-command.sh')
  assert.deepEqual(resto, [])
  assert.match(b64, /^[A-Za-z0-9_-]+$/)
})

test('no envuelve dos veces', () => {
  const una = envolverStatusline({ type: 'command', command: 'mi-linea' }, SCRIPT)
  assert.deepEqual(envolverStatusline(una, SCRIPT), una)
  assert.ok(JSON.stringify(una).includes(STATUSLINE_MARKER))
})

test('sin statusline solo captura; lo que no es de comando no se toca', () => {
  assert.deepEqual(envolverStatusline(undefined, SCRIPT), { type: 'command', command: 'node "C:/Users/yo/AppData/Roaming/Sloth/sloth-statusline.cjs"' })
  const rara = { type: 'otra', valor: 1 }
  assert.equal(envolverStatusline(rara, SCRIPT), rara)
})

function correrScript(original: string | null, entrada: string, env: Record<string, string | undefined>): { salida: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sloth-sl-'))
  const script = join(dir, 'sloth-statusline.cjs')
  writeFileSync(script, STATUSLINE_SCRIPT)
  const args = [script]
  if (original) args.push(Buffer.from(original).toString('base64url'))
  const limpio: Record<string, string | undefined> = { ...process.env, MSYSTEM: undefined, EXEPATH: undefined, SLOTH_WS: undefined, CLAUDE_CONFIG_DIR: undefined, ...env }
  const r = spawnSync(process.execPath, args, { input: entrada, encoding: 'utf8', env: limpio as NodeJS.ProcessEnv, timeout: 20_000 })
  return { salida: r.stdout, dir }
}

const ENTRADA = JSON.stringify({ model: { display_name: 'Opus' }, rate_limits: { five_hour: { used_percentage: 72.5, resets_at: 1894000000 } } })

test('el script guarda los límites solo si lo lanzó Sloth y devuelve la salida de la statusline original', { skip: process.platform !== 'win32' }, () => {
  const conSloth = correrScript('Write-Output "hola desde powershell"', ENTRADA, { SLOTH_WS: 'w1', CLAUDE_CONFIG_DIR: undefined })
  try {
    assert.equal(conSloth.salida.trim(), 'hola desde powershell')
  } finally {
    rmSync(conSloth.dir, { recursive: true, force: true })
  }
  const dir = mkdtempSync(join(tmpdir(), 'sloth-cuenta-'))
  try {
    const r = correrScript(null, ENTRADA, { SLOTH_WS: 'w1', CLAUDE_CONFIG_DIR: dir })
    rmSync(r.dir, { recursive: true, force: true })
    assert.equal(r.salida, '')
    const j = JSON.parse(readFileSync(join(dir, LIMITES_ARCHIVO), 'utf8')) as { fiveHour: unknown; sevenDay: unknown }
    assert.deepEqual(j.fiveHour, { pct: 72.5, resetsAt: 1894000000 })
    assert.equal(j.sevenDay, null)
    rmSync(join(dir, LIMITES_ARCHIVO))
    const sinSloth = correrScript(null, ENTRADA, { CLAUDE_CONFIG_DIR: dir })
    rmSync(sinSloth.dir, { recursive: true, force: true })
    assert.equal(existsSync(join(dir, LIMITES_ARCHIVO)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('con Git Bash (MSYSTEM y EXEPATH) corre el original en ese bash, con la misma entrada', { skip: !existsSync('C:\\Program Files\\Git\\bin\\bash.exe') }, () => {
  const r = correrScript('read -r j; printf "bash vio: %s" "${j:0:9}"', ENTRADA, { MSYSTEM: 'MINGW64', EXEPATH: 'C:\\Program Files\\Git\\bin' })
  try {
    assert.equal(r.salida, 'bash vio: {"model":')
  } finally {
    rmSync(r.dir, { recursive: true, force: true })
  }
})
