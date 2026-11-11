/**
 * Lo que arma el asistente de conectores propios, en una forma cómoda para editar, y su paso a
 * ConectorMcp. Módulo puro: la validación es la misma que usa main (`validarPropio`).
 */
import { ACCIONES, type Accion, type Estado } from '../../../../shared/tickets'
import { ConectorInvalidoError, PLACEHOLDERS, type ArgValor, type ConectorDef, type ConectorMcp, type PasoLlamada } from '../../../../main/features/tickets/conector'
import { ESTADO_EN_SNAKE, faltaConector, PISTA_ESTADOS } from '../../../../main/features/tickets/conectores/comun'
import { jsonCanonico, validarPropio } from '../../../../main/features/tickets/propios'

export type Rol = 'lista' | 'detalle' | 'apoyo' | 'nada'
export type FormatoId = 'clave-numero' | 'numero' | 'alfanumerico' | 'propio'

export interface AccionBorrador {
  herramienta: string
  /** Placeholder → nombre del argumento que lo lleva ('' = no va). */
  args: Record<string, string>
  nota: string
}

export interface Borrador {
  id: string
  nombre: string
  prefijo: string
  herramientas: { nombre: string; rol: Rol }[]
  acciones: Partial<Record<Accion, AccionBorrador>>
  /** Herramienta de detalle → argumento que lleva el id del ticket. */
  detalleArg: Record<string, string>
  formato: FormatoId
  regexPropia: string
  ejemploId: string
  estados: Estado[]
  pistas: { yoConId: string; yoSinId: string; lista: string; pedirEstados: boolean; apoyo: string }
  /** El conector que se está editando: lo que el asistente no maneja se toma de acá. */
  original?: ConectorMcp
}

export const FORMATOS: Record<Exclude<FormatoId, 'propio'>, { regex: string; mayusculas: boolean; ejemplo: string; etiqueta: string }> = {
  'clave-numero': { regex: '^[A-Z][A-Z0-9]*-\\d{1,7}$', mayusculas: true, ejemplo: 'ABC-123', etiqueta: 'Clave y número (ABC-123)' },
  numero: { regex: '^#?\\d{1,9}$', mayusculas: false, ejemplo: '123', etiqueta: 'Solo número (123 o #123)' },
  alfanumerico: { regex: '^[A-Za-z0-9]{4,24}$', mayusculas: false, ejemplo: 'a1b2c3d4', etiqueta: 'Código alfanumérico' }
}

export const ESTADOS_INICIALES: Estado[] = [
  { clave: 'por_hacer', nombre: 'Por hacer', categoria: 'pendiente' },
  { clave: 'en_curso', nombre: 'En curso', categoria: 'en_curso' },
  { clave: 'en_revision', nombre: 'En revisión', categoria: 'revision' },
  { clave: 'bloqueado', nombre: 'Bloqueado', categoria: 'bloqueado' },
  { clave: 'hecho', nombre: 'Hecho', categoria: 'hecho' }
]

export const ACCION_ETIQUETA: Record<Accion, string> = {
  estado: 'Mover de estado',
  tomar: 'Tomar',
  soltar: 'Soltar',
  comentar: 'Comentar',
  criterio: 'Tildar criterio',
  horas: 'Cargar horas'
}

const NEGAR_MAX = 100
const ID_MAX = 32
const PLACEHOLDER_RE = /^\{([A-Za-z]+)\}$/

export function slugId(nombre: string): string {
  const s = nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, ID_MAX)
    .replace(/-+$/, '')
  return s.length >= 2 ? s : `conector${s ? `-${s}` : ''}`
}

export const argsPorDefecto = (a: Accion): Record<string, string> => Object.fromEntries(PLACEHOLDERS[a].map((p) => [p, p === 'ticket' ? 'id' : p]))

export function borradorNuevo(nombre: string, prefijo: string, herramientas: string[]): Borrador {
  return {
    id: slugId(nombre),
    nombre,
    prefijo,
    herramientas: herramientas.map((h) => ({ nombre: h, rol: 'nada' })),
    acciones: {},
    detalleArg: {},
    formato: 'clave-numero',
    regexPropia: '',
    ejemploId: FORMATOS['clave-numero'].ejemplo,
    estados: ESTADOS_INICIALES.map((e) => ({ ...e })),
    pistas: {
      yoConId: `Tu id en ${nombre} es "{id}": usalo en yo.id.`,
      yoSinId: 'Tu id y tu nombre los sacás de la herramienta que dice quién sos.',
      lista: `Traé los tickets abiertos de todo el equipo, sin filtrar por asignado (no solo los tuyos), como máximo 250. ${ESTADO_EN_SNAKE}`,
      pedirEstados: true,
      apoyo: ''
    }
  }
}

