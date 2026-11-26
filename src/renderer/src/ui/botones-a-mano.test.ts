import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const RENDERER = fileURLToPath(new URL('..', import.meta.url))
const CLASE = /className="([^"]*)"/g
const DE_BOTON = new Set(['btn', 'g-btn-solid', 'g-btn-plain', 'g-btn-ghost', 'g-btn-danger'])

function fuentes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'ui' ? [] : fuentes(p)
    return p.endsWith('.tsx') ? [p] : []
  })
}

function aMano(src: string): number[] {
  const etiquetas = [...src.matchAll(/<([A-Za-z][\w.]*)/g)]
  const lineas: number[] = []
  for (const m of src.matchAll(CLASE)) {
    if (!m[1]!.split(/\s+/).some((t) => DE_BOTON.has(t))) continue
    const etiqueta = etiquetas.filter((t) => (t.index ?? 0) < (m.index ?? 0)).at(-1)?.[1]
    if (etiqueta === 'button') lineas.push(src.slice(0, m.index).split('\n').length)
  }
  return lineas
}

test('ningún <button> escrito a mano con la clase btn o g-btn-*: va <Button look="classic"> o <Button look="git">', () => {
  const sobran = fuentes(RENDERER).flatMap((f) => aMano(readFileSync(f, 'utf8')).map((l) => `${relative(RENDERER, f)}:${l}`))
  assert.deepEqual(sobran, [])
})

test('la detección marca el botón a mano y deja pasar el <a> y el <Button>', () => {
  assert.deepEqual(aMano('<div>\n<button type="button" className="btn sm">x</button>\n</div>'), [2])
  assert.deepEqual(aMano('<button\n  className="g-btn-plain"\n>x</button>'), [2])
  assert.deepEqual(aMano('<a className="btn sm" href="x">x</a>'), [])
  assert.deepEqual(aMano('<Button className="btn">x</Button>'), [])
  assert.deepEqual(aMano('<button className="icon-btn chip-btn">x</button>'), [])
})
