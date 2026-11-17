import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { FeatureContext } from './context'
import type { ConvCandidata } from './chat-mcp-core'
import { VIA_CLAUDE_PREFIX } from '../../shared/chat-mcp'
import {
  CHAT_LIMITS,
  convKey,
  type ChatAuth,
  type ChatConnection,
  type ChatConvRef,
  type ChatInvite,
  type ChatInviteSent,
  type ChatMember,
  type ChatMessage,
  type ChatProfile,
  type ChatReactionEvent,
  type ChatReadEvent,
  type ChatRemoveResult,
  type ChatTypingEvent,
  type ChatSnapshot,
  type ChatTeam,
  type ChatThread,
  type ChatView
} from '../../shared/chat'
import {
  convOfRow,
  exMemberProfile,
  firstChars,
  inviteFromRow,
  isObj,
  compareMembers,
  messageFromRow,
  MSG_COLS_BASE,
  MSG_COLS_EXTRAS,
  memberFromRow,
  oldestFirst,
  otherOf,
  otherReadAt,
  parseBody,
  parseClientId,
  parseConvRef,
  parseEmoji,
  parseInviteCode,
  parseLimit,
  parseLogin,
  parseOptionalUuid,
  parseSearch,
  parseTeamFields,
  parseUuid,
  parseView,
  photoPathOf,
  profileFromRow,
  reactionsByMessage,
  replyRefFrom,
  roleOf,
  sameConv,
  sortByActivity,
  teamFromRow,
  threadFromRow,
  unreadIndex,
  type InviteRow,
  type MessageRow,
  type TeamRow,
  type ThreadRow
} from './chat-map'
import { decodePhotoBase64, downloadTeamPhoto, PhotoCache, removeTeamPhoto, uploadTeamPhoto, type Photo } from './chat-photos'
import { openInbox, openTopic } from './chat-realtime'
import {
  BROADCAST_EVENT,
  convOfTopic,
  diffTopics,
  reactionFromBroadcast,
  READ_EVENT,
  REACTION_EVENT,
  readFromBroadcast,
  rowFromBroadcast,
  SeenIds,
  Throttle,
  TYPING_EVENT,
  typingFromBroadcast,
  UPDATE_EVENT,
  versionKey,
  wantedTopics
} from './chat-topics'
import { containsText, escapeLike, mentionsLogin } from '../../shared/chat-text'
import { canManageConv, parseRetention } from '../../shared/chat-retention'
import { currentSettings } from './settings'
import { faltaLaFuncion, resultadoExpulsar } from './chat-expulsar'

/**
 * Datos del chat (equipos, DMs, mensajes, no leídos, realtime, fotos, avisos). Contrato entre
 * chat.ts (T2: config + login) y este archivo (T8).
 *
 * Reglas: todo Supabase corre en main; una sola conexión realtime mientras hay sesión y ventana, con
 * el canal «sloth-inbox» (postgres_changes, respaldo) y uno privado de Broadcast por conversación
 * (entrega rápida; si la migración 0003 no está, se cae a «sloth-inbox» solo). Las listas se refrescan al arrancar, al reconectar y al enfocar
 * la ventana (mínimo 30 s entre refrescos); el único timer es la purga horaria del borrado automático. Nunca se loguea el cuerpo de un mensaje ni un token.
 */

/** Lo que chat.ts (T2) le da a la parte de datos. */
export interface ChatCoreHandle {
  /** Cliente de Supabase CON sesión iniciada, o null. Es un SupabaseClient: castealo con `as SupabaseClient`. */
  client(): unknown
  me(): ChatProfile | null
  auth(): ChatAuth
}

export type ChatDataPart = Omit<ChatSnapshot, 'auth'>

export interface ChatData {
  /** Estado actual para armar ChatSnapshot (chat.ts le suma `auth`). */
  part(): ChatDataPart
  /** chat.ts lo llama al quedar con sesión y ventana: carga listas y abre UNA conexión realtime. */
  start(): Promise<void>
  /** Al cerrar sesión, cambiar de config o cerrarse la ventana: cierra realtime y vacía cachés en memoria. */
  stop(): Promise<void>
  /** Entra a un equipo con su código (lo usa también la invitación completa). */
  joinByCode(code: unknown): Promise<ChatTeam>
  /** Equipos y directos ya cargados, para el MCP. Sin listas (ventana cerrada) tira. */
  conversaciones(): ConvCandidata[]
  leerUltimos(conv: ChatConvRef, n: number): Promise<ChatMessage[]>
  enviarViaClaude(conv: ChatConvRef, texto: string): Promise<ChatMessage>
  /** El servidor tiene la 0005 (columna `via`). */
  viaColumn(): boolean
}

export const EMPTY_PART: ChatDataPart = { connection: 'off', teams: [], threads: [], invites: [], unreadTotal: 0, extras: false, listsLoaded: false }

/** Dependencias inyectables (las pruebas no cargan Electron). */
export interface NoticeLike {
  on(event: 'click' | 'failed', cb: (...args: unknown[]) => void): unknown
  show(): void
}
export interface NotifierCtor {
  isSupported(): boolean
  new (opts: { title: string; body: string; silent: boolean }): NoticeLike
}
export interface ChatDataDeps {
  loadNotifier?: () => Promise<NotifierCtor | undefined>
  now?: () => number
}

const REFRESH_MIN_MS = 30_000
const NOTIFY_MIN_MS = 5_000
const MENTION_MIN_MS = 2_000
const PROFILE_CACHE_MAX = 500
const PHOTO_CACHE_MAX = 50
const UNREAD_CAP = 99
const NOTICE_CHARS = 120
const PURGE_EVERY_MS = 3_600_000
const EXTRAS_RETRY_MS = 30_000

const defaultNotifier = async (): Promise<NotifierCtor | undefined> => {
  const el = await import('electron')
  return el.Notification as unknown as NotifierCtor
}

type Lists = { teams: ChatTeam[]; threads: ChatThread[]; invites: ChatInvite[] }
const EMPTY_LISTS: Lists = { teams: [], threads: [], invites: [] }

type PgError = { code?: string; message?: string }
const REPLY_GONE = 'Solo podés responder a un mensaje de esta conversación.'
const MISSING_SCHEMA = new Set(['42703', '42P01', 'PGRST204', 'PGRST205'])

/** Error de PostgREST → mensaje para mostrar. Solo pasan los RAISE de nuestras funciones (P0001). */
function check(res: { error: PgError | null }, fallback: string): void {
  if (!res.error) return
  const e = res.error
  throw new Error(e.code === 'P0001' && e.message ? e.message.slice(0, 300) : fallback)
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const uniq = (a: string[]): string[] => [...new Set(a)].filter((x) => x !== '')
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : 'Algo salió mal.')
const isMsg = (m: ChatMessage | undefined): m is ChatMessage => m !== undefined

