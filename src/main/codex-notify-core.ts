export const NOTIFY_MARCA = '# sloth-notify'

export type CambioNotify = 'agregada' | 'actualizada' | 'igual' | 'ajeno'

const CLAVE_NOTIFY = /^\s*(?:notify|"notify"|'notify')\s*=/
const LINEA_DE_SLOTH = /^\s*notify\s*=\s*\[.*\]\s*# sloth-notify\s*$/

// Nada de lo que se escribe puede cortar la línea ni colar otra clave: salto de línea o control = no se escribe.
const CONTROL = /[\u0000-\u001f\u007f]/

const aToml = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export function lineaNotify(nodeExe: string, script: string): string | undefined {
  if (!nodeExe || !script || CONTROL.test(nodeExe) || CONTROL.test(script)) return undefined
  return `notify = [${aToml(nodeExe)}, ${aToml(script)}] ${NOTIFY_MARCA}`
}

interface LineaNotifyEnArchivo {
  indice: number
  nuestra: boolean
}

function finDeLinea(l: string): string {
  return l.endsWith('\r\n') ? '\r\n' : l.endsWith('\n') ? '\n' : ''
}

function partir(toml: string): string[] {
  return toml.split(/(?<=\n)/)
}

/**
 * Busca `notify` de nivel superior: antes de la primera `[tabla]` y fuera de cadenas multilínea y de
 * arrays que siguen en la línea de abajo. Un comentario que dice notify no cuenta.
 */
function buscarNotify(lineas: string[]): LineaNotifyEnArchivo | undefined {
  let multi: string | null = null
  let profundidad = 0
  for (let i = 0; i < lineas.length; i++) {
    const l = i === 0 ? lineas[i].replace(/^﻿/, '') : lineas[i]
    if (multi === null && profundidad === 0) {
      if (l.trimStart().startsWith('[')) return undefined
      if (CLAVE_NOTIFY.test(l)) return { indice: i, nuestra: LINEA_DE_SLOTH.test(l) }
    }
    let j = 0
    while (j < l.length) {
      if (multi !== null) {
        const fin = l.indexOf(multi, j)
        if (fin === -1) break
        j = fin + 3
        multi = null
        continue
      }
      const c = l[j]
      if (c === '#') break
      if (c === '"' || c === "'") {
        if (l.startsWith(c.repeat(3), j)) {
          multi = c.repeat(3)
          j += 3
          continue
        }
        j++
        while (j < l.length && l[j] !== c) j += c === '"' && l[j] === '\\' ? 2 : 1
        j++
        continue
      }
      if (c === '[') profundidad++
      else if (c === ']' && profundidad > 0) profundidad--
      j++
    }
  }
  return undefined
}

/**
 * Agrega al principio (una clave suelta después de una `[tabla]` caería dentro de esa tabla) o actualiza
 * la línea marcada. Una clave `notify` sin la marca es del usuario: no se toca. El resto queda byte a byte.
 */
export function aplicarNotify(toml: string, linea: string): { toml: string; cambio: CambioNotify } {
  const lineas = partir(toml)
  const hallada = buscarNotify(lineas)
  if (hallada && !hallada.nuestra) return { toml, cambio: 'ajeno' }
  if (hallada) {
    const actual = lineas[hallada.indice]
    const bom = hallada.indice === 0 && actual.startsWith('﻿') ? '﻿' : ''
    const nueva = `${bom}${linea}${finDeLinea(actual)}`
    if (nueva === actual) return { toml, cambio: 'igual' }
    lineas[hallada.indice] = nueva
    return { toml: lineas.join(''), cambio: 'actualizada' }
  }
  const salto = lineas[0]?.endsWith('\r\n') ? '\r\n' : '\n'
  const bom = toml.startsWith('﻿') ? '﻿' : ''
  return { toml: `${bom}${linea}${salto}${toml.slice(bom.length)}`, cambio: 'agregada' }
}

/** Saca solo la línea que puso Sloth. Si no hay, devuelve el texto tal cual. */
export function quitarNotify(toml: string): { toml: string; quitada: boolean } {
  const lineas = partir(toml)
  const hallada = buscarNotify(lineas)
  if (!hallada?.nuestra) return { toml, quitada: false }
  const bom = hallada.indice === 0 && lineas[0].startsWith('﻿') ? '﻿' : ''
  lineas.splice(hallada.indice, 1)
  const resto = lineas.join('')
  return { toml: bom && !resto.startsWith('﻿') ? `${bom}${resto}` : resto, quitada: true }
}
