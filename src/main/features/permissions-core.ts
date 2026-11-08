/**
 * Pedidos de permiso (lógica pura, sin Electron ni Node): tipos de pedido, reglas «Permitir siempre»,
 * decisión que se le manda al daemon y cuándo avisar. Lo usan main (permissions.ts) y la interfaz.
 */

export type PermissionKind = 'cmd' | 'edit' | 'net' | 'other'
/** Lo que elige el usuario. `terminal` deja que Claude pregunte en la terminal, como antes. */
export type PermissionChoice = 'allow' | 'allowAlways' | 'deny' | 'terminal'

/** Forma mínima de un pedido (la de PendingPermission del daemon). */
export interface PermissionRequestLike {
  id: string
  ws: string
  tool: string
  input: Record<string, unknown>
  at: number
  expiresAt: number
}

/** Regla «Permitir siempre» de un espacio. Coincide solo con pedidos iguales (no por prefijo). */
export interface PermissionRule {
  id: string
  workspaceId: string
  kind: PermissionKind
  tool: string
  /** cmd: comando exacto · net: dominio · edit/other: «*» */
  match: string
  label: string
  on: boolean
  createdAt: number
}

export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
export const NET_TOOLS: ReadonlySet<string> = new Set(['WebFetch', 'WebSearch'])

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

export function kindOf(tool: string): PermissionKind {
  if (tool === 'Bash') return 'cmd'
  if (FILE_EDIT_TOOLS.has(tool)) return 'edit'
  if (NET_TOOLS.has(tool)) return 'net'
  return 'other'
}

/** Dominio (host) de un WebFetch; '' si no se puede leer. */
export function hostOf(input: Record<string, unknown>): string {
  const url = str(input.url)
  if (!url) return ''
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

/** Archivos que toca un pedido de edición (ruta, o varias en MultiEdit). */
export function filesOf(tool: string, input: Record<string, unknown>): string[] {
  void tool
  const p = str(input.file_path) ?? str(input.notebook_path)
  return p ? [p] : []
}

export interface DiffLine {
  t: '+' | '-'
  text: string
}

export interface FileChange {
  path: string
  add: number
  del: number
  isNew: boolean
  lines: DiffLine[]
}

const linesOf = (s: unknown): string[] => (typeof s === 'string' && s.length ? s.split(/\r?\n/) : [])

/**
 * Cambios que trae el pedido, tal como los manda el hook: Edit (old/new), MultiEdit (edits[]) y Write
 * (content). Si el hook no los trae, la lista queda vacía: no se inventa un diff.
 */
export function changesOf(tool: string, input: Record<string, unknown>): FileChange[] {
  const path = filesOf(tool, input)[0] ?? ''
  const mk = (p: string, pairs: { oldS?: unknown; newS?: unknown; isNew?: boolean }[]): FileChange => {
    const lines: DiffLine[] = []
    for (const pr of pairs) {
      for (const l of linesOf(pr.oldS)) lines.push({ t: '-', text: l })
      for (const l of linesOf(pr.newS)) lines.push({ t: '+', text: l })
    }
    return {
      path: p,
      add: lines.filter((l) => l.t === '+').length,
      del: lines.filter((l) => l.t === '-').length,
      isNew: pairs.some((x) => x.isNew),
      lines
    }
  }
  if (tool === 'Edit' || tool === 'NotebookEdit') return path ? [mk(path, [{ oldS: input.old_string, newS: input.new_string ?? input.new_source }])] : []
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : []
    const pairs = edits.map((e) => ({ oldS: (e as Record<string, unknown>)?.old_string, newS: (e as Record<string, unknown>)?.new_string }))
    return path && pairs.length ? [mk(path, pairs)] : []
  }
  if (tool === 'Write') return path ? [mk(path, [{ newS: input.content, isNew: false }])] : []
  return []
}

/** Explicación que puso Claude en el pedido (campo description de Bash, si viene). */
export function explanationOf(input: Record<string, unknown>): string | undefined {
  return str(input.description)
}

/** Título de la tarjeta y de la revisión: «Claude quiere ejecutar un comando»… */
export function titleOf(kind: PermissionKind, tool: string, input: Record<string, unknown>): string {
  if (kind === 'cmd') return 'Claude quiere ejecutar un comando'
  if (kind === 'edit') {
    const n = filesOf(tool, input).length || 1
    return n === 1 ? 'Claude quiere editar un archivo' : `Claude quiere editar ${n} archivos`
  }
  if (kind === 'net') return 'Claude quiere acceder a internet'
  return `Claude quiere usar ${otherName(tool)}`
}

/** Nombre corto de una herramienta: en MCP, la herramienta sin el prefijo `mcp__servidor__`. */
export function otherName(tool: string): string {
  if (!tool.startsWith('mcp__')) return tool
  const rest = tool.slice('mcp__'.length)
  const i = rest.indexOf('__')
  return i < 0 ? rest : rest.slice(i + 2) || rest.slice(0, i)
}

/** Texto corto del pedido (para listas, avisos e historial). */
export function labelOf(kind: PermissionKind, tool: string, input: Record<string, unknown>): string {
  if (kind === 'cmd') return str(input.command) ?? 'comando'
  if (kind === 'edit') {
    const f = filesOf(tool, input)
    return f.length === 1 ? `Editar ${f[0]}` : 'Editar archivos'
  }
  if (kind === 'net') {
    const h = hostOf(input)
    return h ? `Acceder a ${h}` : 'Acceder a internet'
  }
  return otherName(tool)
}

