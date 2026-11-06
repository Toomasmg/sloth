// Publica una versión de Sloth en GitHub Releases (Toomasmg/sloth).
// electron-builder --publish crea la release dos veces en paralelo y falla; por eso compilamos sin
// publicar y subimos con `gh`. Requiere `gh` logueado. Uso: subir "version" en package.json y
// correr `npm run release`.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

// npm/npx son .cmd en Windows y necesitan shell; gh es un .exe y va sin shell (si no, parte los textos con espacios).
const run = (cmd, args) =>
  execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx') })
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
