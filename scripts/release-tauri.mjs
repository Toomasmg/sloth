// Publica Sloth (versión Tauri) en GitHub Releases. Uso: subir "version" en package.json y correr
// `npm run release:tauri` (o con --sin-subir para dejar los archivos en dist-tauri/ sin publicar).
// Requiere: cargo con MSVC, gh logueado y la clave del updater en TAURI_SIGNING_PRIVATE_KEY (ruta o texto).
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPO, latestJson, latestYml, nombreElectron, nombreTauri } from './release-tauri-core.mjs'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const sinSubir = process.argv.includes('--sin-subir')
const { version } = JSON.parse(readFileSync(join(raiz, 'package.json'), 'utf8'))
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) throw new Error('Falta TAURI_SIGNING_PRIVATE_KEY (la clave privada del updater).')

const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const correr = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: raiz, ...opts })
const npm = (...args) => correr(process.execPath, [npmCli, ...args])

npm('run', 'build')
npm('run', 'build:sidecar')
correr(process.execPath, [join(raiz, 'scripts', 'prepare-tauri.mjs')])
npm('exec', '--', 'tauri', 'build', '--bundles', 'nsis')

const bundle = join(raiz, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
const instalador = join(bundle, nombreTauri(version))
for (const f of [instalador, `${instalador}.sig`]) if (!existsSync(f)) throw new Error(`Falta ${f}`)

const salida = join(raiz, 'dist-tauri')
mkdirSync(salida, { recursive: true })
const fecha = new Date().toISOString()
const bytes = readFileSync(instalador)
const firma = readFileSync(`${instalador}.sig`, 'utf8').trim()
copyFileSync(instalador, join(salida, nombreTauri(version)))
copyFileSync(instalador, join(salida, nombreElectron(version)))
copyFileSync(`${instalador}.sig`, join(salida, `${nombreTauri(version)}.sig`))
writeFileSync(join(salida, 'latest.json'), JSON.stringify(latestJson({ version, notas: `Sloth ${version}`, firma, fecha }), null, 2))
writeFileSync(join(salida, 'latest.yml'), latestYml({ version, bytes, fecha }))

const archivos = [nombreTauri(version), `${nombreTauri(version)}.sig`, nombreElectron(version), 'latest.json', 'latest.yml'].map((f) => join(salida, f))
if (sinSubir) {
  console.log(`Armado en ${salida} (sin subir)`)
  process.exit(0)
}
const tag = `v${version}`
let existe = true
try {
  execFileSync('gh', ['release', 'view', tag, '-R', REPO], { stdio: 'ignore' })
} catch {
  existe = false
}
if (existe) correr('gh', ['release', 'upload', tag, ...archivos, '-R', REPO, '--clobber'])
else correr('gh', ['release', 'create', tag, ...archivos, '-R', REPO, '--title', `Sloth ${version}`, '--notes', `Sloth ${version}. Instalá ${nombreElectron(version)}; las próximas versiones se actualizan solas.`])
console.log(`Publicado ${tag}`)
