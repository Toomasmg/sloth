import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCOUNT_PALETTE,
  applyPatch,
  canonicalCombo,
  cloneSettings,
  DEFAULT_SETTINGS,
  MAX_ACCOUNT_COLORS,
  MAX_PLAN,
  MAX_SHORTCUTS,
  normalize,
  parseCombo,
  resetSection,
  resolveDark,
  SECTIONS,
  SHORTCUT_IDS
} from './settings-model'

const D = DEFAULT_SETTINGS

test('normalize de algo que no es objeto da los valores por defecto, en copia', () => {
  for (const v of [null, undefined, 3, 'x', [], true]) assert.deepEqual(normalize(v), D)
  const a = normalize(null)
  a.terminal.fontSize = 99
  assert.equal(D.terminal.fontSize, 12.5)
})

test('normalize conserva lo válido y descarta campo por campo lo inválido', () => {
  const s = normalize({ theme: 'claro', uiFontSize: 99, editor: 'Cursor', terminal: { fontSize: 14, shell: 'zsh' }, notify: { done: false, perm: 'sí' } })
  assert.equal(s.theme, 'claro')
  assert.equal(s.uiFontSize, D.uiFontSize)
  assert.equal(s.editor, 'Cursor')
  assert.equal(s.terminal.fontSize, 14)
  assert.equal(s.terminal.shell, D.terminal.shell)
  assert.equal(s.notify.done, false)
  assert.equal(s.notify.perm, true)
})

test('normalize ignora campos desconocidos y claves viejas', () => {
  const s = normalize({ tema: 'claro', foo: 1, terminal: { viejo: 1 }, shortcuts: { fantasma: 'Ctrl K' } })
  assert.deepEqual(s, D)
  assert.equal('foo' in s, false)
})

test('normalize limita la cantidad de colores y planes', () => {
  const colors: Record<string, string> = {}
  const plans: Record<string, string> = {}
  for (let i = 0; i < 200; i++) {
    colors[`c${i}`] = ACCOUNT_PALETTE[0].hex
    plans[`c${i}`] = 'Pro'
  }
  const s = normalize({ accountColors: colors, accountPlans: plans })
  assert.equal(Object.keys(s.accountColors).length, MAX_ACCOUNT_COLORS)
  assert.equal(Object.keys(s.accountPlans).length, MAX_ACCOUNT_COLORS)
})

test('normalize canoniza atajos y descarta los inválidos', () => {
  const s = normalize({ shortcuts: { palette: 'ctrl shift k', new: 'K', help: null } })
  assert.deepEqual(s.shortcuts, { palette: 'Ctrl Shift K' })
})

test('applyPatch rechaza lo que no es objeto y las claves desconocidas', () => {
  for (const p of [null, 1, 'x', []]) assert.throws(() => applyPatch(D, p), /objeto/)
  assert.throws(() => applyPatch(D, { nope: 1 }), /desconocido: nope/)
  assert.throws(() => applyPatch(D, { terminal: { nope: 1 } }), /terminal\.nope/)
  assert.throws(() => applyPatch(D, { notify: { nope: 1 } }), /notify\.nope/)
})

test('applyPatch no muta el original y no aplica nada a medias', () => {
  const before = JSON.stringify(D)
  const n = applyPatch(D, { theme: 'claro' })
  assert.equal(n.theme, 'claro')
  assert.equal(JSON.stringify(D), before)
  assert.throws(() => applyPatch(D, { theme: 'claro', uiFontSize: 1 }))
  assert.equal(JSON.stringify(D), before)
})

test('applyPatch valida enteros en rango', () => {
  assert.equal(applyPatch(D, { uiFontSize: 12 }).uiFontSize, 12)
  assert.equal(applyPatch(D, { uiFontSize: 16 }).uiFontSize, 16)
  for (const v of [11, 17, 13.5, '13', NaN, Infinity, null]) assert.throws(() => applyPatch(D, { uiFontSize: v }))
  assert.throws(() => applyPatch(D, { terminal: { fontSize: 10 } }))
  assert.throws(() => applyPatch(D, { terminal: { scrollback: 999 } }))
  assert.equal(applyPatch(D, { terminal: { scrollback: 20000 } }).terminal.scrollback, 20000)
})

