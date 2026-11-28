import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { escribirJsonAtomico, leerJson, respaldar } from '../json-file'
import { migrar } from '../versionado'
import { avisoVersionFutura } from '../avisos'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import type { PendingPermission } from '../daemon-client'
import type { HookEventPayload } from '../hooks'
import { PUERTO_POR_DEFECTO, type CelularVista, type RemotoVista } from '../../shared/celular'
import { CELU_WEB_URL, enlaceCelu, secretoValido } from '../../shared/celu-remoto'
import { LIMITES_ARCHIVO } from '../statusline-core'
import { agenteDe, capacidadesDe } from '../../shared/proveedores'
import { limitesDeCuenta } from '../codex-limites'
import { armarEstado, claveValida, pedidoParaCelu, httpsTailscale, ipTailscale, cuerpoNtfy, enlaceAviso, textoAvisoPrivado, NTFY_POR_DEFECTO, debeAvisar, elegirIp, leerLimites, puertoValido, resumenPermiso, servidorNtfy, TEMA_MIN, temaValido, textoAviso, tokenNtfyTras, tokenNtfyValido, type TipoAviso } from './celular-core'
import { crearRepetidos } from './celular-sello'
import { crearFuenteWifi, type FuenteDeEstado, type ProveedorDeEstado } from './celular-servidor'
import { XTERM } from './celular-xterm'
import { debeEsperar, nuevoVisor, ponerFoto, salidaDesde, sinSalida, sinAutomaticas, sumarSalida, tamanoActual, vencidos, type RespuestaTerminal, type Visor } from './celular-terminal-core'
import { crearEsperas } from './celular-espera'
import { crearEscrituras } from './celular-escrituras'
import { crearActividad, type Quien } from './celular-actividad'
import { MAX_CELUS, VERSION_CELULAR, crearEntradas, leerCelus, migracionesCelular, nivelValido, paraVista, permisosDe, sinVencidos, usar, type CeluGuardado } from './celular-acceso'
import { crearFuenteRemota, type CambioRemoto } from './celular-remoto'
import { sesionChat } from './chat'
import { kindOf } from '../../shared/permissions-core'
import { responderPermiso } from './permissions'
import { currentSettings } from './settings'
import { carpetaFeatures } from '../perfil'

/**
 * Función «celular»: un visor en el celu con el estado de las sesiones y el uso de cada cuenta.
 * Servidor HTTP en el Wi-Fi de casa con los cuerpos sellados (AES-256-CTR + HMAC). La clave del QR (en el `#`,
 * para que no viaje en ningún pedido) solo sirve para pedir entrar: cada celu genera la suya y entra cuando en la PC
 * tocan «Dejar entrar», con un nivel (ver, aprobar, terminal) que se puede cambiar o sacar. Apagado por defecto; aprobar desde el celu y los avisos por ntfy, también.
 * Persiste en userData/features/celular.json (escritura atómica).
 *
 * Límites conocidos (v1): la página es http, así que no hay wake lock ni service worker (la pantalla
 * prendida la maneja el celu), y afuera del Wi-Fi de casa no anda hasta que haya cuentas.
 */

interface Config {
  encendido: boolean
  puerto: number
  /** La del QR: solo sirve para pedir entrar. Cada celu que la PC deja entrar tiene la suya, en `celus`. */
  clave: string
  celus: CeluGuardado[]
  aprobar: boolean
  /** Ver y escribir en las terminales desde el celu (solo en el Wi-Fi). */
  terminal: boolean
  /** `privado`: los avisos no llevan el nombre del espacio ni el mensaje de Claude. */
  ntfy: { encendido: boolean; tema: string; servidor: string; token?: string; temaRenovado?: boolean; privado?: boolean }
  remoto: { encendido: boolean; aprobar: boolean; secreto: string }
  /** Apagado por defecto: abre la misma página en la IP de Tailscale y en 127.0.0.1 (para `tailscale serve`). */
  tailscale: { encendido: boolean; https?: string }
}

const REVISAR_IP_MS = 15_000
const LOCAL = '127.0.0.1'

const file = (): string => join(carpetaFeatures(), 'celular.json')
const nuevoToken = (): string => randomBytes(32).toString('base64url')
const nuevoTema = (): string => `sloth-${randomBytes(12).toString('hex')}`

