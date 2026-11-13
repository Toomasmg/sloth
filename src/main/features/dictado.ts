import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import { AJUSTES_DICTADO, WHISPER_MODEL, errorDictado, hilos, textoDeSalida, wavValido, whisperArgs } from '../dictado-core'
import type { ResultadoDictado, TipoErrorDictado } from '../../shared/dictado'

/**
 * Función «dictado»: el micrófono de cada terminal. La UI graba y manda el WAV; acá se transcribe
 * con whisper-cli (vendor/whisper, en el instalador) y se devuelve el texto. Ops: transcribir(wav),
 * ajustes(tipo). Una transcripción a la vez: la que llega mientras otra corre espera su turno.
 */

const TIMEOUT_MS = 120_000

function carpetaWhisper(): string {
  return app.isPackaged ? join(process.resourcesPath, 'whisper') : join(app.getAppPath(), 'vendor', 'whisper')
}

let cola: Promise<unknown> = Promise.resolve()

async function transcribir(c: FeatureContext, wav: Uint8Array): Promise<ResultadoDictado> {
  if (process.platform !== 'win32') return { ok: false, error: errorDictado('sistema') }
  const dir = carpetaWhisper()
  const exe = join(dir, 'whisper-cli.exe')
  const model = join(dir, WHISPER_MODEL)
  if (!existsSync(exe) || !existsSync(model)) {
    c.log('[dictado] falta whisper en', dir)
    return { ok: false, error: errorDictado('sin-motor') }
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
