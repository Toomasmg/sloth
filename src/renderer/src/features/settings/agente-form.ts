import type { AgenteDisponible } from '../../../../shared/types'

export interface FormularioCuenta {
  titulo: string
  mostrarSelector: boolean
  mostrarPlan: boolean
  aviso?: string
  avisoVersion?: string
}

export const AVISO_CODEX =
  'Se abre una terminal con «codex login». Probá de a una cuenta por vez: el login usa el puerto 1455. Con Codex todavía no hay uso ni límites, avisos de permisos desde el celu, tickets ni chat MCP.'
export const AVISO_CODEX_VIEJO = 'Tu Codex es viejo; actualizalo con «npm install -g @openai/codex».'

/** Sin otro agente instalado devuelve lo de siempre (Claude), así el formulario no cambia. */
export function formularioCuenta(proveedor: string, agentes: AgenteDisponible[]): FormularioCuenta {
  const codex = agentes.find((a) => a.id === 'codex' && a.instalado)
  if (!codex) return { titulo: 'Nueva cuenta de Claude', mostrarSelector: false, mostrarPlan: true }
  if (proveedor !== 'codex') return { titulo: 'Nueva cuenta de Claude', mostrarSelector: true, mostrarPlan: true }
  return {
    titulo: 'Nueva cuenta de Codex',
    mostrarSelector: true,
    mostrarPlan: false,
    aviso: AVISO_CODEX,
    avisoVersion: codex.versionOk === false ? AVISO_CODEX_VIEJO : undefined
  }
}
