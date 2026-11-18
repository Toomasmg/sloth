import type { Accion } from '../../../shared/tickets'
import { nombreServidorValido } from './codex-config'
import { aSobreComun, ERROR_COMANDOS, esComando, esLlamadaMcp, leerSalidaCodex } from './codex-salida'
import type { ConectorMcp } from './conector'
import { permisosPorConsulta } from './motor'
import type { MotorTickets, PedidoMotor, TareaMotor } from './motor-tickets'
import { textoTope, TopeVueltasError, VUELTAS_DEFECTO, vueltasValidas } from './uso'

/**
 * Mientras sea false, la tarea `accion` falla antes de lanzar Codex: que `-c ...enabled_tools` pise lo del
 * config.toml de la cuenta y que con approval_policy never las herramientas MCP corran no está probado a mano.
 */
export const ACCIONES_VERIFICADAS: boolean = false

const SOLO_LECTURA = 'Las acciones con Codex todavía no se probaron: por ahora es de solo lectura.'
const SIN_DESCUBRIR = 'Esta cuenta no puede buscar herramientas todavía: Codex no informa los servidores de la sesión.'
const HERRAMIENTA_RE = /^[A-Za-z0-9_.-]{1,128}$/

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
  const permitidas = herramientasPermitidas(p.def, p.tarea, p.accion).filter((t) => HERRAMIENTA_RE.test(t))
  if (!permitidas.length) throw new Error('El conector no tiene herramientas permitidas para esta consulta.')
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
    ...[...new Set(apagados)].flatMap((n) => ['-c', `mcp_servers.${n}.enabled=false`]),
    '-c',
    `mcp_servers.${elegido}.enabled_tools=${JSON.stringify(permitidas)}`,
    '-'
  ]
}

const llamadas = new WeakMap<PedidoMotor, number>()

function cortarSi(linea: string, p: PedidoMotor): Error | undefined {
  if (esComando(linea)) return new Error(ERROR_COMANDOS)
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
  normalizar: (stdout) => aSobreComun(leerSalidaCodex(stdout)),
  cortarSi
}
