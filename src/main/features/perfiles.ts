import { app, net } from 'electron'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import { run, type RunResult } from './git-run'
import { leerJson } from '../json-file'
import { logger } from '../logger-global'
import { indicePerfiles, modoRaiz, raizDatos, recargarIndice, rutaPerfil } from '../perfil'
import { agregarActividad, leerActividad } from '../perfiles-actividad'
import { dentroDe, idPerfilValido, NOMBRE_INICIAL, nombreLibre } from '../perfiles-core'
import {
  borrarPerfilFs,
  cambiarActivoFs,
  crearPerfilFs,
  guardarFoto,
  guardarGhLogin,
  leerFotoDataUrl,
  MAX_BYTES_FOTO,
  renombrarPerfilFs,
  rutasPerfiles,
  tieneFoto
} from '../perfiles-fs'
import { parsearUsuarioGh, urlAvatarConTamano, type IdentidadGh } from '../perfiles-github'
import { validarEstado, type EstadoValidado } from '../store-core'
import type { EntradaActividad, PerfilesPayload } from '../../shared/perfiles'

const SIN_GH = 'No encontré un GitHub conectado en esta PC. Iniciá sesión con `gh auth login`.'
const SIN_PERFILES = 'Los perfiles no están disponibles: Sloth está usando tus datos de siempre. Reiniciá para reintentar.'
const TAMANO_AVATAR = 128
const ESPERA_GH_MS = 15000
const ESPERA_RESPUESTA_MS = 150

const mensaje = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Un fallo al anotar la actividad nunca tira la acción que se estaba haciendo. */
export function registrarActividad(e: EntradaActividad): void {
  try {
    agregarActividad(rutaPerfil('actividad'), e)
  } catch (err) {
    logger.aviso('perfiles', `no se pudo registrar la actividad: ${mensaje(err)}`)
  }
}

function exigirPerfiles(): void {
  if (modoRaiz()) throw new Error(SIN_PERFILES)
}

function existente(id: unknown): string {
  exigirPerfiles()
  if (!idPerfilValido(id) || !indicePerfiles().perfiles.some((p) => p.id === id)) throw new Error('Ese perfil no existe.')
  return id
}

function opcion(raw: unknown, clave: string): boolean {
  if (raw === undefined || raw === null) return false
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Opciones inválidas.')
  const v = (raw as Record<string, unknown>)[clave]
  if (v !== undefined && typeof v !== 'boolean') throw new Error('Opciones inválidas.')
  return v === true
}

async function leerIdentidadGh(): Promise<IdentidadGh> {
  let r: RunResult
  try {
    r = await run('gh', ['api', 'user', '--jq', '{login: .login, name: .name, avatar_url: .avatar_url}'], { timeoutMs: ESPERA_GH_MS, maxBytes: 16 * 1024 })
  } catch (e) {
    logger.aviso('perfiles', `gh no respondió: ${mensaje(e)}`)
    throw new Error(SIN_GH)
  }
  if (r.code !== 0) throw new Error(SIN_GH)
  const identidad = parsearUsuarioGh(r.stdout)
  if (!identidad) throw new Error('GitHub devolvió una respuesta que Sloth no pudo usar.')
  return identidad
}

/** La URL ya pasó por parsearUsuarioGh (https y host exacto); acá se corta el cuerpo al tope y no se siguen redirecciones. */
async function bajarAvatar(avatarUrl: string): Promise<Buffer> {
  const res = await net.fetch(urlAvatarConTamano(avatarUrl, TAMANO_AVATAR), { signal: AbortSignal.timeout(ESPERA_GH_MS), redirect: 'error' })
  if (!res.ok || !res.body) throw new Error(`GitHub respondió ${res.status} al pedir la foto.`)
  const declarado = Number(res.headers.get('content-length'))
  if (Number.isFinite(declarado) && declarado > MAX_BYTES_FOTO) throw new Error('La foto de GitHub pesa demasiado.')
  const lector = res.body.getReader()
  const partes: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await lector.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES_FOTO) {
      await lector.cancel()
      throw new Error('La foto de GitHub pesa demasiado.')
    }
    partes.push(Buffer.from(value))
  }
  return Buffer.concat(partes)
}

/** Ids de espacio del perfil, solo lectura: sirve para saber si tiene terminales vivas en el daemon. */
function espaciosDe(id: string): string[] {
  const base = rutasPerfiles(raizDatos()).carpeta
  const archivo = join(base, id, 'sloth-state.json')
  if (!dentroDe(base, archivo)) return []
  const r = leerJson<EstadoValidado | null>(archivo, { validar: (v) => validarEstado(v), porDefecto: () => null, silencioso: true, soloConsulta: true })
  return r.valor?.estado.workspaces.map((w) => w.id) ?? []
}