export function registerChatData(ctx: FeatureContext, core: ChatCoreHandle, onChange: () => void, deps: ChatDataDeps = {}): ChatData {
  const loadNotifier = deps.loadNotifier ?? defaultNotifier
  const now = deps.now ?? Date.now

  let gen = 0
  let running = false
  let connection: ChatConnection = 'off'
  let lists: Lists = EMPTY_LISTS
  let listsLoaded = false
  let view: ChatView = { open: false }
  let closeInbox: (() => Promise<void>) | undefined
  let subscribedOnce = false
  let lastRefresh = 0
  let refreshChain: Promise<void> = Promise.resolve()
  const profiles = new Map<string, ChatProfile>()
  const teamPhotoPath = new Map<string, string>()
  const photos = new PhotoCache(PHOTO_CACHE_MAX)
  const photoLoading = new Set<string>()
  const photoFailed = new Set<string>()
  const lastNotify = new Map<string, number>()
  // El mismo mensaje llega por broadcast y por postgres_changes: se procesa (emite, no leído, aviso) una vez.
  const seen = new SeenIds()
  const topics = new Map<string, () => Promise<void>>()
  const failedTopics = new Set<string>()
  let broadcastWarned = false
  let extras = false
  let viaCol = false
  const typingThrottle = new Throttle()
  let purgeTimer: ReturnType<typeof setInterval> | undefined

  const cols = (): string => `${extras ? MSG_COLS_EXTRAS : MSG_COLS_BASE}${viaCol ? ', via' : ''}`

  const clientNow = (): SupabaseClient => {
    const c = core.client() as SupabaseClient | null
    if (!c) throw new Error('Iniciá sesión en el chat.')
    return c
  }
  const meNow = (): ChatProfile => {
    const m = core.me()
    if (!m) throw new Error('Iniciá sesión en el chat.')
    return m
  }
  const isFocused = (): boolean => {
    const w = ctx.window()
    return !!w && !w.isDestroyed() && w.isFocused()
  }

  // ---------- perfiles ----------

  function cacheProfile(p: ChatProfile): void {
    profiles.delete(p.id)
    profiles.set(p.id, p)
    while (profiles.size > PROFILE_CACHE_MAX) {
      const first = profiles.keys().next()
      if (first.done) break
      profiles.delete(first.value)
    }
  }

  const profileFor = (id: string): ChatProfile => profiles.get(id) ?? exMemberProfile(id)

  /** Carga en caché los perfiles que falten. Si falla, quedan como «ex-miembro»: no es fatal. */
  async function loadProfiles(c: SupabaseClient, ids: readonly string[]): Promise<void> {
    const missing = uniq(ids.filter((id) => !profiles.has(id)))
    if (missing.length === 0) return
    const res = await c.from('profiles').select('id, login, name, avatar_url').in('id', missing)
    if (res.error) return
    for (const row of (res.data ?? []) as unknown[]) {
      const p = profileFromRow(row)
      if (p) cacheProfile(p)
    }
  }

  /** El servidor tiene la 0004 si existen sus columnas y la tabla de reacciones. */
  async function detectExtras(c: SupabaseClient): Promise<void> {
    const [a, b, t] = await Promise.all([
      c.from('messages').select('id, edited_at, deleted_at, reply_to, kind').limit(1),
      c.from('message_reactions').select('message_id').limit(1),
      c.from('teams').select('id, retention_hours').limit(1)
    ])
    const errors: PgError[] = [a.error, b.error, t.error].filter((e) => e !== null)
    // Solo «no existe la columna o la tabla» dice que falta la 0004; un corte o un 5xx no cambia nada.
    if (errors.some((e) => !MISSING_SCHEMA.has(e.code ?? ''))) {
      throw new Error(`chat: no se pudo comprobar la 0004 (${errors.map((e) => e.code ?? '?').join(', ')})`)
    }
    const next = errors.length === 0
    if (next === extras) return
    extras = next
    onChange()
  }

  /** La 0005 va aparte de la 0004: solo un «no existe la columna» dice que falta; otro error no cambia nada. */
  async function detectVia(c: SupabaseClient): Promise<void> {
    const r = await c.from('messages').select('via').limit(1)
    if (r.error && !MISSING_SCHEMA.has(r.error.code ?? '')) {
      ctx.log('chat: no se pudo comprobar la actualización 0005:', r.error.code ?? '?')
      return
    }
    const next = !r.error
    if (next === viaCol) return
    viaCol = next
    onChange()
  }

  function checkVia(c: SupabaseClient, g: number): Promise<void> {
    return detectVia(c).catch((e: unknown) => {
      if (g === gen) ctx.log('chat: no se pudo comprobar la actualización 0005:', msgOf(e))
    })
  }

  /** Si el chequeo falla por la red, se queda con lo que sabía y reintenta; sin conexión, reintenta la reconexión. */
  function checkExtras(c: SupabaseClient, g: number): Promise<void> {
    return detectExtras(c).catch((e: unknown) => {
      ctx.log('chat: no se pudo comprobar la actualización 0004:', msgOf(e))
      setTimeout(() => {
        const cl = core.client() as SupabaseClient | null
        if (!cl || !running || g !== gen || connection !== 'live') return
        void checkExtras(cl, g).then(() => (g === gen ? refreshLists(true) : undefined))
      }, EXTRAS_RETRY_MS)
    })
  }

  /** Suma reacciones (si `withReactions`) y el mensaje al que responde cada uno. Sin la 0004 no hace nada. */
  async function enrich(c: SupabaseClient, rows: MessageRow[], msgs: ChatMessage[], withReactions = true): Promise<ChatMessage[]> {
    if (!extras || msgs.length === 0) return msgs
    const inPage = new Map(rows.map((r) => [s(r.id), r]))
    const missing = uniq(rows.map((r) => s(r.reply_to)).filter((id) => id !== '' && !inPage.has(id)))
    const [react, parents] = await Promise.all([
      withReactions ? c.from('message_reactions').select('message_id, user_id, emoji').in('message_id', msgs.map((m) => m.id)) : undefined,
      missing.length ? c.from('messages').select('id, author_id, body, deleted_at').in('id', missing) : undefined
    ])
    const reactionRows = react && !react.error ? ((react.data ?? []) as Array<{ message_id: unknown; user_id: unknown; emoji: unknown }>) : []
    const parentRows = parents && !parents.error ? ((parents.data ?? []) as Array<{ id: unknown; author_id: unknown; body: unknown; deleted_at?: unknown }>) : []
    for (const r of rows) {
      const p = inPage.get(s(r.reply_to))
      if (p) parentRows.push(p)
    }
    await loadProfiles(c, [...reactionRows.map((r) => s(r.user_id)), ...parentRows.map((r) => s(r.author_id))])
    const byMessage = reactionsByMessage(reactionRows, (id) => profileFor(id).login)
    const parentById = new Map(parentRows.map((r) => [s(r.id), r]))
    const replyOf = new Map(rows.map((r) => [s(r.id), s(r.reply_to)]))
    return msgs.map((m) => {
      const out = { ...m }
      const reactions = byMessage.get(m.id)
      if (reactions) out.reactions = reactions
      const parent = parentById.get(replyOf.get(m.id) ?? '')
      const ref = parent ? replyRefFrom(parent, profileFor(s(parent.author_id)).login) : undefined
      if (ref) out.replyTo = ref
      return out
    })
  }

  // ---------- fotos ----------

  function withPhoto(t: ChatTeam): ChatTeam {
    const path = teamPhotoPath.get(t.id)
    if (!path) return t
    const url = photos.get(path)
    if (url) return { ...t, photo: url }
    loadPhoto(path)
    return t
  }

  function loadPhoto(path: string): void {
    if (photoLoading.has(path) || photoFailed.has(path)) return
    const c = core.client() as SupabaseClient | null
    if (!c || !running) return
    photoLoading.add(path)
    const g = gen
    downloadTeamPhoto(c, path)
      .then((url) => {
        if (g === gen) photos.set(path, url)
      })
      .catch(() => {
        if (g === gen) photoFailed.add(path)
      })
      .finally(() => {
        photoLoading.delete(path)
        if (g === gen) onChange()
      })
  }

  /** Sube (o quita, con null) la foto de un equipo: valida antes, borra la anterior después. */
  async function applyPhoto(c: SupabaseClient, teamId: string, photo: Photo | null): Promise<void> {
    const cur = await c.from('teams').select('photo_path').eq('id', teamId).maybeSingle()
    check(cur, 'No se pudo leer la foto actual.')
    const oldPath = s(cur.data?.photo_path)
    const newPath = photo ? await uploadTeamPhoto(c, teamId, photo) : null
    const upd = await c.from('teams').update({ photo_path: newPath }).eq('id', teamId).select('id')
    if (upd.error || (upd.data ?? []).length === 0) {
      if (newPath) await removeTeamPhoto(c, newPath)
      throw new Error('No podés cambiar la foto de este equipo.')
    }
    if (oldPath && oldPath !== newPath) await removeTeamPhoto(c, oldPath)
  }

  // ---------- listas (equipos, DMs, invitaciones, no leídos) ----------

  async function loadLists(c: SupabaseClient, me: ChatProfile): Promise<{ lists: Lists; photoPaths: Map<string, string> }> {
    const meId = me.id
    const [mem, inv, thr, unr] = await Promise.all([
      c.from('team_members').select('team_id, role').eq('user_id', meId),
      c.from('team_invites').select('id, team_id, invited_by, created_at').eq('github_login_lower', me.login.toLowerCase()),
      c.from('dm_threads').select('id, user_a, user_b, last_read_a, last_read_b'),
      c.rpc('unread_counts')
    ])
    check(mem, 'No se pudieron leer tus equipos.')
    check(inv, 'No se pudieron leer las invitaciones.')
    check(thr, 'No se pudieron leer los mensajes directos.')
    check(unr, 'No se pudieron leer los no leídos.')

    const memberships = (mem.data ?? []) as Array<{ team_id: unknown; role: unknown }>
    const invites = (inv.data ?? []) as InviteRow[]
    const threadRows = (thr.data ?? []) as ThreadRow[]
    const memberTeamIds = uniq(memberships.map((m) => s(m.team_id)))
    const adminTeamIds = uniq(memberships.filter((m) => m.role === 'owner' || m.role === 'admin').map((m) => s(m.team_id)))
    const allTeamIds = uniq([...memberTeamIds, ...invites.map((i) => s(i.team_id))])

    const none = Promise.resolve({ data: [] as unknown[], error: null })
    const [teamsRes, countRes, codesRes] = await Promise.all([
      allTeamIds.length
        ? c.from('teams').select(extras ? 'id, name, description, photo_path, retention_hours' : 'id, name, description, photo_path').in('id', allTeamIds)
        : none,
      memberTeamIds.length ? c.from('team_members').select('team_id').in('team_id', memberTeamIds) : none,
      adminTeamIds.length ? c.from('team_invite_codes').select('team_id, code').in('team_id', adminTeamIds) : none
    ])
    check(teamsRes, 'No se pudieron leer los equipos.')
    check(countRes, 'No se pudieron leer los miembros.')
    check(codesRes, 'No se pudieron leer los códigos.')

    const teamRows = new Map<string, TeamRow>()
    for (const r of (teamsRes.data ?? []) as TeamRow[]) teamRows.set(s(r.id), r)
    const counts = new Map<string, number>()
    for (const r of (countRes.data ?? []) as Array<{ team_id: unknown }>) {
      const id = s(r.team_id)
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const codes = new Map<string, string>()
    for (const r of (codesRes.data ?? []) as Array<{ team_id: unknown; code: unknown }>) {
      if (typeof r.code === 'string') codes.set(s(r.team_id), r.code)
    }
    const unread = unreadIndex(unr.data ?? [])

    const others = threadRows.map((t) => otherOf(t, meId)).filter((x): x is string => !!x)
    await loadProfiles(c, [...others, ...invites.map((i) => s(i.invited_by))])

    const photoPaths = new Map<string, string>()
    const teams: ChatTeam[] = []
    for (const m of memberships) {
      const id = s(m.team_id)
      const row = teamRows.get(id)
      const role = roleOf(m.role)
      if (!row || !role) continue
      const u = unread.get(convKey({ kind: 'team', id }))
      const t = teamFromRow(row, {
        role,
        memberCount: counts.get(id) ?? 0,
        unread: u?.unread ?? 0,
        lastMessageAt: u?.lastMessageAt,
        inviteCode: codes.get(id)
      })
      if (!t) continue
      teams.push(t)
      const p = photoPathOf(row)
      if (p) photoPaths.set(id, p)
    }
    sortByActivity(teams, (t) => t.name)

    const threads: ChatThread[] = []
    for (const r of threadRows) {
      const other = otherOf(r, meId)
      if (!other) continue
      const u = unread.get(convKey({ kind: 'dm', id: s(r.id) }))
      const t = threadFromRow(r, profileFor(other), { unread: u?.unread ?? 0, lastMessageAt: u?.lastMessageAt, otherReadAt: otherReadAt(r, meId) })
      if (t) threads.push(t)
    }
    sortByActivity(threads, (t) => t.other.login)

    const invitesOut: ChatInvite[] = []
    for (const i of invites) {
      const tr = teamRows.get(s(i.team_id))
      if (!tr) continue
      const inviter = profiles.get(s(i.invited_by))
      const inv2 = inviteFromRow(i, s(tr.name), inviter)
      if (inv2) invitesOut.push(inv2)
    }

    return { lists: { teams, threads, invites: invitesOut }, photoPaths }
  }

  /** Recarga las listas. Se serializa; sin `force`, se salta si hubo un refresco hace menos de 30 s. */
  function refreshLists(force: boolean): Promise<void> {
    const g = gen
    const job = async (): Promise<void> => {
      if (g !== gen) return
      if (!force && now() - lastRefresh < REFRESH_MIN_MS) return
      const c = core.client() as SupabaseClient | null
      const me = core.me()
      if (!c || !me) return
      lastRefresh = now()
      cacheProfile(me)
      const r = await loadLists(c, me)
      if (g !== gen) return
      lists = r.lists
      listsLoaded = true
      syncTopics(g)
      teamPhotoPath.clear()
      for (const [k, v] of r.photoPaths) teamPhotoPath.set(k, v)
      photoFailed.clear()
      onChange()
    }
    refreshChain = refreshChain.then(job).catch(() => ctx.log('chat: no se pudieron cargar las listas.'))
    return refreshChain
  }

  const teamNow = (id: string): ChatTeam => {
    const t = lists.teams.find((x) => x.id === id)
    if (!t) throw new Error('No se pudo leer el equipo.')
    return withPhoto(t)
  }

  // ---------- no leídos ----------

  function unreadOf(ref: ChatConvRef): number {
    if (ref.kind === 'team') return lists.teams.find((t) => t.id === ref.id)?.unread ?? 0
    return lists.threads.find((t) => t.id === ref.id)?.unread ?? 0
  }

  function isKnown(ref: ChatConvRef): boolean {
    return ref.kind === 'team' ? lists.teams.some((t) => t.id === ref.id) : lists.threads.some((t) => t.id === ref.id)
  }

  function changeUnread(ref: ChatConvRef, f: (n: number) => number): void {
    lists = {
      ...lists,
      teams: ref.kind === 'team' ? lists.teams.map((t) => (t.id === ref.id ? { ...t, unread: f(t.unread) } : t)) : lists.teams,
      threads: ref.kind === 'dm' ? lists.threads.map((t) => (t.id === ref.id ? { ...t, unread: f(t.unread) } : t)) : lists.threads
    }
  }

  /** Marca leído en el servidor (RPC) y pone el no leído local en 0. */
  async function markReadRemote(ref: ChatConvRef): Promise<void> {
    const c = clientNow()
    const args = ref.kind === 'team' ? { p_team: ref.id } : { p_thread: ref.id }
    const res = await c.rpc('mark_read', args)
    check(res, 'No se pudo marcar como leído.')
    changeUnread(ref, () => 0)
    onChange()
  }

  const markReadQuiet = (ref: ChatConvRef): void => {
    markReadRemote(ref).catch(() => ctx.log('chat: no se pudo marcar como leído.'))
  }

  // ---------- realtime ----------

  function onStatus(g: number, st: string): void {
    if (g !== gen) return
    if (st === 'SUBSCRIBED') {
      connection = 'live'
      // Reconexión: las listas y los no leídos no vienen por realtime, se piden una vez. Los canales
      // rápidos que se cayeron con la conexión se vuelven a probar al recargar las listas.
      if (subscribedOnce) {
        failedTopics.clear()
        const cl = core.client() as SupabaseClient | null
        const check0 = cl ? Promise.all([checkExtras(cl, g), checkVia(cl, g)]) : Promise.resolve()
        void check0.then(() => (g === gen ? refreshLists(true) : undefined))
      }
      subscribedOnce = true
    } else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') {
      connection = 'retrying'
    } else {
      connection = 'connecting'
    }
    onChange()
  }

  function isRow(raw: unknown): raw is MessageRow {
    return isObj(raw) && typeof raw.id === 'string' && typeof raw.author_id === 'string' && typeof raw.body === 'string'
  }

  async function onInsertRow(g: number, raw: unknown): Promise<void> {
    if (g !== gen) return
    const me = core.me()
    const c = core.client() as SupabaseClient | null
    if (!isRow(raw) || !me || !c) return
    const conv = convOfRow(raw)
    if (!conv || !seen.first(versionKey(raw))) return
    const authorId = s(raw.author_id)
    await loadProfiles(c, [authorId])
    if (g !== gen) return
    const base = messageFromRow(raw, profileFor(authorId))
    if (!base) return
    const msg = (await enrich(c, [raw], [base], false))[0] ?? base
    if (g !== gen) return
    // Propio o ajeno: la UI reemplaza su «enviando…» por clientId, así que no se duplica.
    ctx.emit('message', msg)
    if (msg.notice) {
      if (msg.notice.kind === 'retention') await refreshLists(true)
      return
    }
    if (authorId === me.id) return

    const focused = isFocused()
    const viewing = view.open && !!view.conv && sameConv(view.conv, conv)
    if (focused && viewing) {
      // Lo está mirando: no suma no leído, pero el servidor tiene que saberlo.
      markReadQuiet(conv)
      return
    }
    if (!isKnown(conv)) {
      // Conversación nueva para esta app (DM o equipo recién creado): la trae el servidor con su no leído.
      await refreshLists(true)
      return
    }
    changeUnread(conv, (n) => Math.min(UNREAD_CAP, n + 1))
    onChange()
    // Avisos del sistema: con «notify.team» activo o si lo mencionan, y fuera de «No molestar». Misma regla que alerts.ts.
    const st = currentSettings()
    const mention = mentionsLogin(msg.body, me.login)
    if (!focused && (st.notify.team || mention) && !st.noMolestar) {
      void notify(conv, msg.author, msg.body, mention).catch(() => undefined)
    }
  }

  async function onUpdateRow(g: number, raw: unknown): Promise<void> {
    if (g !== gen) return
    const c = core.client() as SupabaseClient | null
    if (!isRow(raw) || !c) return
    if (!convOfRow(raw) || !seen.first(versionKey(raw))) return
    const authorId = s(raw.author_id)
    await loadProfiles(c, [authorId])
    if (g !== gen) return
    const base = messageFromRow(raw, profileFor(authorId))
    if (!base) return
    const msg = (await enrich(c, [raw], [base], false))[0] ?? base
    if (g !== gen) return
    ctx.emit('message', msg)
  }

  async function onReaction(g: number, conv: ChatConvRef, payload: unknown): Promise<void> {
    const ev = reactionFromBroadcast(payload)
    const c = core.client() as SupabaseClient | null
    if (g !== gen || !ev || !c || !core.me()) return
    await loadProfiles(c, [ev.userId])
    if (g !== gen) return
    ctx.emit('reaction', {
      conv,
      messageId: ev.messageId,
      emoji: ev.emoji,
      userId: ev.userId,
      login: profileFor(ev.userId).login,
      op: ev.op
    } satisfies ChatReactionEvent)
  }

  async function onTyping(g: number, conv: ChatConvRef, payload: unknown): Promise<void> {
    const ev = typingFromBroadcast(payload)
    const c = core.client() as SupabaseClient | null
    const me = core.me()
    if (g !== gen || !ev || !c || !me || ev.userId === me.id) return
    await loadProfiles(c, [ev.userId])
    if (g !== gen) return
    ctx.emit('typing', { conv, userId: ev.userId, login: profileFor(ev.userId).login } satisfies ChatTypingEvent)
  }

  function onRead(g: number, conv: ChatConvRef, payload: unknown): void {
    const ev = readFromBroadcast(payload)
    const me = core.me()
    if (g !== gen || !ev || !me || conv.kind !== 'dm' || ev.userId === me.id) return
    lists = { ...lists, threads: lists.threads.map((t) => (t.id === conv.id ? { ...t, otherReadAt: ev.at } : t)) }
    onChange()
    ctx.emit('read', { conv, userId: ev.userId, at: ev.at } satisfies ChatReadEvent)
  }

  function closeTopic(topic: string): void {
    const close = topics.get(topic)
    topics.delete(topic)
    if (close) close().catch(() => ctx.log('chat: no se pudo cerrar un canal rápido.'))
  }

  /** Abre o cierra los canales de Broadcast según las conversaciones conocidas. */
  function syncTopics(g: number): void {
    const c = core.client() as SupabaseClient | null
    if (!c || !running || g !== gen) return
    const wanted = wantedTopics(lists.teams, lists.threads).filter((t) => !failedTopics.has(t))
    const { add, remove } = diffTopics(topics.keys(), wanted)
    for (const t of remove) closeTopic(t)
    for (const t of add) {
      const conv = convOfTopic(t)
      if (!conv) continue
      topics.set(
        t,
        openTopic(
          c,
          t,
          {
            [BROADCAST_EVENT]: (payload) => {
              const row = rowFromBroadcast(payload, conv)
              if (row) onInsertRow(g, row).catch(() => ctx.log('chat: no se pudo procesar un mensaje nuevo.'))
            },
            [UPDATE_EVENT]: (payload) => {
              const row = rowFromBroadcast(payload, conv)
              if (row) onUpdateRow(g, row).catch(() => ctx.log('chat: no se pudo procesar un mensaje editado.'))
            },
            [REACTION_EVENT]: (payload) => {
              onReaction(g, conv, payload).catch(() => ctx.log('chat: no se pudo procesar una reacción.'))
            },
            [TYPING_EVENT]: (payload) => {
              onTyping(g, conv, payload).catch(() => ctx.log('chat: no se pudo procesar un aviso de escritura.'))
            },
            [READ_EVENT]: (payload) => onRead(g, conv, payload)
          },
          (st) => onTopicStatus(g, t, st)
        )
      )
    }
  }

  /**
   * Si un canal privado no entra (sin la migración 0003 la RLS lo rechaza) se cierra y esa conversación
   * sigue solo con «sloth-inbox». Sin aviso en la UI: el chat anda igual, un poco más lento.
   */
  function onTopicStatus(g: number, topic: string, st: string): void {
    if (g !== gen || (st !== 'CHANNEL_ERROR' && st !== 'TIMED_OUT')) return
    failedTopics.add(topic)
    closeTopic(topic)
    if (broadcastWarned) return
    broadcastWarned = true
    ctx.log('chat: el canal rápido (Broadcast) no está disponible; sigue con postgres_changes. ¿Falta aplicar 0003_realtime_broadcast.sql?')
  }

  /** Aviso del sistema para un mensaje ajeno con la ventana sin foco. Como mucho uno cada 5 s por conversación, o cada 2 s si mencionan al usuario. */
  async function notify(conv: ChatConvRef, author: ChatProfile, body: string, mention = false): Promise<void> {
    const t = now()
    const key = convKey(conv)
    const last = lastNotify.get(key)
    if (last !== undefined && t - last < (mention ? MENTION_MIN_MS : NOTIFY_MIN_MS)) return
    lastNotify.set(key, t)
    const w = ctx.window()
    if (!w || w.isDestroyed()) return
    const N = await loadNotifier().catch(() => undefined)
    if (!N || !N.isSupported()) return ctx.log('chat: el sistema no soporta notificaciones.')
    const where = conv.kind === 'team' ? (lists.teams.find((x) => x.id === conv.id)?.name ?? 'Equipo') : 'Mensaje directo'
    const title = mention ? `${author.login} te mencionó · ${where}` : `${author.login} · ${where}`
    const n = new N({ title, body: firstChars(body, NOTICE_CHARS), silent: false })
    n.on('click', () => {
      if (w.isDestroyed()) return
      w.show()
      w.focus()
      ctx.emit('open', conv)
    })
    n.on('failed', (_e, error) => ctx.log('chat: falló la notificación del sistema:', error))
    try {
      n.show()
    } catch (e) {
      ctx.log('chat: no se pudo mostrar la notificación del sistema:', e)
    }
  }

  // ---------- canales ----------

  ctx.onWindow((w) => {
    w.on('focus', () => {
      if (!running) return
      void refreshLists(false)
      if (view.open && view.conv && unreadOf(view.conv) > 0) markReadQuiet(view.conv)
    })
  })

  ctx.handle('setView', (raw: unknown): void => {
    view = parseView(raw)
    if (view.open && view.conv && isFocused() && unreadOf(view.conv) > 0) markReadQuiet(view.conv)
  })

  async function readMessages(ref: ChatConvRef, beforeId: string | undefined, limit: number): Promise<ChatMessage[]> {
    const c = clientNow()
    let q = c
      .from('messages')
      .select(cols())
      .eq(ref.kind === 'team' ? 'team_id' : 'thread_id', ref.id)
    if (beforeId !== undefined) {
      const b = await c.from('messages').select('created_at').eq('id', beforeId).maybeSingle()
      check(b, 'No se pudo leer la conversación.')
      if (!b.data) return []
      q = q.lt('created_at', b.data.created_at)
    }
    const res = await q.order('created_at', { ascending: false }).limit(limit)
    check(res, 'No se pudo leer la conversación.')
    const rows = (res.data ?? []) as unknown as MessageRow[]
    await loadProfiles(c, rows.map((r) => s(r.author_id)))
    const ordered = oldestFirst(rows)
    const msgs = ordered.map((r) => messageFromRow(r, profileFor(s(r.author_id)))).filter(isMsg)
    return enrich(c, ordered, msgs)
  }

  ctx.handle('messages', async (rawConv: unknown, rawBefore?: unknown, rawLimit?: unknown): Promise<ChatMessage[]> => {
    const ref = parseConvRef(rawConv)
    const limit = parseLimit(rawLimit)
    const beforeId = rawBefore !== undefined && rawBefore !== null ? parseUuid(rawBefore, 'Mensaje inválido.') : undefined
    return readMessages(ref, beforeId, limit)
  })

  async function sendMessage(ref: ChatConvRef, text: string, clientId: string, replyTo: string | undefined, via?: 'claude'): Promise<ChatMessage> {
    const c = clientNow()
    const me = meNow()
    const col = ref.kind === 'team' ? 'team_id' : 'thread_id'
    const useCol = via !== undefined && viaCol
    const body = via !== undefined && !viaCol ? [...(VIA_CLAUDE_PREFIX + text)].slice(0, CHAT_LIMITS.body).join('') : text
    const insert = (reply: string | undefined) =>
      c
        .from('messages')
        .insert({ [col]: ref.id, client_id: clientId, body, ...(extras && reply ? { reply_to: reply } : {}), ...(useCol ? { via } : {}) })
        .select(cols())
    let res = await insert(replyTo)
    // Si el citado se borró mientras tanto, el mensaje sale igual, sin la cita: si no, «Reintentar» fallaría siempre.
    if (res.error && replyTo && (res.error.code === '23503' || (res.error.code === 'P0001' && res.error.message === REPLY_GONE))) {
      res = await insert(undefined)
    }
    if (!res.error) {
      const row = (res.data as unknown as MessageRow[] | null)?.[0]
      const msg = row ? messageFromRow(row, me) : undefined
      if (!row || !msg) throw new Error('No se pudo enviar el mensaje.')
      return (await enrich(c, [row], [msg], false))[0] ?? msg
    }
    if (res.error.code === '23505') {
      // clientId repetido: es un reintento. Se devuelve el mensaje que ya estaba guardado.
      const ex = await c
        .from('messages')
        .select(cols())
        .eq('author_id', me.id)
        .eq('client_id', clientId)
        .eq(col, ref.id)
        .maybeSingle()
      const exRow = !ex.error && ex.data ? (ex.data as unknown as MessageRow) : undefined
      const msg = exRow ? messageFromRow(exRow, me) : undefined
      if (exRow && msg) return (await enrich(c, [exRow], [msg]))[0] ?? msg
      throw new Error('No se pudo enviar el mensaje.')
    }
    if (res.error.code === 'P0001' && res.error.message) throw new Error(res.error.message.slice(0, 300))
    if (res.error.code === '42501') throw new Error('No podés escribir en esta conversación.')
    throw new Error('No se pudo enviar el mensaje.')
  }

  ctx.handle('send', async (rawConv: unknown, rawBody: unknown, rawClientId: unknown, rawReplyTo?: unknown): Promise<ChatMessage> =>
    sendMessage(parseConvRef(rawConv), parseBody(rawBody), parseClientId(rawClientId), parseOptionalUuid(rawReplyTo))
  )

  async function changeOwn(rawConv: unknown, rawId: unknown, patch: Record<string, unknown>, denied: string): Promise<ChatMessage> {
    const c = clientNow()
    const me = meNow()
    const ref = parseConvRef(rawConv)
    const id = parseUuid(rawId, 'Mensaje inválido.')
    const res = await c
      .from('messages')
      .update(patch)
      .eq('id', id)
      .eq('author_id', me.id)
      .eq(ref.kind === 'team' ? 'team_id' : 'thread_id', ref.id)
      .select(cols())
    if (res.error?.code === '42501') throw new Error(denied)
    check(res, denied)
    const row = (res.data as unknown as MessageRow[] | null)?.[0]
    const msg = row ? messageFromRow(row, me) : undefined
    if (!row || !msg) throw new Error(denied)
    return (await enrich(c, [row], [msg]))[0] ?? msg
  }

  ctx.handle('edit', async (rawConv: unknown, rawId: unknown, rawBody: unknown): Promise<ChatMessage> => {
    if (!extras) throw new Error('Para editar, el servidor del chat necesita la actualización 0004.')
    return changeOwn(rawConv, rawId, { body: parseBody(rawBody) }, 'No podés editar ese mensaje.')
  })

  ctx.handle('remove', async (rawConv: unknown, rawId: unknown): Promise<ChatMessage> => {
    if (!extras) throw new Error('Para borrar, el servidor del chat necesita la actualización 0004.')
    return changeOwn(rawConv, rawId, { deleted_at: new Date().toISOString() }, 'No podés borrar ese mensaje.')
  })

  ctx.handle('react', async (rawConv: unknown, rawId: unknown, rawEmoji: unknown, rawOn: unknown): Promise<void> => {
    if (!extras) throw new Error('Para reaccionar, el servidor del chat necesita la actualización 0004.')
    const c = clientNow()
    const me = meNow()
    parseConvRef(rawConv)
    const messageId = parseUuid(rawId, 'Mensaje inválido.')
    const emoji = parseEmoji(rawEmoji)
    if (typeof rawOn !== 'boolean') throw new Error('Reacción inválida.')
    const res = rawOn
      ? await c.from('message_reactions').insert({ message_id: messageId, emoji })
      : await c.from('message_reactions').delete().eq('message_id', messageId).eq('user_id', me.id).eq('emoji', emoji)
    if (res.error?.code === '23505') return
    if (res.error?.code === '42501') throw new Error('No podés reaccionar a ese mensaje.')
    check(res, 'No se pudo guardar la reacción.')
  })

  ctx.handle('search', async (rawConv: unknown, rawQuery: unknown): Promise<ChatMessage[]> => {
    const c = clientNow()
    const ref = parseConvRef(rawConv)
    const q = parseSearch(rawQuery)
    let query = c
      .from('messages')
      .select(cols())
      .eq(ref.kind === 'team' ? 'team_id' : 'thread_id', ref.id)
      .ilike('body', `%${escapeLike(q)}%`)
    if (extras) query = query.is('deleted_at', null).eq('kind', 'text')
    const res = await query.order('created_at', { ascending: false }).limit(50)
    check(res, 'No se pudo buscar.')
    const all = (res.data ?? []) as unknown as MessageRow[]
    const rows = q.includes('*') ? all.filter((r) => containsText(s(r.body), q)) : all
    await loadProfiles(c, rows.map((r) => s(r.author_id)))
    const msgs = rows.map((r) => messageFromRow(r, profileFor(s(r.author_id)))).filter(isMsg)
    return enrich(c, rows, msgs)
  })

  ctx.handle('typing', async (rawConv: unknown): Promise<void> => {
    if (!extras) return
    const c = clientNow()
    const ref = parseConvRef(rawConv)
    if (!typingThrottle.ok(convKey(ref), now())) return
    const res = await c.rpc('chat_typing', ref.kind === 'team' ? { p_team: ref.id } : { p_thread: ref.id })
    if (res.error) ctx.log('chat: no se pudo avisar que estás escribiendo.')
  })

  ctx.handle('clear', async (rawConv: unknown): Promise<void> => {
    if (!extras) throw new Error('Para vaciar, el servidor del chat necesita la actualización 0004.')
    const c = clientNow()
    const ref = parseConvRef(rawConv)
    const role = ref.kind === 'team' ? lists.teams.find((t) => t.id === ref.id)?.role : undefined
    if (!canManageConv(ref.kind, role)) throw new Error('Solo owner o admin pueden vaciar la conversación del equipo.')
    const res = await c.rpc('chat_clear', ref.kind === 'team' ? { p_team: ref.id } : { p_thread: ref.id })
    check(res, 'No se pudo vaciar la conversación.')
  })

  ctx.handle('setRetention', async (rawTeam: unknown, rawHours: unknown): Promise<ChatTeam> => {
    if (!extras) throw new Error('Para el borrado automático, el servidor del chat necesita la actualización 0004.')
    const c = clientNow()
    const teamId = parseUuid(rawTeam, 'Equipo inválido.')
    const hours = parseRetention(rawHours)
    const res = await c.rpc('chat_set_retention', { p_team: teamId, p_hours: hours })
    check(res, 'No se pudo cambiar el borrado automático.')
    await refreshLists(true)
    purgeExpired(c)
    return teamNow(teamId)
  })

  /** Borra de verdad lo vencido; la RLS ya lo oculta, así que si falla no se nota en la UI. */
  function purgeExpired(c: SupabaseClient): void {
    if (!extras) return
    const fail = (why: unknown): void => ctx.log('chat: no se pudo purgar los mensajes vencidos:', why)
    c.rpc('chat_purge_expired').then(
      (res) => (res.error ? fail(`${res.error.code ?? '?'} ${res.error.message ?? ''}`.trim()) : undefined),
      fail
    )
  }

  ctx.handle('markRead', async (rawConv: unknown): Promise<void> => {
    clientNow()
    await markReadRemote(parseConvRef(rawConv))
  })

  ctx.handle('createTeam', async (raw: unknown): Promise<ChatTeam> => {
    const c = clientNow()
    const f = parseTeamFields(raw, 'create')
    const photo = typeof f.photoBase64 === 'string' ? decodePhotoBase64(f.photoBase64) : null
    const rpc = await c.rpc('create_team', { p_name: f.name, p_description: f.description ?? '' })
    check(rpc, 'No se pudo crear el equipo.')
    const teamId = s(rpc.data)
    if (!teamId) throw new Error('No se pudo crear el equipo.')
    let photoErr: unknown
    if (photo) {
      try {
        await applyPhoto(c, teamId, photo)
      } catch (e) {
        photoErr = e
      }
    }
    await refreshLists(true)
    if (photoErr) throw new Error(`El equipo se creó, pero la foto no se guardó: ${msgOf(photoErr)}`)
    return teamNow(teamId)
  })

  ctx.handle('updateTeam', async (rawId: unknown, raw: unknown): Promise<ChatTeam> => {
    const c = clientNow()
    const teamId = parseUuid(rawId, 'Equipo inválido.')
    const f = parseTeamFields(raw, 'update')
    // Primero se valida la foto (sin tocar nada), después el texto y al final la foto.
    const photo = f.photoBase64 === undefined ? undefined : f.photoBase64 === null ? null : decodePhotoBase64(f.photoBase64)
    const patch: Record<string, unknown> = {}
    if (f.name !== undefined) patch.name = f.name
    if (f.description !== undefined) patch.description = f.description
    if (Object.keys(patch).length > 0) {
      const r = await c.from('teams').update(patch).eq('id', teamId).select('id')
      check(r, 'No podés editar este equipo.')
      if ((r.data ?? []).length === 0) throw new Error('No podés editar este equipo.')
    }
    if (photo !== undefined) await applyPhoto(c, teamId, photo)
    await refreshLists(true)
    return teamNow(teamId)
  })

  ctx.handle('members', async (rawTeam: unknown): Promise<ChatMember[]> => {
    const c = clientNow()
    const teamId = parseUuid(rawTeam, 'Equipo inválido.')
    const res = await c.from('team_members').select('user_id, role, joined_at').eq('team_id', teamId)
    check(res, 'No se pudo leer los miembros.')
    const rows = (res.data ?? []) as Array<{ user_id: unknown; role: unknown; joined_at: unknown }>
    await loadProfiles(c, rows.map((r) => s(r.user_id)))
    const out: ChatMember[] = []
    for (const r of rows) {
      const m = memberFromRow(r, profileFor(s(r.user_id)))
      if (m) out.push(m)
    }
    return out.sort(compareMembers)
  })

  ctx.handle('inviteByLogin', async (rawTeam: unknown, rawLogin: unknown): Promise<ChatInviteSent> => {
    const c = clientNow()
    const teamId = parseUuid(rawTeam, 'Equipo inválido.')
    const login = parseLogin(rawLogin)
    const r = await c.from('team_invites').insert({ team_id: teamId, github_login_lower: login }).select('id, github_login_lower')
    if (r.error?.code === '23505') throw new Error('Ya invitaste a esa persona.')
    if (r.error?.code === '42501') throw new Error('Solo owner o admin pueden invitar.')
    check(r, 'No se pudo invitar.')
    const id = s(((r.data ?? []) as Array<{ id: unknown }>)[0]?.id)
    if (!id) throw new Error('No se pudo invitar.')
    return { id, githubLogin: login }
  })

  ctx.handle('regenerateCode', async (rawTeam: unknown): Promise<string> => {
    const c = clientNow()
    const teamId = parseUuid(rawTeam, 'Equipo inválido.')
    const r = await c.rpc('regenerate_invite_code', { p_team: teamId })
    check(r, 'No se pudo cambiar el código.')
    if (typeof r.data !== 'string' || !/^[0-9a-f]{16}$/.test(r.data)) throw new Error('No se pudo cambiar el código.')
    return r.data
  })

  const joinByCode = async (rawCode: unknown): Promise<ChatTeam> => {
    const c = clientNow()
    const code = parseInviteCode(rawCode)
    const r = await c.rpc('join_team_by_code', { p_code: code })
    check(r, 'No se pudo entrar al equipo.')
    const teamId = s(r.data)
    if (!teamId) throw new Error('No se pudo entrar al equipo.')
    await refreshLists(true)
    return teamNow(teamId)
  }

  ctx.handle('joinByCode', joinByCode)

  ctx.handle('acceptInvite', async (rawInvite: unknown): Promise<ChatTeam> => {
    const c = clientNow()
    const inviteId = parseUuid(rawInvite, 'Invitación inválida.')
    const r = await c.rpc('accept_invite', { p_invite: inviteId })
    check(r, 'No se pudo aceptar la invitación.')
    const teamId = s(r.data)
    if (!teamId) throw new Error('No se pudo aceptar la invitación.')
    await refreshLists(true)
    return teamNow(teamId)
  })

  ctx.handle('declineInvite', async (rawInvite: unknown): Promise<void> => {
    const c = clientNow()
    const inviteId = parseUuid(rawInvite, 'Invitación inválida.')
    const r = await c.from('team_invites').delete().eq('id', inviteId).select('id')
    check(r, 'No se pudo rechazar la invitación.')
    if ((r.data ?? []).length === 0) throw new Error('Esa invitación ya no existe.')
    await refreshLists(true)
  })

  ctx.handle('leaveTeam', async (rawTeam: unknown): Promise<void> => {
    const c = clientNow()
    const me = meNow()
    const teamId = parseUuid(rawTeam, 'Equipo inválido.')
    if (lists.teams.find((t) => t.id === teamId)?.role === 'owner') throw new Error('El owner no puede salir del equipo.')
    const r = await c.from('team_members').delete().eq('team_id', teamId).eq('user_id', me.id).select('user_id')
    check(r, 'No se pudo salir del equipo.')
    if ((r.data ?? []).length === 0) throw new Error('El owner no puede salir del equipo.')
    await refreshLists(true)
  })

  // remove_member (0007) saca a la persona y cambia el código en una sola transacción. Sin la 0007, como antes y el código aparte.
  ctx.handle('removeMember', async (rawTeam: unknown, rawUser: unknown): Promise<ChatRemoveResult> => {
    const c = clientNow()
    const me = meNow()
    const teamId = parseUuid(rawTeam, 'Equipo inválido.')
    const userId = parseUuid(rawUser, 'Persona inválida.')
    if (userId === me.id) throw new Error('Para salir usá «Salir del equipo».')
    const rpc = await c.rpc('remove_member', { p_team: teamId, p_user: userId })
    if (!faltaLaFuncion(rpc.error)) {
      check(rpc, 'No podés sacar a esa persona.')
      await refreshLists(true)
      return resultadoExpulsar({ conRpc: true, codigoNuevo: true })
    }
    ctx.log('chat: el servidor no tiene remove_member (falta la migración 0007).')
    const r = await c.from('team_members').delete().eq('team_id', teamId).eq('user_id', userId).eq('role', 'member').select('user_id')
    check(r, 'No podés sacar a esa persona.')
    if ((r.data ?? []).length === 0) throw new Error('No podés sacar a esa persona.')
    const regen = await c.rpc('regenerate_invite_code', { p_team: teamId })
    if (regen.error) ctx.log('chat: no se pudo cambiar el código después de expulsar:', regen.error.message ?? regen.error.code ?? '')
    await refreshLists(true)
    return resultadoExpulsar({ conRpc: false, codigoNuevo: !regen.error })
  })

  ctx.handle('openDm', async (rawUser: unknown): Promise<ChatThread> => {
    const c = clientNow()
    const me = meNow()
    const userId = parseUuid(rawUser, 'Persona inválida.')
    if (userId === me.id) throw new Error('Elegí a otra persona.')
    const r = await c.rpc('open_dm', { p_other: userId })
    check(r, 'No se pudo abrir el mensaje directo.')
    const threadId = s(r.data)
    if (!threadId) throw new Error('No se pudo abrir el mensaje directo.')
    await refreshLists(true)
    const t = lists.threads.find((x) => x.id === threadId)
    if (!t) throw new Error('No se pudo abrir el mensaje directo.')
    return t
  })

  // ---------- ciclo de vida ----------

  return {
    part: (): ChatDataPart => {
      const teams = lists.teams.map(withPhoto)
      const unreadTotal = teams.reduce((n, t) => n + t.unread, 0) + lists.threads.reduce((n, t) => n + t.unread, 0)
      return { connection, teams, threads: lists.threads, invites: lists.invites, unreadTotal, extras, listsLoaded }
    },

    start: async (): Promise<void> => {
      const c = core.client() as SupabaseClient | null
      if (!c || running) return
      running = true
      const g = ++gen
      connection = 'connecting'
      subscribedOnce = false
      closeInbox = openInbox(c, {
        onInsert: (raw) => {
          onInsertRow(g, raw).catch(() => ctx.log('chat: no se pudo procesar un mensaje nuevo.'))
        },
        onUpdate: (raw) => {
          onUpdateRow(g, raw).catch(() => ctx.log('chat: no se pudo procesar un mensaje editado.'))
        },
        onStatus: (st) => onStatus(g, st)
      })
      onChange()
      await Promise.all([checkExtras(c, g), checkVia(c, g)])
      await refreshLists(true)
      if (g !== gen) return
      purgeExpired(c)
      purgeTimer = setInterval(() => {
        const cl = core.client() as SupabaseClient | null
        if (cl && running && g === gen) purgeExpired(cl)
      }, PURGE_EVERY_MS)
    },

    stop: async (): Promise<void> => {
      gen++
      running = false
      if (purgeTimer) clearInterval(purgeTimer)
      purgeTimer = undefined
      connection = 'off'
      lists = EMPTY_LISTS
      listsLoaded = false
      view = { open: false }
      subscribedOnce = false
      lastRefresh = 0
      teamPhotoPath.clear()
      photos.clear()
      photoLoading.clear()
      photoFailed.clear()
      profiles.clear()
      lastNotify.clear()
      seen.clear()
      failedTopics.clear()
      broadcastWarned = false
      extras = false
      viaCol = false
      typingThrottle.clear()
      // removeAllChannels (al cerrar «sloth-inbox») cierra también los canales rápidos.
      topics.clear()
      const close = closeInbox
      closeInbox = undefined
      if (close) await close().catch(() => undefined)
    },

    joinByCode,

    conversaciones: (): ConvCandidata[] => {
      if (!listsLoaded) throw new Error('Abrí el chat de Sloth para cargar las conversaciones.')
      return [
        ...lists.teams.map((t): ConvCandidata => ({ conv: { kind: 'team', id: t.id }, nombre: t.name, tipo: 'equipo' })),
        ...lists.threads.map((t): ConvCandidata => ({ conv: { kind: 'dm', id: t.id }, nombre: t.other.login, tipo: 'directo' }))
      ]
    },

    leerUltimos: (conv: ChatConvRef, n: number): Promise<ChatMessage[]> => readMessages(conv, undefined, n),

    enviarViaClaude: (conv: ChatConvRef, texto: string): Promise<ChatMessage> => sendMessage(conv, texto, randomUUID(), undefined, 'claude'),

    viaColumn: (): boolean => viaCol
  }
}
