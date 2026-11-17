import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { crearLogger, type Logger } from './logger'

const contexto = (dir: string): { dir: string; home: string; userData: string } => ({
  dir,
  home: homedir(),
  userData: dirname(dir)
})

let actual: Logger = crearLogger({ ...contexto(''), soloMemoria: true })

/** Quien lo importa no necesita saber si ya se inició: antes de `iniciarLogger` solo guarda en memoria. */
export const logger: Logger = {
  error: (origen, e) => actual.error(origen, e),
  aviso: (origen, msg) => actual.aviso(origen, msg),
  info: (origen, msg) => actual.info(origen, msg),
  recientes: (n) => actual.recientes(n),
  fallo: () => actual.fallo()
}

/** `dir` es `<userData>/logs`: de ahí sale la ruta que se tapa en los textos. */
export function iniciarLogger(dir: string): void {
  actual = crearLogger(contexto(dir))
}