function porDefecto(): Config {
  return { encendido: false, puerto: PUERTO_POR_DEFECTO, clave: nuevoToken(), celus: [], aprobar: false, terminal: false, ntfy: { encendido: false, tema: nuevoTema(), servidor: NTFY_POR_DEFECTO }, remoto: { encendido: false, aprobar: false, secreto: nuevoToken() }, tailscale: { encendido: false } }
}

/** Cómo quedó el archivo al leerlo: migrado (hay que respaldarlo antes de reescribir) o de una versión más nueva (no se toca). */
const archivo = { migrado: false, futura: false, resto: {} as Record<string, unknown> }

function cargar(): { cfg: Config; claveNueva: boolean } {
  const base = porDefecto()
  const ahora = Date.now()
  const raw = leerJson(file(), {
    validar: (v) => {
      const r = migrar(v, migracionesCelular(ahora), VERSION_CELULAR)
      if (r.estado === 'invalida') return undefined
      archivo.migrado = r.estado === 'migrado'
      archivo.futura = r.estado === 'futura'
      return r.datos as Partial<Config> & Record<string, unknown>
    },
    porDefecto: (): Partial<Config> & Record<string, unknown> => ({})
  }).valor
  if (archivo.futura) avisoVersionFutura(file())
  const { version: _v, encendido: _e, puerto: _p, clave: _c, celus: _cs, aprobar: _a, terminal: _t, ntfy: _n, remoto: _r, tailscale: _ts, ...resto } = raw
  const https = httpsTailscale(raw.tailscale?.https)
  archivo.resto = resto
  const temaGuardado = raw.ntfy?.tema
  const temaOk = temaValido(temaGuardado)
  const token = tokenNtfyValido(raw.ntfy?.token) ? raw.ntfy.token : undefined
  const renovado = raw.ntfy?.temaRenovado === true || (!temaOk && temaGuardado !== undefined)
  const claveNueva = !claveValida(raw.clave)
  const cfg: Config = {
    encendido: raw.encendido === true,
    puerto: puertoValido(raw.puerto) ? raw.puerto : base.puerto,
    clave: claveValida(raw.clave) ? raw.clave : base.clave,
    celus: leerCelus(raw.celus, ahora, raw.clave),
    aprobar: raw.aprobar === true,
    terminal: raw.terminal === true,
    ntfy: {
      encendido: temaOk && raw.ntfy?.encendido === true,
      tema: temaOk ? temaGuardado : base.ntfy.tema,
      servidor: servidorNtfy(raw.ntfy?.servidor) ?? NTFY_POR_DEFECTO,
      ...(token !== undefined && { token }),
      ...(renovado && { temaRenovado: true }),
      ...(raw.ntfy?.privado === true && { privado: true })
    },
    remoto: {
      encendido: raw.remoto?.encendido === true,
      aprobar: raw.aprobar === true && raw.remoto?.aprobar === true,
      secreto: secretoValido(raw.remoto?.secreto) ? raw.remoto.secreto : base.remoto.secreto
    },
    tailscale: { encendido: raw.tailscale?.encendido === true, ...(https && { https }) }
  }
  return { cfg, claveNueva }
}

function guardarConfig(c: Config): void {
  if (archivo.futura) return avisoVersionFutura(file())
  if (archivo.migrado && existsSync(file())) {
    respaldar(file())
    archivo.migrado = false
  }
  escribirJsonAtomico(file(), { ...archivo.resto, version: VERSION_CELULAR, ...c })
}

const ipActual = (): string | null => elegirIp(networkInterfaces())
const ipTs = (): string | null => ipTailscale(networkInterfaces())

let detenerTodo: (() => Promise<void>) | null = null

