// node-pty 1.1.0, al matar una terminal en Windows, lanza `conpty_console_list_agent` con
// child_process.fork sin windowsHide. El daemon corre sin consola, así que Windows le abre a ese
// proceso una ventana negra que parpadea. Este parche le agrega windowsHide; corre en postinstall.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ORIGINAL = "fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()])"
const PARCHEADO = "fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()], { windowsHide: true })"

export function parchear(texto) {
  if (texto.includes(PARCHEADO)) return { texto, cambio: false }
  if (!texto.includes(ORIGINAL)) throw new Error('patch-node-pty: no encontré el fork de conpty_console_list_agent; revisá si node-pty cambió y si el parche sigue haciendo falta.')
  return { texto: texto.replace(ORIGINAL, PARCHEADO), cambio: true }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
  const archivo = join(raiz, 'node_modules', 'node-pty', 'lib', 'windowsPtyAgent.js')
  if (!existsSync(archivo)) {
    console.log('patch-node-pty: node-pty no está instalado, nada que parchear')
  } else {
    const { texto, cambio } = parchear(readFileSync(archivo, 'utf8'))
    if (cambio) writeFileSync(archivo, texto)
    console.log(cambio ? 'patch-node-pty: aplicado (windowsHide en conpty_console_list_agent)' : 'patch-node-pty: ya estaba aplicado')
  }
}
