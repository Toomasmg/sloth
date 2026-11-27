// Compila el main de Sloth a UN archivo CJS (out/sidecar/sloth-sidecar.cjs) que corre con el `node` del
// sistema sin Electron: `electron` y `electron-updater` se reemplazan por los shims de src/sidecar.
// node-pty queda externo (se carga desde node_modules).
import { build } from 'rolldown'
import { builtinModules } from 'node:module'
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Vite resuelve `x?raw` como el texto del archivo; acá lo hace este plugin.
const raw = {
  name: 'raw',
  resolveId(id, importer) {
    if (!id.endsWith('?raw')) return null
    const base = id.slice(0, -4)
    const req = createRequire(importer ?? join(root, 'package.json'))
    return `${req.resolve(base)}?raw`
  },
  load(id) {
    if (!id.endsWith('?raw')) return null
    return `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`
  }
}

const outFile = join(root, 'out', 'sidecar', 'sloth-sidecar.cjs')

await build({
  input: join(root, 'src', 'sidecar', 'entry.ts'),
  platform: 'node',
  external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'node-pty'],
  resolve: {
    alias: {
      electron: join(root, 'src', 'sidecar', 'electron-shim.ts'),
      'electron-updater': join(root, 'src', 'sidecar', 'updater-shim.ts')
    }
  },
  plugins: [raw],
  logLevel: 'warn',
  output: { file: outFile, format: 'cjs', codeSplitting: false, sourcemap: false, minify: false }
})

console.log(`sidecar: ${outFile} (${(statSync(outFile).size / 1024).toFixed(0)} KB)`)
