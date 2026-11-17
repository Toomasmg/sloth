import type { Corrida, UsoAcum, UsoPorDia } from './tickets'

const vacio = (): UsoAcum => ({ corridas: 0, costUsd: 0, vueltas: 0, durationMs: 0 })

const dos = (n: number): string => String(n).padStart(2, '0')

function diasAtras(hoy: string, n: number): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(hoy)
  if (!m) return undefined
  const f = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - n, 12)
  return `${f.getFullYear()}-${dos(f.getMonth() + 1)}-${dos(f.getDate())}`
}

function sumar(a: UsoAcum, b: UsoAcum): void {
  a.corridas += b.corridas
  a.costUsd += b.costUsd
  a.vueltas += b.vueltas
  a.durationMs += b.durationMs
}

export function resumenUso(uso: UsoPorDia | undefined, hoy: string, conectorId?: string): { hoy: UsoAcum; semana: UsoAcum } {
  const out = { hoy: vacio(), semana: vacio() }
  if (!uso) return out
  for (let i = 0; i < 7; i++) {
    const dia = diasAtras(hoy, i)
    const porConector = dia ? uso[dia] : undefined
    if (!porConector) continue
    for (const [id, acum] of Object.entries(porConector)) {
      if (conectorId !== undefined && id !== conectorId) continue
      sumar(out.semana, acum)
      if (i === 0) sumar(out.hoy, acum)
    }
  }
  return out
}

export function fmtCosto(n: number): string {
  const txt = n.toFixed(n < 1 ? 3 : 2).replace('.', ',')
  return `~US$ ${txt}`
}

export function textoUltimaConsulta(r: Corrida): string {
  const partes: string[] = []
  if (r.tokens !== undefined) partes.push(`~${r.tokens.toLocaleString('es-AR')} tokens`)
  if (r.costUsd !== undefined) partes.push(`costo estimado ${fmtCosto(r.costUsd)}`)
  if (r.numTurns !== undefined) partes.push(r.numTurns === 1 ? '1 vuelta' : `${r.numTurns} vueltas`)
  if (r.durationMs !== undefined) partes.push(`${Math.max(1, Math.round(r.durationMs / 1000))} s`)
  return partes.length ? `Última consulta: ${partes.join(' · ')}` : ''
}
