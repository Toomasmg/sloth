import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Accion } from '../../../shared/tickets'
import { validarConector, type ConectorGh } from './conector'
import github from './conectores/github'
import { ghAccion, ghDetalle, ghLista, ghYo, repoValido, type GhOut, type GhRun } from './gh'
import type { AccionInput } from './motor'

const GH = validarConector(github) as ConectorGh
const ME = { id: 'tomy', nombre: 'tomy' }

interface Llamada {
  args: string[]
  input?: string
}

/** Un `gh` falso que anota cada llamada y responde `out`. */
function falso(out: Partial<GhOut> = {}): { run: GhRun; llamadas: Llamada[] } {
  const llamadas: Llamada[] = []
  const run: GhRun = async (args, input) => {
    llamadas.push(input === undefined ? { args } : { args, input })
    return { code: 0, stdout: '', stderr: '', ...out }
  }
  return { run, llamadas }
}

const accion = async (a: Accion, i: Partial<AccionInput>, me = ME as typeof ME | undefined): Promise<Llamada[]> => {
  const f = falso()
  await ghAccion(f.run, { proyecto: 'octo-1/repo.x' }, a, { ticket: '42', ...i }, me)
  return f.llamadas
}

test('repoValido solo acepta dueño/repo', () => {
  assert.equal(repoValido('octo/hola.mundo'), 'octo/hola.mundo')
  for (const malo of ['-x/y', 'a/b c', 'a/b/c', '.a/b', 'a/-b', '', 'a', 3, null]) assert.throws(() => repoValido(malo), /dueño\/repo/, String(malo))
})

test('ghYo lee el login', async () => {
  const f = falso({ stdout: 'tomy\n' })
  assert.deepEqual(await ghYo(f.run), { id: 'tomy', nombre: 'tomy' })
  assert.deepEqual(f.llamadas, [{ args: ['api', 'user', '--jq', '.login'] }])
  await assert.rejects(ghYo(falso({ stdout: '--admin' }).run), /no entiendo/)
})

test('ghLista pide los issues abiertos y los valida', async () => {
  const issues = [
    {
      number: 7,
      title: 'Arreglar\nel login',
      url: 'https://github.com/o/r/issues/7',
      assignees: [{ login: '--admin' }, { login: 'tomy' }],
      labels: [{ name: 'bug' }, { name: 'P1' }],
      body: 'Línea uno\r\nLínea dos‮'
    },
    { number: 8, title: 'Sin url de GitHub', url: 'https://evil.com/github.com/x', assignees: [], labels: [], body: '' },
    { number: 0, title: 'id cero' },
    { number: 1.5, title: 'id con coma' },
    { number: '9', title: 'id texto' },
    { number: 12345678, title: 'id largo' },
    null
  ]
  const f = falso({ stdout: JSON.stringify(issues) })
  const tickets = await ghLista(f.run, GH, 'o/r')
  assert.deepEqual(f.llamadas, [
    { args: ['issue', 'list', '--repo', 'o/r', '--state', 'open', '--limit', '200', '--json', 'number,title,assignees,labels,url,body'] }
  ])
  assert.deepEqual(tickets, [
    {
      id: '7',
      titulo: 'Arreglar el login',
      estado: 'abierto',
      proyecto: 'o/r',
      url: 'https://github.com/o/r/issues/7',
      responsable: 'tomy',
      responsableId: 'tomy',
      prioridad: 'P1',
      descripcion: 'Línea uno Línea dos'
    },
    { id: '8', titulo: 'Sin url de GitHub', estado: 'abierto', proyecto: 'o/r' }
  ])
})

test('ghLista no corre gh con un repo inválido y no acepta cualquier salida', async () => {
  const f = falso()
  await assert.rejects(ghLista(f.run, GH, '-x/y'), /dueño\/repo/)
  assert.equal(f.llamadas.length, 0)
  await assert.rejects(ghLista(falso({ stdout: 'no es json' }).run, GH, 'o/r'), { message: 'gh devolvió algo que no entiendo.' })
  await assert.rejects(ghLista(falso({ stdout: '{}' }).run, GH, 'o/r'), { message: 'gh devolvió algo que no entiendo.' })
})

test('ghDetalle trae los comentarios', async () => {
  const comments = [
    { author: { login: 'ana' }, body: 'Hola', createdAt: '2026-11-10T10:00:00Z' },
    { author: null, body: 'Sin autor' },
    { author: { login: 'x' }, body: '' }
  ]
  const f = falso({ stdout: JSON.stringify({ comments }) })
  assert.deepEqual(await ghDetalle(f.run, { id: '7', proyecto: 'o/r' }), {
    criterios: [],
    comentarios: [
      { autor: 'ana', cuerpo: 'Hola', fecha: '2026-11-10T10:00:00Z' },
      { autor: 'Sin nombre', cuerpo: 'Sin autor' }
    ],
    minutos: null
  })
  assert.deepEqual(f.llamadas, [{ args: ['issue', 'view', '7', '--repo', 'o/r', '--json', 'comments'] }])
  await assert.rejects(ghDetalle(falso().run, { id: '1;x', proyecto: 'o/r' }), /número/)
})

