import { useEffect, useState } from 'react'
import { convKey } from '../../../../shared/chat'
import type { ChatMcpAccountReg, ChatMcpView } from '../../../../shared/chat-mcp'
import { Button, InlineAlert, Tag } from '../../ui'
import { useUi } from '../host'
import { ordenarGrants } from '../chat/mcp-ask'
import { errText, Group, Row, ToggleRow } from './ui'

function estado(a: ChatMcpAccountReg): string {
  switch (a.state) {
    case 'ok':
      return 'Listo'
    case 'pendiente':
      return 'Se aplica al cerrar Claude en esta cuenta'
    case 'conflicto':
      return 'Ya tenés otro servidor MCP llamado “sloth”: no lo tocamos'
    case 'sin-node':
      return 'Falta Node.js en el PATH'
    case 'error':
      return a.detail ?? 'No se pudo configurar'
  }
}

export function ChatClaudeGroup(): React.JSX.Element {
  const ui = useUi()
  const [view, setView] = useState<ChatMcpView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    ui.invoke<ChatMcpView>('feat:chat:mcpConfig').then(
      (v) => {
        if (alive) setView(v)
      },
      (e: unknown) => {
        if (alive) setErr(errText(e))
      }
    )
    const off = ui.on('feat:chat:mcpConfig', (v: ChatMcpView) => setView(v))
    return () => {
      alive = false
      off()
    }
  }, [ui])

  const run = async (channel: string, ...args: unknown[]): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      setView(await ui.invoke<ChatMcpView>(channel, ...args))
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const grants = view ? ordenarGrants(view.grants) : []
  const l = view?.limits

  return (
    <Group id="g-chat-claude" title="Claude en el chat">
      <ToggleRow
        title="Dejar que Claude use el chat"
        hint="Claude Code podrá listar, leer y mandar mensajes desde las terminales de Sloth. Cada conversación te pide permiso la primera vez. Apagado por defecto."
        checked={view?.enabled ?? false}
        disabled={!view || busy}
        onChange={(on) => void run('feat:chat:mcpSetEnabled', on)}
      />
      {err && <InlineAlert tone="danger">{err}</InlineAlert>}
      {view?.enabled && (
        <>
          {view.accounts.length > 0 && (
            <Row title="Cuentas" stack>
              <ul className="f-set-chatclaude-list">
                {view.accounts.map((a) => (
                  <li key={a.accountId}>
                    <strong>{a.label}</strong>
                    <span className={a.state === 'ok' ? 'f-set-ok' : 'f-set-hint'}>{estado(a)}</span>
                  </li>
                ))}
              </ul>
            </Row>
          )}
          <Row
            title="Conversaciones con permiso permanente"
            hint={grants.length === 0 ? 'Ninguna conversación tiene permiso permanente.' : undefined}
            stack
          >
            {grants.length > 0 && (
              <>
                <ul className="f-set-chatclaude-list">
                  {grants.map((g) => (
                    <li key={convKey(g.conv)}>
                      <strong>{g.nombre}</strong>
                      <span className="f-set-chatclaude-ops">
                        {g.ops.map((op) => (
                          <span key={op} className="f-set-chatclaude-op">
                            <Tag mono={false}>{op === 'leer' ? 'leer' : 'enviar'}</Tag>
                            <Button
                              variant="ghost"
                              size="xs"
                              disabled={busy}
                              aria-label={`Quitar permiso de ${op} en ${g.nombre}`}
                              onClick={() => void run('feat:chat:mcpRevoke', convKey(g.conv), op)}
                            >
                              Quitar
                            </Button>
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
                <div>
                  <Button variant="danger" size="sm" disabled={busy} onClick={() => void run('feat:chat:mcpRevokeAll')}>
                    Quitar todas
                  </Button>
                </div>
              </>
            )}
          </Row>
        </>
      )}
      {view && (
        <div className="f-set-chatclaude-notes">
          {l && (
            <p className="f-set-hint">
              Hasta {l.enviarPorMinuto} mensajes y {l.leerPorMinuto} lecturas por minuto; textos de hasta {l.maxTexto} caracteres.
            </p>
          )}
          <p className="f-set-hint">
            {view.viaColumn
              ? 'Los mensajes de Claude se ven con la marca “vía Claude”. Es informativa: la pone la app de quien escribe.'
              : 'Tu servidor del chat no tiene la actualización 0005: los mensajes de Claude llevan “[vía Claude]” al principio del texto.'}
          </p>
        </div>
      )}
    </Group>
  )
}
