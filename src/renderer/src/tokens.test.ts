import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

function bloque(selector: string): Map<string, string> {
  const i = css.indexOf(`${selector} {`)
  assert.ok(i >= 0, `falta el bloque ${selector}`)
  const cuerpo = css.slice(css.indexOf('{', i) + 1, css.indexOf('\n}', i))
  const out = new Map<string, string>()
  for (const m of cuerpo.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim())
  return out
}

const OSCURO = bloque(':root')
const CLARO = new Map([...OSCURO, ...bloque("html[data-theme='light']")])

function resolver(tema: Map<string, string>, nombre: string): string {
  let v = tema.get(nombre)
  assert.ok(v, `falta el token ${nombre}`)
  for (let n = 0; n < 10; n++) {
    const ref = /^var\((--[\w-]+)\)$/.exec(v)
    if (!ref) return v
    v = tema.get(ref[1]!)
    assert.ok(v, `falta el token ${ref[1]}`)
  }
  throw new Error(`referencia circular en ${nombre}`)
}

function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  assert.ok(m, `no es un hex de 6 dígitos: ${hex}`)
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function luminancia([r, g, b]: [number, number, number]): number {
  const c = [r, g, b].map((v) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}

function contraste(a: string, b: string): number {
  const [x, y] = [luminancia(rgb(a)), luminancia(rgb(b))].sort((p, q) => q - p)
  return (x! + 0.05) / (y! + 0.05)
}

// [texto o borde, fondo, mínimo]: 4,5 para texto y 3 para bordes de controles y foco (WCAG 1.4.3 y 1.4.11).
const TEXTO_SOBRE = ['--bg', '--surface', '--raised', '--overlay', '--sunken']
const PARES: [string, string, number][] = [
  ...TEXTO_SOBRE.flatMap((f): [string, string, number][] => [['--text', f, 4.5], ['--text-2', f, 4.5], ['--text-3', f, 4.5]]),
  ['--placeholder', '--raised', 4.5],
  ['--placeholder', '--bg', 4.5],
  ['--placeholder', '--input-bg', 4.5],
  ['--on-accent', '--accent', 4.5],
  ['--accent', '--bg', 4.5],
  ['--accent', '--raised', 4.5],
  ...['--waiting', '--done', '--danger', '--team'].flatMap((t): [string, string, number][] => [[t, '--bg', 4.5], [t, '--raised', 4.5]]),
  ['--control-border', '--raised', 3],
  ['--control-border', '--bg', 3],
  ['--control-border', '--input-bg', 3],
  ['--focus', '--bg', 3],
  ['--focus', '--raised', 3]
]

for (const [nombre, tema] of [['oscuro', OSCURO], ['claro', CLARO]] as const) {
  test(`contraste AA de los tokens (${nombre})`, () => {
    const fallas: string[] = []
    for (const [f, b, min] of PARES) {
      const r = contraste(resolver(tema, f), resolver(tema, b))
      if (r < min) fallas.push(`${f} sobre ${b}: ${r.toFixed(2)} (mínimo ${min})`)
    }
    assert.deepEqual(fallas, [])
  })
}

// Cada acento elegible, con su texto encima y como texto sobre el fondo de su tema.
for (const [tema, base, prefijo] of [
  ['oscuro', OSCURO, 'html'],
  ['claro', CLARO, "html[data-theme='light']"]
] as const) {
  for (const nombre of ['cielo', 'hoja', 'lila', 'ambar']) {
    test(`contraste AA del acento ${nombre} (${tema})`, () => {
      const t = new Map([...base, ...bloque(`${prefijo}[data-accent='${nombre}']`)])
      const a = resolver(t, '--accent')
      assert.ok(contraste(resolver(t, '--accent-fg'), a) >= 4.5, `texto sobre ${nombre}`)
      assert.ok(contraste(a, resolver(t, '--bg')) >= 4.5, `${nombre} como texto sobre --bg`)
    })
  }
}
