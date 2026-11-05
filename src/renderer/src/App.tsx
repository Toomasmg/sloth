import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  accountIdFromLoginPane,
  isLoginPane,
  loginPaneId,
  type Account,
  type AccountStatus,
  type AgentStatus,
  type Workspace
} from '../../shared/types'
import { api } from './api'
import { TerminalView } from './TerminalView'

const STATE_LABEL: Record<AgentStatus['state'], string> = {
  idle: 'Listo',
  working: 'Trabajando',
  waiting: 'Te necesita',
  done: 'Terminó',
  exited: 'Cerrado'
}

function cleanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function App(): React.JSX.Element {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [statuses, setStatuses] = useState<Record<string, AccountStatus>>({})
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [openPanes, setOpenPanesState] = useState<string[]>([])
  const [agents, setAgents] = useState<Record<string, AgentStatus>>({})
  const [generations, setGenerations] = useState<Record<string, number>>({})
  const [focused, setFocused] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showNewWs, setShowNewWs] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const refreshStatuses = useCallback(() => {
    void api.accountStatuses().then(setStatuses)
  }, [])

  useEffect(() => {
    void api.getState().then((s) => {
      setAccounts(s.accounts)
      setWorkspaces(s.workspaces)
      const valid = new Set([...s.workspaces.map((w) => w.id), ...s.accounts.map((a) => loginPaneId(a.id))])
      setOpenPanesState(s.openPanes.filter((p) => valid.has(p)))
      setAgents(s.agents)
      setLoaded(true)
    })
    refreshStatuses()
    const t = setInterval(refreshStatuses, 4000)
    const off = api.onAgentStatus((id, st) => setAgents((a) => ({ ...a, [id]: st })))
    return () => {
      clearInterval(t)
      off()
    }
  }, [refreshStatuses])

  const setOpenPanes = useCallback((updater: (prev: string[]) => string[]) => {
    setOpenPanesState((prev) => {
      const next = updater(prev)
      void api.setOpenPanes(next)
      return next
    })
  }, [])

  const openPane = (id: string): void => {
    setOpenPanes((p) => (p.includes(id) ? p : [...p, id]))
    setFocused(id)
  }
  const closePane = (id: string): void => setOpenPanes((p) => p.filter((x) => x !== id))
  const restartPane = async (id: string): Promise<void> => {
    await api.ptyKill(id)
    setGenerations((g) => ({ ...g, [id]: (g[id] ?? 0) + 1 }))
  }

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const wsById = useMemo(() => new Map(workspaces.map((w) => [w.id, w])), [workspaces])

  const addAccount = async (label: string): Promise<void> => {
    try {
      const acc = await api.addAccount(label)
      setAccounts((a) => [...a, acc])
      openPane(loginPaneId(acc.id))
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const removeAccount = async (acc: Account): Promise<void> => {
    if (!window.confirm(`¿Quitar la cuenta «${acc.label}» de AntiRea?`)) return
    try {
      await api.removeAccount(acc.id)
      setAccounts((a) => a.filter((x) => x.id !== acc.id))
      closePane(loginPaneId(acc.id))
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const removeWorkspace = async (ws: Workspace): Promise<void> => {
    const extra = ws.branch ? `\n\nEl worktree en ${ws.cwd} queda en disco.` : ''
    if (!window.confirm(`¿Quitar el espacio «${ws.name}»? Se cierra su terminal.${extra}`)) return
    await api.removeWorkspace(ws.id)
    setWorkspaces((w) => w.filter((x) => x.id !== ws.id))
    setOpenPanesState((p) => p.filter((x) => x !== ws.id))
  }

  const onTermError = useCallback((m: string) => setError(m), [])

  const cols = openPanes.length <= 1 ? 1 : openPanes.length <= 4 ? 2 : 3

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          AntiRea <span className="muted">multi-cuenta</span>
        </div>

        <section>
          <h2>Cuentas de Claude</h2>
          {accounts.length === 0 && <p className="hint">Agregá una cuenta para empezar.</p>}
          {accounts.map((acc) => {
            const st = statuses[acc.id]
            return (
              <div key={acc.id} className="row">
                <span className={`dot ${st?.loggedIn ? 'ok' : 'off'}`} title={st?.loggedIn ? 'Sesión iniciada' : 'Sin sesión'} />
                <div className="row-main">
                  <div className="row-title">{acc.label}</div>
                  <div className="row-sub">{st?.email ?? (st?.loggedIn ? 'Sesión iniciada' : 'Sin sesión')}</div>
                </div>
                <button className="ghost" onClick={() => openPane(loginPaneId(acc.id))} title="Abrir Claude con esta cuenta para iniciar sesión">
                  {st?.loggedIn ? 'Terminal' : 'Iniciar sesión'}
                </button>
                <button className="ghost danger" onClick={() => void removeAccount(acc)} title="Quitar cuenta">
                  ×
                </button>
              </div>
            )
          })}
          <AddAccount onAdd={addAccount} />
        </section>

        <section className="grow">
          <div className="section-head">
            <h2>Espacios</h2>
            <button className="primary small" disabled={accounts.length === 0} onClick={() => setShowNewWs(true)}>
              + Nuevo
            </button>
          </div>
          {workspaces.length === 0 && <p className="hint">Un espacio = un repo + una cuenta + una PowerShell.</p>}
          {workspaces.map((ws) => {
            const ag = agents[ws.id]
            const acc = accountById.get(ws.accountId)
            const open = openPanes.includes(ws.id)
            return (
              <div key={ws.id} className={`row clickable ${open ? 'active' : ''}`} onClick={() => openPane(ws.id)}>
                <span className={`dot state-${ag?.state ?? 'none'}`} title={ag ? STATE_LABEL[ag.state] : 'Sin abrir'} />
                <div className="row-main">
                  <div className="row-title">{ws.name}</div>
                  <div className="row-sub">
                    {acc?.label ?? 'cuenta borrada'} · {ws.branch ?? shortPath(ws.cwd)}
                  </div>
                </div>
                <button
                  className="ghost danger"
                  onClick={(e) => {
                    e.stopPropagation()
                    void removeWorkspace(ws)
                  }}
                  title="Quitar espacio"
                >
                  ×
                </button>
              </div>
            )
          })}
        </section>
      </aside>

      <main className="panes" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {loaded && openPanes.length === 0 && (
          <div className="empty">
            <h1>AntiRea</h1>
            <p>
              1. Agregá una cuenta y se abre Claude para que inicies sesión.
              <br />
              2. Creá un espacio con un repo y esa cuenta.
              <br />
              3. Abrí varios espacios: cada uno en su PowerShell, su repo y su cuenta.
            </p>
          </div>
        )}
        {openPanes.map((paneId) => {
          const login = isLoginPane(paneId)
          const ws = login ? undefined : wsById.get(paneId)
          const acc = login ? accountById.get(accountIdFromLoginPane(paneId)) : ws && accountById.get(ws.accountId)
          const ag = ws ? agents[ws.id] : undefined
          const email = acc ? statuses[acc.id]?.email : undefined
          return (
            <div
              key={paneId}
              className={`pane ${focused === paneId ? 'focused' : ''} ${ag ? `pane-${ag.state}` : ''}`}
              onMouseDown={() => setFocused(paneId)}
            >
              <div className="pane-head">
                <span className="account-badge" title={email}>
                  {acc?.label ?? '?'}
                </span>
                <span className="pane-title">{login ? 'Login / terminal de cuenta' : ws?.name}</span>
                {!login && ws && <span className="pane-path" title={ws.cwd}>{shortPath(ws.cwd)}</span>}
                {ag && (
                  <span className={`state-badge state-${ag.state}`} title={ag.detail}>
                    {STATE_LABEL[ag.state]}
                    {ag.state === 'working' && ag.detail ? ` · ${ag.detail}` : ''}
                  </span>
                )}
                <span className="spacer" />
                <button className="ghost small" onClick={() => void restartPane(paneId)} title="Cerrar el proceso y abrir otra terminal">
                  Reiniciar
                </button>
                <button className="ghost small" onClick={() => closePane(paneId)} title="Ocultar (la terminal sigue corriendo)">
                  Ocultar
                </button>
              </div>
              <TerminalView id={paneId} generation={generations[paneId] ?? 0} onError={onTermError} />
            </div>
          )
        })}
      </main>

      {showNewWs && (
        <NewWorkspaceDialog
          accounts={accounts}
          statuses={statuses}
          onClose={() => setShowNewWs(false)}
          onCreated={(ws) => {
            setWorkspaces((w) => [...w, ws])
            setShowNewWs(false)
            openPane(ws.id)
          }}
        />
      )}

      {error && (
        <div className="toast" onClick={() => setError(null)}>
          {error}
          <span className="muted"> (clic para cerrar)</span>
        </div>
      )}
    </div>
  )
}

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? p : `…\\${parts.slice(-2).join('\\')}`
}

function AddAccount({ onAdd }: { onAdd: (label: string) => Promise<void> }): React.JSX.Element {
  const [label, setLabel] = useState('')
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (!label.trim()) return
        void onAdd(label).then(() => setLabel(''))
      }}
    >
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Nombre (ej: Personal, Trabajo)" />
      <button className="primary small" type="submit" disabled={!label.trim()}>
        Agregar
      </button>
    </form>
  )
}

