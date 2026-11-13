import { ChatsCircle, Ticket } from '@phosphor-icons/react'
import type { Command, FeatureUi } from '../host'
import { useUi } from '../host'
import { ChatDrawer } from './ChatDrawer'
import { JoinInvite } from './teams'
import { openChat, openJoinInvite, useChatAttach, useChatSnapshot, useDrawer, useJoinInviteOpen } from './store'
import './chat.css'

/** Botón «Chat» de la barra de título, con el total de no leídos. */
function ChatChip(): React.JSX.Element {
  const ui = useUi()
  useChatAttach(ui)
  const snap = useChatSnapshot()
  const n = snap?.unreadTotal ?? 0
  return (
    <button
      type="button"
      className="tb-chip f-chat-chip"
      onClick={() => openChat()}
      aria-haspopup="dialog"
      aria-label={n > 0 ? `Chat, ${n} sin leer` : 'Chat'}
      title="Chat del equipo"
    >
      <ChatsCircle size={14} aria-hidden="true" />
      Chat
      {n > 0 && (
        <span className="f-chat-badge f-chat-badge-top" aria-hidden="true">
          {n > 99 ? '99+' : n}
        </span>
      )}
    </button>
  )
}

/** Drawer del chat y diálogo de invitación: solo existen en el árbol mientras están abiertos. */
function ChatGlobal(): React.JSX.Element {
  const ui = useUi()
  useChatAttach(ui)
  const d = useDrawer()
  const join = useJoinInviteOpen()
  return (
    <>
      {d.open && <ChatDrawer />}
      {join && <JoinInvite />}
    </>
  )
}

const feature: FeatureUi = {
  name: 'chat',
  Titlebar: ChatChip,
  Global: ChatGlobal,
  commands: (): Command[] => [
    {
      id: 'chat:join-invite',
      title: 'Unirme con una invitación',
      subtitle: 'Pegar la invitación del chat del equipo',
      group: 'Equipo',
      keywords: 'chat invitación unirme sumarme equipo código pegar supabase',
      icon: <Ticket size={16} aria-hidden="true" />,
      run: () => openJoinInvite()
    }
  ]
}

export default feature