test('applyPatch valida listas cerradas y booleanos', () => {
  assert.throws(() => applyPatch(D, { theme: 'rojo' }))
  assert.throws(() => applyPatch(D, { editor: 3 }))
  assert.throws(() => applyPatch(D, { sounds: 'si' }))
  assert.throws(() => applyPatch(D, { updateChannel: 'nightly' }))
  assert.equal(applyPatch(D, { updateChannel: 'beta' }).updateChannel, 'beta')
  assert.throws(() => applyPatch(D, { sleepAfterMin: 20 }))
  assert.equal(applyPatch(D, { sleepAfterMin: 60 }).sleepAfterMin, 60)
})

test('applyPatch acepta la altura de línea en pasos de 0.05 y rechaza el resto', () => {
  assert.equal(applyPatch(D, { terminal: { lineHeight: 1.2 } }).terminal.lineHeight, 1.2)
  assert.equal(applyPatch(D, { terminal: { lineHeight: 1.15 } }).terminal.lineHeight, 1.15)
  for (const v of [1.22, 0.95, 1.45, '1.2', NaN]) assert.throws(() => applyPatch(D, { terminal: { lineHeight: v } }))
})

test('applyPatch fusiona terminal y notify campo por campo', () => {
  const n = applyPatch(D, { terminal: { cursorBlink: false }, notify: { team: false } })
  assert.equal(n.terminal.cursorBlink, false)
  assert.equal(n.terminal.fontFamily, D.terminal.fontFamily)
  assert.equal(n.notify.team, false)
  assert.equal(n.notify.done, true)
})

test('applyPatch: colores de cuenta con paleta, minúsculas, quitar con null y accountExists', () => {
  const hex = ACCOUNT_PALETTE[1].hex
  assert.equal(applyPatch(D, { accountColors: { a1: hex.toUpperCase() } }).accountColors.a1, hex)
  assert.throws(() => applyPatch(D, { accountColors: { a1: '#000000' } }), /paleta/)
  assert.throws(() => applyPatch(D, { accountColors: { 'a b': hex } }), /Id/)
  assert.throws(() => applyPatch(D, { accountColors: { a1: hex } }, { accountExists: () => false }), /no existe/)
  const withColor = applyPatch(D, { accountColors: { a1: hex } })
  assert.deepEqual(applyPatch(withColor, { accountColors: { a1: null } }, { accountExists: () => false }).accountColors, {})
})

test('applyPatch: planes recortados, vacío o null los quita, largo y control rechazados', () => {
  assert.equal(applyPatch(D, { accountPlans: { a1: '  Max ' } }).accountPlans.a1, 'Max')
  const withPlan = applyPatch(D, { accountPlans: { a1: 'Pro' } })
  assert.deepEqual(applyPatch(withPlan, { accountPlans: { a1: '' } }).accountPlans, {})
  assert.deepEqual(applyPatch(withPlan, { accountPlans: { a1: null } }).accountPlans, {})
  assert.throws(() => applyPatch(D, { accountPlans: { a1: 'x'.repeat(MAX_PLAN + 1) } }))
  assert.throws(() => applyPatch(D, { accountPlans: { a1: 'a\nb' } }))
  assert.throws(() => applyPatch(D, { accountPlans: { a1: 3 } }))
})

test('applyPatch: tope de cupo entero, 0 o null lo quita, fuera de rango rechazado', () => {
  const con = applyPatch(D, { accountCupos: { a1: 2_500_000 } })
  assert.equal(con.accountCupos.a1, 2_500_000)
  assert.deepEqual(applyPatch(con, { accountCupos: { a1: null } }).accountCupos, {})
  assert.deepEqual(applyPatch(con, { accountCupos: { a1: 0 } }).accountCupos, {})
  for (const malo of [-1, 1.5, 2e9, '5', Number.NaN]) assert.throws(() => applyPatch(D, { accountCupos: { a1: malo } }), String(malo))
  assert.throws(() => applyPatch(D, { accountCupos: { 'a b': 5 } }))
  assert.throws(() => applyPatch(D, { accountCupos: { a1: 5 } }, { accountExists: () => false }))
})

