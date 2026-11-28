// Escribe src/shared/changelog.ts como JSON para la función «help» de Rust (la llama src-tauri/build.rs).
// Así el changelog tiene un solo dueño: el .ts que usan la UI y el main de Node.
// Uso: node scripts/changelog-json.mjs <salida.json>. Necesita Node >= 22.18 (type stripping).
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const salida = process.argv[2]
if (!salida) throw new Error('Falta la ruta de salida')
const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const { CHANGELOG } = await import(pathToFileURL(join(raiz, 'src', 'shared', 'changelog.ts')).href)
if (!Array.isArray(CHANGELOG) || CHANGELOG.length === 0) throw new Error('El changelog vino vacío')
writeFileSync(salida, JSON.stringify(CHANGELOG))
