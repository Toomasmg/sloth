import { nombreProveedor, proveedorIdDe } from './proveedores'

/** La ayuda bajo el campo «Primer mensaje» del espacio nuevo, según cómo llega el mensaje al agente de la cuenta. */
export function ayudaPrimerMensaje(cuenta: { proveedor?: unknown } | undefined): string {
  const id = cuenta ? proveedorIdDe(cuenta) : undefined
  if (!cuenta || id === 'claude') return 'Se manda solo la primera vez que se abre el espacio.'
  const agente = nombreProveedor(cuenta)
  if (id === 'copilot') return `Con ${agente} Sloth todavía no puede mandarlo solo: al abrir el espacio te avisa y lo escribís a mano.`
  return `Con ${agente} Sloth no siempre puede mandarlo solo (depende de cómo esté instalado y de la terminal). Si no puede, te avisa y lo escribís a mano.`
}
