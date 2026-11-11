import { validarConector, type ConectorDef } from '../conector'
import asana from './asana'
import azureDevops from './azure-devops'
import clickup from './clickup'
import github from './github'
import gitlab from './gitlab'
import gruv from './gruv'
import jira from './jira'
import linear from './linear'
import monday from './monday'
import notion from './notion'
import shortcut from './shortcut'
import youtrack from './youtrack'

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

export const CONECTORES: readonly ConectorDef[] = registrar([gruv, github, jira, linear, asana, notion, clickup, monday, azureDevops, gitlab, shortcut, youtrack])

export const conectorPorId = (id: string): ConectorDef | undefined => CONECTORES.find((c) => c.id === id)
