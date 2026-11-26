import { useEffect, useMemo, useState } from 'react'
import { calcularCupo, topeEfectivo, type Cupo } from '../../shared/cupo'
import { capacidadesDe } from '../../shared/proveedores'
import type { Account, AccountUsage } from '../../shared/types'

const REFRESCO_MS = 30_000

/** Cupo estimado de la ventana de 5 h de cada cuenta que lleva cuenta de uso. El reloj avanza solo: una ventana que vence se apaga sin esperar al próximo escaneo. */
export function useCupos(
  accounts: readonly Account[],
  usage: Readonly<Record<string, AccountUsage>>,
  plans: Readonly<Record<string, string>>,
  topes: Readonly<Record<string, number>>
): { cupos: Record<string, Cupo>; ahora: number } {
  const [ahora, setAhora] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), REFRESCO_MS)
    return () => clearInterval(t)
  }, [])
  const cupos = useMemo(() => {
    const out: Record<string, Cupo> = {}
    for (const a of accounts) {
      const u = usage[a.id]
      if (!u || capacidadesDe(a)?.uso !== true) continue
      const c = calcularCupo(u.ventana, topeEfectivo(plans[a.id], topes[a.id]), ahora)
      // Sin tope ni uso no hay nada que decir: no se ocupa una línea por cuenta para mostrar vacío.
      if (c.nivel !== 'sin-tope' || c.usados > 0) out[a.id] = c
    }
    return out
  }, [accounts, usage, plans, topes, ahora])
  return { cupos, ahora }
}
