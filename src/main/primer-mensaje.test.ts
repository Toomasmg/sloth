import { test } from 'node:test'
import assert from 'node:assert/strict'
import { avisoPrimerMensajeAMano, destinoPrimerMensaje } from './primer-mensaje'
import { PROVEEDORES } from './proveedores'
import { shellLaunch, type ShellFamily } from './shell-args'

const FAMILIAS: ShellFamily[] = ['ps', 'cmd', 'posix']
const EXES = [undefined, 'C:\\bin\\codex.cmd', 'C:\\bin\\codex.exe']

test('un agente sin hooks nunca deja un pegado pendiente: o el mensaje va por argumento o se avisa', () => {
  const codex = PROVEEDORES.codex
  for (const prompt of ['Revisá el ticket PROJ-12', 'exec', '--x\n"y" & z']) {
    for (const f of FAMILIAS) {
      for (const exe of EXES) {
        const l = shellLaunch(f, codex.argvInteractivo({ prompt }), exe)
        const destino = destinoPrimerMensaje(codex.capacidades.hooks, l.paste)
        assert.notEqual(destino, 'pegar', `${f} ${exe}`)
        assert.equal(destino, l.paste === undefined ? 'ninguno' : 'a-mano', `${f} ${exe}`)
      }
    }
  }
})

test('con Codex en cmd o con codex.cmd el mensaje no llega solo y se avisa; con codex.exe en ps y posix va por argumento', () => {
  const argv = PROVEEDORES.codex.argvInteractivo({ prompt: 'Revisá el ticket PROJ-12' })
  const hooks = PROVEEDORES.codex.capacidades.hooks
  assert.equal(destinoPrimerMensaje(hooks, shellLaunch('cmd', argv, 'C:\\bin\\codex.exe').paste), 'a-mano')
  assert.equal(destinoPrimerMensaje(hooks, shellLaunch('ps', argv, 'C:\\bin\\codex.cmd').paste), 'a-mano')
  assert.equal(destinoPrimerMensaje(hooks, shellLaunch('posix', argv, undefined).paste), 'a-mano')
  assert.equal(destinoPrimerMensaje(hooks, shellLaunch('ps', argv, 'C:\\bin\\codex.exe').paste), 'ninguno')
  assert.equal(destinoPrimerMensaje(hooks, shellLaunch('posix', argv, 'C:\\bin\\codex.exe').paste), 'ninguno')
})

test('con Claude (hooks) el pegado sigue como antes', () => {
  assert.equal(destinoPrimerMensaje(PROVEEDORES.claude.capacidades.hooks, 'hola'), 'pegar')
  assert.equal(destinoPrimerMensaje(true, undefined), 'ninguno')
})

test('el aviso nombra el agente y el espacio y no lleva el mensaje', () => {
  assert.equal(avisoPrimerMensajeAMano('Codex', 'Mi espacio'), 'Codex no recibe el primer mensaje solo en «Mi espacio»: escribilo a mano.')
})
