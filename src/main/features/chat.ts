import type { Feature } from './context'
import type { ChatSnapshot } from '../../shared/chat'

/**
 * Función «chat» (lado main): chat del equipo sobre Supabase. Contrato completo de canales y
 * eventos en src/shared/chat.ts. STUB v0.5: T2 (config + login) y T8 (datos + realtime) lo completan,
 * en archivos chat-*.ts al lado de este.
 */
const EMPTY: ChatSnapshot = { auth: { status: 'unconfigured' }, connection: 'off', teams: [], threads: [], invites: [], unreadTotal: 0 }

const feature: Feature = {
  name: 'chat',
  register(ctx) {
    ctx.handle('state', (): ChatSnapshot => EMPTY)
  }
}

export default feature
