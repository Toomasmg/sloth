export interface PlanRotacion {
  rotar: boolean
  mover: Array<{ de: string; a: string }>
  borrar: string[]
}

const escapar = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function planRotacion(args: {
  tamanoActual: number
  max: number
  existentes: string[]
  base: string
  mantener: number
}): PlanRotacion {
  const { tamanoActual, max, existentes, base, mantener } = args
  if (tamanoActual <= 0 || tamanoActual < max) return { rotar: false, mover: [], borrar: [] }
  const nombre = (n: number): string => `${base}.${n}.log`
  const patron = new RegExp(`^${escapar(base)}\\.([1-9]\\d*)\\.log$`)
  const numeros = existentes
    .map((f) => patron.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => b - a)
  const borrar = numeros.filter((n) => n >= mantener).map(nombre)
  const mover = numeros.filter((n) => n < mantener).map((n) => ({ de: nombre(n), a: nombre(n + 1) }))
  if (mantener < 1) return { rotar: true, mover: [], borrar: [...borrar, `${base}.log`] }
  return { rotar: true, mover: [...mover, { de: `${base}.log`, a: nombre(1) }], borrar }
}
