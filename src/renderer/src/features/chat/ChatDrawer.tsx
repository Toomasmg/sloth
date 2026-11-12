import { SidePanel } from '../../ui/SidePanel'
import { useEffect, useState, type KeyboardEvent } from 'react'
import { ArrowsClockwise, CheckCircle, CircleNotch, Key, Plus, SignIn, SignOut, WarningCircle } from '@phosphor-icons/react'
import type { ChatConnection, ChatSnapshot, ChatTeam, ChatThread } from '../../../../shared/chat'
import { convKey } from '../../../../shared/chat'
import { useUi, type UiCtx } from '../host'
import { openSettings } from '../settings/bus'
import { Conversation, type ChatModalKind } from './Conversation'
import { InvitesList, InviteDialog, JoinByCode, MembersPanel, TeamEditor } from './teams'
import {
  closeChat,
  errText,
  openChat,
  sendView,
  showChatList,
  teamOf,
  threadOf,
  useChatAttach,
  useChatSnapshot,
  useDrawer
} from './store'
import { Av } from './view-utils'

type Modal = 'newTeam' | 'join' | ChatModalKind | null

/** Acción de chat: si falla, se muestra como aviso (no rompe la vista). */
const run = (ui: UiCtx, channel: string, ...args: unknown[]): void => {
  ui.invoke(channel, ...args).catch((e: unknown) => ui.notifyError(errText(e)))
}

