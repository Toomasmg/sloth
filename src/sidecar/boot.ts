/**
 * Primer módulo del proceso de apoyo: arma el puente con Rust y el shim de `electron` antes de que
 * se evalúe el main. stdout queda reservado para el protocolo; todo lo demás va a stderr.
 */
import { Rpc } from './rpc'
import { iniciar } from './electron-shim'

const aStderr =
  (nivel: string) =>
  (...args: unknown[]): void => {
    process.stderr.write(`[${nivel}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`)
  }
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
