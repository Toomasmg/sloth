import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import {
  AJUSTES_DICTADO,
  MODELO_BYTES,
  MODELO_HOSTS,
  MODELO_SHA256,
  MODELO_URL,
  WHISPER_MODEL,
  errorDictado,
  hilos,
  textoDeSalida,
  wavValido,
  whisperArgs
} from '../dictado-core'
import { ModeloError, asegurarModelo } from '../dictado-modelo'
import { depsModeloReales } from '../dictado-modelo-real'
import type { ProgresoModelo, ResultadoDictado, TipoErrorDictado } from '../../shared/dictado'
import { raizDatos } from '../perfil'

/**
 * Función «dictado»: el micrófono de cada terminal. La UI graba y manda el WAV; acá se transcribe
 * con whisper-cli (vendor/whisper, en el instalador) y se devuelve el texto. El modelo no viene en el
 * instalador: la primera vez se baja a userData/whisper (evento `modelo` con el avance). Ops:
 * transcribir(wav), ajustes(tipo). Una transcripción a la vez: la que llega mientras otra corre espera su turno.
 */

const TIMEOUT_MS = 120_000
/** Cada cuánto se avisa el avance a la UI: el stream manda miles de chunks. */
const AVISO_MS = 250
const MAX_MODELO_BYTES = 256 * 1024 * 1024

function carpetaWhisper(): string {
  return app.isPackaged ? join(process.resourcesPath, 'whisper') : join(app.getAppPath(), 'vendor', 'whisper')
}

function carpetaModelos(): string {
  return join(raizDatos(), 'whisper')
}

/** Primero lo bajado a userData; después lo que traiga la carpeta del motor (dev e instalaciones viejas). */
function buscarModelo(): string | null {
  for (const dir of [carpetaModelos(), carpetaWhisper()]) {
    const p = join(dir, WHISPER_MODEL)
    if (existsSync(p)) return p
  }
  return null
}

/** Una sola bajada a la vez: los dictados que llegan mientras tanto esperan la misma promesa. */
let bajando: Promise<string> | null = null

function bajarModelo(c: FeatureContext): Promise<string> {
  if (bajando) return bajando
  const destino = join(carpetaModelos(), WHISPER_MODEL)
  let ultimoAviso = 0
  const avisar = (recibidos: number, total: number): void => {
    const ahora = Date.now()
    if (ahora - ultimoAviso < AVISO_MS && recibidos < total) return
    ultimoAviso = ahora
    c.emit('modelo', { recibidos, total } satisfies ProgresoModelo)
  }
  bajando = asegurarModelo(
    { url: MODELO_URL, sha256: MODELO_SHA256, destino, hosts: MODELO_HOSTS, maxBytes: MAX_MODELO_BYTES, bytesAprox: MODELO_BYTES, onProgreso: avisar },
    depsModeloReales
  )
    .then(() => destino)
    .finally(() => {
      bajando = null
      c.emit('modelo', null)
    })
  return bajando
}

function errorDeModelo(err: unknown): ResultadoDictado {
  if (err instanceof ModeloError) {
    if (err.tipo === 'escritura') return { ok: false, error: errorDictado('otro', 'no se pudo guardar el modelo') }
    const detalle = err.tipo === 'disco' ? 'disco' : err.tipo === 'hash' || err.tipo === 'http' ? 'servidor' : undefined
    return { ok: false, error: errorDictado('sin-modelo', detalle) }
  }
  return { ok: false, error: errorDictado('otro') }
}

let cola: Promise<unknown> = Promise.resolve()

async function transcribir(c: FeatureContext, wav: Uint8Array): Promise<ResultadoDictado> {
  if (process.platform !== 'win32') return { ok: false, error: errorDictado('sistema') }
  const dir = carpetaWhisper()
  const exe = join(dir, 'whisper-cli.exe')
  if (!existsSync(exe)) {
    c.log('[dictado] falta whisper en', dir)
    return { ok: false, error: errorDictado('sin-motor') }
  }
  let model = buscarModelo()
  if (!model) {
    try {
      model = await bajarModelo(c)
    } catch (err) {
      c.log('[dictado] no se pudo bajar el modelo:', err instanceof Error ? err.message : err)
      return errorDeModelo(err)
    }
  }
  const file = join(tmpdir(), `sloth-dictado-${randomUUID()}.wav`)
  await writeFile(file, wav)
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        exe,
        whisperArgs({ model, wav: file, threads: hilos(availableParallelism()) }),
        { cwd: dir, windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' },
        (err, out) => (err ? reject(err) : resolve(out))
      )
    })
    return { ok: true, texto: textoDeSalida(stdout) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    c.log('[dictado] whisper falló:', msg)
    return { ok: false, error: errorDictado('otro', /timed out|ETIMEDOUT|SIGTERM/i.test(msg) ? 'tardó demasiado' : undefined) }
  } finally {
    await rm(file, { force: true }).catch((e: unknown) => c.log('[dictado] no se pudo borrar', file, e))
  }
}

const feature: Feature = {
  name: 'dictado',
  register(c: FeatureContext) {
    c.handle('transcribir', (raw: unknown) => {
      const wav = raw instanceof Uint8Array ? raw : null
      if (!wav || !wavValido(wav)) throw new Error('Audio inválido.')
      const turno = cola.then(() => transcribir(c, wav))
      cola = turno.catch(() => undefined)
      return turno
    })
    c.handle('ajustes', (tipo: unknown) => {
      if (typeof tipo !== 'string' || !Object.hasOwn(AJUSTES_DICTADO, tipo)) throw new Error('Ajuste desconocido.')
      return shell.openExternal(AJUSTES_DICTADO[tipo as TipoErrorDictado] as string)
    })
  }
}

export default feature
