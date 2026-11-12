import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SURFACE } from './surfaces'

const css = readFileSync(new URL('../renderer/src/tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

function surfaceDe(selector: string): string | undefined {
  const i = css.indexOf(`${selector} {`)
  assert.ok(i >= 0, `falta el bloque ${selector}`)
  const cuerpo = css.slice(css.indexOf('{', i) + 1, css.indexOf('\n}', i))
  return /(?:^|[;\s])--surface\s*:\s*([^;]+);/.exec(cuerpo)?.[1]?.trim()
}

test('SURFACE coincide con --surface de cada tema de tokens.css', () => {
  assert.equal(surfaceDe(':root'), SURFACE.dark)
  assert.equal(surfaceDe("html[data-theme='light']"), SURFACE.light)
  assert.equal(surfaceDe("html[data-night='true']:not([data-theme='light'])"), SURFACE.night)
})
