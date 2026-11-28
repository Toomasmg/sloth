import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { crearLogger, type Logger } from './logger'
import { pedirAlNucleo, rustEsDueno } from './rust-features'
import { textoSeguro } from './diag/texto-seguro'

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

/**
 * Con Rust como dueño, el archivo de log es de Rust: acá se guarda en memoria (lo lee el diagnóstico) y cada línea va
 * a Rust, que la tapa y la escribe. Así no hay dos procesos rotando el mismo archivo.
 */
function reenviado(enMemoria: Logger): Logger {
  const enviar = (nivel: string, origen: string, msg: string): void => {
    // Si el log no llega a Rust no hay a quién avisarle: queda la copia en memoria.
    pedirAlNucleo('log', nivel, origen, msg).catch(() => undefined)
  }
  const texto = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : textoSeguro(e))
  return {
    error: (origen, e) => {
      enMemoria.error(origen, e)
      enviar('error', origen, texto(e))
    },
    aviso: (origen, msg) => {
      enMemoria.aviso(origen, msg)
      enviar('aviso', origen, msg)
    },
    info: (origen, msg) => {
      enMemoria.info(origen, msg)
      enviar('info', origen, msg)
    },
    recientes: (n) => enMemoria.recientes(n),
    fallo: () => enMemoria.fallo()
  }
}

/** `dir` es `<userData>/logs`: de ahí sale la ruta que se tapa en los textos. */
export function iniciarLogger(dir: string): void {
  actual = rustEsDueno() ? reenviado(crearLogger({ ...contexto(dir), soloMemoria: true })) : crearLogger(contexto(dir))
}
