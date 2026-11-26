import { textoRenovacion, type Cupo } from '../../shared/cupo'

export interface TextoCupo {
  /** Lo que se ve en el panel y en el selector. */
  corto: string
  /** Para el lector de pantalla (sin símbolos ni abreviaturas). */
  etiqueta: string
  /** Tooltip y Configuración: qué se midió y por qué es una estimación. */
  largo: string
}

const AVISO =
  'Es una estimación: Sloth cuenta los tokens de los registros locales de Claude Code contra un tope que podés cambiar en Configuración → Cuentas. Anthropic no informa el límite real.'

export function textoCupo(c: Cupo, ahora: number, fmt: (n: number) => string, zona?: string): TextoCupo {
  const hora = c.renueva === undefined ? undefined : textoRenovacion(c.renueva, ahora, zona)
  if (c.usados === 0) {
    return { corto: 'Sin uso en 5 h', etiqueta: 'sin uso en las últimas 5 horas', largo: `Sin uso en la ventana de 5 h. ${AVISO}` }
  }
  if (c.pct === undefined || c.tope === undefined) {
    return {
      corto: `${fmt(c.usados)} · sin tope`,
      etiqueta: `${fmt(c.usados)} tokens en la ventana de 5 horas, sin tope configurado`,
      largo: `${fmt(c.usados)} tokens en la ventana de 5 h${hora ? `, que se renueva ${hora}` : ''}. Sin tope: elegí un plan o poné uno en Configuración → Cuentas para ver el porcentaje.`
    }
  }
  const resumen = `${fmt(c.usados)} de ${fmt(c.tope)}`
  return {
    corto: `${c.pct} % est.${hora ? ` · renueva ${hora}` : ''}`,
    etiqueta: `uso estimado ${c.pct} por ciento de la ventana de 5 horas${c.nivel === 'lleno' ? ', al tope' : ''}${hora ? `, se renueva ${hora}` : ''}`,
    largo: `Ventana de 5 h: ${resumen} (${c.pct} %)${hora ? `, se renueva ${hora}` : ''}. ${AVISO}`
  }
}
