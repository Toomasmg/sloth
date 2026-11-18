import type { ProveedorId } from '../../../shared/proveedores'
import type { Accion } from '../../../shared/tickets'
import type { ConectorMcp } from './conector'
import type { Limites } from './motor'

export type TareaMotor = 'lista' | 'detalle' | 'accion' | 'descubrir' | 'revisar'

export interface PedidoMotor {
  tarea: TareaMotor
  def?: ConectorMcp
  model: string
  /** Herramientas o servidores MCP de la cuenta que no son del conector. */
  ajenos: readonly string[]
  limites?: Limites
  accion?: Accion
  schema?: object
  /** Nombres de los servidores MCP que tiene la cuenta en su config (Codex). Claude los ignora. */
  servidoresCuenta?: readonly string[]
  /** Servidor del conector, sin el prefijo `mcp__` ni el `__` final. Claude lo ignora. */
  servidorElegido?: string
}

export interface MotorTickets {
  id: ProveedorId
  /** true: algo clave sin confirmar; la UI lo dice. */
  experimental: boolean
  /** Argumentos del ejecutable, sin el ejecutable. El prompt va siempre por stdin: nunca en argv. */
  argv(p: PedidoMotor): string[]
  /** Variables que suma el motor al entorno de la cuenta. */
  envExtra(p: PedidoMotor): Record<string, string>
  /** stdout crudo del agente a stdout con la forma del sobre común (`{type:'result',...}`). */
  normalizar(stdout: string, p: PedidoMotor): string
  /** Mira cada línea; devuelve un Error para cortar el proceso (tope emulado). */
  cortarSi?(linea: string, p: PedidoMotor): Error | undefined
  /** true si el motor entiende el `system/init` con los servidores MCP de la sesión. */
  leeInit: boolean
}