test('ghAccion arma los argumentos exactos de cada acción', async () => {
  const base = ['--repo', 'octo-1/repo.x']
  assert.deepEqual(await accion('estado', { estado: 'cerrado' }), [{ args: ['issue', 'close', '42', ...base] }])
  assert.deepEqual(await accion('estado', { estado: 'abierto' }), [{ args: ['issue', 'reopen', '42', ...base] }])
  assert.deepEqual(await accion('tomar', { persona: 'tomy' }), [{ args: ['issue', 'edit', '42', ...base, '--add-assignee', 'tomy'] }])
  assert.deepEqual(await accion('soltar', { persona: null }), [{ args: ['issue', 'edit', '42', ...base, '--remove-assignee', 'tomy'] }])
  assert.deepEqual(await accion('comentar', { cuerpo: 'Listo' }), [{ args: ['issue', 'comment', '42', ...base, '--body-file', '-'], input: 'Listo' }])
})

test('el cuerpo del comentario va solo por stdin', async () => {
  const cuerpo = '--foo; rm -rf /'
  const [l] = await accion('comentar', { cuerpo })
  assert.equal(l.input, cuerpo)
  assert.ok(l.args.every((a) => !a.includes('--foo') && !a.includes('rm -rf')))
})

test('ghAccion valida todo antes de correr gh', async () => {
  const casos: Array<[string, Accion, Partial<AccionInput>, typeof ME | undefined, RegExp]> = [
    ['id con punto y coma', 'estado', { ticket: '1;x', estado: 'cerrado' }, ME, /número/],
    ['id cero', 'estado', { ticket: '0', estado: 'cerrado' }, ME, /número/],
    ['id negativo', 'estado', { ticket: '-1', estado: 'cerrado' }, ME, /número/],
    ['otro estado', 'estado', { estado: 'en_curso' }, ME, /flujo de GitHub Issues/],
    ['login que es una opción', 'tomar', { persona: '--admin' }, ME, /usuario de GitHub/],
    ['soltar sin saber quién soy', 'soltar', { persona: null }, undefined, /usuario de GitHub/],
    ['soltar con un login raro', 'soltar', { persona: null }, { id: '--admin', nombre: 'x' }, /usuario de GitHub/],
    ['comentario vacío', 'comentar', { cuerpo: '  ' }, ME, /vacío/],
    ['criterio', 'criterio', { criterioId: 'x', hecho: true }, ME, /GitHub no permite esa acción desde Sloth\./],
    ['horas', 'horas', { minutos: 30 }, ME, /GitHub no permite esa acción desde Sloth\./]
  ]
  for (const [nombre, a, i, me, motivo] of casos) {
    const f = falso()
    await assert.rejects(ghAccion(f.run, { proyecto: 'o/r' }, a, { ticket: '42', ...i }, me), motivo, nombre)
    assert.equal(f.llamadas.length, 0, nombre)
  }
  const f = falso()
  for (const proyecto of ['a/b c', undefined, '--repo=x/y']) {
    await assert.rejects(ghAccion(f.run, { proyecto }, 'estado', { ticket: '42', estado: 'cerrado' }, ME), /de qué repo/, String(proyecto))
    await assert.rejects(ghDetalle(f.run, { id: '42', proyecto }), /de qué repo/, String(proyecto))
  }
  assert.equal(f.llamadas.length, 0)
})

test('el detalle y las escrituras van al repo de donde salió el issue', async () => {
  const f = falso({ stdout: '{"comments":[]}' })
  const t = { id: '7', proyecto: 'dueno/repo-a' }
  await ghDetalle(f.run, t)
  await ghAccion(f.run, t, 'estado', { ticket: '7', estado: 'cerrado' }, ME)
  await ghAccion(f.run, t, 'comentar', { ticket: '7', cuerpo: 'Hola' }, ME)
  for (const l of f.llamadas) assert.equal(l.args[l.args.indexOf('--repo') + 1], 'dueno/repo-a', l.args.join(' '))
  assert.equal(f.llamadas.length, 3)
})

test('los errores de gh se explican', async () => {
  const casos: Array<[Partial<GhOut>, string]> = [
    [{ missing: true, code: -1 }, 'No encontré GitHub CLI (gh). Instalalo y corré `gh auth login`.'],
    [{ code: 1, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }, 'gh no tiene sesión iniciada: corré `gh auth login`.'],
    [{ code: 4, stderr: 'HTTP 401: Bad credentials' }, 'gh no tiene sesión iniciada: corré `gh auth login`.'],
    [{ timedOut: true, code: -1 }, 'gh tardó demasiado.'],
    [{ code: 1, stderr: '\n\u001b[31mGraphQL: Could not resolve to an issue\u001b[0m\nmás' }, '[31mGraphQL: Could not resolve to an issue [0m'],
    [{ code: 2, stderr: '' }, 'gh terminó con código 2.']
  ]
  for (const [out, msg] of casos) await assert.rejects(ghYo(falso(out).run), { message: msg })
  await assert.rejects(ghYo(falso({ code: 1, stderr: 'x'.repeat(500) }).run), (e: Error) => e.message.length === 200)
})
