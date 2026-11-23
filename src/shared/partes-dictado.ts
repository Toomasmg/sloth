import { rms, unir } from './wav'

/**
 * Corta la grabación en partes mientras se habla, en las pausas, para transcribir cada una apenas
 * termina. Whisper trabaja en ventanas de 30 s: con partes más cortas cada una es una sola ventana
 * con la pista de vocabulario, un error no arrastra al resto y al soltar queda poco por transcribir.
 */

export interface OpcionesCortador {
  rate: number
  /** Una parte no se corta antes de esto (s): las muy cortas pierden contexto. */
  minSegundos?: number
  /** Ni pasa de esto (s): sin pausa, se corta en el momento más callado de los últimos segundos. */
  maxSegundos?: number
  /** Silencio seguido que cuenta como pausa (s). */
  pausaSegundos?: number
}

/** Por debajo de esto una parte es silencio (o ruido): no vale la pena transcribirla. */
export const SILENCIO = 0.004
/** Un cuadro es silencio si su nivel no llega a este piso o a varias veces el ruido de fondo. */
const SILENCIO_CUADRO = 0.006
const VECES_RUIDO = 2.5
const MAX_RUIDO = 0.012
/** Dónde buscar el momento más callado cuando la parte llega al máximo sin pausa (s). */
const BUSCAR_CORTE_SEGUNDOS = 6

export interface Cortador {
  /** Suma un cuadro del micrófono; devuelve las partes que se cerraron con él. */
  agregar(cuadro: Float32Array): Float32Array[]
  /** Lo que quedó sin cerrar, o null si es silencio. */
  cerrar(): Float32Array | null
}

/** ¿Vale la pena transcribir este audio? Al menos 0,3 s y algo más que silencio. */
export function tieneVoz(audio: Float32Array, rate: number): boolean {
  return audio.length >= rate * 0.3 && rms(audio) >= SILENCIO
}

export function crearCortador(o: OpcionesCortador): Cortador {
  const min = (o.minSegundos ?? 4) * o.rate
  const max = (o.maxSegundos ?? 25) * o.rate
  const pausa = (o.pausaSegundos ?? 0.7) * o.rate
  let cuadros: Float32Array[] = []
  let niveles: number[] = []
  let muestras = 0
  /**
   * Ruido de fondo: baja con el cuadro más callado y sube de a poco si el ambiente cambia. Arranca bajo
   * y tiene tope para que hablar sin parar no lo confunda con ruido.
   */
  let ruido = SILENCIO_CUADRO / VECES_RUIDO

  const silencioso = (nivel: number): boolean => nivel < Math.max(SILENCIO_CUADRO, ruido * VECES_RUIDO)

  /** Cierra la parte con los primeros `n` cuadros y deja el resto para la siguiente. */
  const cortar = (n: number): Float32Array | null => {
    const parte = unir(cuadros.slice(0, n))
    cuadros = cuadros.slice(n)
    niveles = niveles.slice(n)
    muestras = cuadros.reduce((s, c) => s + c.length, 0)
    return tieneVoz(parte, o.rate) ? parte : null
  }

  /** Cuántos cuadros del final son silencio seguido, y cuántas muestras suman. */
  const silencioFinal = (): number => {
    let s = 0
    for (let i = niveles.length - 1; i >= 0 && silencioso(niveles[i]); i--) s += cuadros[i].length
    return s
  }

  return {
    agregar(cuadro) {
      const nivel = rms(cuadro)
      ruido = nivel < ruido ? nivel : Math.min(MAX_RUIDO, ruido * 1.05)
      cuadros.push(cuadro)
      niveles.push(nivel)
      muestras += cuadro.length
      const partes: Float32Array[] = []
      let p: Float32Array | null = null
      if (muestras >= min && silencioFinal() >= pausa) {
        p = cortar(cuadros.length)
      } else if (muestras >= max) {
        // Sin pausa: el cuadro más callado de los últimos segundos, para no cortar una palabra al medio.
        let desde = cuadros.length
        for (let s = 0; desde > 1 && s < BUSCAR_CORTE_SEGUNDOS * o.rate; ) s += cuadros[--desde].length
        let corte = desde
        for (let i = desde; i < niveles.length; i++) if (niveles[i] < niveles[corte]) corte = i
        p = cortar(Math.max(1, corte + 1))
      }
      if (p) partes.push(p)
      return partes
    },
    cerrar() {
      const parte = unir(cuadros)
      cuadros = []
      niveles = []
      muestras = 0
      return tieneVoz(parte, o.rate) ? parte : null
    }
  }
}
