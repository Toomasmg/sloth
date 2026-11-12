// Publica una versión de Sloth en GitHub Releases (Toomasmg/sloth).
// electron-builder --publish crea la release dos veces en paralelo y falla; por eso compilamos sin
// publicar y subimos con `gh`. Requiere `gh` logueado. Uso: subir "version" en package.json y
// correr `npm run release`.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// npm y npx son .cmd en Windows y execFileSync no los corre sin shell (y `shell: true` con args da DEP0190):
// se llama a node con el script JS de npm. gh es un .exe y va directo.
const npmCli = (nombre) => {
  const junto = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', `${nombre}-cli.js`)
  if (existsSync(junto)) return junto
  const deNpm = process.env.npm_execpath
  const hermano = deNpm && join(dirname(deNpm), `${nombre}-cli.js`)
  if (hermano && existsSync(hermano)) return hermano
  throw new Error(`No encuentro ${nombre}-cli.js junto a node (${process.execPath}).`)
}
const run = (cmd, args) =>
  process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx')
    ? execFileSync(process.execPath, [npmCli(cmd), ...args], { stdio: 'inherit' })
    : execFileSync(cmd, args, { stdio: 'inherit' })
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = `v${version}`
const files = [`dist/Sloth-Setup-${version}.exe`, `dist/Sloth-Setup-${version}.exe.blockmap`, 'dist/latest.yml']

run('npm', ['run', 'build'])
run('npx', ['electron-builder', '--win', 'nsis', '--publish', 'never'])
for (const f of files) if (!existsSync(f)) throw new Error(`Falta ${f}`)

let exists = true
try {
  execFileSync('gh', ['release', 'view', tag, '-R', 'Toomasmg/sloth'], { stdio: 'ignore' })
} catch {
  exists = false
}
if (exists) run('gh', ['release', 'upload', tag, ...files, '-R', 'Toomasmg/sloth', '--clobber'])
else run('gh', ['release', 'create', tag, ...files, '-R', 'Toomasmg/sloth', '--title', `Sloth ${version}`, '--notes', `Sloth ${version}. Instalá Sloth-Setup-${version}.exe; las próximas versiones se actualizan solas.`])
console.log(`Publicado ${tag}`)
