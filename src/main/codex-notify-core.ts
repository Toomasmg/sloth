import { analizar, problemaDeDuplicados } from './toml-escaner'
import type { Sentencia } from './toml-escaner'

export const NOTIFY_MARCA = '# sloth-notify'

// `dudoso`: el archivo no se pudo leer con seguridad (TOML que no se entiende o con claves repetidas). No se escribe.
export type CambioNotify = 'agregada' | 'actualizada' | 'igual' | 'ajeno' | 'dudoso'

const CLAVE_PROPIA = /^notify\s*=\s*\[/

// Nada de lo que se escribe puede cortar la línea ni colar otra clave: salto de línea o control = no se escribe.
const CONTROL = /[\u0000-\u001f\u007f]/

const aToml = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export function lineaNotify(nodeExe: string, script: string): string | undefined {
  if (!nodeExe || !script || CONTROL.test(nodeExe) || CONTROL.test(script)) return undefined
  return `notify = [${aToml(nodeExe)}, ${aToml(script)}] ${NOTIFY_MARCA}`
}

function finDeLinea(l: string): string {
  return l.endsWith('\r\n') ? '\r\n' : l.endsWith('\n') ? '\n' : ''
}

function partir(toml: string): string[] {
  return toml.split(/(?<=\n)/)
}

const esNotifyDeRaiz = (s: Sentencia): boolean => s.tipo === 'clave' && s.tabla.length === 0 && s.ruta[0] === 'notify'

// Una tabla `[notify]` o una clave `notify.x = …` también chocan con una clave `notify` de raíz.
const chocaConNotify = (s: Sentencia): boolean => (s.tipo === 'clave' ? esNotifyDeRaiz(s) : s.ruta[0] === 'notify')

/** Nuestra: una sola línea, clave pelada `notify`, y lo único después del valor es la marca. */
function esNuestra(toml: string, s: Sentencia): boolean {
  if (s.tipo !== 'clave' || s.ruta.length !== 1 || s.lineaIni !== s.lineaFin) return false
  if (!CLAVE_PROPIA.test(toml.slice(s.desde, s.hasta))) return false
  const finLinea = toml.indexOf('\n', s.hasta)
  const resto = toml.slice(s.hasta, finLinea === -1 ? undefined : finLinea).trim()
  return resto === NOTIFY_MARCA
}

type Busqueda = { tipo: 'sin' } | { tipo: 'ajeno' } | { tipo: 'hallada'; sentencia: Sentencia; nuestra: boolean } | { tipo: 'dudoso'; motivo: string }

/** Lee el archivo con el escáner de TOML y busca la clave `notify` de raíz. Dudar es un resultado: no se escribe. */
function buscar(toml: string): Busqueda {
  const a = analizar(toml)
  if (!a.ok) return { tipo: 'dudoso', motivo: a.motivo }
  const dup = problemaDeDuplicados(a.sentencias)
  if (dup) return { tipo: 'dudoso', motivo: dup }
  const chocan = a.sentencias.filter(chocaConNotify)
  if (chocan.length === 0) return { tipo: 'sin' }
  const raiz = chocan.filter(esNotifyDeRaiz)
  if (chocan.length > 1 || raiz.length !== 1 || raiz[0].ruta.length !== 1) return { tipo: 'ajeno' }
  return { tipo: 'hallada', sentencia: raiz[0], nuestra: esNuestra(toml, raiz[0]) }
}

/**
 * Agrega al principio (una clave suelta después de una `[tabla]` caería dentro de esa tabla) o actualiza
 * la línea marcada. Una clave `notify` sin la marca es del usuario: no se toca. El resto queda byte a byte.
 */
export function aplicarNotify(toml: string, linea: string): { toml: string; cambio: CambioNotify } {
  const b = buscar(toml)
  if (b.tipo === 'dudoso') return { toml, cambio: 'dudoso' }
  if (b.tipo === 'ajeno' || (b.tipo === 'hallada' && !b.nuestra)) return { toml, cambio: 'ajeno' }
  const lineas = partir(toml)
  if (b.tipo === 'hallada') {
    const indice = b.sentencia.lineaIni
    const actual = lineas[indice]
    const bom = indice === 0 && actual.startsWith('﻿') ? '﻿' : ''
    const nueva = `${bom}${linea}${finDeLinea(actual)}`
    if (nueva === actual) return { toml, cambio: 'igual' }
    lineas[indice] = nueva
    return { toml: lineas.join(''), cambio: 'actualizada' }
  }
  const salto = lineas[0]?.endsWith('\r\n') ? '\r\n' : '\n'
  const bom = toml.startsWith('﻿') ? '﻿' : ''
  return { toml: `${bom}${linea}${salto}${toml.slice(bom.length)}`, cambio: 'agregada' }
}

/** Saca solo la línea que puso Sloth. Si no hay (o el archivo es dudoso), devuelve el texto tal cual. */
export function quitarNotify(toml: string): { toml: string; quitada: boolean; dudoso?: boolean } {
  if (!toml.includes(NOTIFY_MARCA)) return { toml, quitada: false }
  const b = buscar(toml)
  if (b.tipo === 'dudoso') return { toml, quitada: false, dudoso: true }
  if (b.tipo !== 'hallada' || !b.nuestra) return { toml, quitada: false }
  const lineas = partir(toml)
  const bom = b.sentencia.lineaIni === 0 && lineas[0].startsWith('﻿') ? '﻿' : ''
  lineas.splice(b.sentencia.lineaIni, 1)
  const resto = lineas.join('')
  return { toml: bom && !resto.startsWith('﻿') ? `${bom}${resto}` : resto, quitada: true }
}

const firma = (s: Sentencia): string => `${s.tipo}|${s.tabla.join('\u0000')}|${s.ruta.join('\u0000')}`

/**
 * Segunda lectura, sobre el texto que se va a escribir: tiene que entenderse, no repetir claves y tener
 * exactamente las mismas claves y tablas que antes, salvo el `notify` de Sloth (uno solo, nuestro, o ninguno).
 * Devuelve el motivo del problema, o undefined si está bien.
 */
export function verificarCambio(antes: string, despues: string, conNotify: boolean): string | undefined {
  const a = analizar(antes)
  const d = analizar(despues)
  if (!a.ok || !d.ok) return 'El config.toml no se entiende con seguridad.'
  const dup = problemaDeDuplicados(d.sentencias)
  if (dup) return dup
  const sinNuestra = (ss: Sentencia[]): string[] => ss.filter((s) => !(esNotifyDeRaiz(s) && s.ruta.length === 1)).map(firma)
  const previas = sinNuestra(a.sentencias)
  const nuevas = sinNuestra(d.sentencias)
  if (previas.length !== nuevas.length || previas.some((f, k) => f !== nuevas[k])) return 'El config.toml cambiaría más que la línea de Sloth.'
  const propias = d.sentencias.filter((s) => esNotifyDeRaiz(s) && s.ruta.length === 1)
  if (d.sentencias.some((s) => chocaConNotify(s) && !(esNotifyDeRaiz(s) && s.ruta.length === 1))) return 'El config.toml quedaría con otro notify.'
  if (propias.length !== (conNotify ? 1 : 0)) return 'El config.toml no quedaría con un solo notify.'
  if (conNotify && !esNuestra(despues, propias[0])) return 'El notify del config.toml no es el de Sloth.'
  return undefined
}
