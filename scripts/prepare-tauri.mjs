// Arma lo que el instalador de Tauri lleva además del ejecutable: el node del sistema (sidecar externo),
// el main compilado, los daemons, node-pty recortado, el ícono y Whisper. Todo queda en src-tauri/stage
// con la misma forma que tenía resources/ en Electron, así el main encuentra todo donde lo busca.
// También pasa la versión de package.json a tauri.conf.json.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tauri = join(root, 'src-tauri')
const stage = join(tauri, 'stage')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const confPath = join(tauri, 'tauri.conf.json')
const conf = JSON.parse(readFileSync(confPath, 'utf8'))
if (conf.version !== pkg.version) {
  conf.version = pkg.version
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n')
  console.log(`tauri.conf.json: versión ${pkg.version}`)
}

const necesita = (ruta, como) => {
  if (!existsSync(ruta)) throw new Error(`Falta ${ruta} (${como})`)
  return ruta
}

rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, 'sidecar'), { recursive: true })
mkdirSync(join(stage, 'daemon'), { recursive: true })

cpSync(necesita(join(root, 'out', 'sidecar', 'sloth-sidecar.cjs'), 'npm run build:sidecar'), join(stage, 'sidecar', 'sloth-sidecar.cjs'))
cpSync(necesita(join(root, 'out', 'daemon', 'sloth-daemon.cjs'), 'npm run build:daemon'), join(stage, 'daemon', 'sloth-daemon.cjs'))
cpSync(necesita(join(root, 'out', 'daemon', 'sloth-daemon.exe'), 'npm run build:daemon-rs'), join(stage, 'daemon', 'sloth-daemon.exe'))
cpSync(necesita(join(root, 'build', 'icon.png'), 'ícono'), join(stage, 'icon.png'))

// node-pty sin fuentes ni prebuilds de otras plataformas (como excluía electron-builder). Va en dos lugares:
// donde lo resuelve el main (resources/node_modules) y de donde lo copia el lanzador del daemon de Node.
const pty = necesita(join(root, 'node_modules', 'node-pty'), 'npm ci')
const sobra = ['src', 'deps', 'third_party', 'scripts', 'typings', 'build']
const filtroPty = (origen) => {
  const rel = origen.slice(pty.length).split(sep).filter(Boolean)
  if (rel.length === 1 && sobra.includes(rel[0])) return false
  if (rel[0] === 'prebuilds' && rel.length >= 2 && rel[1] !== 'win32-x64') return false
  return !/\.(pdb|md|ts|map)$/.test(origen)
}
for (const destino of [join(stage, 'node_modules', 'node-pty'), join(stage, 'app.asar.unpacked', 'node_modules', 'node-pty')]) {
  cpSync(pty, destino, { recursive: true, filter: filtroPty })
}

const whisper = join(root, 'vendor', 'whisper')
if (existsSync(whisper)) {
  cpSync(whisper, join(stage, 'whisper'), { recursive: true, filter: (o) => !/\.(bin|part)$/.test(o) })
} else {
  console.log('whisper: sin vendor/whisper (npm run build:whisper); el dictado no va en este instalador')
}

// El proceso de apoyo corre con este mismo node: el instalador lo lleva al lado del ejecutable (externalBin).
const bin = join(tauri, 'binaries')
mkdirSync(bin, { recursive: true })
cpSync(process.execPath, join(bin, 'node-x86_64-pc-windows-msvc.exe'))

console.log(`tauri: recursos en ${stage}`)
