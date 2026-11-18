export type DestinoPrimerMensaje = 'pegar' | 'a-mano' | 'ninguno'

/**
 * Qué hacer con un primer mensaje que no se pudo pasar como argumento. Se pega cuando arranca el agente
 * solo si avisa de su arranque con un hook: sin hook nadie dispara el pegado y el mensaje se perdería en silencio.
 */
export function destinoPrimerMensaje(hooks: boolean, paste: string | undefined): DestinoPrimerMensaje {
  if (paste === undefined) return 'ninguno'
  return hooks ? 'pegar' : 'a-mano'
}

export function avisoPrimerMensajeAMano(agente: string, espacio: string): string {
  return `${agente} no recibe el primer mensaje solo en «${espacio}»: escribilo a mano.`
}
