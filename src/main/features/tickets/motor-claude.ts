import { buildDescubrirArgs } from './descubrir'
import { buildAccionArgs, buildDetalleArgs, buildListaArgs, buildPersonasArgs } from './motor'
import type { MotorTickets, PedidoMotor } from './motor-tickets'

const incompleto = (): never => {
  throw new Error('Pedido de motor incompleto')
}

function argv(p: PedidoMotor): string[] {
  switch (p.tarea) {
    case 'lista':
      // --verbose trae el system/init: de ahí sale qué servidores tenía la sesión de verdad.
      return p.def ? [...buildListaArgs(p.def, p.model, p.ajenos, p.limites), '--verbose'] : incompleto()
    case 'detalle':
      return p.def ? buildDetalleArgs(p.def, p.model, p.ajenos, p.limites) : incompleto()
    case 'accion':
      return p.def && p.accion ? buildAccionArgs(p.def, p.model, p.accion, p.ajenos, p.limites) : incompleto()
    case 'personas':
      return p.def ? buildPersonasArgs(p.def, p.model, p.ajenos, p.limites) : incompleto()
    case 'descubrir':
      return buildDescubrirArgs()
    case 'revisar':
      return buildDescubrirArgs(p.schema, 'stream-json')
  }
}

export const motorClaude: MotorTickets = {
  id: 'claude',
  experimental: false,
  leeInit: true,
  argv,
  envExtra: () => ({}),
  normalizar: (stdout) => stdout
}
