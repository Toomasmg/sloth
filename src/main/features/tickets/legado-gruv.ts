/**
 * Lo que la vista «Equipo» (team.ts, team-gruv.ts) usa de los tickets, armado sobre el conector de
 * Gruv del registro. Equipo sigue atado a Gruv; esto se va cuando use conectores.
 * Si Gruv no quedó registrado, importar esto no tira: falla recién al usarlo, con un mensaje claro.
 * Lo carga `node --test` con type stripping: sin enums, namespaces ni parameter properties.
 */
import type { ConectorMcp } from './conector'
import { conectorPorId } from './conectores'
import { ConectorFaltaError, negadas } from './motor'

export { extractJson, normEstado } from './motor'
export { resolveClaudeExe } from './claude-run'

function gruv(): ConectorMcp {
  const def = conectorPorId('gruv')
  if (def?.via !== 'mcp') throw new Error('El conector de Gruv no está en esta versión de Sloth: Equipo no puede consultar tickets.')
  return def
}

/** La clave con la que Claude avisa que la cuenta no tiene el conector de Gruv. */
export const noGruvClave = (): string => gruv().faltaConector.clave
/** Herramientas de Gruv que Equipo le niega a Claude (nombres completos). */
export const herramientasNegadas = (): string[] => negadas(gruv())

export class NoGruvError extends ConectorFaltaError {
  constructor() {
    super(gruv())
  }
}
