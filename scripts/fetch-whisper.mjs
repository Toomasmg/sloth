// Baja whisper.cpp (binario para Windows x64) y el modelo «small» al vendor/whisper que va al
// instalador (extraResources). Versiones fijas y verificadas con SHA-256: si algo no coincide, falla.
// Si ya está todo y el sello coincide, no baja nada.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = {
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
  sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb'
}
const MODEL = {
  name: 'ggml-small-q5_1.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
  sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'
}
// Solo lo que necesita whisper-cli: sin demos, tests ni otros modelos.
const KEEP = /^(whisper-cli\.exe|whisper\.dll|ggml(-[a-z0-9-]+)?\.dll)$/i

const out = join(import.meta.dirname, '..', 'vendor', 'whisper')
const stampFile = join(out, 'version.txt')
const stamp = `${BIN.sha256}\n${MODEL.sha256}\n`

if (process.platform !== 'win32') {
  console.log('whisper: solo se empaqueta para Windows; se saltea.')
  process.exit(0)
}
if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp && existsSync(join(out, 'whisper-cli.exe')) && existsSync(join(out, MODEL.name))) {
  console.log('whisper: ya está.')
  process.exit(0)
}

async function download(url, sha256) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`whisper: ${url} respondió ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = createHash('sha256').update(buf).digest('hex')
  if (got !== sha256) throw new Error(`whisper: el SHA-256 de ${url} no coincide (${got})`)
  return buf
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

console.log('whisper: bajando el binario…')
const zip = join(tmpdir(), `sloth-whisper-${process.pid}.zip`)
const unz = join(tmpdir(), `sloth-whisper-${process.pid}`)
writeFileSync(zip, await download(BIN.url, BIN.sha256))
mkdirSync(unz, { recursive: true })
// El tar.exe de Windows 10+ (bsdtar) abre .zip; por ruta completa, no el de Git Bash (GNU, no puede).
execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', unz])
const rel = join(unz, 'Release')
let n = 0
for (const f of readdirSync(rel)) {
  if (!KEEP.test(f)) continue
  copyFileSync(join(rel, f), join(out, f))
  n++
}
rmSync(zip, { force: true })
rmSync(unz, { recursive: true, force: true })
if (!existsSync(join(out, 'whisper-cli.exe'))) throw new Error('whisper: el zip no trae whisper-cli.exe')
console.log(`whisper: ${n} archivos del binario.`)

console.log('whisper: bajando el modelo (182 MB)…')
writeFileSync(join(out, MODEL.name), await download(MODEL.url, MODEL.sha256))
writeFileSync(stampFile, stamp)
console.log('whisper: listo.')
