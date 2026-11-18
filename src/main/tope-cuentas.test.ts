import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { motivoNoAgregar } from '../shared/proveedores'
import { cuentasEnOtrosPerfiles } from './tope-cuentas'

function conPerfiles(estados: Record<string, string | undefined>, fn: (carpeta: string) => void): void {
  const raiz = mkdtempSync(join(tmpdir(), 'sloth-tope-'))
  try {
    const carpeta = join(raiz, 'perfiles')
    for (const [id, texto] of Object.entries(estados)) {
      mkdirSync(join(carpeta, id), { recursive: true })
      if (texto !== undefined) writeFileSync(join(carpeta, id, 'sloth-state.json'), texto)
    }
    fn(carpeta)
  } finally {
    rmSync(raiz, { recursive: true, force: true })
  }
}

const estado = (...proveedores: (string | undefined)[]): string =>
  JSON.stringify({ version: 1, accounts: proveedores.map((proveedor, i) => ({ id: `c${i}`, ...(proveedor ? { proveedor } : {}) })) })

test('cuenta las de Copilot de los otros perfiles y no las del propio ni las de otros agentes', () => {
  conPerfiles({ principal: estado('copilot'), 'p-b': estado('copilot', 'codex', undefined), 'p-c': estado('codex') }, (c) => {
    const avisos: string[] = []
    assert.equal(cuentasEnOtrosPerfiles(c, 'principal', 'copilot', (m) => avisos.push(m)), 1)
    assert.equal(cuentasEnOtrosPerfiles(c, 'p-b', 'copilot', (m) => avisos.push(m)), 1)
    assert.equal(cuentasEnOtrosPerfiles(c, 'p-c', 'copilot', (m) => avisos.push(m)), 2)
    assert.deepEqual(avisos, [])
  })
})

test('sin carpeta de perfiles, sin estado o con un estado roto no cuenta y solo avisa lo que no es un archivo ausente', () => {
  const avisos: string[] = []
  assert.equal(cuentasEnOtrosPerfiles(join(tmpdir(), 'sloth-no-existe-tope'), 'principal', 'copilot', (m) => avisos.push(m)), 0)
  conPerfiles({ vacio: undefined, roto: '{roto', raro: '[1,2]', sinLista: '{"accounts":3}', bien: estado('copilot') }, (c) => {
    assert.equal(cuentasEnOtrosPerfiles(c, 'principal', 'copilot', (m) => avisos.push(m)), 1)
  })
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /perfil roto/)
})

test('un proveedor que esta versión no conoce no cuenta como Copilot', () => {
  conPerfiles({ a: estado('otro-agente') }, (c) => {
    assert.equal(cuentasEnOtrosPerfiles(c, 'principal', 'copilot', () => undefined), 0)
  })
})

test('el tope de Copilot vale entre perfiles: con una cuenta en otro perfil no se puede sumar otra acá', () => {
  conPerfiles({ principal: estado(), 'p-b': estado('copilot') }, (c) => {
    const otros = cuentasEnOtrosPerfiles(c, 'principal', 'copilot', () => undefined)
    assert.match(motivoNoAgregar([], 'copilot', otros) ?? '', /en otro perfil/)
    assert.equal(motivoNoAgregar([], 'claude', otros), undefined)
  })
})

test('un perfil borrado (su carpeta ya no está) libera el tope', () => {
  conPerfiles({ principal: estado() }, (c) => {
    assert.equal(motivoNoAgregar([], 'copilot', cuentasEnOtrosPerfiles(c, 'principal', 'copilot', () => undefined)), undefined)
  })
})
