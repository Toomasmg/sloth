import { validarConector, type ConectorDef } from '../conector'
import gruv from './gruv'

export const CONECTOR_POR_DEFECTO = 'gruv'

/** Un conector mal escrito se saltea con un aviso: no tira la app. */
function registrar(defs: readonly unknown[]): ConectorDef[] {
  const out: ConectorDef[] = []
  for (const d of defs) {
    try {
      const def = validarConector(d)
      if (out.some((c) => c.id === def.id)) throw new Error(`el id «${def.id}» está repetido`)
      out.push(def)
    } catch (e) {
      console.error(`tickets: conector salteado: ${(e as Error).message}`)
    }
  }
  return out
}

export const CONECTORES: readonly ConectorDef[] = registrar([gruv])

export const conectorPorId = (id: string): ConectorDef | undefined => CONECTORES.find((c) => c.id === id)