/** Texto del botón «Permitir siempre» según el tipo. */
export function alwaysLabel(kind: PermissionKind): string {
  if (kind === 'cmd') return 'Permitir siempre aquí'
  if (kind === 'edit') return 'Permitir siempre ediciones aquí'
  if (kind === 'net') return 'Permitir siempre este dominio aquí'
  return 'Permitir siempre aquí'
}

/** Regla que se guarda al elegir «Permitir siempre» para este pedido. */
export function ruleFor(req: PermissionRequestLike): Omit<PermissionRule, 'id' | 'on' | 'createdAt'> {
  const kind = kindOf(req.tool)
  const label = labelOf(kind, req.tool, req.input)
  if (kind === 'cmd') return { workspaceId: req.ws, kind, tool: req.tool, match: str(req.input.command) ?? '', label }
  if (kind === 'net') return { workspaceId: req.ws, kind, tool: req.tool, match: hostOf(req.input), label }
  if (kind === 'edit') return { workspaceId: req.ws, kind, tool: req.tool, match: '*', label }
  return { workspaceId: req.ws, kind, tool: req.tool, match: '*', label }
}

/** ¿La regla cubre este pedido? Mismo espacio, mismo tipo y, según el tipo, mismo comando o dominio. */
export function ruleMatches(rule: PermissionRule, req: PermissionRequestLike): boolean {
  if (!rule.on || rule.workspaceId !== req.ws) return false
  const kind = kindOf(req.tool)
  if (rule.kind !== kind) return false
  if (kind === 'cmd') return rule.match !== '' && (str(req.input.command) ?? '') === rule.match
  if (kind === 'net') return rule.match !== '' && hostOf(req.input) === rule.match
  if (kind === 'edit') return FILE_EDIT_TOOLS.has(req.tool) && rule.match === '*'
  return rule.tool === req.tool
}

export function findRule(rules: readonly PermissionRule[], req: PermissionRequestLike): PermissionRule | undefined {
  return rules.find((r) => ruleMatches(r, req))
}

/** Regla validada, lista para guardar (sin id, sin espacio, sin estado). */
export interface RuleDraft {
  kind: PermissionKind
  tool: string
  match: string
  label: string
}

export const MAX_RULE_MATCH = 2000
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * Valida una regla que llega de afuera (archivo importado, pedido de la interfaz). Es la misma
 * forma que guarda «Permitir siempre»: el tipo sale de la herramienta, el texto es exacto (comando
 * o dominio) y nunca hay comodines, salvo «*» en ediciones y en herramientas completas.
 */
export function checkRule(raw: unknown): { ok: true; rule: RuleDraft } | { ok: false; motivo: string } {
  const fail = (motivo: string): { ok: false; motivo: string } => ({ ok: false, motivo })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('formato inválido')
  const o = raw as Record<string, unknown>
  const kind = o.kind
  if (kind !== 'cmd' && kind !== 'edit' && kind !== 'net' && kind !== 'other') return fail('tipo de regla desconocido')
  const tool = typeof o.tool === 'string' ? o.tool.trim() : ''
  const match = typeof o.match === 'string' ? o.match.trim() : ''
  if (!TOOL_NAME.test(tool)) return fail('nombre de herramienta inválido')
  if (kindOf(tool) !== kind) return fail('el tipo no corresponde a la herramienta')

  if (kind === 'cmd') {
    if (!match) return fail('falta el comando')
    if (match.length > MAX_RULE_MATCH || CONTROL.test(match)) return fail('comando demasiado largo o con caracteres de control')
    if (match.includes('*')) return fail('Sloth solo guarda comandos exactos, sin comodines')
    return { ok: true, rule: { kind, tool, match, label: match } }
  }
  if (kind === 'net') {
    if (!NET_TOOLS.has(tool)) return fail('herramienta de red no válida')
    const host = match.toLowerCase()
    if (!HOST.test(host)) return fail('el dominio no es válido')
    return { ok: true, rule: { kind, tool, match: host, label: `Acceder a ${host}` } }
  }
  if (kind === 'edit') {
    if (!FILE_EDIT_TOOLS.has(tool) || match !== '*') return fail('regla de edición no válida')
    return { ok: true, rule: { kind, tool, match: '*', label: 'Editar archivos' } }
  }
  if (match !== '*') return fail('Sloth solo guarda herramientas completas, sin patrón')
  return { ok: true, rule: { kind, tool, match: '*', label: otherName(tool) } }
}

/**
 * Decisión para el daemon (lo que espera el hook de PermissionRequest). `allowAlways` se resuelve
 * como una aprobación: la regla de Sloth la guarda main aparte, por espacio.
 */
export function decisionFor(choice: PermissionChoice, message?: string): object | null {
  switch (choice) {
    case 'allow':
    case 'allowAlways':
      return { behavior: 'allow' }
    case 'deny':
      return { behavior: 'deny', message: (message ?? '').trim() || 'Rechazado desde Sloth.' }
    case 'terminal':
      return null
  }
}

/** Avisos de Windows: no se avisa con «No molestar» ni si la ventana está en ese espacio. */
export function shouldNotify(o: { dnd: boolean; windowFocused: boolean; focusedSpace: string | null; wsId: string }): boolean {
  if (o.dnd) return false
  return !(o.windowFocused && o.focusedSpace === o.wsId)
}

export const CHOICES: readonly PermissionChoice[] = ['allow', 'allowAlways', 'deny', 'terminal']
