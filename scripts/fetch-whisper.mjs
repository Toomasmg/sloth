// Baja el binario de whisper.cpp (Windows x64) al vendor/whisper que va al instalador (extraResources).
// Versión fija y verificada con SHA-256: si no coincide, falla. El modelo NO se baja acá: lo baja la app
// la primera vez que se dicta (src/main/dictado-modelo.ts). Nunca se borra lo que ya hay en vendor/whisper.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = {
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
  sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb'
}
// Solo lo que necesita whisper-cli: sin demos, tests ni modelos.
const KEEP = /^(whisper-cli\.exe|whisper\.dll|ggml(-[a-z0-9-]+)?\.dll)$/i

const out = join(import.meta.dirname, '..', 'vendor', 'whisper')
const exe = join(out, 'whisper-cli.exe')
const stampFile = join(out, 'version.txt')
const stamp = `${BIN.sha256}\n`

if (process.platform !== 'win32') {
  console.log('whisper: solo se empaqueta para Windows; se saltea.')
  process.exit(0)
}
if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp && existsSync(exe)) {
  console.log('whisper: ya está.')
  process.exit(0)
}

class HashError extends Error {}

async function download(url, sha256) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`whisper: ${url} respondió ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = createHash('sha256').update(buf).digest('hex')
  if (got !== sha256) throw new HashError(`whisper: el SHA-256 de ${url} no coincide (${got})`)
  return buf
}

console.log('whisper: bajando el binario…')
let zipBuf
try {
  zipBuf = await download(BIN.url, BIN.sha256)
} catch (e) {
  // Un hash que no coincide nunca se tapa: solo la falta de red con un binario ya bajado.
  if (e instanceof HashError || !existsSync(exe)) throw e
  console.warn('whisper: sin red, se usa el binario que ya estaba.')
  process.exit(0)
}

const zip = join(tmpdir(), `sloth-whisper-${process.pid}.zip`)
const unz = join(tmpdir(), `sloth-whisper-${process.pid}`)
const stage = `${out}.tmp`
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
writeFileSync(zip, zipBuf)
mkdirSync(unz, { recursive: true })
// El tar.exe de Windows 10+ (bsdtar) abre .zip; por ruta completa, no el de Git Bash (GNU, no puede).
execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', unz])
const rel = join(unz, 'Release')
const archivos = readdirSync(rel).filter((f) => KEEP.test(f))
for (const f of archivos) copyFileSync(join(rel, f), join(stage, f))
rmSync(zip, { force: true })
rmSync(unz, { recursive: true, force: true })
if (!existsSync(join(stage, 'whisper-cli.exe'))) throw new Error('whisper: el zip no trae whisper-cli.exe')

mkdirSync(out, { recursive: true })
for (const f of archivos) copyFileSync(join(stage, f), join(out, f))
rmSync(stage, { recursive: true, force: true })
writeFileSync(`${stampFile}.tmp`, stamp)
renameSync(`${stampFile}.tmp`, stampFile)
console.log(`whisper: ${archivos.length} archivos del binario.`)
console.log('whisper: listo.')
