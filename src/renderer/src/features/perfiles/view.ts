import type { EntradaActividad, PerfilesPayload } from '../../../../shared/perfiles'

export function iniciales(nombre: string): string {
  const palabras = nombre.trim().split(/\s+/).filter(Boolean)
  if (palabras.length === 0) return '?'
  const letras = palabras.slice(0, 2).map((p) => [...p][0])
  return letras.join('').toLocaleUpperCase('es')
}

export function textoActividad(e: EntradaActividad): string {
  const en = e.espacio ? ` en «${e.espacio}»` : ''
  if (e.tipo === 'espacio') return e.espacio ? `Abriste el espacio «${e.espacio}»` : 'Abriste un espacio'
  if (e.tipo === 'ticket') return e.ticket ? `Tomaste el ticket ${e.ticket}${en}` : `Tomaste un ticket${en}`
  const n = e.pr?.replace(/^#/, '')
  return n ? `Creaste el PR ${n}${en}` : `Creaste un PR${en}`
}

export function textoConfirmarCambio(nombre: string, conservar: boolean, vivas: number): string {
  const reinicio = `Sloth se reinicia y abre «${nombre}».`
  if (vivas <= 0) return reinicio
  const cuantas = vivas === 1 ? 'La terminal' : `Las ${vivas} terminales`
  if (conservar) {
    return `${reinicio} ${cuantas} de este perfil ${vivas === 1 ? 'sigue abierta' : 'siguen abiertas'} en segundo plano. Podés cerrarlas desde Perfiles.`
  }
  return `${reinicio} ${cuantas} de este perfil ${vivas === 1 ? 'se cierra' : 'se cierran'} y lo que estaba en curso se corta.`
}

export const mostrarChip = (p: PerfilesPayload | null): boolean => !!p && p.perfiles.length >= 2

const inicioDelDia = (t: number): number => {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function etiquetaDia(t: number, ahora: number): string {
  const hoy = new Date(inicioDelDia(ahora))
  const ayer = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 1).getTime()
  const dia = inicioDelDia(t)
  if (dia === hoy.getTime()) return 'Hoy'
  if (dia === ayer) return 'Ayer'
  const d = new Date(t)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}`
}

/** Mantiene el orden recibido: cada grupo nuevo se abre cuando cambia el día. */
export function agruparActividadPorDia(es: readonly EntradaActividad[], ahora: number): Array<{ dia: string; items: EntradaActividad[] }> {
  const grupos: Array<{ dia: string; items: EntradaActividad[] }> = []
  for (const e of es) {
    const dia = etiquetaDia(e.t, ahora)
    const ultimo = grupos[grupos.length - 1]
    if (ultimo && ultimo.dia === dia) ultimo.items.push(e)
    else grupos.push({ dia, items: [e] })
  }
  return grupos
}
