export interface EntradaLog {
  t: number
  nivel: 'error' | 'aviso' | 'info'
  origen: string
  msg: string
}

export interface DatosDiagnostico {
  sloth: string
  electron: string
  node: string
  chrome: string
  so: string
  features: string[]
  cuentas: number
  espacios: number
  ajustes: Record<string, boolean>
  errores: EntradaLog[]
  avisos: string[]
  crashPrevio: boolean
  fallosLog?: string
}

export const MAX_ENTRADAS = 30

const iso = (t: number): string => (Number.isFinite(t) ? new Date(t).toISOString() : 'fecha desconocida')

export function textoDiagnostico(d: DatosDiagnostico, ahora: number): string {
  const errores = d.errores.slice(-MAX_ENTRADAS)
  const avisos = d.avisos.slice(-MAX_ENTRADAS)
  const ajustes = Object.entries(d.ajustes).map(([k, v]) => `  ${k}: ${v ? 'sí' : 'no'}`)
  const lineas = [
    'Diagnóstico de Sloth',
    iso(ahora),
    '',
    `Sloth ${d.sloth} · Electron ${d.electron} · Node ${d.node} · Chrome ${d.chrome}`,
    `Sistema: ${d.so}`,
    '',
    `Funciones activas: ${d.features.join(', ') || '(ninguna)'}`,
    `Cuentas: ${d.cuentas} · Espacios: ${d.espacios}`,
    '',
    'Ajustes:',
    ...(ajustes.length ? ajustes : ['  (sin datos)']),
    '',
    `Últimos errores y avisos (${errores.length + avisos.length})`,
    ...(errores.length ? errores.map((e) => `[${iso(e.t)}] ${e.origen}: ${e.msg}`) : ['(sin errores)']),
    ...(avisos.length ? avisos.map((a) => `[aviso] ${a}`) : ['(sin avisos)'])
  ]
  if (d.crashPrevio) lineas.push('', 'La sesión anterior terminó de forma inesperada.')
  if (d.fallosLog) lineas.push('', `No se pudo escribir el archivo de log: ${d.fallosLog}`)
  lineas.push('', 'Este texto no se envió a ningún lado: se copió a tu portapapeles. Revisalo antes de compartirlo.')
  return lineas.join('\n')
}
