import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ENCABEZADO = `-- Generado por scripts/build-supabase-setup.mjs. No lo edites: editá las migraciones y corré
-- \`node scripts/build-supabase-setup.mjs\`. Es seguro correrlo más de una vez. Pegalo entero en el SQL Editor
-- de tu proyecto de Supabase.
`

export function construirSetup(carpeta) {
  const nombres = readdirSync(carpeta)
    .filter((n) => /^\d{4}_.*\.sql$/.test(n))
    .sort()
  let salida = ENCABEZADO
  for (const nombre of nombres) {
    const sql = readFileSync(join(carpeta, nombre), 'utf8').replaceAll('\r\n', '\n')
    salida += `\n-- ===== ${nombre} =====\n${sql.endsWith('\n') ? sql : sql + '\n'}`
  }
  return salida
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const destino = join(raiz, 'supabase', 'setup.sql')
  const tmp = destino + '.tmp'
  mkdirSync(dirname(destino), { recursive: true })
  writeFileSync(tmp, construirSetup(join(raiz, 'supabase', 'migrations')))
  renameSync(tmp, destino)
  process.stdout.write('supabase/setup.sql generado\n')
}
