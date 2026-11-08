import type { SupabaseClient } from '@supabase/supabase-js'
import type { FeatureContext } from './context'
import {
  type ChatAuth,
  type ChatConnection,
  type ChatInvite,
  type ChatInviteSent,
  type ChatMember,
  type ChatProfile,
  type ChatSnapshot,
  type ChatTeam,
  type ChatThread,
  type ChatRole
} from '../../shared/chat'
import {
  channelFromRow,
  compareMembers,
  exMemberProfile,
  filesByMessage,
  firstChars,
  inviteFromRow,
  isObj,
  memberFromRow,
  messageFromRow,
  MSG_COLS,
  oldestFirst,
  type ChatViewV2,
  otherOf,
  parseBody,
  parseBool,
  parseClientId,
  parseConv,
  parseChannelInput,
  parseFileUpload,
  parseInviteCode,
  parseLimit,
  parseLogin,
  parseProfilePatch,
  parseReaction,
  parseSendInput,
  parseTeamFields,
  parseUuid,
  parseViewV2,
  personFromRow,
  photoPathOf,
  profileOfPerson,
  quoteFromRow,
  reactionsByMessage,
  roleOf,
  sameConv,
  sortByActivity,
  teamFromRow,
  teamPersonOf,
  threadFromRow,
  unreadIndex,
  messageKindOf,
  cardToRow,
  type InviteRow,
  type MessageRow,
  type PersonRow,
  type TeamRow,
  type ThreadRow,
  type ChannelRow,
  type UnreadInfo,

} from './chat-map'
import type {
  ChatChannel,
  ChatConv,
  ChatFile,
  ChatMessageFull,
  ChatPerson,
  ChatPresence,
  ChatPresenceEvent,
  ChatReactionKind,
  ChatReadMark,
  ChatReaction,
  ChatTeamPerson,
  ChatTypingEvent,
  ChatNoticeEvent,
  ChatFileRef,
} from './chat-model'
import { CHAT_LIMITS_V2 } from './chat-model'
import { chatEvents } from './chat-events'
import { decodePhotoBase64, downloadProfilePhoto, downloadTeamPhoto, PhotoCache, removeProfilePhoto, removeTeamPhoto, uploadProfilePhoto, uploadTeamPhoto, type Photo } from './chat-photos'
import { downloadChatFile, removeChatFiles, uploadChatFile } from './chat-files'
import { dmTopic, openInbox, openTeamRealtime, teamTopic, type TeamRealtime, type TopicSpec } from './chat-realtime'

/**
 * Datos del chat (equipos, canales, DMs, mensajes, hilos, reacciones, adjuntos, perfiles, lecturas,
 * presencia). Contrato entre chat.ts (config + login) y este archivo.
 *
 * Reglas: todo Supabase corre en main; una sola conexión de cambios (canal «sloth-inbox») mientras hay
 * sesión y ventana, más canales privados de presencia por equipo; sin timers (salvo el reintento de
 * realtime-js). Las listas se refrescan al arrancar, al reconectar y al enfocar la ventana (mínimo 30 s).
 * Nunca se loguea el cuerpo de un mensaje ni un token.
 *
 * Eventos a la interfaz (feat:chat:<evento>): snapshot, message (nuevo o propio), messageChanged
 * (edición, borrado, fijado, reacciones, contadores), presence, typing, open.
 * Evento INTERNO de main: chatEvents «message» (ver chat-events.ts).
 */

/** Lo que chat.ts (config + login) le da a la parte de datos. */
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
  /** chat.ts lo llama al quedar con sesión y ventana: carga listas y abre las conexiones. */
  start(): Promise<void>
  /** Al cerrar sesión, cambiar de config o cerrarse la ventana: cierra realtime y vacía cachés en memoria. */
  stop(): Promise<void>
}

export const EMPTY_PART: ChatDataPart = { connection: 'off', teams: [], threads: [], invites: [], unreadTotal: 0 }

/** Dependencias inyectables (las pruebas no cargan Electron). */
export interface ChatDataDeps {
  now?: () => number
}

const REFRESH_MIN_MS = 30_000
const TYPING_MIN_MS = 2_000
const PROFILE_CACHE_MAX = 500
const PHOTO_CACHE_MAX = 50
const UNREAD_CAP = 99
const NOTICE_CHARS = 120

const PROFILE_SELECT = 'id, login, name, avatar_url, handle, display_name, color, photo_path, presence, status_text, status_until, role_title, timezone'


type Lists = { teams: ChatTeam[]; threads: ChatThread[]; invites: ChatInvite[]; channels: ChatChannel[] }
const EMPTY_LISTS: Lists = { teams: [], threads: [], invites: [], channels: [] }

type PgError = { code?: string; message?: string }

/** Error de PostgREST → mensaje para mostrar. Solo pasan los RAISE de nuestras funciones (P0001). */
function check(res: { error: PgError | null }, fallback: string): void {
  if (!res.error) return
  const e = res.error
  throw new Error(e.code === 'P0001' && e.message ? e.message.slice(0, 300) : fallback)
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const uniq = (a: string[]): string[] => [...new Set(a)].filter((x) => x !== '')
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : 'Algo salió mal.')
const isMsg = (m: ChatMessageFull | undefined): m is ChatMessageFull => m !== undefined
const isRow = (raw: unknown): raw is MessageRow => isObj(raw) && typeof raw.id === 'string' && typeof raw.author_id === 'string'
const convKeyOf = (kind: string, id: string): string => `${kind}:${id}`

