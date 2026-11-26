// Compila el daemon en Rust (native/daemon) a out/daemon/sloth-daemon.exe. Es opcional: sin cargo o fuera
// de Windows se avisa y la app usa el daemon de Node (out/daemon/sloth-daemon.cjs).
// Con el toolchain GNU (rustup en otra unidad) hace falta mingw con dlltool en el PATH; si el enlazado
// pide -lgcc_eh, una libgcc_eh.a vacía en una carpeta aparte y RUSTFLAGS="-L <carpeta>" lo resuelve.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const crate = join(root, 'native', 'daemon')
const out = join(root, 'out', 'daemon', 'sloth-daemon.exe')

if (process.platform !== 'win32') {
  console.log('daemon rust: solo en Windows, se usa el de Node')
  process.exit(0)
}
const cargo = process.env.CARGO_HOME ? join(process.env.CARGO_HOME, 'bin', 'cargo.exe') : 'cargo'
if (spawnSync(cargo, ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.log('daemon rust: no hay cargo, se usa el de Node')
  process.exit(0)
}
execFileSync(cargo, ['build', '--release', '--manifest-path', join(crate, 'Cargo.toml')], { stdio: 'inherit' })
mkdirSync(dirname(out), { recursive: true })
copyFileSync(join(crate, 'target', 'release', 'sloth-daemon.exe'), out)
if (!existsSync(out)) throw new Error(`Falta ${out}`)
console.log(`daemon rust: ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`)
