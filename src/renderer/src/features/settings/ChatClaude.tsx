import { useEffect, useState } from 'react'
import { convKey } from '../../../../shared/chat'
import type { ChatMcpAccountReg, ChatMcpView } from '../../../../shared/chat-mcp'
import { Button, InlineAlert, Tag } from '../../ui'
import { useUi } from '../host'
import { alternarCuenta, ordenarGrants } from '../chat/mcp-ask'
import { errText, Group, Row, ToggleRow } from './ui'

function estado(a: ChatMcpAccountReg, elegida: boolean): string {
  switch (a.state) {
    case 'revisando':
      return 'Revisando…'
    case 'ok':
      return elegida ? 'Listo' : 'Sin acceso'
    case 'pendiente':
      return a.detail ?? 'Se aplica al cerrar Claude en esta cuenta'
    case 'conflicto':
      return 'Ya tenés otro servidor MCP llamado “sloth”: no lo tocamos'
    case 'sin-node':
      return 'Falta Node.js en el PATH'
    case 'sin-cli':
      return 'No encontré Claude Code en el PATH: no se tocó nada'
    case 'error':
      return a.detail ?? 'No se pudo configurar'
    case 'no-soportado':
      return a.detail ?? 'Esta cuenta es de otro agente: el chat con MCP todavía no está disponible'
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
  const etiqueta = (id: string): string => view?.accounts.find((a) => a.accountId === id)?.label ?? id

  return (
    <Group id="g-chat-claude" title="Claude en el chat">
      <ToggleRow
        title="Dejar que Claude use el chat"
        hint="Claude Code podrá listar, leer y mandar mensajes desde las cuentas que marques abajo. Para leer te pide permiso; cada mensaje que quiera mandar te lo muestra antes. Apagado por defecto."
        checked={view?.enabled ?? false}
        disabled={!view || busy}
        onChange={(on) => void run('feat:chat:mcpSetEnabled', on)}
      />
      {err && <InlineAlert tone="danger">{err}</InlineAlert>}
      {view && view.accounts.length > 0 && (
        <Row
          title="Cuentas"
          hint="Claude solo puede usar el chat desde las cuentas que marques."
          stack
        >
          {view.enabled && view.cuentas.length === 0 && <InlineAlert tone="warning">Elegí al menos una cuenta.</InlineAlert>}
          <ul className="f-set-chatclaude-list">
            {view.accounts.map((a) => {
              const elegida = view.cuentas.includes(a.accountId)
              const ok = a.state === 'ok'
              return (
                <li key={a.accountId}>
                  <label className="f-set-chatclaude-check">
                    <input
                      type="checkbox"
                      checked={elegida}
                      disabled={!view.enabled || busy || a.state === 'no-soportado'}
                      onChange={(e) => void run('feat:chat:mcpSetAccounts', alternarCuenta(view.cuentas, a.accountId, e.target.checked))}
                    />
                    <strong>{a.label}</strong>
                  </label>
                  {(view.enabled || !ok) && <span className={ok && elegida ? 'f-set-ok' : 'f-set-hint'}>{estado(a, elegida)}</span>}
                </li>
              )
            })}
          </ul>
        </Row>
      )}
      {view && (view.enabled || grants.length > 0) && (
        <Row
          title="Conversaciones que Claude puede leer sin preguntar"
          hint={grants.length === 0 ? 'Ninguna. Mandar mensajes siempre te pide confirmación.' : 'Mandar mensajes siempre te pide confirmación.'}
          stack
        >
          {grants.length > 0 && (
            <>
              <ul className="f-set-chatclaude-list">
                {grants.map((g) => (
                  <li key={`${g.accountId}|${convKey(g.conv)}`}>
                    <strong>{g.nombre}</strong>
                    <span className="f-set-chatclaude-ops">
                      <span className="f-set-chatclaude-op">
                        <Tag mono={false}>{etiqueta(g.accountId)}</Tag>
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={busy}
                          aria-label={`Quitar permiso de leer ${g.nombre} desde ${etiqueta(g.accountId)}`}
                          onClick={() => void run('feat:chat:mcpRevoke', g.accountId, convKey(g.conv))}
                        >
                          Quitar
                        </Button>
                      </span>
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
