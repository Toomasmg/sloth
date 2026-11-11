/**
 * Lo que la vista «Equipo» (team.ts, team-gruv.ts) usa de los tickets, con los mismos nombres de
 * antes y armado sobre el conector de Gruv. Equipo sigue atado a Gruv; esto se va cuando use conectores.
 * Lo carga `node --test` con type stripping: sin enums, namespaces ni parameter properties.
 */
import { validarConector } from './conector'
import gruv from './conectores/gruv'
import { ConectorFaltaError, negadas } from './motor'

export { extractJson, normEstado } from './motor'
export { resolveClaudeExe } from './claude-run'

const GRUV = validarConector(gruv)

export const NO_GRUV = GRUV.faltaConector.clave
export const WRITE_TOOLS = negadas(GRUV)

export class NoGruvError extends ConectorFaltaError {
  constructor() {
    super(GRUV)
  }
}