function NewWorkspaceDialog(props: {
  accounts: Account[]
  statuses: Record<string, AccountStatus>
  onClose: () => void
  onCreated: (ws: Workspace) => void
}): React.JSX.Element {
  const { accounts, statuses } = props
  const [name, setName] = useState('')
  const [repoPath, setRepoPath] = useState('')
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [useWorktree, setUseWorktree] = useState(false)
  const [branch, setBranch] = useState('')
  const [autoStartClaude, setAutoStart] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const pick = async (): Promise<void> => {
    const p = await api.pickFolder()
    if (p) {
      setRepoPath(p)
      if (!name) setName(p.split(/[\\/]/).filter(Boolean).pop() ?? '')
    }
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      const ws = await api.addWorkspace({
        name,
        repoPath,
        accountId,
        branch: useWorktree ? branch : undefined,
        autoStartClaude
      })
      props.onCreated(ws)
    } catch (e2) {
      setErr(cleanError(e2))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => void submit(e)}>
        <h2>Nuevo espacio</h2>
        <label>
          Repo
          <div className="input-row">
            <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="C:\ruta\al\repo" />
            <button type="button" className="ghost" onClick={() => void pick()}>
              Elegir…
            </button>
          </div>
        </label>
        <label>
          Nombre
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej: backend - cuenta trabajo" />
        </label>
        <label>
          Cuenta de Claude
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
                {statuses[a.id]?.email ? ` (${statuses[a.id]!.email})` : statuses[a.id]?.loggedIn ? '' : ' (sin sesión)'}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={useWorktree} onChange={(e) => setUseWorktree(e.target.checked)} />
          Trabajar en un worktree aparte (rama propia, no toca tu copia del repo)
        </label>
        {useWorktree && (
          <label>
            Rama
            <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feature/mi-cambio" />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={autoStartClaude} onChange={(e) => setAutoStart(e.target.checked)} />
          Abrir Claude automáticamente en la PowerShell
        </label>
        {err && <div className="form-error">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={props.onClose}>
            Cancelar
          </button>
          <button
            className="primary"
            type="submit"
            disabled={busy || !name.trim() || !repoPath.trim() || !accountId || (useWorktree && !branch.trim())}
          >
            {busy ? 'Creando…' : 'Crear espacio'}
          </button>
        </div>
      </form>
    </div>
  )
}
