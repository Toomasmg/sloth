let crashPrevio = false
let preguntado = false

export function marcarCrashPrevio(v: boolean): void {
  crashPrevio = v
}

/** True solo la primera vez que se pregunta: el aviso al arrancar se muestra una vez por sesión. */
export function tomarCrashPrevio(): boolean {
  if (preguntado) return false
  preguntado = true
  return crashPrevio
}

export function huboCrashPrevio(): boolean {
  return crashPrevio
}
