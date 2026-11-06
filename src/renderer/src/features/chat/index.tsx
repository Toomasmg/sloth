import { ChatsCircle } from '@phosphor-icons/react'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
import { ChatDrawer } from './ChatDrawer'
import { openChat, useChatAttach, useChatSnapshot, useDrawer } from './store'
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

/** Drawer del chat: solo existe en el árbol mientras está abierto. */
function ChatGlobal(): React.JSX.Element | null {
  const ui = useUi()
  useChatAttach(ui)
  const d = useDrawer()
  return d.open ? <ChatDrawer /> : null
}

const feature: FeatureUi = {
  name: 'chat',
  Titlebar: ChatChip,
  Global: ChatGlobal
}

export default feature
