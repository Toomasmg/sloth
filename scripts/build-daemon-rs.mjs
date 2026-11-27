// Compila los ejecutables en Rust de native/: el daemon de terminales (out/daemon/sloth-daemon.exe) y el de los hooks
// de Claude Code y Codex (out/daemon/sloth-hook.exe). Es opcional: sin cargo, fuera de Windows o si falla se avisa y
// la app usa el daemon de Node y los scripts de Node (out/daemon/sloth-daemon.cjs).
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const destino = join(root, 'out', 'daemon')
const piezas = [
  { crate: 'daemon', exe: 'sloth-daemon.exe' },
  { crate: 'helper', exe: 'sloth-hook.exe' }
]

// Un .exe de una compilación anterior no se empaqueta si esta vez no se pudo compilar.
const sinRust = (motivo) => {
  for (const p of piezas) {
    try {
      rmSync(join(destino, p.exe), { force: true })
    } catch {
      // En uso por un proceso vivo: queda el anterior, que se reemplaza al relanzar.
    }
  }
  console.log(`rust: ${motivo}, se usan los de Node`)
  process.exit(0)
}

if (process.platform !== 'win32') sinRust('solo en Windows')
const cargo = process.env.CARGO_HOME ? join(process.env.CARGO_HOME, 'bin', 'cargo.exe') : 'cargo'
if (spawnSync(cargo, ['--version'], { stdio: 'ignore' }).status !== 0) sinRust('no hay cargo')
mkdirSync(destino, { recursive: true })
for (const p of piezas) {
  const crate = join(root, 'native', p.crate)
  const build = spawnSync(cargo, ['build', '--release', '--manifest-path', join(crate, 'Cargo.toml'), '--message-format=short'], { stdio: 'inherit' })
  if (build.status !== 0) sinRust(`falló la compilación de ${p.crate}`)
  const exe = join(process.env.CARGO_TARGET_DIR || join(crate, 'target'), 'release', p.exe)
  if (!existsSync(exe)) sinRust(`no está ${exe}`)
  try {
    copyFileSync(exe, join(destino, p.exe))
  } catch (e) {
    // EBUSY: un proceso vivo corre desde out/. No se pisa; se verá en el próximo build.
    console.log(`rust: no se pudo copiar ${p.exe} (${e.code ?? e.message}), queda el anterior`)
    continue
  }
  console.log(`rust: ${join(destino, p.exe)} (${(statSync(join(destino, p.exe)).size / 1024).toFixed(0)} KB)`)
}