/** Otra búsqueda de herramientas: conserva los roles y acciones de las que siguen existiendo. */
export function conHerramientas(b: Borrador, herramientas: string[]): Borrador {
  const rol = new Map(b.herramientas.map((h) => [h.nombre, h.rol]))
  const existe = new Set(herramientas)
  const acciones: Borrador['acciones'] = {}
  for (const a of ACCIONES) {
    const x = b.acciones[a]
    if (x && existe.has(x.herramienta)) acciones[a] = x
  }
  return {
    ...b,
    herramientas: herramientas.map((h) => ({ nombre: h, rol: rol.get(h) ?? 'nada' })),
    acciones,
    detalleArg: Object.fromEntries(Object.entries(b.detalleArg).filter(([h]) => existe.has(h)))
  }
}

const conRol = (b: Borrador, r: Rol): string[] => b.herramientas.filter((h) => h.rol === r).map((h) => h.nombre)

export function regexDe(b: Borrador): { regex: string; mayusculas: boolean } {
  if (b.formato === 'propio') return { regex: b.regexPropia, mayusculas: b.original?.idRegex === b.regexPropia ? b.original.idMayusculas : false }
  const f = FORMATOS[b.formato]
  return { regex: f.regex, mayusculas: f.mayusculas }
}

const esPlaceholder = (v: ArgValor): boolean => typeof v === 'string' && PLACEHOLDER_RE.test(v)

/** El argumento de nivel uno que lleva `{ticket}` en los pasos de esa herramienta (el último gana, como en deDef). */
function argTicket(pasos: readonly PasoLlamada[], h: string): string | undefined {
  let arg: string | undefined
  for (const p of pasos) if (p.herramienta === h) arg = Object.entries(p.args).find(([, v]) => v === '{ticket}')?.[0] ?? arg
  return arg
}

export function aDef(b: Borrador): ConectorMcp {
  const o = b.original
  const lista = conRol(b, 'lista')
  const detalle = conRol(b, 'detalle')
  const apoyo = conRol(b, 'apoyo')
  const escritura: Partial<Record<Accion, string>> = {}
  const acciones: ConectorMcp['pistas']['acciones'] = {}
  for (const a of ACCIONES) {
    const x = b.acciones[a]
    if (!x?.herramienta) continue
    escritura[a] = x.herramienta
    const puestos = Object.entries(x.args)
      .filter(([, n]) => n.trim())
      .map(([p, n]) => [n.trim(), `{${p}}`])
    const previa = o?.herramientas.escritura[a] === x.herramienta ? o.pistas.acciones[a] : undefined
    // Los literales y los objetos anidados no se editan en el asistente: se conservan.
    const resto = Object.entries(structuredClone(previa?.args ?? {})).filter(([, v]) => !esPlaceholder(v))
    acciones[a] = { args: Object.fromEntries([...resto, ...puestos]), ...(x.nota.trim() ? { nota: x.nota.trim() } : {}) }
  }
  const escribe = Object.values(escritura)
  const apoyoEn: Partial<Record<Accion, string[]>> = {}
  if (apoyo.length)
    for (const a of ACCIONES) {
      const xs = (o?.herramientas.apoyoEn?.[a] ?? []).filter((t) => !escribe.includes(t))
      if (escritura[a] && xs.length) apoyoEn[a] = xs
    }
  const usadas = new Set([...lista, ...detalle, ...apoyo, ...escribe, ...Object.values(apoyoEn).flat()])
  const negar = b.herramientas
    .map((h) => h.nombre)
    .filter((h) => !usadas.has(h))
    .slice(0, NEGAR_MAX)
  const previos = o?.pistas.detalle ?? []
  const argDe = (h: string): string => b.detalleArg[h]?.trim() || 'id'
  const conservar = new Set(detalle.filter((h) => previos.some((p) => p.herramienta === h) && argDe(h) === (argTicket(previos, h) ?? 'id')))
  const pasos: PasoLlamada[] = [
    ...structuredClone(previos.filter((p) => conservar.has(p.herramienta))),
    ...detalle.filter((h) => !conservar.has(h)).map((h) => ({ herramienta: h, args: { [argDe(h)]: '{ticket}' } }))
  ]
  const { regex, mayusculas } = regexDe(b)
  const estadoEj = o && b.estados.some((e) => e.clave === o.ejemplo.estado) ? o.ejemplo.estado : (b.estados.find((e) => e.categoria !== 'hecho')?.clave ?? '')
  return {
    id: b.id,
    nombre: b.nombre,
    via: 'mcp',
    verificado: false,
    idRegex: regex,
    idMayusculas: mayusculas,
    ...(o?.personaId !== undefined ? { personaId: o.personaId } : {}),
    ejemplo: { id: b.ejemploId, estado: estadoEj, prioridad: o?.ejemplo.prioridad ?? 'prioridad', proyecto: o?.ejemplo.proyecto ?? 'proyecto' },
    estados: b.estados.map((e) => ({ ...e })),
    faltaConector: o && o.nombre === b.nombre ? { ...o.faltaConector } : faltaConector(b.id, b.nombre),
    herramientas: { prefijo: b.prefijo, lista, detalle, escritura, negar, ...(apoyo.length ? { apoyo } : {}), ...(Object.keys(apoyoEn).length ? { apoyoEn } : {}) },
    pistas: {
      yo: { conId: b.pistas.yoConId, sinId: b.pistas.yoSinId },
      lista: b.pistas.lista,
      ...(b.pistas.pedirEstados ? { estados: o?.pistas.estados ?? PISTA_ESTADOS } : {}),
      detalle: pasos,
      ...(apoyo.length ? { apoyo: b.pistas.apoyo } : {}),
      acciones
    }
  }
}

