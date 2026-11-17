import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSummary,
  copyConversation,
  latestSession,
  projectDirOf,
  projectSlug,
  sanitizeSummary,
  SUMMARY_MAX,
  UUID_RE
} from './move-account-core'

const ID = '11111111-2222-3333-4444-555555555555'
const ID2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const CWD = 'C:\\Users\\yo\\repo'

async function conTmp(fn: (from: string, to: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'sloth-move-'))
  try {
    const from = join(base, 'a')
    const to = join(base, 'b')
    await mkdir(from)
    await mkdir(to)
    await fn(from, to)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function escribirSesion(config: string, id: string, contenido: string, mtime?: number): Promise<string> {
  const dir = projectDirOf(config, CWD)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  await writeFile(file, contenido)
  if (mtime !== undefined) await utimes(file, mtime, mtime)
  return file
}

test('projectSlug reemplaza todo lo no alfanumérico por guiones', () => {
  assert.equal(projectSlug('C:\\Users\\yo\\mi repo'), 'C--Users-yo-mi-repo')
  assert.equal(projectSlug('/home/ñu/x.y'), '-home--u-x-y')
})

test('UUID_RE acepta uuids y rechaza ids con rutas o de largo raro', () => {
  assert.ok(UUID_RE.test(ID))
  assert.ok(UUID_RE.test(ID.toUpperCase()))
  for (const mal of ['', 'abc', '../' + ID, ID + '/..', ID + '\n', `${ID}.jsonl`, '1111111-2222-3333-4444-555555555555']) {
    assert.ok(!UUID_RE.test(mal), mal)
  }
})

test('latestSession elige la conversación más reciente e ignora lo que no es una sesión', async () => {
  await conTmp(async (from) => {
    await escribirSesion(from, ID, 'vieja', 1000)
    await escribirSesion(from, ID2, 'nueva', 2000)
    const dir = projectDirOf(from, CWD)
    await writeFile(join(dir, 'notas.jsonl'), 'x')
    await writeFile(join(dir, 'a1111111-2222-3333-4444-555555555555.txt'), 'x')
    await writeFile(join(dir, 'ffffffff-2222-3333-4444-555555555555.jsonl'), '')
    await mkdir(join(dir, '99999999-2222-3333-4444-555555555555.jsonl'))
    const best = await latestSession(dir)
    assert.equal(best?.sessionId, ID2)
    assert.equal(best?.file, join(dir, `${ID2}.jsonl`))
  })
})

test('latestSession devuelve undefined si la carpeta no existe o no hay sesiones', async () => {
  await conTmp(async (from) => {
    assert.equal(await latestSession(projectDirOf(from, CWD)), undefined)
    await mkdir(projectDirOf(from, CWD), { recursive: true })
    assert.equal(await latestSession(projectDirOf(from, CWD)), undefined)
  })
})

test('copyConversation copia la conversación y su carpeta, y deja el origen intacto', async () => {
  await conTmp(async (from, to) => {
    await escribirSesion(from, ID, 'hola')
    const sub = join(projectDirOf(from, CWD), ID, 'subagents')
    await mkdir(sub, { recursive: true })
    await writeFile(join(sub, 'a.jsonl'), 'sub')
    const r = await copyConversation(from, to, CWD, ID)
    assert.deepEqual(r, { copied: true, dirCopied: true })
    assert.equal(await readFile(join(projectDirOf(to, CWD), `${ID}.jsonl`), 'utf8'), 'hola')
    assert.equal(await readFile(join(projectDirOf(to, CWD), ID, 'subagents', 'a.jsonl'), 'utf8'), 'sub')
    assert.equal(await readFile(join(projectDirOf(from, CWD), `${ID}.jsonl`), 'utf8'), 'hola')
  })
})

test('copyConversation sin carpeta homónima no la inventa', async () => {
  await conTmp(async (from, to) => {
    await escribirSesion(from, ID, 'hola')
    const r = await copyConversation(from, to, CWD, ID)
    assert.equal(r.dirCopied, false)
    assert.deepEqual(await readdir(projectDirOf(to, CWD)), [`${ID}.jsonl`])
  })
})

test('copyConversation con la misma copia ya en el destino no la duplica ni hace respaldo', async () => {
  await conTmp(async (from, to) => {
    await escribirSesion(from, ID, 'hola', 1000)
    await copyConversation(from, to, CWD, ID)
    const r = await copyConversation(from, to, CWD, ID)
    assert.equal(r.copied, false)
    assert.equal(r.backup, undefined)
    assert.deepEqual(await readdir(projectDirOf(to, CWD)), [`${ID}.jsonl`])
  })
})

test('copyConversation con otro contenido en el destino lo respalda en vez de pisarlo', async () => {
  await conTmp(async (from, to) => {
    await escribirSesion(to, ID, 'del destino, distinto')
    await escribirSesion(from, ID, 'del origen')
    const r = await copyConversation(from, to, CWD, ID)
    assert.equal(r.copied, true)
    assert.ok(r.backup)
    assert.ok(r.backup.includes(`${ID}.jsonl.sloth-`) && r.backup.endsWith('.bak'))
    assert.equal(await readFile(r.backup, 'utf8'), 'del destino, distinto')
    assert.equal(await readFile(join(projectDirOf(to, CWD), `${ID}.jsonl`), 'utf8'), 'del origen')
  })
})

test('copyConversation no pisa lo que ya hay en la carpeta del destino', async () => {
  await conTmp(async (from, to) => {
    await escribirSesion(from, ID, 'hola')
    const srcSub = join(projectDirOf(from, CWD), ID)
    await mkdir(srcSub, { recursive: true })
    await writeFile(join(srcSub, 'x.txt'), 'origen')
    await writeFile(join(srcSub, 'nuevo.txt'), 'nuevo')
    const dstSub = join(projectDirOf(to, CWD), ID)
    await mkdir(dstSub, { recursive: true })
    await writeFile(join(dstSub, 'x.txt'), 'destino')
    await copyConversation(from, to, CWD, ID)
    assert.equal(await readFile(join(dstSub, 'x.txt'), 'utf8'), 'destino')
    assert.equal(await readFile(join(dstSub, 'nuevo.txt'), 'utf8'), 'nuevo')
  })
})

test('copyConversation rechaza ids inválidos o con rutas y no escribe nada', async () => {
  await conTmp(async (from, to) => {
    await escribirSesion(from, ID, 'hola')
    for (const mal of ['', '../../../etc/passwd', `..\\${ID}`, ID + '/..', 'no-es-uuid']) {
      await assert.rejects(copyConversation(from, to, CWD, mal), /Id de conversación inválido/, mal)
    }
    assert.deepEqual(await readdir(to), [])
  })
})

test('copyConversation falla si la conversación no existe en el origen', async () => {
  await conTmp(async (from, to) => {
    await assert.rejects(copyConversation(from, to, CWD, ID), { code: 'ENOENT' })
  })
})

test('copyConversation deja cada cwd en su carpeta (no mezcla proyectos)', async () => {
  await conTmp(async (from, to) => {
    await escribirSesion(from, ID, 'hola')
    await copyConversation(from, to, CWD, ID)
    assert.equal(await latestSession(projectDirOf(to, 'C:\\otro\\repo')), undefined)
  })
})

test('buildSummary nombra el espacio, la carpeta y la rama', () => {
  const s = buildSummary({ name: 'api', cwd: CWD, branch: 'feat/x', changes: 3 })
  assert.match(s, /«api»/)
  assert.ok(s.includes(`carpeta ${CWD}, rama feat/x`))
  assert.match(s, /Hay 3 archivos con cambios sin confirmar/)
})

test('buildSummary sin rama y con cada cantidad de cambios', () => {
  const sinRama = buildSummary({ name: 'a', cwd: CWD, branch: null, changes: 0 })
  assert.ok(sinRama.includes(`(carpeta ${CWD})`))
  assert.match(sinRama, /No hay cambios sin confirmar/)
  assert.match(buildSummary({ name: 'a', cwd: CWD, branch: null, changes: 1 }), /Hay 1 archivo con cambios/)
  assert.match(buildSummary({ name: 'a', cwd: CWD, branch: null, changes: -1 }), /No pude leer los cambios/)
})

test('sanitizeSummary saca caracteres de control, conserva saltos de línea y recorta', () => {
  assert.equal(sanitizeSummary('  hola\u0000 mundo\u001b[31m\nchau\u007f  '), 'hola mundo[31m\nchau')
  assert.equal(sanitizeSummary('a\tb'), 'a\tb')
})

test('sanitizeSummary rechaza lo que no es texto y lo demasiado largo', () => {
  for (const mal of [undefined, null, 5, {}, ['a']]) assert.throws(() => sanitizeSummary(mal), /tiene que ser texto/)
  assert.equal(sanitizeSummary('a'.repeat(SUMMARY_MAX)).length, SUMMARY_MAX)
  assert.throws(() => sanitizeSummary('a'.repeat(SUMMARY_MAX + 1)), /demasiado largo/)
})
