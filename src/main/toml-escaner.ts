export interface Sentencia {
  tipo: 'clave' | 'tabla' | 'tablaArray'
  /** Camino de la clave (relativo a su tabla) o de la cabecera. Sin comillas ni escapes. */
  ruta: string[]
  /** Cabecera bajo la que está una clave; vacío en la raíz. */
  tabla: string[]
  /** Offsets en el texto: de la primera letra a donde termina el valor (sin el comentario del final). */
  desde: number
  hasta: number
  lineaIni: number
  lineaFin: number
}

export type Analisis = { ok: true; sentencias: Sentencia[] } | { ok: false; motivo: string }

class ErrorToml extends Error {}

const FECHA = /(?:\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)/y
const BARE = /[A-Za-z0-9_+\-.:]+/y
const VALOR_BARE = /^(?:true|false|[+-]?(?:inf|nan)|[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?|0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*)$/
const CLAVE_BARE = /[A-Za-z0-9_-]+/y
const HEX = /^[0-9A-Fa-f]+$/
const PROFUNDIDAD_MAX = 64
const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\u001b', '"': '"', '\\': '\\' }

/**
 * Recorre un TOML sin evaluarlo: cadenas básicas y literales (de una línea y multilínea, con sus escapes), arrays,
 * tablas en línea, cabeceras y comentarios. Ante cualquier cosa que no cierra devuelve `ok: false`: quien lo usa
 * para editar un archivo del usuario tiene que tratar la duda como «no escribir».
 */
export function analizar(texto: string): Analisis {
  try {
    return { ok: true, sentencias: recorrer(texto) }
  } catch (e) {
    if (e instanceof ErrorToml) return { ok: false, motivo: e.message }
    throw e
  }
}

function recorrer(texto: string): Sentencia[] {
  const n = texto.length
  let i = texto.charCodeAt(0) === 0xfeff ? 1 : 0
  const inicios = [0]
  for (let k = 0; k < n; k++) if (texto[k] === '\n') inicios.push(k + 1)
  const lineaDe = (off: number): number => {
    let lo = 0
    let hi = inicios.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (inicios[mid] <= off) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  // Sin el contenido del archivo: el motivo termina en un log que se comparte.
  const falla = (m: string): never => {
    throw new ErrorToml(`${m} (línea ${lineaDe(Math.min(i, n)) + 1})`)
  }

  const espacios = (): void => {
    while (i < n && (texto[i] === ' ' || texto[i] === '\t')) i++
  }
  const comentario = (): void => {
    if (texto[i] !== '#') return
    while (i < n && texto[i] !== '\n') i++
  }
  const blancos = (): void => {
    while (i < n) {
      const c = texto[i]
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') i++
      else if (c === '#') comentario()
      else break
    }
  }
  const finDeLinea = (): void => {
    espacios()
    comentario()
    if (i >= n) return
    if (texto[i] === '\n') i++
    else if (texto[i] === '\r' && texto[i + 1] === '\n') i += 2
    else falla('hay texto después del valor')
  }

  const escape = (multi: boolean): string => {
    const e = texto[i + 1]
    if (e === undefined) return falla('escape sin terminar')
    if (e in ESCAPES) {
      i += 2
      return ESCAPES[e]
    }
    if (e === 'u' || e === 'U') {
      const largo = e === 'u' ? 4 : 8
      const hex = texto.slice(i + 2, i + 2 + largo)
      if (hex.length !== largo || !HEX.test(hex)) return falla('escape unicode inválido')
      const cp = parseInt(hex, 16)
      if (cp > 0x10ffff) return falla('escape unicode inválido')
      i += 2 + largo
      return String.fromCodePoint(cp)
    }
    if (multi) {
      // Una barra al final de la línea se come el salto y los blancos que siguen.
      let j = i + 1
      while (texto[j] === ' ' || texto[j] === '\t') j++
      if (texto[j] === '\n' || (texto[j] === '\r' && texto[j + 1] === '\n')) {
        while (j < n && (texto[j] === ' ' || texto[j] === '\t' || texto[j] === '\r' || texto[j] === '\n')) j++
        i = j
        return ''
      }
    }
    return falla('escape desconocido')
  }

  const cadenaBasica = (): string => {
    let out = ''
    if (texto.startsWith('"""', i)) {
      i += 3
      while (true) {
        if (i >= n) return falla('cadena multilínea sin cerrar')
        if (texto.startsWith('"""', i)) {
          let k = 0
          while (texto[i + k] === '"') k++
          if (k > 5) return falla('comillas de más al cerrar una cadena')
          out += '"'.repeat(k - 3)
          i += k
          return out
        }
        if (texto[i] === '\\') out += escape(true)
        else out += texto[i++]
      }
    }
    i++
    while (true) {
      if (i >= n || texto[i] === '\n' || texto[i] === '\r') return falla('cadena sin cerrar')
      const c = texto[i]
      if (c === '"') {
        i++
        return out
      }
      if (c === '\\') out += escape(false)
      else out += texto[i++]
    }
  }

  const cadenaLiteral = (): string => {
    if (texto.startsWith("'''", i)) {
      i += 3
      const ini = i
      while (true) {
        if (i >= n) return falla('cadena multilínea sin cerrar')
        if (texto.startsWith("'''", i)) {
          let k = 0
          while (texto[i + k] === "'") k++
          if (k > 5) return falla('comillas de más al cerrar una cadena')
          const out = texto.slice(ini, i + (k - 3))
          i += k
          return out
        }
        i++
      }
    }
    i++
    const ini = i
    while (true) {
      if (i >= n || texto[i] === '\n' || texto[i] === '\r') return falla('cadena sin cerrar')
      if (texto[i] === "'") {
        const out = texto.slice(ini, i)
        i++
        return out
      }
      i++
    }
  }

  const clave = (): string => {
    const c = texto[i]
    if (c === '"') return cadenaBasica()
    if (c === "'") return cadenaLiteral()
    CLAVE_BARE.lastIndex = i
    const m = CLAVE_BARE.exec(texto)
    if (!m) return falla('clave inválida')
    i += m[0].length
    return m[0]
  }

  const ruta = (): string[] => {
    const partes = [clave()]
    while (true) {
      espacios()
      if (texto[i] !== '.') return partes
      i++
      espacios()
      partes.push(clave())
    }
  }

  const bare = (): void => {
    FECHA.lastIndex = i
    const f = FECHA.exec(texto)
    if (f) {
      i += f[0].length
      return
    }
    BARE.lastIndex = i
    const m = BARE.exec(texto)
    if (!m || !VALOR_BARE.test(m[0])) return falla('valor no reconocido')
    i += m[0].length
  }

  const valor = (prof: number): void => {
    if (prof > PROFUNDIDAD_MAX) falla('demasiado anidado')
    const c = texto[i]
    if (c === '"') cadenaBasica()
    else if (c === "'") cadenaLiteral()
    else if (c === '[') {
      i++
      while (true) {
        blancos()
        if (texto[i] === ']') {
          i++
          return
        }
        valor(prof + 1)
        blancos()
        if (texto[i] === ',') i++
        else if (texto[i] === ']') {
          i++
          return
        } else falla('array mal cerrado')
      }
    } else if (c === '{') {
      i++
      blancos()
      if (texto[i] === '}') {
        i++
        return
      }
      while (true) {
        ruta()
        blancos()
        if (texto[i] !== '=') falla('falta el = en una tabla en línea')
        i++
        blancos()
        valor(prof + 1)
        blancos()
        if (texto[i] === ',') {
          i++
          blancos()
          if (texto[i] === '}') {
            i++
            return
          }
        } else if (texto[i] === '}') {
          i++
          return
        } else falla('tabla en línea mal cerrada')
      }
    } else bare()
  }

  const sentencias: Sentencia[] = []
  let tabla: string[] = []
  while (true) {
    blancos()
    if (i >= n) return sentencias
    const desde = i
    let tipo: Sentencia['tipo']
    let r: string[]
    let propia: string[]
    if (texto[i] === '[') {
      const doble = texto[i + 1] === '['
      tipo = doble ? 'tablaArray' : 'tabla'
      i += doble ? 2 : 1
      espacios()
      r = ruta()
      espacios()
      if (texto[i] !== ']' || (doble && texto[i + 1] !== ']')) falla('cabecera mal cerrada')
      i += doble ? 2 : 1
      propia = []
    } else {
      tipo = 'clave'
      r = ruta()
      espacios()
      if (texto[i] !== '=') falla('falta el =')
      i++
      espacios()
      valor(0)
      propia = tabla
    }
    const hasta = i
    finDeLinea()
    sentencias.push({ tipo, ruta: r, tabla: propia, desde, hasta, lineaIni: lineaDe(desde), lineaFin: lineaDe(hasta - 1) })
    if (tipo !== 'clave') tabla = r
  }
}

const SEP = '\u0000'
const unir = (r: string[]): string => r.join(SEP)

/** Lo que TOML rechaza por repetido: dos veces la misma clave, o una clave y una tabla con el mismo camino. Sin nombres en el motivo. */
export function problemaDeDuplicados(sentencias: Sentencia[]): string | undefined {
  const claves = new Set<string>()
  const prefijos = new Set<string>()
  const tablas = new Set<string>()
  const arrays = new Set<string>()
  const implicitas = new Set<string>()
  const repetido = 'El config.toml tiene claves o tablas repetidas.'
  const prefijoEn = (conjunto: Set<string>, ruta: string[], desdeLargo: number): boolean => {
    for (let k = desdeLargo; k < ruta.length; k++) if (conjunto.has(unir(ruta.slice(0, k)))) return true
    return false
  }
  const limpiarHijos = (ruta: string[]): void => {
    const p = unir(ruta) + SEP
    for (const c of [claves, prefijos, tablas, arrays, implicitas]) for (const x of [...c]) if (x.startsWith(p)) c.delete(x)
  }
  for (const s of sentencias) {
    if (s.tipo === 'clave') {
      const completa = [...s.tabla, ...s.ruta]
      const k = unir(completa)
      if (claves.has(k) || tablas.has(k) || prefijos.has(k) || arrays.has(k)) return repetido
      if (prefijoEn(claves, completa, 1) || prefijoEn(tablas, completa, s.tabla.length + 1)) return repetido
      claves.add(k)
      for (let l = s.tabla.length + 1; l < completa.length; l++) prefijos.add(unir(completa.slice(0, l)))
      continue
    }
    const k = unir(s.ruta)
    if (claves.has(k) || prefijos.has(k) || prefijoEn(claves, s.ruta, 1)) return repetido
    if (s.tipo === 'tabla') {
      if (tablas.has(k) || arrays.has(k)) return repetido
      tablas.add(k)
    } else {
      if (tablas.has(k) || (implicitas.has(k) && !arrays.has(k))) return repetido
      limpiarHijos(s.ruta)
      arrays.add(k)
    }
    for (let l = 1; l < s.ruta.length; l++) implicitas.add(unir(s.ruta.slice(0, l)))
  }
  return undefined
}