function formatoDe(def: ConectorMcp): FormatoId {
  const f = (Object.keys(FORMATOS) as (keyof typeof FORMATOS)[]).find((k) => FORMATOS[k].regex === def.idRegex && FORMATOS[k].mayusculas === def.idMayusculas)
  return f ?? 'propio'
}

/** Guarda el conector como `original`: aDef conserva lo que el asistente no muestra. */
export function deDef(def: ConectorMcp): Borrador {
  const h = def.herramientas
  const roles = new Map<string, Rol>()
  for (const [r, xs] of [['lista', h.lista], ['detalle', h.detalle], ['apoyo', h.apoyo ?? []]] as const) for (const x of xs) roles.set(x, r)
  for (const x of [...h.negar, ...Object.values(h.escritura)]) if (!roles.has(x)) roles.set(x, 'nada')

  const acciones: Borrador['acciones'] = {}
  for (const a of ACCIONES) {
    const herramienta = h.escritura[a]
    if (!herramienta) continue
    const pista = def.pistas.acciones[a]
    const args = Object.fromEntries(PLACEHOLDERS[a].map((p) => [p, '']))
    for (const [n, v] of Object.entries(pista?.args ?? {})) {
      const m = typeof v === 'string' ? PLACEHOLDER_RE.exec(v) : null
      if (m && m[1] in args) args[m[1]] = n
    }
    acciones[a] = { herramienta, args, nota: pista?.nota ?? '' }
  }

  const detalleArg: Record<string, string> = {}
  for (const paso of def.pistas.detalle) {
    const arg = argTicket(def.pistas.detalle, paso.herramienta)
    if (arg) detalleArg[paso.herramienta] = arg
  }

  const formato = formatoDe(def)
  return {
    id: def.id,
    nombre: def.nombre,
    prefijo: h.prefijo,
    herramientas: [...roles].map(([nombre, rol]) => ({ nombre, rol })),
    acciones,
    detalleArg,
    formato,
    regexPropia: formato === 'propio' ? def.idRegex : '',
    ejemploId: def.ejemplo.id,
    estados: def.estados.map((e) => ({ ...e })),
    pistas: {
      yoConId: def.pistas.yo.conId,
      yoSinId: def.pistas.yo.sinId,
      lista: def.pistas.lista,
      pedirEstados: def.pistas.estados !== undefined,
      apoyo: def.pistas.apoyo ?? ''
    },
    original: structuredClone(def)
  }
}

/** Si pasar el conector por el asistente lo deja igual. Si no (p. ej. una herramienta con dos roles), no se edita con el asistente. */
export function seEditaSinPerder(def: ConectorMcp): boolean {
  try {
    return jsonCanonico(validarPropio(aDef(deDef(def)))) === jsonCanonico(validarPropio(def))
  } catch {
    return false
  }
}

export type Revision = { ok: true; def: ConectorDef } | { ok: false; ruta: string; mensaje: string }

export function validarBorrador(b: Borrador): Revision {
  try {
    return { ok: true, def: validarPropio(aDef(b)) }
  } catch (e) {
    if (!(e instanceof ConectorInvalidoError)) throw e
    return { ok: false, ruta: e.ruta, mensaje: e.message.replace(`Conector inválido en ${e.ruta}: `, '') }
  }
}

/** Si el ejemplo de id cumple el formato elegido; con el mensaje del problema si no. */
export function revisarId(b: Borrador): string | null {
  const r = validarBorrador(b)
  if (!r.ok && (r.ruta === 'conector.idRegex' || r.ruta === 'conector.ejemplo.id')) return r.ruta === 'conector.idRegex' ? `La regex ${r.mensaje}.` : 'El ejemplo no cumple el formato.'
  const { regex, mayusculas } = regexDe(b)
  try {
    const ok = new RegExp(`^(?:${regex.slice(1, -1)})$`).test(b.ejemploId) && (!mayusculas || b.ejemploId === b.ejemploId.toUpperCase())
    return ok ? null : 'El ejemplo no cumple el formato.'
  } catch {
    return 'La regex no compila.'
  }
}
