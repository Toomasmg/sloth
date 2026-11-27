/**
 * Primer módulo del proceso de apoyo: arma el puente con Rust y el shim de `electron` antes de que
 * se evalúe el main. stdout queda reservado para el protocolo; todo lo demás va a stderr.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Rpc } from './rpc'
import { iniciar } from './electron-shim'

// La cáscara de Tauri no tiene consola: lo que sale por stderr también queda en userData/logs/sidecar.log.
const carpetaLogs = join(process.env.SLOTH_USER_DATA || join(process.env.APPDATA ?? '.', 'Sloth'), 'logs')
const archivoLog = join(carpetaLogs, 'sidecar.log')
try {
  mkdirSync(carpetaLogs, { recursive: true })
} catch {
  // Sin permisos o sin disco: queda solo stderr.
}
const aLog = (texto: string): void => {
  process.stderr.write(texto)
  try {
    appendFileSync(archivoLog, `${new Date().toISOString()} ${texto}`)
  } catch {
    // El log es una ayuda: si no se puede escribir, no frena nada.
  }
}
const aStderr =
  (nivel: string) =>
  (...args: unknown[]): void => {
    aLog(`[${nivel}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`)
  }
const textoDe = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e))
process.on('uncaughtException', (e) => aLog(`[fatal] ${textoDe(e)}\n`))
process.on('unhandledRejection', (e) => aLog(`[rechazo] ${textoDe(e)}\n`))
console.log = aStderr('log')
console.info = aStderr('info')
console.debug = aStderr('debug')
console.warn = aStderr('warn')

const rpc = new Rpc((linea) => process.stdout.write(linea))
iniciar(rpc)

;(process as unknown as { resourcesPath: string }).resourcesPath = process.env.SLOTH_RESOURCES ?? process.cwd()

process.stdin.setEncoding('utf8')
process.stdin.on('data', (trozo: string) => rpc.recibir(trozo))
// Si la cáscara se va, el proceso de apoyo no puede quedar suelto.
process.stdin.on('end', () => process.exit(0))