test('normalize: un archivo viejo sin accountCupos queda con el mapa vacío, y uno con topes inválidos los descarta', () => {
  assert.deepEqual(normalize({ theme: 'claro' }).accountCupos, {})
  assert.deepEqual(normalize({ accountCupos: { a: 100, b: 'x', c: -3 } }).accountCupos, { a: 100 })
})

test('applyPatch: demasiados colores falla', () => {
  const c: Record<string, string> = {}
  for (let i = 0; i <= MAX_ACCOUNT_COLORS; i++) c[`c${i}`] = ACCOUNT_PALETTE[0].hex
  assert.throws(() => applyPatch(D, { accountColors: c }), /Demasiados/)
})

test('applyPatch: projectsDir recorta y rechaza largos y caracteres de control', () => {
  assert.equal(applyPatch(D, { projectsDir: '  C:\\Dev ' }).projectsDir, 'C:\\Dev')
  assert.throws(() => applyPatch(D, { projectsDir: 'x'.repeat(261) }))
  assert.throws(() => applyPatch(D, { projectsDir: 'a\u0000b' }))
  assert.throws(() => applyPatch(D, { projectsDir: 5 }))
})

test('applyPatch: atajos válidos, null quita, desconocidos y combos malos fallan', () => {
  const n = applyPatch(D, { shortcuts: { palette: 'alt k' } })
  assert.deepEqual(n.shortcuts, { palette: 'Alt K' })
  assert.deepEqual(applyPatch(n, { shortcuts: { palette: null } }).shortcuts, {})
  assert.throws(() => applyPatch(D, { shortcuts: { fantasma: 'Ctrl K' } }), /desconocido/)
  assert.throws(() => applyPatch(D, { shortcuts: { palette: 'K' } }), /no es válida/)
  assert.throws(() => applyPatch(D, { shortcuts: { palette: 5 } }), /no es válida/)
  assert.ok(MAX_SHORTCUTS >= SHORTCUT_IDS.length)
})

test('parseCombo y canonicalCombo', () => {
  assert.equal(canonicalCombo('shift ctrl k'), 'Ctrl Shift K')
  assert.equal(canonicalCombo('  Ctrl   Alt  F5 '), 'Ctrl Alt F5')
  assert.equal(canonicalCombo('F2'), 'F2')
  assert.equal(canonicalCombo('Ctrl ←'), 'Ctrl ←')
  assert.equal(canonicalCombo('Ctrl Shift ,'), 'Ctrl Shift ,')
  for (const v of ['', ' ', 'Ctrl', 'Shift K', 'Ctrl Ctrl K', 'Ctrl Meta K', 'Ctrl F13', 'Ctrl Escape', 'F13', 'Ctrl K L']) assert.equal(parseCombo(v), null, v)
  assert.deepEqual(parseCombo('ctrl Enter'), { ctrl: true, alt: false, shift: false, key: 'Enter' })
})

test('parseCombo normaliza la tecla sin importar mayúsculas', () => {
  assert.deepEqual(parseCombo('ctrl enter'), { ctrl: true, alt: false, shift: false, key: 'Enter' })
  assert.deepEqual(parseCombo('alt pageup'), { ctrl: false, alt: true, shift: false, key: 'PageUp' })
  assert.deepEqual(parseCombo('ctrl f5'), { ctrl: true, alt: false, shift: false, key: 'F5' })
  assert.deepEqual(parseCombo('f5'), { ctrl: false, alt: false, shift: false, key: 'F5' })
  assert.equal(parseCombo('ctrl f13'), null)
  assert.equal(parseCombo('ctrl esc'), null)
})

