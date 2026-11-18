import type { Accion } from '../../../shared/tickets'
import { nombreServidorValido, servidoresIgnorados } from './codex-config'
import { aSobreComun, ERROR_COMANDOS, errorFuera, esComando, esLlamadaMcp, eventoDe, leerSalidaCodex, usoFueraDelConector, type ReglaConector } from './codex-salida'
import type { ConectorMcp } from './conector'
import { permisosPorConsulta } from './motor'
import type { MotorTickets, PedidoMotor, TareaMotor } from './motor-tickets'
import { textoTope, TopeVueltasError, VUELTAS_DEFECTO, vueltasValidas } from './uso'

/**
 * Mientras sea false, la tarea `accion` falla antes de lanzar Codex: que `-c ...enabled_tools` pise lo del
 * config.toml de la cuenta y que con approval_policy never las herramientas MCP corran no está probado a mano.
 * Una escritura necesita además que lo que Codex trae por fuera del conector quede acotado (ver FUNCIONES_APAGADAS).
 */
export const ACCIONES_VERIFICADAS: boolean = false

export const SOLO_LECTURA = 'Las acciones con Codex todavía no se probaron: por ahora es de solo lectura.'
const SIN_DESCUBRIR = 'Esta cuenta no puede buscar herramientas todavía: Codex no informa los servidores de la sesión.'
const HERRAMIENTA_RE = /^[A-Za-z0-9_.-]{1,128}$/

/**
 * Lo que Codex trae por su cuenta además del MCP del conector, apagado con `-c features.<nombre>=false` (lo mismo que
 * `--disable`). Los nombres salen de `codex features list` (0.164, la versión mínima) y la búsqueda web de `web_search`
 * (valores `live|indexed|cached|disabled`, según el propio aviso de Codex). Lo que no se puede apagar desde acá
 * (el `managed_config.toml` de un administrador, por ejemplo) queda acotado solo por `-s read-only`, `approval_policy="never"` y
 * el corte de `cortarSi`, que actúa cuando Codex ya anunció la llamada.
 */
const FUNCIONES_APAGADAS = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'computer_use', 'multi_agent']

const incompleto = (): never => {
  throw new Error('Pedido de motor incompleto')
}

/** Nombres cortos de herramienta que se le dejan al conector en cada tarea: los mismos que `--allowedTools` en Claude. */
export function herramientasPermitidas(def: ConectorMcp, tarea: TareaMotor, accion?: Accion): string[] {
  const p = permisosPorConsulta(def)
  if (tarea === 'lista') return p.lista
  if (tarea === 'detalle') return p.detalle
  if (tarea === 'accion') return (accion && p.acciones[accion]) || []
  return []
}

function argv(p: PedidoMotor): string[] {
  if (p.tarea === 'descubrir' || p.tarea === 'revisar') throw new Error(SIN_DESCUBRIR)
  if (p.tarea === 'accion' && !ACCIONES_VERIFICADAS) throw new Error(SOLO_LECTURA)
  if (!p.def) return incompleto()
  if (p.tarea === 'accion' && !p.accion) return incompleto()
  // El prefijo del conector (`mcp__claude_ai_Gruv__`) es el nombre que le da Claude: en Codex el servidor se llama como lo puso la persona en su config.
  const { servidorElegido: elegido, servidoresCuenta } = p
  if (elegido === undefined || servidoresCuenta === undefined) throw new Error('Falta saber qué servidor MCP de la cuenta es el del conector.')
  if (!nombreServidorValido(elegido) || !servidoresCuenta.includes(elegido)) throw new Error('El servidor MCP elegido no está en la configuración de la cuenta o su nombre no es válido.')
  // Un servidor que no se puede apagar por su nombre dejaría todas sus herramientas (también las de escritura) a mano de una consulta de lectura: no se consulta.
  const ignorados = servidoresIgnorados(servidoresCuenta)
  if (ignorados.length) throw new Error(errorIgnorados(ignorados))
  const pedidas = herramientasPermitidas(p.def, p.tarea, p.accion)
  const permitidas = pedidas.filter((t) => HERRAMIENTA_RE.test(t))
  if (!permitidas.length) throw new Error('El conector no tiene herramientas permitidas para esta consulta.')
  // Una que se cae en silencio haría fallar la consulta de una forma que nadie entiende.
  if (permitidas.length !== pedidas.length) throw new Error('El conector tiene herramientas con un nombre que Sloth no puede pasarle a Codex.')
  // Sin `-m`: el modelo es el de la cuenta de Codex; p.model es un alias de Claude.
  // Cada valor de `-c` va como un solo elemento: sin shell, nada se concatena ni se separa por espacios.
  const apagados = servidoresCuenta.filter((n) => n !== elegido && nombreServidorValido(n))
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-rules',
    '-s',
    'read-only',
    '-c',
    'approval_policy="never"',
    '-c',
    'web_search="disabled"',
    ...FUNCIONES_APAGADAS.flatMap((f) => ['-c', `features.${f}=false`]),
    ...[...new Set(apagados)].flatMap((n) => ['-c', `mcp_servers.${n}.enabled=false`]),
    '-c',
    `mcp_servers.${elegido}.enabled_tools=${JSON.stringify(permitidas)}`,
    '-'
  ]
}

export const errorIgnorados = (nombres: readonly string[]): string =>
  `La cuenta tiene ${nombres.length === 1 ? 'un servidor MCP' : 'servidores MCP'} con un nombre que Sloth no puede apagar durante la consulta (${nombres.slice(0, 5).join(', ')}) y dejarlos habilitados le daría a Codex todas sus herramientas. No se consultó nada: renombralos en el config.toml de la cuenta (solo letras, números, guion y guion bajo) y tocá «Volver a revisar».`

/** Servidor y herramientas del conector para esta tarea; undefined si el pedido no dice cuál es. */
function reglaDe(p: PedidoMotor): ReglaConector | undefined {
  if (!p.def || p.servidorElegido === undefined) return undefined
  return { servidor: p.servidorElegido, herramientas: herramientasPermitidas(p.def, p.tarea, p.accion) }
}

const llamadas = new WeakMap<PedidoMotor, number>()

/**
 * Corta apenas Codex anuncia algo que no es del conector (la llamada ya salió: lo que la previene son los `-c` del
 * argv, esto la limita a una) o un comando. El tope de vueltas cuenta las llamadas anunciadas, así que deja
 * correr una de más antes de cortar: al leer no hace daño.
 */
function cortarSi(linea: string, p: PedidoMotor): Error | undefined {
  if (esComando(linea)) return new Error(ERROR_COMANDOS)
  if (linea.includes('"item.')) {
    const e = eventoDe(linea)
    const fuera = e && usoFueraDelConector(e, reglaDe(p))
    if (fuera !== undefined) return new Error(errorFuera(fuera))
  }
  if (!esLlamadaMcp(linea)) return undefined
  const n = (llamadas.get(p) ?? 0) + 1
  llamadas.set(p, n)
  const limite = vueltasValidas(p.limites?.maxTurns) ?? VUELTAS_DEFECTO
  if (n <= limite) return undefined
  return new TopeVueltasError(textoTope('vueltas', limite, p.tarea === 'accion'), 'vueltas', { numTurns: n, tope: 'vueltas' })
}

export const motorCodex: MotorTickets = {
  id: 'codex',
  experimental: true,
  leeInit: false,
  argv,
  envExtra: () => ({}),
  normalizar: (stdout, p) => aSobreComun(leerSalidaCodex(stdout, reglaDe(p))),
  cortarSi
}
