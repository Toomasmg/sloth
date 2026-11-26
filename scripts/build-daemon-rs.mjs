// Compila el daemon en Rust (native/daemon) a out/daemon/sloth-daemon.exe. Es opcional: sin cargo, fuera de
// Windows o si la compilación falla se avisa y la app usa el daemon de Node (out/daemon/sloth-daemon.cjs).
// Con el toolchain GNU hace falta mingw con dlltool en el PATH; si el enlazado pide -lgcc_eh, una
// libgcc_eh.a vacía en una carpeta aparte y RUSTFLAGS="-L <carpeta>" lo resuelve.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const crate = join(root, 'native', 'daemon')
const out = join(root, 'out', 'daemon', 'sloth-daemon.exe')

// Un .exe de una compilación anterior no se empaqueta si esta vez no se pudo compilar.
const sinRust = (motivo) => {
  try {
    rmSync(out, { force: true })
  } catch {
    // En uso por un daemon vivo: queda el anterior, que el cliente reemplaza al relanzar.
  }
  console.log(`daemon rust: ${motivo}, se usa el de Node`)
  process.exit(0)
}

if (process.platform !== 'win32') sinRust('solo en Windows')
const cargo = process.env.CARGO_HOME ? join(process.env.CARGO_HOME, 'bin', 'cargo.exe') : 'cargo'
if (spawnSync(cargo, ['--version'], { stdio: 'ignore' }).status !== 0) sinRust('no hay cargo')
const build = spawnSync(cargo, ['build', '--release', '--manifest-path', join(crate, 'Cargo.toml'), '--message-format=short'], { stdio: 'inherit' })
if (build.status !== 0) sinRust('falló la compilación')
const target = process.env.CARGO_TARGET_DIR || join(crate, 'target')
const exe = join(target, 'release', 'sloth-daemon.exe')
if (!existsSync(exe)) sinRust(`no está ${exe}`)
mkdirSync(dirname(out), { recursive: true })
try {
  copyFileSync(exe, out)
} catch (e) {
  // EBUSY: un daemon vivo está corriendo desde out/. No se pisa; se verá en el próximo build.
  console.log(`daemon rust: no se pudo copiar (${e.code ?? e.message}), queda el anterior`)
  process.exit(0)
}
console.log(`daemon rust: ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`)
