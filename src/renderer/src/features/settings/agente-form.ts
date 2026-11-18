import type { LecturaLimitesCodex, LimitesCodex } from '../../../../shared/celular'
import type { AgenteDisponible } from '../../../../shared/types'

/** Lo que dice Codex es cuánto se usó (usedPercent), igual que el celu: el valor lo dice, nunca parece «lo que te queda». */
export const TITULO_LIMITES = 'Cuánto de cada ventana ya usaste, según Codex, leído hace un momento.'

/** Una fila por ventana que haya llegado; sin ventanas queda vacío y la pantalla dice «Sin dato». Nunca se rellena con ceros. */
export function filasLimites(l: LimitesCodex | null | undefined): { nombre: string; valor: string }[] {
  const filas: { nombre: string; valor: string }[] = []
  if (l?.cincoHoras) filas.push({ nombre: '5 h', valor: `${Math.round(l.cincoHoras.pct)} % usado` })
  if (l?.semana) filas.push({ nombre: 'Semana', valor: `${Math.round(l.semana.pct)} % usado` })
  return filas
}

export const SIN_DATO_EN_USO = 'Sin dato (cerrá la terminal de esta cuenta para medir)'

/** Qué decir cuando no hay filas: todavía leyendo (sin respuesta), terminal abierta de la cuenta, o sin dato (con cuánto falta para reintentar). */
export function textoSinLimites(r: LecturaLimitesCodex | undefined): string {
  if (!r) return 'Leyendo límites…'
  if (r.tipo === 'en-uso') return SIN_DATO_EN_USO
  if (r.tipo === 'sin-dato' && r.reintentaEnMin) return `Sin dato (reintenta en ${r.reintentaEnMin} min)`
  return 'Sin dato'
}

export interface FormularioCuenta {
  titulo: string
  mostrarSelector: boolean
  mostrarPlan: boolean
  aviso?: string
  avisoVersion?: string
}

export const AVISO_CODEX =
  'Se abre una terminal con «codex login». Probá de a una cuenta por vez: el login usa el puerto 1455. Con Codex todavía no hay conteo de uso, avisos de permisos desde el celu, tickets ni chat MCP; los límites de uso son experimentales y se activan por cuenta.'
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