/** Drawer lateral del chat. Se monta solo mientras está abierto (sin costo cuando está cerrado). */
export function ChatDrawer(): React.JSX.Element {
  const ui = useUi()
  useChatAttach(ui)
  const d = useDrawer()
  const snap = useChatSnapshot()
  const [modal, setModal] = useState<Modal>(null)
  const key = d.conv ? convKey(d.conv) : 'list'

  // Qué mira el usuario (para no leídos y avisos en main). Al cerrar: open false.
  useEffect(() => {
    sendView(d.conv ? { open: true, conv: d.conv } : { open: true })
    return () => sendView({ open: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const team = d.conv?.kind === 'team' ? teamOf(snap, d.conv.id) : undefined
  const thread = d.conv?.kind === 'dm' ? threadOf(snap, d.conv.id) : undefined
  const close = (): void => setModal(null)

  // Con un modal abierto, Esc cierra el modal; si no, lo cierra el SidePanel.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Escape' || e.defaultPrevented || !modal) return
    e.preventDefault()
    setModal(null)
  }

  const showConv = !!d.conv && (!!team || !!thread)

  return (
    <SidePanel labelId="f-chat-title" title="Chat del equipo" onClose={closeChat} width={420}>
      <div className="f-chat-drawer" onKeyDown={onKeyDown}>
        {showConv && d.conv ? (
          <Conversation
            key={convKey(d.conv)}
            conv={d.conv}
            title={team ? team.name : `@${thread!.other.login}`}
            photo={team ? team.photo : thread!.other.avatarUrl}
            initial={team ? team.name : thread!.other.login}
            role={team?.role}
            meId={snap?.auth.status === 'signedIn' ? snap.auth.me.id : undefined}
            onBack={() => showChatList()}
            onModal={(k) => setModal(k)}
          />
        ) : (
          <ListView snap={snap} onModal={(k) => setModal(k)} ui={ui} />
        )}

        {modal === 'newTeam' && (
          <TeamEditor
            onClose={close}
            onSaved={(t) => {
              close()
              openChat({ kind: 'team', id: t.id })
            }}
          />
        )}
        {modal === 'editTeam' && team && <TeamEditor team={team} onClose={close} onSaved={close} />}
        {modal === 'join' && (
          <JoinByCode
            onClose={close}
            onJoined={(t) => {
              close()
              openChat({ kind: 'team', id: t.id })
            }}
          />
        )}
        {modal === 'invite' && team && <InviteDialog team={team} onClose={close} />}
        {modal === 'members' && team && (
          <MembersPanel
            team={team}
            onClose={close}
            onOpenDm={(th: ChatThread) => {
              close()
              openChat({ kind: 'dm', id: th.id })
            }}
            onLeft={() => {
              close()
              showChatList()
            }}
          />
        )}
      </div>
    </SidePanel>
  )
}

function Badge({ n }: { n: number }): React.JSX.Element {
  return (
    <span className="f-chat-badge">
      <span aria-hidden="true">{n > 99 ? '99+' : n}</span>
      <span className="sr-only">{n} sin leer</span>
    </span>
  )
}

const CONN: Record<ChatConnection, string> = {
  off: 'Sin conexión',
  connecting: 'Conectando…',
  live: 'Conectado',
  retrying: 'Reconectando…'
}

function ConnIcon({ c }: { c: ChatConnection }): React.JSX.Element {
  if (c === 'live') return <CheckCircle size={12} weight="fill" aria-hidden="true" />
  if (c === 'connecting' || c === 'retrying') return <ArrowsClockwise size={12} className="f-chat-spin" aria-hidden="true" />
  return <WarningCircle size={12} aria-hidden="true" />
}

/** Lista: sesión, equipos, mensajes directos e invitaciones. */
function ListView({ snap, onModal, ui }: { snap: ChatSnapshot | null; onModal(k: Modal): void; ui: UiCtx }): React.JSX.Element {
  return (
    <>
      <div className="f-chat-body">
        {!snap && <p className="hint">Cargando…</p>}
        {snap && <ListBody snap={snap} onModal={onModal} ui={ui} />}
      </div>

      {snap?.auth.status === 'signedIn' && (
        <footer className="f-chat-foot">
          <span className={`f-chat-conn ${snap.connection}`} role="status">
            <ConnIcon c={snap.connection} />
            {CONN[snap.connection]}
          </span>
          <button type="button" className="btn sm ghost" onClick={() => run(ui, 'feat:chat:signOut')}>
            <SignOut size={14} aria-hidden="true" />
            Cerrar sesión
          </button>
        </footer>
      )}
    </>
  )
}

function ListBody({ snap, onModal, ui }: { snap: ChatSnapshot; onModal(k: Modal): void; ui: UiCtx }): React.JSX.Element {
  const a = snap.auth
  if (a.status === 'unconfigured') {
    return (
      <div className="f-chat-block">
        <p>
          Para usar el chat, cargá la URL y la clave publicable del proyecto de Supabase de tu equipo en Configuración → Equipo y chat.
        </p>
        <button
          type="button"
          className="btn primary sm"
          onClick={() => {
            closeChat()
            openSettings('equipo')
          }}
        >
          Configurar
        </button>
      </div>
    )
  }
  if (a.status === 'signedOut') {
    return (
      <div className="f-chat-block">
        <p>Entrá con tu cuenta de GitHub para leer y escribir en los equipos.</p>
        <button type="button" className="btn primary" onClick={() => run(ui, 'feat:chat:signIn')}>
          <SignIn size={14} aria-hidden="true" />
          Iniciar sesión con GitHub
        </button>
      </div>
    )
  }
  if (a.status === 'signingIn') {
    return (
      <div className="f-chat-block">
        <p role="status">
          <CircleNotch size={14} className="f-chat-spin" aria-hidden="true" /> Esperando el navegador…
        </p>
        <button type="button" className="btn sm ghost" onClick={() => run(ui, 'feat:chat:cancelSignIn')}>
          Cancelar
        </button>
      </div>
    )
  }
  if (a.status === 'error') {
    return (
      <div className="f-chat-block">
        <p className="f-chat-err" role="alert">
          {a.message}
        </p>
        <button type="button" className="btn sm" onClick={() => run(ui, 'feat:chat:signIn')}>
          Reintentar
        </button>
      </div>
    )
  }

  return (
    <>
      {snap.invites.length > 0 && (
        <InvitesList invites={snap.invites} onJoined={(t: ChatTeam) => openChat({ kind: 'team', id: t.id })} />
      )}

      <section className="f-chat-section" aria-labelledby="f-chat-h-teams">
        <h4 id="f-chat-h-teams">Equipos</h4>
        {snap.teams.length === 0 ? (
          <p className="hint">Todavía no estás en ningún equipo.</p>
        ) : (
          <ul className="f-chat-rows">
            {snap.teams.map((t) => (
              <li key={t.id}>
                <button type="button" className="f-chat-row" onClick={() => openChat({ kind: 'team', id: t.id })}>
                  <Av src={t.photo} initial={t.name} size={26} />
                  <span className="f-chat-row-main">
                    <strong>{t.name}</strong>
                    <span className="hint">{t.memberCount === 1 ? '1 miembro' : `${t.memberCount} miembros`}</span>
                  </span>
                  {t.unread > 0 && <Badge n={t.unread} />}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="f-chat-actions">
          <button type="button" className="btn sm" onClick={() => onModal('newTeam')}>
            <Plus size={14} aria-hidden="true" />
            Nuevo equipo
          </button>
          <button type="button" className="btn sm ghost" onClick={() => onModal('join')}>
            <Key size={14} aria-hidden="true" />
            Entrar con código
          </button>
        </div>
      </section>

      <section className="f-chat-section" aria-labelledby="f-chat-h-dm">
        <h4 id="f-chat-h-dm">Mensajes directos</h4>
        {snap.threads.length === 0 ? (
          <p className="hint">Podés escribirle a alguien con quien compartís un equipo, desde «Miembros».</p>
        ) : (
          <ul className="f-chat-rows">
            {snap.threads.map((th) => (
              <li key={th.id}>
                <button type="button" className="f-chat-row" onClick={() => openChat({ kind: 'dm', id: th.id })}>
                  <Av src={th.other.avatarUrl} initial={th.other.login} size={26} />
                  <span className="f-chat-row-main">
                    <strong>@{th.other.login}</strong>
                  </span>
                  {th.unread > 0 && <Badge n={th.unread} />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

