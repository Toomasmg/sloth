// Lint de CSS del rediseño: font-size, border-radius y z-index con valores sueltos y colores literales
// (fuera de tokens.css). Solo mira lo nuevo respecto de origin/staging: un archivo nuevo entero, y en un
// archivo tocado las líneas con infracción que no estaban antes (mover una línea de un archivo a otro no cuenta).
// Para dejar pasar un caso justificado: /* lint-css-ok: motivo */ en la misma línea.
// Uso: node scripts/lint-css.mjs [--base=<ref>] [--todo: cuenta todo el CSS sin mirar la base]   (también LINT_CSS_BASE; por defecto origin/staging)
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const baseArg = process.argv.find((a) => a.startsWith('--base='))?.slice(7)
const baseRef = baseArg ?? process.env.LINT_CSS_BASE ?? 'origin/staging'
const ARCHIVO_DE_TOKENS = 'tokens.css'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const REGLAS = [
  { id: 'font-size', msg: 'font-size en px: usá un token --fs-*', re: /(?:^|[;{\s])font(?:-size)?\s*:[^;}]*\d(?:\.\d+)?px/ },
  { id: 'border-radius', msg: 'border-radius en px: usá un token --r-*', re: /border(?:-[a-z]+)*-radius\s*:[^;}]*\d(?:\.\d+)?px/ },
  { id: 'z-index', msg: 'z-index suelto: usá un token --z-*', re: /(?:^|[;{\s])z-index\s*:\s*(?!0\b|-1\b)-?\d/ },
  { id: 'color', msg: 'color literal: usá un token de color', re: /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch)\((?![^)]*var\()|:[^;{}]*\b(?:white|black)\b/, soloDeclaraciones: true }
]

function sinComentarios(texto) {
  const lineas = texto.split('\n')
  let dentro = false
  return lineas.map((linea) => {
    let sal = ''
    let i = 0
    while (i < linea.length) {
      if (dentro) {
        const f = linea.indexOf('*/', i)
        if (f === -1) return sal
        dentro = false
        i = f + 2
      } else {
        const a = linea.indexOf('/*', i)
        if (a === -1) { sal += linea.slice(i); break }
        sal += linea.slice(i, a)
        dentro = true
        i = a + 2
      }
    }
    return sal
  })
}

function infracciones(ruta, texto) {
  if (basename(ruta) === ARCHIVO_DE_TOKENS) return []
  const crudas = texto.split('\n')
  const limpias = sinComentarios(texto)
  const out = []
  limpias.forEach((linea, i) => {
    if (/lint-css-ok/.test(crudas[i] ?? '')) return
    const t = linea.trim()
    if (!t) return
    const esSelector = /[{,]$/.test(t)
    for (const r of REGLAS) {
      if (r.soloDeclaraciones && esSelector) continue
      if (r.re.test(linea)) out.push({ ruta, linea: i + 1, regla: r, clave: `${r.id}|${t}` })
    }
  })
  return out
}

if (process.argv.includes('--todo')) {
  const todos = git('ls-files', '--', 'src/**/*.css').split('\n').filter(Boolean)
  const todas = todos.flatMap((ruta) => infracciones(ruta, readFileSync(ruta, 'utf8')))
  const porRegla = {}
  for (const v of todas) porRegla[v.regla.id] = (porRegla[v.regla.id] ?? 0) + 1
  for (const v of todas) process.stderr.write(`${v.ruta}:${v.linea}  ${v.regla.msg}\n`)
  process.stdout.write(`lint:css --todo: ${todas.length} infracciones en todo el CSS ${JSON.stringify(porRegla)}\n`)
  process.exit(todas.length ? 1 : 0)
}

let base
try {
  base = git('merge-base', baseRef, 'HEAD').trim()
} catch {
  process.stderr.write(`lint:css: no encuentro ${baseRef}. En CI, el checkout tiene que traer la historia (fetch-depth: 0).\n`)
  process.exit(2)
}

const cambios = git('diff', '--name-status', '--no-renames', base, '--', '*.css')
  .split('\n')
  .filter(Boolean)
  .map((l) => l.split('\t'))
const sinSeguimiento = git('ls-files', '--others', '--exclude-standard', '--', '*.css').split('\n').filter(Boolean)

const viejas = new Map()
const nuevas = []
for (const [estado, ruta] of cambios) {
  if (estado !== 'A') {
    for (const v of infracciones(ruta, git('show', `${base}:${ruta}`))) viejas.set(v.clave, (viejas.get(v.clave) ?? 0) + 1)
  }
  if (estado !== 'D') nuevas.push(...infracciones(ruta, readFileSync(ruta, 'utf8')))
}
for (const ruta of sinSeguimiento) nuevas.push(...infracciones(ruta, readFileSync(ruta, 'utf8')))

const fallas = nuevas.filter((v) => {
  const n = viejas.get(v.clave) ?? 0
  if (n > 0) {
    viejas.set(v.clave, n - 1)
    return false
  }
  return true
})

if (fallas.length) {
  for (const f of fallas) process.stderr.write(`${f.ruta}:${f.linea}  ${f.regla.msg}\n`)
  process.stderr.write(`\nlint:css: ${fallas.length} infracción(es) nueva(s) respecto de ${baseRef}.\n`)
  process.exit(1)
}
process.stdout.write(`lint:css: sin infracciones nuevas respecto de ${baseRef}.\n`)
