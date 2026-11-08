import type { SupabaseClient } from '@supabase/supabase-js'
import type { FeatureContext } from './context'
import {
  convKey,
  type ChatAuth,
  type ChatConnection,
  type ChatConvRef,
  type ChatInvite,
  type ChatInviteSent,
  type ChatMember,
  type ChatMessage,
  type ChatProfile,
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
  memberFromRow,
  oldestFirst,
  otherOf,
  parseBody,
  parseClientId,
  parseConvRef,
  parseInviteCode,
  parseLimit,
  parseLogin,
  parseTeamFields,
  parseUuid,
  parseView,
  photoPathOf,
  profileFromRow,
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
import { openInbox } from './chat-realtime'

/**
 * Datos del chat (equipos, DMs, mensajes, no leídos, realtime, fotos, avisos). Contrato entre
 * chat.ts (T2: config + login) y este archivo (T8).
 *
 * Reglas: todo Supabase corre en main; una sola conexión realtime (canal «sloth-inbox») mientras
 * hay sesión y ventana; sin timers: las listas se refrescan al arrancar, al reconectar y al enfocar
 * la ventana (mínimo 30 s entre refrescos). Nunca se loguea el cuerpo de un mensaje ni un token.
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
}

export const EMPTY_PART: ChatDataPart = { connection: 'off', teams: [], threads: [], invites: [], unreadTotal: 0 }

/** Dependencias inyectables (las pruebas no cargan Electron). */
export interface NoticeLike {
  on(event: 'click', cb: () => void): unknown
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
const PROFILE_CACHE_MAX = 500
const PHOTO_CACHE_MAX = 50
const UNREAD_CAP = 99
const NOTICE_CHARS = 120

const defaultNotifier = async (): Promise<NotifierCtor | undefined> => {
  const el = await import('electron')
  return el.Notification as unknown as NotifierCtor
}

type Lists = { teams: ChatTeam[]; threads: ChatThread[]; invites: ChatInvite[] }
const EMPTY_LISTS: Lists = { teams: [], threads: [], invites: [] }

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
const isMsg = (m: ChatMessage | undefined): m is ChatMessage => m !== undefined

const MSG_COLS = 'id, client_id, team_id, thread_id, author_id, body, created_at'

export function registerChatData(ctx: FeatureContext, core: ChatCoreHandle, onChange: () => void, deps: ChatDataDeps = {}): ChatData {
  const loadNotifier = deps.loadNotifier ?? defaultNotifier
  const now = deps.now ?? Date.now

  let gen = 0
  let running = false
  let connection: ChatConnection = 'off'
  let lists: Lists = EMPTY_LISTS
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
      c.from('dm_threads').select('id, user_a, user_b'),
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
      allTeamIds.length ? c.from('teams').select('id, name, description, photo_path').in('id', allTeamIds) : none,
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
      const t = threadFromRow(r, profileFor(other), { unread: u?.unread ?? 0, lastMessageAt: u?.lastMessageAt })
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

  function isRow(raw: unknown): raw is MessageRow {
    return isObj(raw) && typeof raw.id === 'string' && typeof raw.author_id === 'string' && typeof raw.body === 'string'
  }

  async function onInsertRow(g: number, raw: unknown): Promise<void> {
    if (g !== gen) return
    const me = core.me()
    const c = core.client() as SupabaseClient | null
    if (!isRow(raw) || !me || !c) return
    const conv = convOfRow(raw)
    if (!conv) return
    const authorId = s(raw.author_id)
    await loadProfiles(c, [authorId])
    if (g !== gen) return
    const msg = messageFromRow(raw, profileFor(authorId))
    if (!msg) return
    // Propio o ajeno: la UI reemplaza su «enviando…» por clientId, así que no se duplica.
    ctx.emit('message', msg)
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
    if (!focused) void notify(conv, msg.author, msg.body).catch(() => undefined)
  }

  /** Aviso del sistema para un mensaje ajeno con la ventana sin foco. Como mucho uno cada 5 s por conversación. */
  async function notify(conv: ChatConvRef, author: ChatProfile, body: string): Promise<void> {
    const t = now()
    const key = convKey(conv)
    const last = lastNotify.get(key)
    if (last !== undefined && t - last < NOTIFY_MIN_MS) return
    lastNotify.set(key, t)
    const w = ctx.window()
    if (!w || w.isDestroyed()) return
    const N = await loadNotifier().catch(() => undefined)
    if (!N || !N.isSupported()) return
    const where = conv.kind === 'team' ? (lists.teams.find((x) => x.id === conv.id)?.name ?? 'Equipo') : 'Mensaje directo'
    const n = new N({ title: `${author.login} · ${where}`, body: firstChars(body, NOTICE_CHARS), silent: false })
    n.on('click', () => {
      if (w.isDestroyed()) return
      w.show()
      w.focus()
      ctx.emit('open', conv)
    })
    n.show()
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

  ctx.handle('messages', async (rawConv: unknown, rawBefore?: unknown, rawLimit?: unknown): Promise<ChatMessage[]> => {
    const c = clientNow()
    const ref = parseConvRef(rawConv)
    const limit = parseLimit(rawLimit)
    let q = c
      .from('messages')
      .select(MSG_COLS)
      .eq(ref.kind === 'team' ? 'team_id' : 'thread_id', ref.id)
    if (rawBefore !== undefined && rawBefore !== null) {
      const beforeId = parseUuid(rawBefore, 'Mensaje inválido.')
      const b = await c.from('messages').select('created_at').eq('id', beforeId).maybeSingle()
      check(b, 'No se pudo leer la conversación.')
      if (!b.data) return []
      q = q.lt('created_at', b.data.created_at)
    }
    const res = await q.order('created_at', { ascending: false }).limit(limit)
    check(res, 'No se pudo leer la conversación.')
    const rows = (res.data ?? []) as MessageRow[]
    await loadProfiles(c, rows.map((r) => s(r.author_id)))
    return oldestFirst(rows)
      .map((r) => messageFromRow(r, profileFor(s(r.author_id))))
      .filter(isMsg)
  })

  ctx.handle('send', async (rawConv: unknown, rawBody: unknown, rawClientId: unknown): Promise<ChatMessage> => {
    const c = clientNow()
    const me = meNow()
    const ref = parseConvRef(rawConv)
    const body = parseBody(rawBody)
    const clientId = parseClientId(rawClientId)
    const col = ref.kind === 'team' ? 'team_id' : 'thread_id'
    const res = await c
      .from('messages')
      .insert({ [col]: ref.id, client_id: clientId, body })
      .select(MSG_COLS)
    if (!res.error) {
      const row = ((res.data ?? []) as MessageRow[])[0]
      const msg = row ? messageFromRow(row, me) : undefined
      if (!msg) throw new Error('No se pudo enviar el mensaje.')
      return msg
    }
    if (res.error.code === '23505') {
      // clientId repetido: es un reintento. Se devuelve el mensaje que ya estaba guardado.
      const ex = await c
        .from('messages')
        .select(MSG_COLS)
        .eq('author_id', me.id)
        .eq('client_id', clientId)
        .eq(col, ref.id)
        .maybeSingle()
      const msg = !ex.error && ex.data ? messageFromRow(ex.data as MessageRow, me) : undefined
      if (msg) return msg
      throw new Error('No se pudo enviar el mensaje.')
    }
    if (res.error.code === 'P0001' && res.error.message) throw new Error(res.error.message.slice(0, 300))
    if (res.error.code === '42501') throw new Error('No podés escribir en esta conversación.')
    throw new Error('No se pudo enviar el mensaje.')
  })

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

  ctx.handle('joinByCode', async (rawCode: unknown): Promise<ChatTeam> => {
    const c = clientNow()
    const code = parseInviteCode(rawCode)
    const r = await c.rpc('join_team_by_code', { p_code: code })
    check(r, 'No se pudo entrar al equipo.')
    const teamId = s(r.data)
    if (!teamId) throw new Error('No se pudo entrar al equipo.')
    await refreshLists(true)
    return teamNow(teamId)
  })

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
    return t
  })

  // ---------- ciclo de vida ----------

  return {
    part: (): ChatDataPart => {
      const teams = lists.teams.map(withPhoto)
      const unreadTotal = teams.reduce((n, t) => n + t.unread, 0) + lists.threads.reduce((n, t) => n + t.unread, 0)
      return { connection, teams, threads: lists.threads, invites: lists.invites, unreadTotal }
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
        onStatus: (st) => onStatus(g, st)
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
      teamPhotoPath.clear()
      photos.clear()
      photoLoading.clear()
      photoFailed.clear()
      profiles.clear()
      lastNotify.clear()
      const close = closeInbox
      closeInbox = undefined
      if (close) await close().catch(() => undefined)
    }
  }
}
