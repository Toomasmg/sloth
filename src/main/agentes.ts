import { execFile } from 'node:child_process'
import type { AgenteDisponible } from '../shared/types'
import { NOMBRE_PROVEEDOR, PROVEEDORES_IDS } from '../shared/proveedores'
import { versionCodexOk } from './codex-exe'
import { PROVEEDORES } from './proveedores'

const TIMEOUT_MS = 5000

// cmd lee estos caracteres como sintaxis aun entre comillas: una ruta así no se ejecuta.
const RUTA_CMD_RARA = /[%"&^!<>|\r\n]/

function ejecutar(file: string, args: string[], verbatim: boolean): Promise<string | undefined> {
  return new Promise((resolver) => {
    execFile(file, args, { timeout: TIMEOUT_MS, windowsHide: true, windowsVerbatimArguments: verbatim }, (err, stdout) => {
      resolver(err ? undefined : String(stdout))
    })
  })
}

function salidaDeVersion(exe: string): Promise<string | undefined> {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(exe)) return ejecutar(exe, ['--version'], false)
  if (RUTA_CMD_RARA.test(exe)) return Promise.resolve(undefined)
  // Un .cmd de npm solo corre por cmd.exe. Argumentos fijos y la ruta entre comillas; las de afuera las quita /s.
  return ejecutar('cmd.exe', ['/d', '/s', '/c', `""${exe}" --version"`], true)
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
