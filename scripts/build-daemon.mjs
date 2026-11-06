// Compila src/daemon/index.ts a UN archivo CJS autónomo (out/daemon/sloth-daemon.cjs) que corre
// con el `node` del sistema. Sin code-splitting; la única dependencia en runtime es node-pty, que el
// daemon carga por ruta absoluta (no se bundlea).
import { build } from 'rolldown'
import { builtinModules } from 'node:module'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const outFile = join(root, 'out', 'daemon', 'sloth-daemon.cjs')

await build({
  input: join(root, 'src', 'daemon', 'index.ts'),
  platform: 'node',
  external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'node-pty'],
  logLevel: 'warn',
  output: {
    file: outFile,
    format: 'cjs',
    codeSplitting: false,
    sourcemap: false,
    minify: false,
    banner: `'use strict';\nvar __SLOTH_DAEMON_VERSION__ = ${JSON.stringify(pkg.version)};`
  }
})

console.log(`daemon: ${outFile} (${(statSync(outFile).size / 1024).toFixed(1)} KB, v${pkg.version})`)
