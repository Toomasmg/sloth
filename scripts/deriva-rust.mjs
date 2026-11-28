// Lista el TypeScript de src/main y src/shared que cambió desde el último punto en que Rust quedó al día
// (el commit de docs/migracion-rust-base.txt). Cada archivo que aparece acá tiene o va a tener un equivalente en
// native/: hay que portar el cambio antes de avanzar la base (`node scripts/deriva-rust.mjs --avanzar`).
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const ARCHIVO_BASE = new URL('../docs/migracion-rust-base.txt', import.meta.url)
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

const base = readFileSync(ARCHIVO_BASE, 'utf8').trim()
const destino = process.argv.includes('--avanzar') ? git('rev-parse', 'HEAD') : git('rev-parse', 'origin/staging')

if (process.argv.includes('--avanzar')) {
  writeFileSync(ARCHIVO_BASE, `${destino}\n`)
  console.log(`Base de Rust avanzada a ${destino.slice(0, 7)}.`)
  process.exit(0)
}

const ESPEJADOS = ['src/main', 'src/shared', 'src/preload']
const log = git('log', `${base}..${destino}`, '--format=%x01%h %an: %s', '--name-only', '--', ...ESPEJADOS)
const porArchivo = new Map()
for (const bloque of log.split('\x01').filter(Boolean)) {
  const [cabecera, ...archivos] = bloque.split('\n').filter(Boolean)
  for (const f of archivos) {
    if (/\.test\.ts$|\.json$|\.md$/.test(f)) continue
    porArchivo.set(f, [...(porArchivo.get(f) ?? []), cabecera])
  }
}

if (porArchivo.size === 0) {
  console.log(`Rust al día con ${destino.slice(0, 7)}: no hay cambios de TypeScript sin portar desde ${base.slice(0, 7)}.`)
} else {
  console.log(`TypeScript que cambió desde ${base.slice(0, 7)} y puede faltar en Rust:\n`)
  for (const [f, commits] of [...porArchivo].sort()) console.log(`${f}\n${commits.map((c) => `    ${c}`).join('\n')}`)
  process.exitCode = 1
}
