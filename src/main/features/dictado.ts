import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import {
  AJUSTES_DICTADO,
  MODELO_CHICO,
  MODELO_TURBO,
  MODELO_HOSTS,
  errorDictado,
  hilos,
  previoDe,
  timeoutMs,
  textoDeSalida,
  wavValido,
  whisperArgs,
  type ModeloWhisper
} from '../dictado-core'
import { ModeloError, asegurarModelo } from '../dictado-modelo'
import { depsModeloReales } from '../dictado-modelo-real'
import type { ProgresoModelo, ResultadoDictado, TipoErrorDictado } from '../../shared/dictado'
import { raizDatos } from '../perfil'
import { currentSettings } from './settings'

/**
 * Función «dictado»: el micrófono de cada terminal. La UI graba y manda el WAV; acá se transcribe
 * con whisper-cli (vendor/whisper, en el instalador) y se devuelve el texto. El modelo no viene en el
 * instalador: la primera vez se baja a userData/whisper (evento `modelo` con el avance). Ops:
 * transcribir(wav), ajustes(tipo). Una transcripción a la vez: la que llega mientras otra corre espera su turno.
 */

/** Cada cuánto se avisa el avance a la UI: el stream manda miles de chunks. */
const AVISO_MS = 250
/** Si esta carpeta existe, cada parte dictada se guarda ahí (audio y texto) para revisar qué falló. */
const DIAGNOSTICO = 'diagnostico'
const MAX_DIAGNOSTICO = 400

function carpetaWhisper(): string {
  return app.isPackaged ? join(process.resourcesPath, 'whisper') : join(app.getAppPath(), 'vendor', 'whisper')
}

function carpetaModelos(): string {
  return join(raizDatos(), 'whisper')
}

/** Primero lo bajado a userData; después lo que traiga la carpeta del motor (dev e instalaciones viejas). */
function buscarModelo(m: ModeloWhisper): string | null {
  for (const dir of [carpetaModelos(), carpetaWhisper()]) {
    const p = join(dir, m.archivo)
    if (existsSync(p)) return p
  }
  return null
}

/** Una sola bajada por modelo: los dictados que llegan mientras tanto esperan la misma promesa. */
const bajando = new Map<string, Promise<string>>()

/** `avisar`: el dictado espera esta bajada y la UI muestra el avance; si no, baja callada. */
function bajarModelo(c: FeatureContext, m: ModeloWhisper, avisar: boolean): Promise<string> {
  const enCurso = bajando.get(m.archivo)
  if (enCurso) return enCurso
  const destino = join(carpetaModelos(), m.archivo)
  let ultimoAviso = 0
  const progreso = (recibidos: number, total: number): void => {
    const ahora = Date.now()
    if (ahora - ultimoAviso < AVISO_MS && recibidos < total) return
    ultimoAviso = ahora
    c.emit('modelo', { recibidos, total } satisfies ProgresoModelo)
  }
  const p = asegurarModelo(
    {
      url: m.url,
      sha256: m.sha256,
      destino,
      hosts: MODELO_HOSTS,
      maxBytes: Math.ceil(m.bytes * 1.1),
      bytesAprox: m.bytes,
      onProgreso: avisar ? progreso : undefined
    },
    depsModeloReales
  )
    .then(() => destino)
    .finally(() => {
      bajando.delete(m.archivo)
      if (avisar) c.emit('modelo', null)
    })
  bajando.set(m.archivo, p)
  return p
}

/**
 * El modelo elegido en Configuración. Si es el turbo y todavía no está, se dicta con el chico mientras el turbo baja
 * de fondo (son 574 MB: el primer dictado no puede esperarlo).
 */
async function modeloListo(c: FeatureContext): Promise<{ path: string; archivo: string }> {
  const elegido = currentSettings().terminal.dictadoPreciso ? MODELO_TURBO : MODELO_CHICO
  const listo = buscarModelo(elegido)
  if (listo) return { path: listo, archivo: elegido.archivo }
  if (elegido !== MODELO_CHICO) {
    bajarModelo(c, elegido, false).catch((err: unknown) =>
      c.log('[dictado] no se pudo bajar', elegido.archivo, err instanceof Error ? err.message : err)
    )
  }
  const chico = buscarModelo(MODELO_CHICO) ?? (await bajarModelo(c, MODELO_CHICO, true))
  return { path: chico, archivo: MODELO_CHICO.archivo }
}

/** Guarda la parte (audio, contexto y texto) si existe la carpeta de diagnóstico; se queda con las últimas. */
async function guardarDiagnostico(c: FeatureContext, wav: Uint8Array, datos: Record<string, unknown>): Promise<void> {
  const dir = join(carpetaModelos(), DIAGNOSTICO)
  if (!existsSync(dir)) return
  try {
    const base = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 4)}`)
    await writeFile(`${base}.wav`, wav)
    await writeFile(`${base}.json`, JSON.stringify(datos, null, 2))
    const archivos = (await readdir(dir)).sort()
    for (const viejo of archivos.slice(0, Math.max(0, archivos.length - MAX_DIAGNOSTICO))) await rm(join(dir, viejo), { force: true })
  } catch (e) {
    c.log('[dictado] no se pudo guardar el diagnóstico:', e instanceof Error ? e.message : e)
  }
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

async function transcribir(c: FeatureContext, wav: Uint8Array, previo: string): Promise<ResultadoDictado> {
  if (process.platform !== 'win32') return { ok: false, error: errorDictado('sistema') }
  const dir = carpetaWhisper()
  const exe = join(dir, 'whisper-cli.exe')
  if (!existsSync(exe)) {
    c.log('[dictado] falta whisper en', dir)
    return { ok: false, error: errorDictado('sin-motor') }
  }
  let modelo: { path: string; archivo: string }
  try {
    modelo = await modeloListo(c)
  } catch (err) {
    c.log('[dictado] no se pudo bajar el modelo:', err instanceof Error ? err.message : err)
    return errorDeModelo(err)
  }
  const file = join(tmpdir(), `sloth-dictado-${randomUUID()}.wav`)
  await writeFile(file, wav)
  const inicio = Date.now()
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        exe,
        whisperArgs({ model: modelo.path, wav: file, threads: hilos(availableParallelism()), previo }),
        { cwd: dir, windowsHide: true, timeout: timeoutMs(wav.byteLength), maxBuffer: 1024 * 1024, encoding: 'utf8' },
        (err, out) => (err ? reject(err) : resolve(out))
      )
    })
    const texto = textoDeSalida(stdout)
    const ms = Date.now() - inicio
    const segundos = Math.round((wav.byteLength - 44) / 3200) / 10
    c.log(`[dictado] ${segundos} s de audio en ${ms} ms con ${modelo.archivo}`)
    await guardarDiagnostico(c, wav, { modelo: modelo.archivo, segundos, ms, previo, texto, salida: stdout })
    return { ok: true, texto }
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
    // Llega el WAV solo o { wav, previo }: lo ya dictado, para que la parte siga la oración.
    c.handle('transcribir', (raw: unknown) => {
      const obj = typeof raw === 'object' && raw !== null && !(raw instanceof Uint8Array) ? (raw as { wav?: unknown; previo?: unknown }) : null
      const wav = obj ? obj.wav : raw
      if (!(wav instanceof Uint8Array) || !wavValido(wav)) throw new Error('Audio inválido.')
      const previo = previoDe(obj?.previo)
      const turno = cola.then(() => transcribir(c, wav, previo))
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