export function registerChatData(ctx: FeatureContext, core: ChatCoreHandle, onChange: () => void, deps: ChatDataDeps = {}): ChatData {
  const now = deps.now ?? Date.now

  let gen = 0
  let running = false
  let connection: ChatConnection = 'off'
  let lists: Lists = EMPTY_LISTS
  let view: ChatViewV2 = { open: false }
  let closeInbox: (() => Promise<void>) | undefined
  let rt: TeamRealtime | undefined
  let subscribedOnce = false
  let lastRefresh = 0
  let refreshChain: Promise<void> = Promise.resolve()
  const unreadMap = new Map<string, UnreadInfo>()
  const persons = new Map<string, PersonRow>()
  const presence = new Map<string, Map<string, ChatPresence>>()
  const teamPhotoPath = new Map<string, string>()
  const teamPhotos = new PhotoCache(PHOTO_CACHE_MAX)
  const teamPhotoLoading = new Set<string>()
  const teamPhotoFailed = new Set<string>()
  const profilePhotos = new PhotoCache(PHOTO_CACHE_MAX)
  const profilePhotoLoading = new Set<string>()
  const profilePhotoFailed = new Set<string>()
  const lastTyping = new Map<string, number>()

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

  // ---------- personas y perfiles ----------

  function cachePerson(p: PersonRow): void {
    persons.delete(p.person.id)
    persons.set(p.person.id, p)
    while (persons.size > PROFILE_CACHE_MAX) {
      const first = persons.keys().next()
      if (first.done) break
      persons.delete(first.value)
    }
  }

  const personRowOf = (id: string): PersonRow =>
    persons.get(id) ?? { person: { id, login: 'ex-miembro', handle: 'ex-miembro', color: 'gris', presence: 'invisible', timezone: 'America/Argentina/Buenos_Aires' } }

  const profileFor = (id: string): ChatProfile => {
    const p = persons.get(id)
    return p ? profileOfPerson(p.person) : exMemberProfile(id)
  }

  /** Persona para la UI: con su foto si ya está bajada (si no, la baja y avisa con onChange). */
  function personOut(id: string): ChatPerson {
    const r = personRowOf(id)
    if (!r.photoPath) return r.person
    const url = profilePhotos.get(r.photoPath)
    if (url) return { ...r.person, photo: url }
    loadProfilePhoto(r.photoPath)
    return r.person
  }

  function loadProfilePhoto(path: string): void {
    if (profilePhotoLoading.has(path) || profilePhotoFailed.has(path)) return
    const c = core.client() as SupabaseClient | null
    if (!c || !running) return
    profilePhotoLoading.add(path)
    const g = gen
    downloadProfilePhoto(c, path)
      .then((url) => {
        if (g === gen) profilePhotos.set(path, url)
      })
      .catch(() => {
        if (g === gen) profilePhotoFailed.add(path)
      })
      .finally(() => {
        profilePhotoLoading.delete(path)
        if (g === gen) onChange()
      })
  }

  /** Carga en caché los perfiles que falten (o todos, con force). Si falla, quedan como «ex-miembro». */
  async function loadProfiles(c: SupabaseClient, ids: readonly string[], force = false): Promise<void> {
    const missing = uniq(ids.filter((id) => force || !persons.has(id)))
    if (missing.length === 0) return
    const res = await c.from('profiles').select(PROFILE_SELECT).in('id', missing)
    if (res.error) return
    for (const row of (res.data ?? []) as unknown[]) {
      const p = personFromRow(row)
      if (p) cachePerson(p)
    }
  }

  // ---------- fotos de equipo ----------

  function withPhoto(t: ChatTeam): ChatTeam {
    const path = teamPhotoPath.get(t.id)
    if (!path) return t
    const url = teamPhotos.get(path)
    if (url) return { ...t, photo: url }
    loadPhoto(path)
    return t
  }

  function loadPhoto(path: string): void {
    if (teamPhotoLoading.has(path) || teamPhotoFailed.has(path)) return
    const c = core.client() as SupabaseClient | null
    if (!c || !running) return
    teamPhotoLoading.add(path)
    const g = gen
    downloadTeamPhoto(c, path)
      .then((url) => {
        if (g === gen) teamPhotos.set(path, url)
      })
      .catch(() => {
        if (g === gen) teamPhotoFailed.add(path)
      })
      .finally(() => {
        teamPhotoLoading.delete(path)
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

  // ---------- listas (equipos, canales, DMs, invitaciones, no leídos) ----------

  async function loadLists(c: SupabaseClient, me: ChatProfile): Promise<{ lists: Lists; photoPaths: Map<string, string>; unread: Map<string, UnreadInfo> }> {
    const meId = me.id
    const [mem, inv, thr, unr] = await Promise.all([
      c.from('team_members').select('team_id, role').eq('user_id', meId),
      c.from('team_invites').select('id, team_id, invited_by, created_at').eq('github_login_lower', me.login.toLowerCase()),
      c.from('dm_threads').select('id, user_a, user_b, created_at'),
      c.rpc('chat_unread')
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
    const [teamsRes, countRes, codesRes, chanRes] = await Promise.all([
      allTeamIds.length ? c.from('teams').select('id, name, description, photo_path').in('id', allTeamIds) : none,
      memberTeamIds.length ? c.from('team_members').select('team_id').in('team_id', memberTeamIds) : none,
      adminTeamIds.length ? c.from('team_invite_codes').select('team_id, code').in('team_id', adminTeamIds) : none,
      memberTeamIds.length
        ? c.from('team_channels').select('id, team_id, name, topic, description, is_default, created_at').in('team_id', memberTeamIds)
        : none
    ])
    check(teamsRes, 'No se pudieron leer los equipos.')
    check(countRes, 'No se pudieron leer los miembros.')
    check(codesRes, 'No se pudieron leer los códigos.')
    check(chanRes, 'No se pudieron leer los canales.')

    const others = threadRows.map((t) => otherOf(t, meId)).filter((x): x is string => !!x)
    await loadProfiles(c, [meId, ...others, ...invites.map((i) => s(i.invited_by))], true)

    const unread = unreadIndex(unr.data ?? [])
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

    const channels: ChatChannel[] = []
    for (const r of (chanRes.data ?? []) as ChannelRow[]) {
      const id = s(r.id)
      const u = unread.get(convKeyOf('channel', id))
      const ch = channelFromRow(r, { unread: u?.unread ?? 0, muted: u?.muted ?? false, lastMessageAt: u?.lastMessageAt })
      if (ch) channels.push(ch)
    }

    const photoPaths = new Map<string, string>()
    const teams: ChatTeam[] = []
    for (const m of memberships) {
      const id = s(m.team_id)
      const row = teamRows.get(id)
      const role = roleOf(m.role)
      if (!row || !role) continue
      const chs = channels.filter((ch) => ch.teamId === id)
      const last = chs.reduce<number | undefined>((acc, ch) => (ch.lastMessageAt !== undefined && (acc === undefined || ch.lastMessageAt > acc) ? ch.lastMessageAt : acc), undefined)
      const t = teamFromRow(row, {
        role,
        memberCount: counts.get(id) ?? 0,
        unread: 0,
        lastMessageAt: last,
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
      const u = unread.get(convKeyOf('dm', s(r.id)))
      const t = threadFromRow(r, profileFor(other), { unread: u?.unread ?? 0, lastMessageAt: u?.lastMessageAt })
      if (t) threads.push(t)
    }
    sortByActivity(threads, (t) => t.other.login)

    const invitesOut: ChatInvite[] = []
    for (const i of invites) {
      const tr = teamRows.get(s(i.team_id))
      if (!tr) continue
      const inviter = persons.get(s(i.invited_by))
      const inv2 = inviteFromRow(i, s(tr.name), inviter ? profileOfPerson(inviter.person) : undefined)
      if (inv2) invitesOut.push(inv2)
    }

    return { lists: { teams, threads, invites: invitesOut, channels }, photoPaths, unread }
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
      const r = await loadLists(c, me)
      if (g !== gen) return
      lists = r.lists
      unreadMap.clear()
      for (const [k, v] of r.unread) unreadMap.set(k, v)
      teamPhotoPath.clear()
      for (const [k, v] of r.photoPaths) teamPhotoPath.set(k, v)
      teamPhotoFailed.clear()
      syncRealtime()
      onChange()
    }
    refreshChain = refreshChain.then(job).catch(() => ctx.log('chat: no se pudieron cargar las listas.'))
    return refreshChain
  }

  const teamOf = (id: string): ChatTeam | undefined => lists.teams.find((x) => x.id === id)

  /** Equipo para la UI: unread = suma de sus canales (sin silenciados). */
  function teamOut(t: ChatTeam): ChatTeam {
    const unread = lists.channels
      .filter((c) => c.teamId === t.id)
      .reduce((n, c) => n + (unreadMap.get(convKeyOf('channel', c.id))?.unread ?? 0), 0)
    return withPhoto({ ...t, unread })
  }

  /** Canal para la UI con sus no leídos y silencio. */
  function channelOut(c: ChatChannel): ChatChannel {
    const u = unreadMap.get(convKeyOf('channel', c.id))
    return { ...c, unread: u?.unread ?? 0, muted: u?.muted ?? false, ...(u?.lastMessageAt !== undefined ? { lastMessageAt: u.lastMessageAt } : {}) }
  }

  function threadOut(t: ChatThread): ChatThread {
    const u = unreadMap.get(convKeyOf('dm', t.id))
    return { ...t, unread: u?.unread ?? 0 }
  }

  /** Clave de la conversación para mapas internos. «team» (0.5) pasa al canal general. */
  function keyOf(conv: ChatConv): string | undefined {
    if (conv.kind === 'dm') return convKeyOf('dm', conv.id)
    if (conv.kind === 'channel') return convKeyOf('channel', conv.id)
    const general = lists.channels.find((c) => c.teamId === conv.id && c.isDefault)
    return general ? convKeyOf('channel', general.id) : undefined
  }

  /** Resuelve «team» (0.5) al canal general; si todavía no hay canales en memoria, recarga una vez. */
  async function resolveConv(conv: ChatConv): Promise<{ kind: 'channel' | 'dm'; id: string; teamId?: string }> {
    if (conv.kind === 'dm') return { kind: 'dm', id: conv.id }
    if (conv.kind === 'channel') {
      const ch = lists.channels.find((c) => c.id === conv.id)
      if (!ch) await refreshLists(true)
      const again = lists.channels.find((c) => c.id === conv.id)
      if (!again) throw new Error('Ese canal no existe o ya no lo ves.')
      return { kind: 'channel', id: again.id, teamId: again.teamId }
    }
    let general = lists.channels.find((c) => c.teamId === conv.id && c.isDefault)
    if (!general) {
      await refreshLists(true)
      general = lists.channels.find((c) => c.teamId === conv.id && c.isDefault)
    }
    if (!general) throw new Error('No se encontró el canal del equipo.')
    return { kind: 'channel', id: general.id, teamId: general.teamId }
  }

  /** Columna y valor para filtrar mensajes de una conversación ya resuelta. */
  const convFilter = (r: { kind: 'channel' | 'dm'; id: string }): { col: 'channel_id' | 'thread_id'; id: string } =>
    r.kind === 'channel' ? { col: 'channel_id', id: r.id } : { col: 'thread_id', id: r.id }

  // ---------- no leídos ----------

  function bumpUnread(key: string): void {
    const cur = unreadMap.get(key) ?? { unread: 0, muted: false }
    unreadMap.set(key, { ...cur, unread: Math.min(UNREAD_CAP, cur.unread + 1), lastMessageAt: now() })
  }

  /** Marca leído en el servidor (RPC) y pone el no leído local en 0. */
  async function markReadRemote(r: { kind: 'channel' | 'dm'; id: string }): Promise<void> {
    const c = clientNow()
    const args = r.kind === 'channel' ? { p_channel: r.id, p_thread: null } : { p_channel: null, p_thread: r.id }
    const res = await c.rpc('chat_mark_read', args)
    check(res, 'No se pudo marcar como leído.')
    const key = convKeyOf(r.kind, r.id)
    unreadMap.set(key, { ...(unreadMap.get(key) ?? { muted: false }), unread: 0 })
    onChange()
  }

  const markReadQuiet = (r: { kind: 'channel' | 'dm'; id: string }): void => {
    markReadRemote(r).catch(() => ctx.log('chat: no se pudo marcar como leído.'))
  }

  // ---------- presencia y realtime ----------

  /** Temas de realtime: presencia por equipo (con mi estado) y «escribiendo» por DM. */
  function syncRealtime(): void {
    if (!rt) return
    const me = core.me()
    if (!me) return
    const mine = personRowOf(me.id).person.presence
    const specs: TopicSpec[] = [
      ...lists.teams.map((t) => ({ topic: teamTopic(t.id), trackAs: mine })),
      ...lists.threads.map((t) => ({ topic: dmTopic(t.id) }))
    ]
    rt.sync(specs)
  }

  function onPresence(ev: ChatPresenceEvent): void {
    const m = new Map<string, ChatPresence>()
    for (const p of ev.people) m.set(p.userId, p.presence)
    presence.set(ev.teamId, m)
    ctx.emit('presence', ev)
  }

  function onTyping(ev: ChatTypingEvent): void {
    ctx.emit('typing', ev)
  }

  function onStatus(g: number, st: string): void {
    if (g !== gen) return
    if (st === 'SUBSCRIBED') {
      connection = 'live'
      // Reconexión: las listas y los no leídos no vienen por realtime, se piden una vez.
      if (subscribedOnce) void refreshLists(true)
      subscribedOnce = true
    } else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') {
      connection = 'retrying'
    } else {
      connection = 'connecting'
    }
    onChange()
  }

  /**
   * Hidrata filas de messages: autor, reacciones, adjuntos y cita del mensaje al que responden.
   * Una sola pasada de consultas por lote (no por mensaje).
   */
  async function hydrate(c: SupabaseClient, rows: MessageRow[], status: 'sent' | 'sending' = 'sent'): Promise<ChatMessageFull[]> {
    if (rows.length === 0) return []
    const ids = uniq(rows.map((r) => s(r.id)))
    const known = new Map(rows.map((r) => [s(r.id), r] as const))
    const replyIds = uniq(rows.map((r) => s(r.reply_to)).filter((x) => x !== '' && !known.has(x)))
    const quoteRes = replyIds.length ? await c.from('messages').select(MSG_COLS).in('id', replyIds) : { data: [], error: null }
    check(quoteRes, 'No se pudo leer la conversación.')
    const quoteRows = (quoteRes.data ?? []) as MessageRow[]
    const quoteById = new Map<string, MessageRow>()
    for (const q of quoteRows) quoteById.set(s(q.id), q)
    await loadProfiles(c, [...rows.map((r) => s(r.author_id)), ...quoteRows.map((q) => s(q.author_id))])
    const [rx, fl] = await Promise.all([
      c.from('message_reactions').select('message_id, user_id, kind').in('message_id', ids),
      c.from('message_files').select('id, message_id, name, size_bytes, mime, path, created_at').in('message_id', ids)
    ])
    check(rx, 'No se pudieron leer las reacciones.')
    check(fl, 'No se pudieron leer los adjuntos.')
    const rxMap = reactionsByMessage((rx.data ?? []) as unknown[])
    const flMap = filesByMessage((fl.data ?? []) as unknown[])
    const out: ChatMessageFull[] = []
    for (const r of rows) {
      const replyId = s(r.reply_to)
      const quoteSrc = replyId ? (known.get(replyId) ?? quoteById.get(replyId)) : undefined
      const quote = quoteSrc ? quoteFromRow(quoteSrc) : undefined
      const id = s(r.id)
      const m = messageFromRow(r, profileFor(s(r.author_id)), {
        status,
        reactions: rxMap.get(id) ?? [],
        files: flMap.get(id) ?? [],
        ...(quote ? { replyTo: quote } : {})
      })
      if (m) out.push(m)
    }
    return out
  }

  function mentionsMe(body: string): boolean {
    const me = core.me()
    if (!me) return false
    const p = personRowOf(me.id).person
    const text = body.toLowerCase()
    return text.includes(`@${p.login.toLowerCase()}`) || text.includes(`@${p.handle.toLowerCase()}`)
  }

  async function onInsertRow(g: number, raw: unknown): Promise<void> {
    if (g !== gen) return
    const me = core.me()
    const c = core.client() as SupabaseClient | null
    if (!isRow(raw) || !me || !c) return
    const [msg] = await hydrate(c, [raw])
    if (g !== gen || !msg) return
    // Propio o ajeno: la UI reemplaza su «enviando…» por clientId, así que no se duplica.
    ctx.emit('message', msg)
    if (msg.authorId === me.id) return

    const key = convKeyOf(msg.conv.kind === 'dm' ? 'dm' : 'channel', msg.conv.id)
    const team = msg.conv.kind === 'dm' ? null : lists.channels.find((ch) => ch.id === msg.conv.id)?.teamId ?? null
    const muted = unreadMap.get(key)?.muted === true
    const focused = isFocused()
    const viewing = view.open && !!view.conv && keyOf(view.conv) === key
    // Evento interno para el resto de main (avisos, permisos): siempre, con la ventana en cualquier estado.
    const notice: ChatNoticeEvent = {
      teamId: team,
      conversationId: msg.conv.id,
      from: msg.author.login,
      preview: firstChars(msg.body, NOTICE_CHARS),
      mentionsMe: mentionsMe(msg.body),
      muted
    }
    chatEvents.emitMessage(notice)

    if (focused && viewing) {
      // Lo está mirando: no suma no leído, pero el servidor tiene que saberlo.
      markReadQuiet(msg.conv.kind === 'dm' ? { kind: 'dm', id: msg.conv.id } : { kind: 'channel', id: msg.conv.id })
      return
    }
    const known =
      msg.conv.kind === 'dm' ? lists.threads.some((t) => t.id === msg.conv.id) : lists.channels.some((ch) => ch.id === msg.conv.id)
    if (!known) {
      // Canal o DM nuevo para esta app: lo trae el servidor con su no leído.
      await refreshLists(true)
      return
    }
    bumpUnread(key)
    onChange()
  }

  async function onUpdateRow(g: number, raw: unknown): Promise<void> {
    if (g !== gen) return
    const c = core.client() as SupabaseClient | null
    if (!isRow(raw) || !c) return
    const [msg] = await hydrate(c, [raw])
    if (g !== gen || !msg) return
    ctx.emit('messageChanged', msg)
  }

  // ---------- canales ----------

  ctx.onWindow((w) => {
    w.on('focus', () => {
      if (!running) return
      void refreshLists(false)
      if (view.open && view.conv) {
        const k = keyOf(view.conv)
        const u = k ? unreadMap.get(k) : undefined
        if (k && u && u.unread > 0) markReadQuiet(k.startsWith('dm:') ? { kind: 'dm', id: k.slice(3) } : { kind: 'channel', id: k.slice(8) })
      }
    })
  })

  ctx.handle('setView', (raw: unknown): void => {
    view = parseViewV2(raw)
    if (view.open && view.conv && isFocused()) {
      const k = keyOf(view.conv)
      const u = k ? unreadMap.get(k) : undefined
      if (k && u && u.unread > 0) markReadQuiet(k.startsWith('dm:') ? { kind: 'dm', id: k.slice(3) } : { kind: 'channel', id: k.slice(8) })
    }
  })

  /** Mensajes de un canal o DM, viejo → nuevo. Sin las respuestas de hilo (van en threadReplies). */
  async function pageOf(raw: unknown, rawBefore?: unknown, rawLimit?: unknown): Promise<ChatMessageFull[]> {
    const c = clientNow()
    const conv = await resolveConv(parseConv(raw))
    const f = convFilter(conv)
    const limit = parseLimit(rawLimit)
    let q = c.from('messages').select(MSG_COLS).eq(f.col, f.id).is('thread_root', null)
    if (rawBefore !== undefined && rawBefore !== null) {
      const beforeId = parseUuid(rawBefore, 'Mensaje inválido.')
      const b = await c.from('messages').select('created_at').eq('id', beforeId).maybeSingle()
      check(b, 'No se pudo leer la conversación.')
      if (!b.data) return []
      q = q.lt('created_at', b.data.created_at)
    }
    const res = await q.order('created_at', { ascending: false }).limit(limit)
    check(res, 'No se pudo leer la conversación.')
    return oldestFirst(await hydrate(c, (res.data ?? []) as MessageRow[])).filter(isMsg)
  }

  ctx.handle('messages', async (rawConv: unknown, rawBefore?: unknown, rawLimit?: unknown): Promise<ChatMessageFull[]> => pageOf(rawConv, rawBefore, rawLimit))

  /** Envío v2: texto, tarjeta o adjuntos (ya subidos con uploadFile). Idempotente por clientId. */
  async function sendInternal(raw: unknown): Promise<ChatMessageFull> {
    const c = clientNow()
    const me = meNow()
    const input = parseSendInput(raw)
    const conv = await resolveConv(input.conv)
    const f = convFilter(conv)
    const row: Record<string, unknown> = {
      [f.col]: f.id,
      client_id: input.clientId,
      body: input.body,
      kind: messageKindOf(input),
      payload: {}
    }
    if (conv.kind === 'channel') row.team_id = conv.teamId
    if (input.card) row.payload = cardToRow(input.card).payload
    if (input.replyTo) row.reply_to = input.replyTo
    if (input.threadRoot) row.thread_root = input.threadRoot
    const res = await c.from('messages').insert(row).select(MSG_COLS)
    let inserted: MessageRow | undefined
    if (!res.error) {
      inserted = ((res.data ?? []) as MessageRow[])[0]
    } else if (res.error.code === '23505') {
      // clientId repetido: es un reintento. Se devuelve el mensaje que ya estaba guardado.
      const ex = await c.from('messages').select(MSG_COLS).eq('author_id', me.id).eq('client_id', input.clientId).maybeSingle()
      inserted = !ex.error && ex.data ? (ex.data as MessageRow) : undefined
    } else if (res.error.code === 'P0001' && res.error.message) {
      throw new Error(res.error.message.slice(0, 300))
    } else if (res.error.code === '42501') {
      throw new Error('No podés escribir en esta conversación.')
    } else {
      throw new Error('No se pudo enviar el mensaje.')
    }
    if (!inserted) throw new Error('No se pudo enviar el mensaje.')
    if (input.files.length) {
      const rows = input.files.map((fr) => ({
        message_id: s(inserted?.id),
        team_id: conv.kind === 'channel' ? conv.teamId : null,
        name: fr.name,
        size_bytes: fr.size,
        mime: fr.mime,
        path: fr.path
      }))
      const fres = await c.from('message_files').insert(rows)
      if (fres.error) throw new Error('El mensaje se envió, pero los adjuntos no se guardaron. Probá de nuevo.')
    }
    const [msg] = await hydrate(c, [inserted])
    if (!msg) throw new Error('No se pudo enviar el mensaje.')
    return msg
  }

  ctx.handle('sendMessage', (raw: unknown): Promise<ChatMessageFull> => sendInternal(raw))

  ctx.handle('send', async (rawConv: unknown, rawBody: unknown, rawClientId: unknown): Promise<ChatMessageFull> =>
    // Compat con 0.5: texto simple.
    sendInternal({ conv: rawConv, body: parseBody(rawBody), clientId: parseClientId(rawClientId), files: [] })
  )

  ctx.handle('threadReplies', async (rawRoot: unknown, rawLimit?: unknown): Promise<ChatMessageFull[]> => {
    const c = clientNow()
    const root = parseUuid(rawRoot, 'Mensaje inválido.')
    const res = await c.from('messages').select(MSG_COLS).eq('thread_root', root).order('created_at', { ascending: true }).limit(parseLimit(rawLimit))
    check(res, 'No se pudo leer el hilo.')
    return (await hydrate(c, (res.data ?? []) as MessageRow[])).filter(isMsg)
  })

  ctx.handle('editMessage', async (rawId: unknown, rawBody: unknown): Promise<ChatMessageFull> => {
    const c = clientNow()
    const id = parseUuid(rawId, 'Mensaje inválido.')
    const body = parseBody(rawBody)
    const res = await c.from('messages').update({ body }).eq('id', id).is('deleted_at', null).select(MSG_COLS)
    check(res, 'No podés editar este mensaje.')
    const row = ((res.data ?? []) as MessageRow[])[0]
    if (!row) throw new Error('No podés editar este mensaje.')
    const [msg] = await hydrate(c, [row])
    if (!msg) throw new Error('No podés editar este mensaje.')
    return msg
  })

  ctx.handle('deleteMessage', async (rawId: unknown): Promise<void> => {
    const c = clientNow()
    const id = parseUuid(rawId, 'Mensaje inválido.')
    // Primero los adjuntos (se leen mientras el mensaje todavía está vivo), después el borrado lógico y
    // por último los objetos del bucket: así las políticas de storage siguen viendo la autoría.
    const fl = await c.from('message_files').select('path').eq('message_id', id)
    check(fl, 'No podés borrar este mensaje.')
    const paths = ((fl.data ?? []) as Array<{ path: unknown }>).map((r) => s(r.path)).filter((p) => p !== '')
    const res = await c.from('messages').update({ deleted_at: new Date().toISOString() }).eq('id', id).is('deleted_at', null).select('id')
    check(res, 'No podés borrar este mensaje.')
    if ((res.data ?? []).length === 0) throw new Error('No podés borrar este mensaje.')
    await removeChatFiles(c, paths)
  })

  ctx.handle('pinMessage', async (rawId: unknown, rawPinned: unknown): Promise<ChatMessageFull> => {
    const c = clientNow()
    const id = parseUuid(rawId, 'Mensaje inválido.')
    const pinned = parseBool(rawPinned, 'Valor de fijado inválido.')
    const res = await c.from('messages').update({ pinned_at: pinned ? new Date().toISOString() : null }).eq('id', id).select(MSG_COLS)
    check(res, 'No podés fijar este mensaje.')
    const row = ((res.data ?? []) as MessageRow[])[0]
    if (!row) throw new Error('No podés fijar este mensaje.')
    const [msg] = await hydrate(c, [row])
    if (!msg) throw new Error('No podés fijar este mensaje.')
    return msg
  })

  ctx.handle('pinnedMessages', async (rawConv: unknown): Promise<ChatMessageFull[]> => {
    const c = clientNow()
    const conv = await resolveConv(parseConv(rawConv))
    const f = convFilter(conv)
    const res = await c.from('messages').select(MSG_COLS).eq(f.col, f.id).not('pinned_at', 'is', null).is('deleted_at', null).order('pinned_at', { ascending: false }).limit(100)
    check(res, 'No se pudieron leer los fijados.')
    return (await hydrate(c, (res.data ?? []) as MessageRow[])).filter(isMsg)
  })

  ctx.handle('toggleReaction', async (rawId: unknown, rawKind: unknown, rawOn: unknown): Promise<ChatReaction[]> => {
    const c = clientNow()
    const me = meNow()
    const id = parseUuid(rawId, 'Mensaje inválido.')
    const kind: ChatReactionKind = parseReaction(rawKind)
    const on = parseBool(rawOn, 'Valor inválido.')
    if (on) {
      const r = await c.from('message_reactions').insert({ message_id: id, user_id: me.id, kind })
      if (r.error && r.error.code !== '23505') check(r, 'No se pudo reaccionar.')
    } else {
      const r = await c.from('message_reactions').delete().eq('message_id', id).eq('user_id', me.id).eq('kind', kind)
      check(r, 'No se pudo quitar la reacción.')
    }
    const list = await c.from('message_reactions').select('message_id, user_id, kind').eq('message_id', id)
    check(list, 'No se pudieron leer las reacciones.')
    return reactionsByMessage((list.data ?? []) as unknown[]).get(id) ?? []
  })

  ctx.handle('uploadFile', async (rawConv: unknown, rawFile: unknown): Promise<ChatFileRef> => {
    const c = clientNow()
    const conv = await resolveConv(parseConv(rawConv))
    const file = parseFileUpload(rawFile)
    const prefix = conv.kind === 'dm' ? `dm/${conv.id}` : s(conv.teamId)
    return uploadChatFile(c, prefix, file)
  })

  ctx.handle('downloadFile', async (rawId: unknown): Promise<{ name: string; mime: string; base64: string }> => {
    const c = clientNow()
    const id = parseUuid(rawId, 'Adjunto inválido.')
    const res = await c.from('message_files').select('name, mime, path').eq('id', id).maybeSingle()
    check(res, 'No se pudo bajar el adjunto.')
    if (!res.data) throw new Error('No se pudo bajar el adjunto.')
    const bytes = await downloadChatFile(c, s(res.data.path))
    return { name: s(res.data.name), mime: s(res.data.mime) || 'application/octet-stream', base64: bytes.toString('base64') }
  })

  ctx.handle('convFiles', async (rawConv: unknown): Promise<ChatFile[]> => {
    const c = clientNow()
    const conv = await resolveConv(parseConv(rawConv))
    const f = convFilter(conv)
    const res = await c
      .from('message_files')
      .select('id, message_id, name, size_bytes, mime, path, created_at, messages!inner(channel_id, thread_id, deleted_at)')
      .eq(`messages.${f.col}`, f.id)
      .is('messages.deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(200)
    check(res, 'No se pudieron leer los archivos.')
    return [...filesByMessage((res.data ?? []) as unknown[]).values()].flat()
  })

  ctx.handle('readMarks', async (rawConv: unknown): Promise<ChatReadMark[]> => {
    const c = clientNow()
    const conv = await resolveConv(parseConv(rawConv))
    const args = conv.kind === 'channel' ? { p_channel: conv.id, p_thread: null } : { p_channel: null, p_thread: conv.id }
    const res = await c.rpc('conv_read_marks', args)
    check(res, 'No se pudo leer quién vio la conversación.')
    return ((res.data ?? []) as Array<{ user_id: unknown; last_read_at: unknown }>)
      .map((r) => ({ userId: s(r.user_id), lastReadAt: Date.parse(s(r.last_read_at)) || 0 }))
      .filter((r) => r.userId !== '')
  })

  ctx.handle('markRead', async (rawConv: unknown): Promise<void> => {
    clientNow()
    const conv = await resolveConv(parseConv(rawConv))
    await markReadRemote(conv.kind === 'channel' ? { kind: 'channel', id: conv.id } : { kind: 'dm', id: conv.id })
  })

  ctx.handle('setMuted', async (rawConv: unknown, rawMuted: unknown): Promise<void> => {
    const c = clientNow()
    const conv = await resolveConv(parseConv(rawConv))
    const muted = parseBool(rawMuted, 'Valor inválido.')
    const args = conv.kind === 'channel' ? { p_channel: conv.id, p_thread: null, p_muted: muted } : { p_channel: null, p_thread: conv.id, p_muted: muted }
    const res = await c.rpc('chat_set_muted', args)
    check(res, 'No se pudo cambiar el aviso de la conversación.')
    const key = convKeyOf(conv.kind, conv.id)
    unreadMap.set(key, { ...(unreadMap.get(key) ?? { unread: 0 }), muted })
    onChange()
  })

  ctx.handle('channels', (rawTeam: unknown): ChatChannel[] => {
    clientNow()
    const teamId = parseUuid(rawTeam, 'Equipo inválido.')
    return lists.channels
      .filter((ch) => ch.teamId === teamId)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name, 'es'))
      .map(channelOut)
  })

  ctx.handle('createChannel', async (rawTeam: unknown, rawInput: unknown): Promise<ChatChannel> => {
    const c = clientNow()
    const teamId = parseUuid(rawTeam, 'Equipo inválido.')
    const f = parseChannelInput(rawInput, 'create')
    const res = await c.rpc('create_channel', { p_team: teamId, p_name: f.name, p_topic: f.topic ?? '', p_description: f.description ?? '' })
    check(res, 'No se pudo crear el canal.')
    const id = s(res.data)
    if (!id) throw new Error('No se pudo crear el canal.')
    await refreshLists(true)
    const ch = lists.channels.find((x) => x.id === id)
    if (!ch) throw new Error('No se pudo crear el canal.')
    return channelOut(ch)
  })

  ctx.handle('updateChannel', async (rawId: unknown, rawPatch: unknown): Promise<ChatChannel> => {
    const c = clientNow()
    const id = parseUuid(rawId, 'Canal inválido.')
    const f = parseChannelInput(rawPatch, 'update')
    const res = await c.rpc('update_channel', {
      p_channel: id,
      p_name: f.name ?? null,
      p_topic: f.topic ?? null,
      p_description: f.description ?? null
    })
    check(res, 'No podés editar este canal.')
    await refreshLists(true)
    const ch = lists.channels.find((x) => x.id === id)
    if (!ch) throw new Error('No podés editar este canal.')
    return channelOut(ch)
  })

  ctx.handle('setTyping', (rawConv: unknown, rawTyping: unknown): void => {
    if (!rt) return
    const conv = parseConv(rawConv)
    const typing = parseBool(rawTyping, 'Valor inválido.')
    if (!typing) return
    const key = keyOf(conv)
    if (!key) return
    const t = now()
    if ((lastTyping.get(key) ?? 0) + TYPING_MIN_MS > t) return
    lastTyping.set(key, t)
    if (conv.kind === 'dm') rt.typing(dmTopic(conv.id), { kind: 'dm', id: conv.id })
    else {
      const ch = lists.channels.find((x) => x.id === conv.id || (conv.kind === 'team' && x.teamId === conv.id && x.isDefault))
      if (ch) rt.typing(teamTopic(ch.teamId), { kind: 'channel', id: ch.id })
    }
  })

  ctx.handle('presence', (rawTeam: unknown): ChatPresenceEvent => {
    const teamId = parseUuid(rawTeam, 'Equipo inválido.')
    const m = presence.get(teamId) ?? new Map<string, ChatPresence>()
    return { teamId, people: [...m.entries()].map(([userId, p]) => ({ userId, presence: p })) }
  })

  // ---------- perfiles ----------

  ctx.handle('profile', async (rawUser?: unknown): Promise<ChatPerson> => {
    const c = clientNow()
    const me = meNow()
    const id = rawUser === undefined || rawUser === null ? me.id : parseUuid(rawUser, 'Persona inválida.')
    await loadProfiles(c, [id], id === me.id)
    if (!persons.has(id)) throw new Error('No podés ver ese perfil.')
    return personOut(id)
  })

  ctx.handle('updateProfile', async (rawPatch: unknown): Promise<ChatPerson> => {
    const c = clientNow()
    const me = meNow()
    const patch = parseProfilePatch(rawPatch)
    const res = await c.rpc('update_profile', { p_patch: patch })
    check(res, 'No se pudo guardar el perfil.')
    await loadProfiles(c, [me.id], true)
    syncRealtime()
    onChange()
    return personOut(me.id)
  })

  ctx.handle('setProfilePhoto', async (rawPhoto: unknown): Promise<ChatPerson> => {
    const c = clientNow()
    const me = meNow()
    const oldPath = persons.get(me.id)?.photoPath
    let newPath: string | null = null
    if (rawPhoto !== null) {
      if (typeof rawPhoto !== 'string') throw new Error('La foto no es válida.')
      const photo = decodePhotoBase64(rawPhoto, CHAT_LIMITS_V2.photoBytes)
      newPath = await uploadProfilePhoto(c, me.id, photo)
    }
    const res = await c.rpc('set_profile_photo', { p_path: newPath })
    if (res.error) {
      if (newPath) await removeProfilePhoto(c, newPath)
      throw new Error('No se pudo guardar la foto.')
    }
    if (oldPath && oldPath !== newPath) await removeProfilePhoto(c, oldPath)
    await loadProfiles(c, [me.id], true)
    onChange()
    return personOut(me.id)
  })

  ctx.handle('people', async (rawTeam: unknown): Promise<ChatTeamPerson[]> => {
    const c = clientNow()
    const teamId = parseUuid(rawTeam, 'Equipo inválido.')
    const res = await c.from('team_members').select('user_id, role, joined_at').eq('team_id', teamId)
    check(res, 'No se pudo leer los miembros.')
    const rows = (res.data ?? []) as Array<{ user_id: unknown; role: unknown; joined_at: unknown }>
    await loadProfiles(c, rows.map((r) => s(r.user_id)))
    const out: ChatTeamPerson[] = []
    for (const r of rows) {
      const role = roleOf(r.role)
      if (!role) continue
      const id = s(r.user_id)
      const joined = Date.parse(s(r.joined_at)) || 0
      out.push(teamPersonOf(personOut(id), role, joined))
    }
    return out.sort((a, b) => ({ owner: 0, admin: 1, member: 2 })[a.role] - ({ owner: 0, admin: 1, member: 2 })[b.role] || a.login.localeCompare(b.login))
  })

  // ---------- equipos, personas e invitaciones (0.5) ----------

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
    const t = teamOf(teamId)
    if (!t) throw new Error('No se pudo leer el equipo.')
    return teamOut(t)
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
    const t = teamOf(teamId)
    if (!t) throw new Error('No se pudo leer el equipo.')
    return teamOut(t)
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

  ctx.handle('joinByCode', async (rawCode: unknown): Promise<ChatTeam> => {
    const c = clientNow()
    const code = parseInviteCode(rawCode)
    const r = await c.rpc('join_team_by_code', { p_code: code })
    check(r, 'No se pudo entrar al equipo.')
    const teamId = s(r.data)
    if (!teamId) throw new Error('No se pudo entrar al equipo.')
    await refreshLists(true)
    const t = teamOf(teamId)
    if (!t) throw new Error('No se pudo entrar al equipo.')
    return teamOut(t)
  })

  ctx.handle('acceptInvite', async (rawInvite: unknown): Promise<ChatTeam> => {
    const c = clientNow()
    const inviteId = parseUuid(rawInvite, 'Invitación inválida.')
    const r = await c.rpc('accept_invite', { p_invite: inviteId })
    check(r, 'No se pudo aceptar la invitación.')
    const teamId = s(r.data)
    if (!teamId) throw new Error('No se pudo aceptar la invitación.')
    await refreshLists(true)
    const t = teamOf(teamId)
    if (!t) throw new Error('No se pudo aceptar la invitación.')
    return teamOut(t)
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
    if (teamOf(teamId)?.role === 'owner') throw new Error('El owner no puede salir del equipo.')
    const r = await c.from('team_members').delete().eq('team_id', teamId).eq('user_id', me.id).select('user_id')
    check(r, 'No se pudo salir del equipo.')
    if ((r.data ?? []).length === 0) throw new Error('El owner no puede salir del equipo.')
    await refreshLists(true)
  })

  ctx.handle('removeMember', async (rawTeam: unknown, rawUser: unknown): Promise<void> => {
    const c = clientNow()
    const me = meNow()
    const teamId = parseUuid(rawTeam, 'Equipo inválido.')
    const userId = parseUuid(rawUser, 'Persona inválida.')
    if (userId === me.id) throw new Error('Para salir usá «Salir del equipo».')
    const r = await c.from('team_members').delete().eq('team_id', teamId).eq('user_id', userId).eq('role', 'member').select('user_id')
    check(r, 'No podés sacar a esa persona.')
    if ((r.data ?? []).length === 0) throw new Error('No podés sacar a esa persona.')
    await refreshLists(true)
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
    return threadOut(t)
  })

  // ---------- ciclo de vida ----------

  return {
    part: (): ChatDataPart => {
      const teams = lists.teams.map(teamOut)
      const threads = lists.threads.map(threadOut)
      // El total del botón no cuenta lo silenciado.
      const unreadTotal = [...unreadMap.entries()]
        .filter(([, v]) => !v.muted)
        .reduce((n, [, v]) => n + v.unread, 0)
      return { connection, teams, threads, invites: lists.invites, unreadTotal }
    },

    start: async (): Promise<void> => {
      const c = core.client() as SupabaseClient | null
      const me = core.me()
      if (!c || !me || running) return
      running = true
      const g = ++gen
      connection = 'connecting'
      subscribedOnce = false
      closeInbox = openInbox(c, {
        onInsert: (raw) => {
          onInsertRow(g, raw).catch(() => ctx.log('chat: no se pudo procesar un mensaje nuevo.'))
        },
        onUpdate: (raw) => {
          onUpdateRow(g, raw).catch(() => ctx.log('chat: no se pudo procesar un cambio de mensaje.'))
        },
        onChannelChange: () => {
          if (g === gen) void refreshLists(true)
        },
        onProfileChange: (raw) => {
          const p = personFromRow(raw)
          if (g !== gen || !p) return
          cachePerson(p)
          if (p.person.id === me.id) syncRealtime()
          onChange()
        },
        onStatus: (st) => onStatus(g, st)
      })
      rt = openTeamRealtime(c, me.id, {
        onPresence: (ev) => {
          if (g === gen) onPresence(ev)
        },
        onTyping: (ev) => {
          if (g === gen) onTyping(ev)
        }
      })
      onChange()
      await refreshLists(true)
    },

    stop: async (): Promise<void> => {
      gen++
      running = false
      connection = 'off'
      lists = EMPTY_LISTS
      view = { open: false }
      subscribedOnce = false
      lastRefresh = 0
      unreadMap.clear()
      persons.clear()
      presence.clear()
      lastTyping.clear()
      teamPhotoPath.clear()
      teamPhotos.clear()
      teamPhotoLoading.clear()
      teamPhotoFailed.clear()
      profilePhotos.clear()
      profilePhotoLoading.clear()
      profilePhotoFailed.clear()
      const close = closeInbox
      closeInbox = undefined
      const realtime = rt
      rt = undefined
      if (realtime) await realtime.close().catch(() => undefined)
      if (close) await close().catch(() => undefined)
    }
  }
}
