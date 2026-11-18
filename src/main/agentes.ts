import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { AgenteDisponible } from '../shared/types'
import { NOMBRE_PROVEEDOR, PROVEEDORES_IDS } from '../shared/proveedores'
import { versionCodexOk } from './codex-exe'
import { AVISO_POWERSHELL_7, hayPowerShell7, versionCopilotOk } from './copilot-exe'
import { motivoNoAgregarCuenta } from './accounts'
import { entornoLimpio } from './env-limpio'
import { PROVEEDORES } from './proveedores'

const TIMEOUT_MS = 5000
const TIMEOUT_PWSH_MS = 4000

// cmd lee estos caracteres como sintaxis aun entre comillas: una ruta así no se ejecuta.
const RUTA_CMD_RARA = /[%"&^!<>|\r\n]/

function ejecutar(file: string, args: string[], verbatim: boolean, env?: NodeJS.ProcessEnv, timeout = TIMEOUT_MS): Promise<string | undefined> {
  return new Promise((resolver) => {
    execFile(file, args, { timeout, windowsHide: true, windowsVerbatimArguments: verbatim, env }, (err, stdout) => {
      resolver(err ? undefined : String(stdout))
    })
  })
}

function salidaDeVersion(exe: string, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(exe)) return ejecutar(exe, ['--version'], false, env)
  if (RUTA_CMD_RARA.test(exe)) return Promise.resolve(undefined)
  // Un .cmd de npm solo corre por cmd.exe. Argumentos fijos y la ruta entre comillas; las de afuera las quita /s.
  return ejecutar('cmd.exe', ['/d', '/s', '/c', `""${exe}" --version"`], true, env)
}

// Sin shell y con -NoProfile: no corre nada del usuario. El pwsh de la Store es un alias, por eso se prueba ejecutándolo.
const pwshMayor = (exe: string): Promise<string | undefined> =>
  ejecutar(exe, ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', '$PSVersionTable.PSVersion.Major'], false, undefined, TIMEOUT_PWSH_MS)

/** Exportada para validar el alta fuera del formulario (IPC directo, importación). */
export const powerShell7Disponible = (): Promise<boolean> => hayPowerShell7(process.env, process.platform, { existe: existsSync, mayor: pwshMayor })

// La versión corre con el entorno de una terminal de Copilot (sin tokens de GitHub) y sin autoactualización: detectar no cambia el binario.
const envDeVersionCopilot = (): NodeJS.ProcessEnv => ({ ...entornoLimpio(process.env, PROVEEDORES.copilot.quitarDelEntorno), COPILOT_AUTO_UPDATE: 'false' })

/** Qué agentes hay para elegir. Todos aparecen; instalado es si se encontró su ejecutable. */
export async function detectarAgentes(): Promise<AgenteDisponible[]> {
  return Promise.all(
    PROVEEDORES_IDS.map(async (id): Promise<AgenteDisponible> => {
      const p = PROVEEDORES[id]
      const exe = p.resolverExe()
      const base = { id, nombre: NOMBRE_PROVEEDOR[id], instalado: exe !== undefined, comoInstalar: p.comoInstalar }
      if (exe === undefined) return base
      if (id === 'codex') {
        const salida = await salidaDeVersion(exe)
        if (salida === undefined) return base
        const { version, ok } = versionCodexOk(salida)
        return { ...base, version, versionOk: ok }
      }
      if (id === 'copilot') {
        const [hayPwsh, salida] = await Promise.all([powerShell7Disponible(), salidaDeVersion(exe, envDeVersionCopilot())])
        const aviso = hayPwsh ? motivoNoAgregarCuenta([], 'copilot') : AVISO_POWERSHELL_7
        const conAviso = aviso ? { ...base, aviso } : base
        if (salida === undefined) return conAviso
        const { version, ok } = versionCopilotOk(salida)
        return { ...conAviso, version, versionOk: ok }
      }
      return base
    })
  )
}
