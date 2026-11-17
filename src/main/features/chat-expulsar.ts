import type { ChatRemoveResult } from '../../shared/chat'

/** PostgREST responde PGRST202 cuando la función no existe; Postgres directo, 42883. */
export function faltaLaFuncion(error: { code?: string } | null | undefined): boolean {
  return error?.code === 'PGRST202' || error?.code === '42883'
}

export const AVISO_0007 =
  'Tu servidor del chat no tiene la migración 0007 (expulsar). Se sacó a la persona como antes y se intentó cambiar el código aparte. Pedile a quien administra el Supabase que aplique supabase/migrations/0007_expulsar.sql.'

export const REENVIAR = 'El código de invitación cambió: reenviá la invitación a quienes todavía no entraron.'

/** Qué se le cuenta a la UI después de expulsar, según si la RPC nueva estaba y si el código cambió. */
export function resultadoExpulsar(o: { conRpc: boolean; codigoNuevo: boolean }): ChatRemoveResult {
  if (o.conRpc) return { codigoNuevo: true, aviso: REENVIAR }
  if (o.codigoNuevo) return { codigoNuevo: true, aviso: `${REENVIAR} ${AVISO_0007}` }
  return { codigoNuevo: false, aviso: `El código de invitación NO cambió: con la invitación vieja puede volver a entrar. ${AVISO_0007}` }
}
