import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import type { PendingPermission } from '../daemon-client'
import type { HookEventPayload } from '../hooks'
import { PUERTO_POR_DEFECTO, type CelularVista, type RemotoVista } from '../../shared/celular'
import { enlaceCelu, secretoValido } from '../../shared/celu-remoto'
import { LIMITES_ARCHIVO } from '../statusline-core'
import { armarEstado, debeAvisar, elegirIp, leerLimites, puertoValido, temaValido, textoAviso, type TipoAviso } from './celular-core'
import { crearFuenteWifi, type FuenteDeEstado, type ProveedorDeEstado } from './celular-servidor'
import { crearFuenteRemota, type CambioRemoto } from './celular-remoto'
import { sesionChat } from './chat'
import { kindOf, labelOf } from './permissions-core'
import { responderPermiso } from './permissions'
import { currentSettings } from './settings'

/**
 * Función «celular»: un visor en el celu con el estado de las sesiones y el uso de cada cuenta.
 * v1: servidor HTTP en el Wi-Fi de casa con un token de 32 bytes que va en el QR. Apagado por
 * defecto; aprobar desde el celu y los avisos por ntfy, también.
 * Persiste en userData/features/celular.json (escritura atómica).
 *
 * Límites conocidos (v1): la página es http, así que no hay wake lock ni service worker (la pantalla
 * prendida la maneja el celu), y afuera del Wi-Fi de casa no anda hasta que haya cuentas.
 */

interface Config {
  encendido: boolean
  puerto: number
  token: string
  aprobar: boolean
  ntfy: { encendido: boolean; tema: string }
  remoto: { encendido: boolean; aprobar: boolean; secreto: string }
}

const REVISAR_IP_MS = 15_000
const NTFY_URL = 'https://ntfy.sh/'

const file = (): string => join(app.getPath('userData'), 'features', 'celular.json')
const nuevoToken = (): string => randomBytes(32).toString('base64url')
const nuevoTema = (): string => `sloth-${randomBytes(9).toString('hex')}`

function porDefecto(): Config {
  return { encendido: false, puerto: PUERTO_POR_DEFECTO, token: nuevoToken(), aprobar: false, ntfy: { encendido: false, tema: nuevoTema() }, remoto: { encendido: false, aprobar: false, secreto: nuevoToken() } }
}

function cargar(): Config {
  const base = porDefecto()
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8').replace(/^﻿/, '')) as Partial<Config>
    return {
      encendido: raw.encendido === true,
      puerto: puertoValido(raw.puerto) ? raw.puerto : base.puerto,
      token: typeof raw.token === 'string' && raw.token.length >= 43 ? raw.token : base.token,
      aprobar: raw.aprobar === true,
      ntfy: {
        encendido: raw.ntfy?.encendido === true,
        tema: temaValido(raw.ntfy?.tema) ? raw.ntfy.tema : base.ntfy.tema
      },
      remoto: {
        encendido: raw.remoto?.encendido === true,
        aprobar: raw.aprobar === true && raw.remoto?.aprobar === true,
        secreto: secretoValido(raw.remoto?.secreto) ? raw.remoto.secreto : base.remoto.secreto
      }
    }
  } catch {
    return base
  }
}

