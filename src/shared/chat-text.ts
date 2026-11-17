/** Texto de los mensajes del chat: menciones @login y búsqueda. Puro: se prueba con Node. */

export type TextPart = { kind: 'text'; text: string } | { kind: 'mention'; login: string }

// El `@` cuenta si está al principio o después de algo que no sea parte de un mail o de otra mención,
// así `a@b.com` no es una mención.
const MENTION_RE = /(?<![A-Za-z0-9_@.])@([A-Za-z0-9][A-Za-z0-9-]{0,38})(?![A-Za-z0-9-])/g
const QUERY_RE = /(?<![A-Za-z0-9_@.])@([A-Za-z0-9-]{0,39})$/
const LOGIN_CHAR_RE = /[A-Za-z0-9-]/

export function splitMentions(text: string): TextPart[] {
  const out: TextPart[] = []
  let last = 0
  for (const m of text.matchAll(MENTION_RE)) {
    const at = m.index
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) })
    out.push({ kind: 'mention', login: m[1] })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

export function mentionsLogin(body: string, login: string): boolean {
  const want = login.toLowerCase()
  return splitMentions(body).some((p) => p.kind === 'mention' && p.login.toLowerCase() === want)
}

/** Si el cursor está terminando de escribir una mención, dónde empieza (el `@`) y lo escrito hasta ahí. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | undefined {
  if (caret < 0 || caret > text.length) return undefined
  if (caret < text.length && LOGIN_CHAR_RE.test(text[caret])) return undefined
  const m = QUERY_RE.exec(text.slice(0, caret))
  if (!m) return undefined
  return { start: m.index, query: m[1] }
}

/** Reemplaza lo escrito entre `start` y `caret` por la mención completa, con un espacio después. */
export function applyMention(text: string, start: number, caret: number, login: string): { text: string; caret: number } {
  const rest = text.slice(caret)
  const spaced = rest.startsWith(' ')
  const inserted = `@${login}${spaced ? '' : ' '}`
  return { text: text.slice(0, start) + inserted + rest, caret: start + inserted.length + (spaced ? 1 : 0) }
}

/**
 * Escapa los comodines de LIKE/ILIKE. PostgREST convierte todo `*` en `%` aunque vaya escapado, así que
 * pasa a `_` (un carácter cualquiera) y el resultado hay que filtrarlo después con `containsText`.
 */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, '\\$&').replace(/\*/g, '_')
}

export function containsText(body: string, q: string): boolean {
  return body.toLowerCase().includes(q.toLowerCase())
}

/**
 * ¿El host es el de un proyecto de Supabase en la nube (`<ref>.supabase.co`)? Una invitación o un
 * team.json puede apuntar a cualquier servidor https, y uno parecido (`acme.supabase.co.otro.com`)
 * vería todo lo que se escribe. Los que no pasan se muestran con una advertencia; no se rechazan,
 * porque un Supabase propio es válido.
 */
export function esHostSupabase(host: string): boolean {
  return /^[a-z0-9]{8,40}\.supabase\.co$/.test(host.toLowerCase())
}

/**
 * Lo que la UI manda para confirmar una invitación. Con un servidor fuera de supabase.co va atado al
 * host completo que se le mostró: confirmar «conectar» no alcanza para otro servidor.
 */
export function inviteConfirmation(decision: string, host: string): string {
  return esHostSupabase(host) ? decision : `${decision}@${host}`
}

/** El host de la URL si no es de Supabase (para avisarlo); undefined si es <ref>.supabase.co o no es una URL. */
export function hostNoSupabase(url: string): string | undefined {
  let host: string
  try {
    host = new URL(url).host
  } catch {
    return undefined
  }
  return esHostSupabase(host) ? undefined : host
}