test('resetSection restaura solo su sección', () => {
  const s = applyPatch(D, { theme: 'claro', terminal: { fontSize: 16 }, updateChannel: 'beta', editor: 'Cursor', shortcuts: { palette: 'Ctrl K' } })
  const a = resetSection(s, 'apariencia')
  assert.equal(a.theme, 'oscuro')
  assert.equal(a.editor, 'Cursor')
  assert.equal(resetSection(s, 'terminal').terminal.fontSize, D.terminal.fontSize)
  assert.equal(resetSection(s, 'updates').updateChannel, 'estable')
  assert.deepEqual(resetSection(s, 'atajos').shortcuts, {})
  assert.equal(resetSection(s, 'atajos').theme, 'claro')
  assert.equal(resetSection(s, 'general').editor, 'VS Code')
  assert.equal(s.theme, 'claro')
})

test('resetSection acepta todas las secciones y rechaza otras', () => {
  for (const sec of SECTIONS) assert.doesNotThrow(() => resetSection(D, sec))
  for (const v of ['nada', null, 3, undefined]) assert.throws(() => resetSection(D, v), /Sección/)
})

test('resetSection de todas las secciones deja los valores por defecto', () => {
  let s = applyPatch(D, { theme: 'noche', sounds: true, noMolestar: true, notify: { done: false }, accountPlans: { a: 'Pro' }, lightMode: true })
  for (const sec of SECTIONS) s = resetSection(s, sec)
  assert.deepEqual(s, D)
})

test('cloneSettings es una copia profunda', () => {
  const c = cloneSettings(D)
  c.notify.done = false
  c.shortcuts.palette = 'Ctrl K'
  assert.equal(D.notify.done, true)
  assert.deepEqual(D.shortcuts, {})
})

test('resolveDark', () => {
  assert.equal(resolveDark('claro', true), false)
  assert.equal(resolveDark('oscuro', false), true)
  assert.equal(resolveDark('noche', false), true)
  assert.equal(resolveDark('sistema', true), true)
  assert.equal(resolveDark('sistema', false), false)
})

test('los colores de la paleta son hex únicos', () => {
  const hex = ACCOUNT_PALETTE.map((c) => c.hex)
  assert.equal(new Set(hex).size, hex.length)
  for (const h of hex) assert.match(h, /^#[0-9a-f]{6}$/)
})

test('rendimiento: valida RAM y núcleos de cada perfil, y 0 es sin límite', () => {
  const s = applyPatch(D, { rendimiento: { enchufada: { ramMB: 8192, nucleos: 8 }, bateriaDistinta: true } })
  assert.deepEqual(s.rendimiento.enchufada, { ramMB: 8192, nucleos: 8 })
  assert.equal(s.rendimiento.bateriaDistinta, true)
  assert.deepEqual(applyPatch(s, { rendimiento: { bateria: { nucleos: 2 } } }).rendimiento.bateria, { ramMB: 0, nucleos: 2 })
  assert.equal(applyPatch(s, { rendimiento: { enchufada: { ramMB: 0 } } }).rendimiento.enchufada.ramMB, 0)
  for (const bad of [{ enchufada: { ramMB: 1024 } }, { enchufada: { ramMB: 2048.5 } }, { bateria: { nucleos: -1 } }, { bateria: { nucleos: 65 } }, { bateria: { otro: 1 } }, { turbo: true }, { bateriaDistinta: 'sí' }])
    assert.throws(() => applyPatch(D, { rendimiento: bad }))
  assert.equal(D.rendimiento.enchufada.ramMB, 0)
})

test('rendimiento: normalize descarta campo por campo y reset vuelve a sin límites', () => {
  const s = normalize({ rendimiento: { enchufada: { ramMB: 500, nucleos: 4 }, bateria: 'x', bateriaDistinta: true } })
  assert.deepEqual(s.rendimiento, { enchufada: { ramMB: 0, nucleos: 4 }, bateria: { ramMB: 0, nucleos: 0 }, bateriaDistinta: true })
  assert.deepEqual(resetSection(s, 'rendimiento').rendimiento, D.rendimiento)
  const c = cloneSettings(s)
  c.rendimiento.enchufada.nucleos = 1
  assert.equal(s.rendimiento.enchufada.nucleos, 4)
})