const feature: Feature = {
  name: 'celular',
  register(ctx: FeatureContext) {
    const cargada = cargar()
    const cfg = cargada.cfg
    if (!existsSync(file()) || cargada.claveNueva || cfg.ntfy.temaRenovado || archivo.migrado) {
      try {
        guardarConfig(cfg)
      } catch (e) {
        ctx.log('no se pudo guardar la configuración:', (e as Error).message)
      }
    }
    let fuente: (FuenteDeEstado & { puerto(): number }) | null = null
    // Por Tailscale: la IP 100.x (directo, http) y 127.0.0.1 (lo que `tailscale serve` pasa a HTTPS). Mismo proveedor y mismas claves.
    let extras: { host: string; f: FuenteDeEstado }[] = []
    let tsServida: string | null = null
    // La IP de Tailscale con la que se probó abrir, haya abierto o no: si falla, no se reintenta cada 15 s tirando lo del Wi-Fi.
    let tsIntentada: string | null = null
    let tsError: string | null = null
    let ipServida: string | null = null
    let ipCambio = false
    let error: string | null = null
    let errorDePuerto = false
    let revisor: NodeJS.Timeout | null = null
    const iconos = new Map<string, Buffer | null>()
    const enviados = new Map<string, number>()
    let fuenteRemota: FuenteDeEstado | null = null
    let remotoEstado: RemotoVista['estado'] = 'apagado'
    let remotoError: string | null = null
    let celuActivo = false
    const visores = new Map<string, Visor>()
    const esperas = crearEsperas()
    const escrituras = crearEscrituras()
    const repetidos = crearRepetidos()
    let vencedor: NodeJS.Timeout | null = null


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

    // Qué celus entraron y qué hicieron, para que la PC no tenga a alguien adentro sin que se vea.
    const actividad = crearActividad()
    let conectadosAntes = 0
    let vigia: NodeJS.Timeout | null = null
    let avisoPendiente: NodeJS.Timeout | null = null
    const avisarPronto = (): void => {
      if (avisoPendiente) return
      avisoPendiente = setTimeout(() => {
        avisoPendiente = null
        avisar()
      }, 1000)
      avisoPendiente.unref()
    }
    const revisarConectados = (): void => {
      const n = actividad.conectados(Date.now()).length
      if (n !== conectadosAntes) avisarPronto()
      conectadosAntes = n
      if (!n && vigia) {
        clearInterval(vigia)
        vigia = null
      } else if (n && !vigia) {
        vigia = setInterval(revisarConectados, 5000)
        vigia.unref()
      }
    }
    // Quién tiene acceso y quién pide entrar. Un celu sacado o vencido deja de abrir pedidos en el acto: su clave ya no está.
    const entradas = crearEntradas()
    let repintarEntradas: NodeJS.Timeout | null = null
    const programarEntradas = (): void => {
      if (repintarEntradas) clearTimeout(repintarEntradas)
      const ms = entradas.proximoVence(Date.now())
      repintarEntradas = ms === null ? null : setTimeout(() => {
        repintarEntradas = null
        avisar()
        programarEntradas()
      }, ms + 50)
      repintarEntradas?.unref()
    }
    const celuDe = (quien?: Quien): CeluGuardado | undefined => (quien?.celu ? cfg.celus.find((c) => c.id === quien.celu) : undefined)
    /** Sin `quien` (la fuente remota, que tiene su propia llave) valen solo los interruptores. */
    const permisos = (quien?: Quien): { aprobar: boolean; terminal: boolean } => {
      if (!quien) return { aprobar: cfg.aprobar, terminal: cfg.terminal }
      const c = celuDe(quien)
      return c ? permisosDe(c.nivel, cfg) : { aprobar: false, terminal: false }
    }
    const podarCelus = (): void => {
      const vivos = sinVencidos(cfg.celus, Date.now())
      if (vivos.length === cfg.celus.length) return
      cfg.celus = vivos
      guardar()
      avisarPronto()
    }
    const entrar = (cuerpo: unknown, quien: Quien): { status: number; data: unknown } => {
      const b = cuerpo as { clave?: unknown; consultar?: unknown } | null
      if (!b || typeof b !== 'object' || !claveValida(b.clave) || b.clave === cfg.clave) return { status: 400, data: { error: 'Pedido inválido.' } }
      // Un celu que ya tenía acceso y volvió a escanear el QR sigue con su clave: no se suma otro a la lista.
      if (cfg.celus.some((c) => c.clave === b.clave)) return { status: 200, data: { estado: 'listo' } }
      if (b.consultar === true) return { status: 200, data: { estado: entradas.estado(b.clave, Date.now()) } }
      if (cfg.celus.length >= MAX_CELUS) return { status: 403, data: { error: 'Esta PC ya tiene demasiados celus con acceso. Sacá alguno en el panel «Celular».' } }
      const r = entradas.pedir(b.clave, quien, Date.now())
      if ('error' in r) return { status: 409, data: r }
      ctx.log('un celu pide entrar:', quien.ip)
      programarEntradas()
      avisar()
      return { status: 200, data: { codigo: r.codigo, estado: 'esperando' } }
    }

    const nombreEspacio = (id: string): string => ctx.store.workspace(id)?.name ?? 'un espacio'
    function anotarCelu(quien: Quien | undefined, tipo: 'aprobo' | 'rechazo' | 'abrio' | 'escribio', ws: string): void {
      if (!quien) return
      if (actividad.anotar(quien, tipo, nombreEspacio(ws), Date.now())) avisarPronto()
    }

    const vista = (): CelularVista => ({
      encendido: cfg.encendido,
      escuchando: !!fuente,
      ip: ipServida ?? ipActual(),
      puerto: cfg.puerto,
      enlace: fuente && ipServida ? `http://${ipServida}:${cfg.puerto}/#k=${cfg.clave}` : null,
      aprobar: cfg.aprobar,
      terminal: cfg.terminal,
      ntfy: {
        encendido: cfg.ntfy.encendido,
        tema: cfg.ntfy.tema,
        servidor: cfg.ntfy.servidor,
        conToken: cfg.ntfy.token !== undefined,
        privado: cfg.ntfy.privado === true,
        ...(cfg.ntfy.temaRenovado && { temaRenovado: true })
      },
      error,
      ipCambio,
      remoto: vistaRemota(),
      tailscale: {
        encendido: cfg.tailscale.encendido,
        ip: tsServida ?? ipTs(),
        enlace: tsServida ? `http://${tsServida}:${cfg.puerto}/#k=${cfg.clave}` : null,
        https: cfg.tailscale.https ?? null,
        enlaceHttps: cfg.tailscale.https && extras.some((x) => x.host === LOCAL) ? `${cfg.tailscale.https}/#k=${cfg.clave}` : null,
        error: tsError
      },
      celus: actividad.conectados(Date.now()),
      actividad: actividad.eventos().slice(0, 30),
      conAcceso: paraVista(cfg.celus),
      entradas: entradas.pendientes(Date.now())
    })
    const avisar = (): void => ctx.emit('changed', vista())

    const leerIcono = (archivo = 'icono-192.png'): Buffer | null => {
      const visto = iconos.get(archivo)
      if (visto !== undefined) return visto
      // El de 192 px pesa 15 KB; el icon.png de la app, medio mega, solo queda de respaldo.
      const respaldo = archivo === 'icono-192.png' ? [join(process.resourcesPath, 'icon.png'), join(__dirname, '../../build/icon-256.png')] : []
      const ruta = [join(process.resourcesPath, 'celu-iconos', archivo), join(__dirname, '../../src/celu-web/iconos', archivo), ...respaldo].find((p) => existsSync(p))
      let png: Buffer | null = null
      try {
        png = ruta ? readFileSync(ruta) : null
      } catch {
        png = null
      }
      iconos.set(archivo, png)
      return png
    }

    async function limites(): Promise<Record<string, ReturnType<typeof leerLimites>>> {
      const ahora = Date.now()
      const pares = await Promise.all(
        ctx.store.accounts.map(async (a) => {
          let texto: string | null = null
          // El archivo de límites lo escribe la statusline de Claude: otro agente no lo tiene y no se lo busca.
          if (!capacidadesDe(a)?.statusline) {
            // Sin esperar: el celu consulta seguido y la lectura de Codex puede tardar hasta 10 s; muestra lo último leído.
            const l = await limitesDeCuenta(a, false)
            return [a.id, l.tipo === 'datos' ? { cincoHoras: l.limites.cincoHoras, semana: l.limites.semana, at: l.limites.at } : leerLimites(null, ahora)] as const
          }
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
      async estado(quien) {
        const c = celuDe(quien)
        if (c && usar(c, Date.now())) guardar()
        if (quien && actividad.visto(quien, Date.now())) {
          const c = actividad.conectados(Date.now()).find((x) => x.ip === quien.ip)
          ctx.log('celu conectado:', c?.dispositivo ?? '?', quien.ip)
          ctx.emit('celu-nuevo', { dispositivo: c?.dispositivo ?? 'Un celu', ip: quien.ip })
          avisarPronto()
        }
        if (quien) revisarConectados()
        const cuentas = ctx.store.accounts
        let uso = ctx.usage.latest
        try {
          uso = await ctx.usage.scan(cuentas)
        } catch (e) {
          ctx.log('no se pudo leer el uso:', (e as Error).message)
        }
        return armarEstado({
          ahora: Date.now(),
          ...permisos(quien),
          cuentas: cuentas.map((a) => ({ id: a.id, label: a.label })),
          espacios: ctx.store.workspaces.map((w) => ({ id: w.id, name: w.name, accountId: w.accountId })),
          agentes: ctx.agents(),
          uso,
          limites: await limites(),
          pedidos: pedidos().map((p) => ({ id: p.id, ws: p.ws, tool: p.tool, input: p.input, at: p.at, expiresAt: p.expiresAt }))
        })
      },
      decidir(id, decision, quien) {
        if (!cfg.aprobar) throw new Error('Aprobar desde el celu está apagado en Sloth.')
        if (!permisos(quien).aprobar) throw new Error('Este celu solo puede mirar. En la PC, panel «Celular», podés darle permiso para aprobar.')
        const pedido = pedidos().find((p) => p.id === id)
        const ws = pedido?.ws
        // Una página vieja no sabe de `cortado`: la PC no acepta aprobar algo que el celu no pudo mostrar entero.
        if (decision === 'allow' && pedido && pedidoParaCelu(pedido.tool, pedido.input).cortado) throw new Error('Es demasiado largo para verlo entero en el celu: respondelo en la PC.')
        responderPermiso(id, decision)
        if (ws) anotarCelu(quien, decision === 'allow' ? 'aprobo' : 'rechazo', ws)
        ctx.log(`permiso ${decision === 'allow' ? 'aprobado' : 'rechazado'} desde el celu`)
      },
      puedeAprobar: (quien) => permisos(quien).aprobar,
      clave: () => cfg.clave,
      celus: () => {
        podarCelus()
        return cfg.celus.map((c) => ({ id: c.id, clave: c.clave }))
      },
      entrar,
      icono: leerIcono,
      async terminal(p, cancelar, quien) {
        if (!cfg.terminal) return { status: 403, error: 'La terminal desde el celu está apagada en Sloth.' }
        if (!permisos(quien).terminal) return { status: 403, error: 'Este celu no tiene permiso para abrir las terminales. En la PC, panel «Celular», podés dárselo.' }
        if (!ctx.store.workspace(p.id)) return { status: 404, error: 'Ese espacio ya no está en la PC.' }
        if (p.desde === -1 && !p.soloEscribir) anotarCelu(quien, 'abrio', p.id)
        const b = await ctx.backend()
        const viva = b.isRunning(p.id)
        let v = visores.get(p.id)
        if (!v && viva) {
          v = nuevoVisor(Date.now())
          visores.set(p.id, v)
          programarVencer()
          // Corriendo, start devuelve el buffer sin arrancar nada; el spawn vacío hace que, si justo se cerró, falle en vez de abrir otra shell.
          try {
            const foto = await b.start(p.id, { file: '', args: [], cwd: '', env: {}, cols: 80, rows: 24 })
            ponerFoto(v, foto.chunks, foto.upTo)
          } catch {
            visores.delete(p.id)
            v = undefined
          }
        }
        if (v) v.usadoEn = Date.now()
        // Un reintento (la respuesta se perdió) trae el mismo número: lo que ya se escribió no se escribe dos veces.
        const repetida = p.sesion !== undefined && p.n !== undefined && (p.escribir !== undefined || p.tam !== undefined) && !escrituras.nueva(p.id, p.sesion, p.n, Date.now())
        if (v && viva && !repetida) {
          // Lo que el xterm del celu contesta solo (posición, foco, mouse) no es entrada del usuario; `tam` de una página vieja se ignora.
          const texto = p.escribir ? sinAutomaticas(p.escribir) : ''
          if (texto) {
            ctx.writePty(p.id, texto)
            anotarCelu(quien, 'escribio', p.id)
          }
        }
        const respuesta = (visor: Visor | undefined, sigueViva: boolean, salida: ReturnType<typeof salidaDesde>): RespuestaTerminal => {
          const tam = tamanoActual(ctx.ptySize(p.id))
          return { ...salida, viva: sigueViva && !!visor, cols: tam.cols, rows: tam.rows, ajustado: false }
        }
        if (p.soloEscribir) return respuesta(v, viva, sinSalida(p))
        const salida = v ? salidaDesde(v, p.desde) : { reinicio: p.desde !== -1, datos: '', hasta: 0, mas: false }
        if (v && p.espera && debeEsperar(p, salida, viva)) {
          const espera = esperas.esperar(p.id, p.espera, cancelar, p.sesion)
          if (espera === null) return { status: 429, error: 'La PC tiene demasiadas terminales abiertas desde el celu.' }
          v.usadoEn = Date.now()
          const motivo = await espera
          // Mientras esperaba pudo apagarse la terminal del celu o soltarse el visor: se vuelve a mirar todo, nada de lo de antes vale.
          if (!cfg.terminal) return { status: 403, error: 'La terminal desde el celu está apagada en Sloth.' }
          const actual = visores.get(p.id)
          if (actual) actual.usadoEn = Date.now()
          const sigue = b.isRunning(p.id)
          if (!actual || motivo === 'soltada' || motivo === 'cancelada') return respuesta(actual, sigue, sinSalida(p))
          return respuesta(actual, sigue, salidaDesde(actual, p.desde))
        }
        return respuesta(v, viva, salida)
      },
      xterm: () => XTERM
    }

    function soltarVisores(ids?: string[]): void {
      for (const id of ids ?? [...visores.keys()]) {
        visores.delete(id)
        esperas.soltar(id)
      }
      if (!ids) esperas.soltarTodas()
      if (!visores.size && vencedor) {
        clearInterval(vencedor)
        vencedor = null
      }
    }

    function programarVencer(): void {
      if (vencedor) return
      vencedor = setInterval(() => soltarVisores(vencidos(visores, Date.now())), 10_000)
      vencedor.unref()
    }

    ctx.onPtyData((id, chunks) => {
      const v = visores.get(id)
      if (!v) return
      sumarSalida(v, chunks)
      esperas.avisar(id)
    })
    ctx.onPtyExit((id) => {
      esperas.avisar(id)
    })

    async function detener(): Promise<void> {
      const f = fuente
      const otras = extras
      fuente = null
      ipServida = null
      extras = []
      tsServida = null
      tsIntentada = null
      esperas.soltarTodas()
      if (f) await f.detener()
      await Promise.all(otras.map((x) => x.f.detener()))
    }

    // Que Tailscale no abra no apaga lo del Wi-Fi: el error queda en su sección.
    async function iniciarTailscale(): Promise<void> {
      tsError = null
      if (!cfg.tailscale.encendido || !fuente) return
      const ip = ipTs()
      tsIntentada = ip
      for (const host of ip ? [ip, LOCAL] : [LOCAL]) {
        // Por 127.0.0.1 entran todos los celus que usan la dirección https: más conexiones, y en el panel se ven como «Tailscale (HTTPS)».
        const local = host === LOCAL
        const f = crearFuenteWifi({ host, puerto: cfg.puerto, proveedor, repetidos, log: ctx.log, ...(local && { maxConexionesPorIp: 64, etiqueta: 'Tailscale (HTTPS)' }) })
        try {
          await f.iniciar()
          extras.push({ host, f })
          if (host === ip) tsServida = ip
        } catch (e) {
          tsError = `No pude abrir ${host}:${cfg.puerto}: ${(e as Error).message}`
        }
      }
      if (!ip) tsError = 'No encontré Tailscale conectado en esta PC. Abrilo e iniciá sesión (en la PC y en el celu, con la misma cuenta).'
    }

    async function iniciar(): Promise<void> {
      await detener()
      error = null
      errorDePuerto = false
      if (!cfg.encendido) return
      const ip = ipActual()
      if (!ip) {
        error = 'No encontré la red de casa. Conectá la PC al Wi-Fi (o por cable al mismo router que el celu).'
        return
      }
      const f = crearFuenteWifi({ host: ip, puerto: cfg.puerto, proveedor, repetidos, log: ctx.log })
      try {
        await f.iniciar()
        fuente = f
        ipServida = ip
        await iniciarTailscale()
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        errorDePuerto = code === 'EADDRINUSE' || code === 'EACCES'
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
      const tsCambio = cfg.tailscale.encendido && !!fuente && ipTs() !== tsIntentada
      if (ip === ipServida && (fuente || !ip) && !tsCambio) return
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

    // Si el usuario prendió o cambió el puerto y no se pudo abrir, no queda «encendido» reintentando a ciegas.
    async function aplicarYApagarSiNoAbre(): Promise<CelularVista> {
      const v = await aplicar()
      if (cfg.encendido && !fuente && errorDePuerto) {
        cfg.encendido = false
        guardar()
        programarRevision()
        avisar()
        return vista()
      }
      return v
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
      const ws = prueba ? undefined : ctx.store.workspace(wsId)
      const espacio = prueba ? 'Sloth' : ws?.name
      if (!espacio) return
      if (!prueba && !debeAvisar(enviados, `${wsId}:${tipo}`, Date.now())) return
      const texto = prueba
        ? { titulo: 'Sloth', cuerpo: 'Así te van a llegar los avisos.' }
        : cfg.ntfy.privado
          ? textoAvisoPrivado(tipo)
          : textoAviso(tipo, espacio, detalle, agenteDe(ws ? (ctx.store.account(ws.accountId) ?? {}) : {}))
      const abrir = enlaceAviso({
        wifi: fuente && ipServida ? { ip: ipServida, puerto: cfg.puerto } : null,
        remoto: cfg.remoto.encendido ? CELU_WEB_URL : null,
        https: cfg.tailscale.encendido && extras.some((x) => x.host === LOCAL) ? cfg.tailscale.https : null,
        privado: cfg.ntfy.privado === true
      })
      const r = await fetch(cfg.ntfy.servidor, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', ...(cfg.ntfy.token !== undefined && { authorization: `Bearer ${cfg.ntfy.token}` }) },
        body: JSON.stringify(cuerpoNtfy(cfg.ntfy.tema, tipo, texto, abrir)),
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
      (b) => b.on('permission', (req: PendingPermission) => ntfyEnFondo('permiso', req.ws, resumenPermiso(kindOf(req.tool)))),
      () => undefined
    )

    ctx.handle('vista', () => vista())

    ctx.handle('encender', async (on: unknown) => {
      if (typeof on !== 'boolean') throw new Error('Valor inválido.')
      cfg.encendido = on
      ipCambio = false
      guardar()
      return aplicarYApagarSiNoAbre()
    })

    ctx.handle('puerto', async (p: unknown) => {
      if (!puertoValido(p)) throw new Error('El puerto tiene que ser un número entre 1024 y 65535.')
      cfg.puerto = p
      guardar()
      return aplicarYApagarSiNoAbre()
    })

    ctx.handle('tailscale', async (on: unknown) => {
      if (typeof on !== 'boolean') throw new Error('Valor inválido.')
      cfg.tailscale.encendido = on
      guardar()
      ctx.log(on ? 'celular: también por Tailscale' : 'celular: Tailscale apagado')
      return aplicar()
    })

    ctx.handle('tailscale-https', (url: unknown) => {
      if (url === '') delete cfg.tailscale.https
      else {
        const https = httpsTailscale(url)
        if (!https) throw new Error('Tiene que ser la dirección que da Tailscale: https://<tu-pc>.<tu-tailnet>.ts.net')
        cfg.tailscale.https = https
      }
      guardar()
      avisar()
      return vista()
    })

    ctx.handle('regenerar', () => {
      soltarVisores()
      actividad.olvidarCelus()
      entradas.olvidar()
      conectadosAntes = 0
      cfg.clave = nuevoToken()
      cfg.celus = []
      guardar()
      ctx.log('clave regenerada: los celus anteriores quedan afuera')
      avisar()
      return vista()
    })

    ctx.handle('entrar', (p: unknown) => {
      const b = p as { id?: unknown; si?: unknown } | null
      if (!b || typeof b !== 'object' || typeof b.id !== 'string' || typeof b.si !== 'boolean') throw new Error('Valor inválido.')
      const ahora = Date.now()
      // El tope se mira antes de responder: si no, el celu leería «listo» sin haber quedado en la lista.
      if (b.si && cfg.celus.length >= MAX_CELUS) throw new Error('Esta PC ya tiene demasiados celus con acceso. Sacá alguno primero.')
      const r = entradas.responder(b.id, b.si, ahora)
      if (!r) throw new Error('Ese pedido ya venció o se respondió. Que escaneen el QR de nuevo.')
      if (b.si) {
        const id = randomBytes(6).toString('hex')
        cfg.celus.push({ id, nombre: r.nombre, clave: r.clave, nivel: 'controlar', creado: ahora, ultimo: ahora })
        guardar()
        actividad.anotar({ ip: r.ip, ua: r.ua, celu: id }, 'entro', '', ahora)
        ctx.log('celu nuevo con acceso:', r.nombre, r.ip)
      }
      programarEntradas()
      avisar()
      return vista()
    })

    ctx.handle('nivel', (p: unknown) => {
      const b = p as { id?: unknown; nivel?: unknown } | null
      if (!b || typeof b !== 'object' || typeof b.id !== 'string' || !nivelValido(b.nivel)) throw new Error('Valor inválido.')
      const c = cfg.celus.find((x) => x.id === b.id)
      if (!c) throw new Error('Ese celu ya no tiene acceso.')
      c.nivel = b.nivel
      guardar()
      avisar()
      return vista()
    })

    ctx.handle('sacar', (id: unknown) => {
      if (typeof id !== 'string') throw new Error('Valor inválido.')
      const antes = cfg.celus.length
      cfg.celus = cfg.celus.filter((c) => c.id !== id)
      if (cfg.celus.length === antes) throw new Error('Ese celu ya no tiene acceso.')
      guardar()
      ctx.log('celu sacado desde la PC')
      avisar()
      return vista()
    })

    ctx.handle('terminal', (on: unknown) => {
      if (typeof on !== 'boolean') throw new Error('Valor inválido.')
      cfg.terminal = on
      if (!on) soltarVisores()
      guardar()
      ctx.log(`terminal desde el celu ${on ? 'prendida' : 'apagada'}`)
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
      const { encendido, tema, servidor, token, generarTema, privado } = (p ?? {}) as { encendido?: unknown; tema?: unknown; servidor?: unknown; token?: unknown; generarTema?: unknown; privado?: unknown }
      if (encendido !== undefined && typeof encendido !== 'boolean') throw new Error('Valor inválido.')
      if (privado !== undefined && typeof privado !== 'boolean') throw new Error('Valor inválido.')
      if (tema !== undefined && !temaValido(tema)) throw new Error(`El tema va de ${TEMA_MIN} a 64 caracteres: letras, números, guion o guion bajo.`)
      if (generarTema !== undefined && generarTema !== true) throw new Error('Valor inválido.')
      const srv = servidor === undefined ? cfg.ntfy.servidor : servidorNtfy(servidor)
      if (srv === null) throw new Error('El servidor tiene que ser una dirección https:// sin usuario, parámetros ni #.')
      if (token !== undefined && token !== null && !tokenNtfyValido(token)) throw new Error('El token solo puede llevar letras, números, punto, guion y guion bajo (hasta 200).')
      const cambiaTema = generarTema === true || (tema !== undefined && tema !== cfg.ntfy.tema)
      const tokenFinal = tokenNtfyTras(cfg.ntfy, srv, token as string | null | undefined)
      cfg.ntfy = {
        encendido: encendido ?? cfg.ntfy.encendido,
        tema: generarTema === true ? nuevoTema() : (tema ?? cfg.ntfy.tema),
        servidor: srv,
        ...(tokenFinal !== undefined && { token: tokenFinal }),
        ...(!cambiaTema && encendido !== true && cfg.ntfy.temaRenovado && { temaRenovado: true }),
        ...((privado ?? cfg.ntfy.privado) === true && { privado: true })
      }
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
      const error = await s.cerrarOtras()
      if (error) throw new Error(`El código es nuevo, pero no pude cerrar las sesiones de los otros dispositivos: ${error}`)
      ctx.log('sesiones del chat de los otros dispositivos cerradas')
      return v
    })

    ctx.handle('probar-ntfy', () => mandarNtfy('termino', '', undefined, true))

    ctx.handle('visto-ip', () => {
      ipCambio = false
      avisar()
    })

    detenerTodo = async () => {
      soltarVisores()
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
