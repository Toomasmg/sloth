import { execFile } from 'node:child_process'
import type { AgenteDisponible } from '../shared/types'
import { NOMBRE_PROVEEDOR, PROVEEDORES_IDS } from '../shared/proveedores'
import { versionCodexOk } from './codex-exe'
import { PROVEEDORES } from './proveedores'

const TIMEOUT_MS = 5000

function salidaDeVersion(exe: string): Promise<string | undefined> {
  // Un .cmd de npm solo corre por cmd: con shell activo, argumentos y ruta fijos (nada que venga de afuera).
  const conShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe)
  const cmd = conShell ? `"${exe}"` : exe
  return new Promise((resolver) => {
    execFile(cmd, ['--version'], { timeout: TIMEOUT_MS, windowsHide: true, shell: conShell }, (err, stdout) => {
      resolver(err ? undefined : String(stdout))
    })
  })
}

/** Qué agentes hay para elegir. Todos aparecen; instalado es si se encontró su ejecutable. */
export async function detectarAgentes(): Promise<AgenteDisponible[]> {
  return Promise.all(
    PROVEEDORES_IDS.map(async (id): Promise<AgenteDisponible> => {
      const p = PROVEEDORES[id]
      const exe = p.resolverExe()
      const base = { id, nombre: NOMBRE_PROVEEDOR[id], instalado: exe !== undefined, comoInstalar: p.comoInstalar }
      if (id !== 'codex' || exe === undefined) return base
      const salida = await salidaDeVersion(exe)
      if (salida === undefined) return base
      const { version, ok } = versionCodexOk(salida)
      return { ...base, version, versionOk: ok }
    })
  )
}
