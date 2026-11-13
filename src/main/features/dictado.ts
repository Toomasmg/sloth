import { shell } from 'electron'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { Feature, FeatureContext } from './context'
import { AJUSTES_DICTADO, dictadoArgs, errorDictado, parseLinea } from '../dictado-core'
import type { ErrorDictado, EstadoDictado, EventoEstadoDictado, EventoTextoDictado, TipoErrorDictado } from '../../shared/dictado'

/**
 * Función «dictado»: micrófono de cada terminal. Una sola sesión a la vez (un micrófono): empezar en
 * otro panel corta la anterior. Ops: start(paneId), stop(paneId), ajustes(tipo).
 * Eventos: estado (EventoEstadoDictado) y texto (EventoTextoDictado).
 */

interface Sesion {
  paneId: string
  proc: ChildProcessByStdio<null, Readable, Readable>
  /** Si existe, el script termina la frase en curso y sale. */
  stopFile: string
  error?: ErrorDictado
  matar?: ReturnType<typeof setTimeout>
}

let sesion: Sesion | null = null

const paneIdValido = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128

function powershell(): string {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function cortar(s: Sesion): void {
  if (s.matar) clearTimeout(s.matar)
  if (s.proc.exitCode === null) s.proc.kill()
  borrar(s.stopFile)
}

function borrar(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch (err) {
    // Un archivo vacío en %TEMP%: si no se pudo borrar, no molesta.
    void err
  }
}

function iniciar(c: FeatureContext, paneId: string): void {
  const estado = (e: EstadoDictado, error?: ErrorDictado): void => {
    const ev: EventoEstadoDictado = error ? { paneId, estado: e, error } : { paneId, estado: e }
    c.emit('estado', ev)
  }
  if (process.platform !== 'win32') {
    estado('inactivo', errorDictado('sistema'))
    return
  }
  const stopFile = join(tmpdir(), `sloth-dictado-${randomUUID()}.stop`)
  const proc = spawn(powershell(), dictadoArgs(), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SLOTH_DICTADO_STOP: stopFile }
  })
  const s: Sesion = { paneId, proc, stopFile }
  sesion = s
  let resto = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    resto += chunk
    const lineas = resto.split(/\r?\n/)
    resto = lineas.pop() ?? ''
    for (const l of lineas) {
      const ev = parseLinea(l)
      if (!ev || sesion !== s) continue
      if (ev.e === 'texto') {
        const t: EventoTextoDictado = { paneId, texto: ev.t }
        c.emit('texto', t)
      } else if (ev.e === 'error') s.error = errorDictado(ev.code)
      else if (ev.e === 'escuchando' || ev.e === 'transcribiendo') estado(ev.e)
    }
  })
  // El stderr de PowerShell es ruido (CLIXML de progreso); los errores reales llegan por stdout.
  proc.stderr.resume()
  proc.on('error', (err) => {
    c.log('[dictado] no arrancó PowerShell:', err.message)
    s.error = { tipo: 'otro', mensaje: 'No se pudo abrir el dictado de Windows.', ajustes: false }
  })
  proc.on('close', () => {
    if (s.matar) clearTimeout(s.matar)
    borrar(stopFile)
    if (sesion !== s) return
    sesion = null
    estado('inactivo', s.error)
  })
  estado('escuchando')
}

const feature: Feature = {
  name: 'dictado',
  register(c: FeatureContext) {
    c.handle('start', (paneId: unknown) => {
      if (!paneIdValido(paneId)) throw new Error('Panel inválido.')
      if (sesion?.paneId === paneId) return
      if (sesion) {
        const vieja = sesion
        sesion = null
        cortar(vieja)
        c.emit('estado', { paneId: vieja.paneId, estado: 'inactivo' } satisfies EventoEstadoDictado)
      }
      iniciar(c, paneId)
    })
    c.handle('stop', (paneId: unknown) => {
      if (!paneIdValido(paneId) || sesion?.paneId !== paneId) return
      const s = sesion
      if (s.matar) return
      // La frase en curso todavía puede llegar; si PowerShell no termina, se corta igual.
      writeFileSync(s.stopFile, '')
      s.matar = setTimeout(() => cortar(s), 8000)
    })
    c.handle('ajustes', (tipo: unknown) => {
      const url = typeof tipo === 'string' ? AJUSTES_DICTADO[tipo as TipoErrorDictado] : undefined
      if (!url || !Object.hasOwn(AJUSTES_DICTADO, tipo as string)) throw new Error('Ajuste desconocido.')
      return shell.openExternal(url)
    })
  },
  dispose() {
    if (sesion) cortar(sesion)
    sesion = null
  }
}

export default feature