const feature: Feature = {
  name: 'perfiles',
  register(ctx: FeatureContext) {
    const cambio = (): void => ctx.emit('cambio')

    ctx.handle('estado', async (): Promise<PerfilesPayload> => {
      const indice = indicePerfiles()
      const backend = ctx.terminal()
      const vivas = backend ? await backend.list().catch(() => []) : []
      return {
        perfiles: indice.perfiles.map((p) => ({ ...p, tieneFoto: tieneFoto(raizDatos(), p.id), activo: p.id === indice.activo })),
        activo: indice.activo,
        ajenas: { cantidad: ctx.terminalesAjenas().length },
        modoRaiz: modoRaiz(),
        terminalesVivas: vivas.filter((s) => s.running && ctx.store.workspace(s.id) !== undefined).length,
        puedeConservarTerminales: backend?.mode === 'daemon'
      }
    })

    ctx.handle('crear', (nombre: unknown) => {
      exigirPerfiles()
      const p = crearPerfilFs(raizDatos(), nombre, Date.now(), () => randomBytes(4).toString('hex'))
      recargarIndice()
      cambio()
      return p
    })

    ctx.handle('renombrar', (id: unknown, nombre: unknown) => {
      exigirPerfiles()
      const p = renombrarPerfilFs(raizDatos(), existente(id), nombre)
      recargarIndice()
      cambio()
      return p
    })

    ctx.handle('cambiar', async (id: unknown, opts?: unknown) => {
      const destino = existente(id)
      const cerrar = opcion(opts, 'cerrarTerminales')
      if (destino === indicePerfiles().activo) throw new Error('Ya estás en ese perfil.')
      if (cerrar) {
        const b = await ctx.backend()
        for (const w of ctx.store.workspaces) if (b.isRunning(w.id)) await b.kill(w.id)
      }
      cambiarActivoFs(raizDatos(), destino)
      // La respuesta tiene que llegar a la UI antes de que se cierre el proceso.
      setTimeout(() => {
        ctx.reiniciarPorPerfil().catch((e: unknown) => {
          logger.error('perfiles', e)
          app.relaunch()
          app.exit(0)
        })
      }, ESPERA_RESPUESTA_MS)
      return { reiniciando: true }
    })

    ctx.handle('borrar', (id: unknown) => {
      const objetivo = existente(id)
      if (objetivo === indicePerfiles().activo) throw new Error('No se puede borrar el perfil activo. Cambiá a otro primero.')
      const ajenas = new Set(ctx.terminalesAjenas())
      if (espaciosDe(objetivo).some((w) => ajenas.has(w))) throw new Error('Cerrá sus terminales antes de borrarlo.')
      const respaldo = borrarPerfilFs(raizDatos(), objetivo, Date.now())
      recargarIndice()
      cambio()
      return { respaldo }
    })

    ctx.handle('traerDeGithub', async (id: unknown, opts?: unknown) => {
      const objetivo = existente(id)
      const usarNombre = opcion(opts, 'usarNombre')
      const identidad = await leerIdentidadGh()
      guardarGhLogin(raizDatos(), objetivo, identidad.login)
      const actual = indicePerfiles().perfiles.find((p) => p.id === objetivo)
      let nombreAplicado = false
      if (identidad.nombre && actual && (usarNombre || actual.nombre === NOMBRE_INICIAL) && nombreLibre(identidad.nombre, indicePerfiles().perfiles, objetivo)) {
        renombrarPerfilFs(raizDatos(), objetivo, identidad.nombre)
        nombreAplicado = true
      }
      let aviso: string | undefined
      try {
        guardarFoto(raizDatos(), objetivo, await bajarAvatar(identidad.avatarUrl))
      } catch (e) {
        logger.aviso('perfiles', `no se pudo traer la foto: ${mensaje(e)}`)
        aviso = 'Traje tu usuario, pero no pude bajar la foto.'
      }
      recargarIndice()
      cambio()
      return { login: identidad.login, nombreAplicado, foto: aviso === undefined, aviso }
    })

    ctx.handle('foto', (id: unknown) => leerFotoDataUrl(raizDatos(), existente(id)))

    ctx.handle('actividad', (id: unknown, limite?: unknown) => {
      const objetivo = existente(id)
      const base = rutasPerfiles(raizDatos()).carpeta
      return leerActividad(join(base, objetivo, 'actividad'), typeof limite === 'number' && Number.isInteger(limite) ? limite : 50)
    })

    ctx.handle('cerrarAjenas', async () => {
      const cerradas = await ctx.cerrarTerminalesAjenas()
      cambio()
      return cerradas
    })
  }
}

export default feature