function guardarConfig(c: Config): void {
  const f = file()
  mkdirSync(dirname(f), { recursive: true })
  const tmp = `${f}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(c, null, 2), 'utf8')
  renameSync(tmp, f)
}

const ipActual = (): string | null => elegirIp(networkInterfaces())

let detenerTodo: (() => Promise<void>) | null = null

const feature: Feature = {
  name: 'celular',
  register(ctx: FeatureContext) {
    let cfg = cargar()
    if (!existsSync(file())) {
      try {
        guardarConfig(cfg)
      } catch (e) {
        ctx.log('no se pudo guardar la configuración:', (e as Error).message)
      }
    }
    let fuente: (FuenteDeEstado & { puerto(): number }) | null = null
    let ipServida: string | null = null
    let ipCambio = false
    let error: string | null = null
    let revisor: NodeJS.Timeout | null = null
    let icono: Buffer | null | undefined
    const enviados = new Map<string, number>()
    let fuenteRemota: FuenteDeEstado | null = null
    let remotoEstado: RemotoVista['estado'] = 'apagado'
    let remotoError: string | null = null
    let celuActivo = false

    const guardar = (): void => {
      try {
        guardarConfig(cfg)
      } catch (e) {
        ctx.log('no se pudo guardar la configuración:', (e as Error).message)
      }
    }

    const vistaRemota = (): RemotoVista => {
      const s = cfg.remoto.encendido ? sesionChat() : null
      return {
        encendido: cfg.remoto.encendido,
        aprobar: cfg.remoto.aprobar,
        estado: cfg.remoto.encendido ? remotoEstado : 'apagado',
        enlace: s ? enlaceCelu({ u: s.supabaseUrl, k: s.anonKey, s: cfg.remoto.secreto, id: s.userId }) : null,
        celuActivo,
        error: remotoError
      }
    }

    const vista = (): CelularVista => ({
      encendido: cfg.encendido,
      escuchando: !!fuente,
      ip: ipServida ?? ipActual(),
      puerto: cfg.puerto,
      enlace: fuente && ipServida ? `http://${ipServida}:${cfg.puerto}/?t=${cfg.token}` : null,
      aprobar: cfg.aprobar,
      ntfy: { ...cfg.ntfy },
      error,
      ipCambio,
      remoto: vistaRemota()
    })
    const avisar = (): void => ctx.emit('changed', vista())

    const leerIcono = (): Buffer | null => {
      if (icono !== undefined) return icono
      const ruta = [join(process.resourcesPath, 'icon.png'), join(__dirname, '../../build/icon-256.png'), join(__dirname, '../../build/icon.png')].find((p) => existsSync(p))
      try {
        icono = ruta ? readFileSync(ruta) : null
      } catch {
        icono = null
      }
      return icono
    }

    async function limites(): Promise<Record<string, ReturnType<typeof leerLimites>>> {
      const ahora = Date.now()
      const pares = await Promise.all(
        ctx.store.accounts.map(async (a) => {
          let texto: string | null = null
          try {
            texto = await readFile(join(a.configDir, LIMITES_ARCHIVO), 'utf8')
          } catch {
            /* la cuenta todavía no tiene el dato */
          }
          return [a.id, leerLimites(texto, ahora)] as const
        })
      )
      return Object.fromEntries(pares)
    }

    const pedidos = (): PendingPermission[] => ctx.terminal()?.pendingPermissions() ?? []

    const proveedor: ProveedorDeEstado = {
      async estado() {
        const cuentas = ctx.store.accounts
        let uso = ctx.usage.latest
        try {
          uso = await ctx.usage.scan(cuentas)
        } catch (e) {
          ctx.log('no se pudo leer el uso:', (e as Error).message)
        }
        return armarEstado({
          ahora: Date.now(),
          aprobar: cfg.aprobar,
          cuentas: cuentas.map((a) => ({ id: a.id, label: a.label })),
          espacios: ctx.store.workspaces.map((w) => ({ id: w.id, name: w.name, accountId: w.accountId })),
          agentes: ctx.agents(),
          uso,
          limites: await limites(),
          pedidos: pedidos().map((p) => ({ id: p.id, ws: p.ws, texto: labelOf(kindOf(p.tool), p.tool, p.input), at: p.at, expiresAt: p.expiresAt }))
        })
      },
      decidir(id, decision) {
        if (!cfg.aprobar) throw new Error('Aprobar desde el celu está apagado en Sloth.')
        responderPermiso(id, decision)
        ctx.log(`permiso ${decision === 'allow' ? 'aprobado' : 'rechazado'} desde el celu`)
      },
      puedeAprobar: () => cfg.aprobar,
      token: () => cfg.token,
      icono: leerIcono
    }

    async function detener(): Promise<void> {
      const f = fuente
      fuente = null
      ipServida = null
      if (f) await f.detener()
    }

    async function iniciar(): Promise<void> {
      await detener()
      error = null
      if (!cfg.encendido) return
      const ip = ipActual()
      if (!ip) {
        error = 'No encontré la red de casa. Conectá la PC al Wi-Fi (o por cable al mismo router que el celu).'
        return
      }
      const f = crearFuenteWifi({ host: ip, puerto: cfg.puerto, proveedor, log: ctx.log })
      try {
        await f.iniciar()
        fuente = f
        ipServida = ip
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        error =
          code === 'EADDRINUSE'
            ? `El puerto ${cfg.puerto} ya lo usa otro programa. Elegí otro.`
            : code === 'EACCES'
              ? `Windows no deja usar el puerto ${cfg.puerto}. Elegí otro.`
              : `No pude abrir el servidor: ${(e as Error).message}`
      }
    }

    /** Si la PC cambió de IP (otra red, el router le dio otra), se reabre en la nueva y se avisa: el QR viejo ya no sirve. */
    async function revisarIp(): Promise<void> {
      if (!cfg.encendido) return
      const ip = ipActual()
      if (ip === ipServida && (fuente || !ip)) return
      const habia = ipServida
      await iniciar()
      if (habia && ipServida && habia !== ipServida) {
        ipCambio = true
        ctx.emit('ip-cambio', { antes: habia, ahora: ipServida })
      }
      avisar()
    }

    function programarRevision(): void {
      if (revisor) clearInterval(revisor)
      revisor = null
      if (!cfg.encendido) return
      revisor = setInterval(() => void revisarIp().catch((e: unknown) => ctx.log('revisar IP:', (e as Error).message)), REVISAR_IP_MS)
      revisor.unref()
    }

    async function aplicar(): Promise<CelularVista> {
      await iniciar()
      programarRevision()
      avisar()
      return vista()
    }

    async function detenerRemota(): Promise<void> {
      const f = fuenteRemota
      fuenteRemota = null
      remotoEstado = 'apagado'
      remotoError = null
      celuActivo = false
      if (f) await f.detener()
    }

    // Independiente del Wi-Fi: anda aunque el servidor de casa esté apagado.
    async function iniciarRemota(): Promise<void> {
      await detenerRemota()
      if (!cfg.remoto.encendido) return
      const f = crearFuenteRemota({
        proveedor,
        sesion: sesionChat,
        secreto: () => cfg.remoto.secreto,
        puedeAprobar: () => cfg.aprobar && cfg.remoto.aprobar,
        alCambiar: (e: CambioRemoto) => {
          if (fuenteRemota !== f) return
          remotoEstado = e.estado
          remotoError = e.error
          celuActivo = e.celuActivo
          avisar()
        },
        log: ctx.log
      })
      fuenteRemota = f
      await f.iniciar()
    }

    async function aplicarRemota(): Promise<CelularVista> {
      await iniciarRemota()
      avisar()
      return vista()
    }

    async function mandarNtfy(tipo: TipoAviso, wsId: string, detalle?: string, prueba = false): Promise<void> {
      if (!prueba && (!cfg.ntfy.encendido || currentSettings().noMolestar)) return
      if (!temaValido(cfg.ntfy.tema)) throw new Error('El tema de ntfy no es válido.')
      // Con Sloth en primer plano el aviso ya se ve en la PC: el celu es para cuando estás en otra cosa.
      const win = ctx.window()
      if (!prueba && win && !win.isDestroyed() && win.isFocused()) return
      const espacio = prueba ? 'Sloth' : ctx.store.workspace(wsId)?.name
      if (!espacio) return
      if (!prueba && !debeAvisar(enviados, `${wsId}:${tipo}`, Date.now())) return
      const { titulo, cuerpo } = prueba ? { titulo: 'Sloth', cuerpo: 'Así te van a llegar los avisos.' } : textoAviso(tipo, espacio, detalle)
      const r = await fetch(NTFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: cfg.ntfy.tema, title: titulo, message: cuerpo, priority: tipo === 'termino' ? 3 : 4, tags: [tipo === 'termino' ? 'white_check_mark' : 'warning'] }),
        signal: AbortSignal.timeout(8000)
      })
      if (!r.ok) throw new Error(`ntfy respondió ${r.status}.`)
    }

    const ntfyEnFondo = (tipo: TipoAviso, wsId: string, detalle?: string): void => {
      mandarNtfy(tipo, wsId, detalle).catch((e: unknown) => ctx.log('ntfy:', (e as Error).message))
    }

    ctx.onHook((p: HookEventPayload) => {
      if (p.enFondo) return
      if (p.event === 'Stop') ntfyEnFondo('termino', p.ws)
      else if (p.event === 'Notification' && p.notificationType !== 'permission_prompt') ntfyEnFondo('teNecesita', p.ws, p.message)
    })
    void ctx.backend().then(
      (b) => b.on('permission', (req: PendingPermission) => ntfyEnFondo('permiso', req.ws, labelOf(kindOf(req.tool), req.tool, req.input))),
      () => undefined
    )

    ctx.handle('vista', () => vista())

    ctx.handle('encender', async (on: unknown) => {
      if (typeof on !== 'boolean') throw new Error('Valor inválido.')
      cfg.encendido = on
      ipCambio = false
      guardar()
      return aplicar()
    })

    ctx.handle('puerto', async (p: unknown) => {
      if (!puertoValido(p)) throw new Error('El puerto tiene que ser un número entre 1024 y 65535.')
      cfg.puerto = p
      guardar()
      return aplicar()
    })

    ctx.handle('regenerar', () => {
      cfg.token = nuevoToken()
      guardar()
      ctx.log('token regenerado: los celus anteriores quedan afuera')
      avisar()
      return vista()
    })

    ctx.handle('aprobar', (on: unknown) => {
      if (typeof on !== 'boolean') throw new Error('Valor inválido.')
      cfg.aprobar = on
      if (!on) cfg.remoto.aprobar = false
      guardar()
      avisar()
      return vista()
    })

    ctx.handle('ntfy', (p: unknown) => {
      const { encendido, tema } = (p ?? {}) as { encendido?: unknown; tema?: unknown }
      if (encendido !== undefined && typeof encendido !== 'boolean') throw new Error('Valor inválido.')
      if (tema !== undefined && !temaValido(tema)) throw new Error('El tema va de 6 a 64 caracteres: letras, números, guion o guion bajo.')
      cfg.ntfy = { encendido: encendido ?? cfg.ntfy.encendido, tema: tema ?? cfg.ntfy.tema }
      guardar()
      avisar()
      return vista()
    })

    ctx.handle('remoto', async (p: unknown) => {
      const { encendido, aprobar } = (p ?? {}) as { encendido?: unknown; aprobar?: unknown }
      if (encendido !== undefined && typeof encendido !== 'boolean') throw new Error('Valor inválido.')
      if (aprobar !== undefined && typeof aprobar !== 'boolean') throw new Error('Valor inválido.')
      if (aprobar === true && !cfg.aprobar) throw new Error('Primero prendé “Aprobar desde el celu”.')
      const cambiaEncendido = encendido !== undefined && encendido !== cfg.remoto.encendido
      cfg.remoto = { ...cfg.remoto, encendido: encendido ?? cfg.remoto.encendido, aprobar: aprobar ?? cfg.remoto.aprobar }
      guardar()
      if (cambiaEncendido) return aplicarRemota()
      avisar()
      return vista()
    })

    // Con la clave nueva la PC deja de publicar con la vieja y no abre decisiones selladas con ella. El
    // secreto no frena una sesión de GitHub robada: para eso se cierran las sesiones de los otros dispositivos.
    ctx.handle('remoto-regenerar', async (p: unknown) => {
      const { cerrarOtras } = (p ?? {}) as { cerrarOtras?: unknown }
      if (cerrarOtras !== undefined && typeof cerrarOtras !== 'boolean') throw new Error('Valor inválido.')
      const anterior = cfg.remoto
      cfg.remoto = { ...cfg.remoto, secreto: nuevoToken() }
      try {
        guardarConfig(cfg)
      } catch (e) {
        cfg.remoto = anterior
        throw new Error(`No se pudo guardar el código nuevo: ${(e as Error).message}`)
      }
      ctx.log('secreto remoto regenerado: los celus anteriores quedan afuera')
      const v = await aplicarRemota()
      if (!cerrarOtras) return v
      const s = sesionChat()
      if (!s) throw new Error('El código es nuevo, pero sin sesión en el chat no pude cerrar las sesiones de los otros dispositivos.')
      const { error } = await s.client.auth.signOut({ scope: 'others' })
      if (error) throw new Error(`El código es nuevo, pero no pude cerrar las sesiones de los otros dispositivos: ${error.message}`)
      ctx.log('sesiones del chat de los otros dispositivos cerradas')
      return v
    })

    ctx.handle('probar-ntfy', () => mandarNtfy('termino', '', undefined, true))

    ctx.handle('visto-ip', () => {
      ipCambio = false
      avisar()
    })

    detenerTodo = async () => {
      if (revisor) clearInterval(revisor)
      revisor = null
      await Promise.all([detener(), detenerRemota()])
    }

    void iniciarRemota().catch((e: unknown) => ctx.log('celu remoto: no se pudo arrancar:', (e as Error).message))
    void aplicar().catch((e: unknown) => ctx.log('no se pudo arrancar:', (e as Error).message))
  },
  dispose() {
    void detenerTodo?.()
  }
}

export default feature
