import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  CheckCircle,
  Circle,
  Command as CommandIcon,
  Copy,
  FolderOpen,
  Info,
  Plus,
  ShieldCheck,
  SignIn,
  Terminal as TerminalIcon,
  Ticket,
  UsersThree,
  Warning,
  X,
  XCircle
} from '@phosphor-icons/react'
import { loginPaneId, type AccountStatus, type Workspace } from '../../../../shared/types'
import { useUi, type Command, type FeatureUi } from '../host'
import { LogoMark } from '../../Logo'
import { useVisiblePolling } from '../../visibility'
import { applyTeamSettings, cleanMsg, importTeam, repoName, scanTeams, settingsText, type ImportPlan, type TeamStatus } from '../team-config/store'
import { onOpen, requestOpen } from './bus'
import heroUrl from '../../assets/sloth-hero.webp'
import './onboarding.css'

type CheckState = 'ok' | 'warn' | 'missing'
interface CheckItem {
  id: string
  label: string
  state: CheckState
  detail?: string
  fix?: string
  command?: string
  doc?: string
  optional?: boolean
}
interface ObState {
  completed: boolean
  step: number
  repoPath?: string
  show: boolean
}

const STEPS = [
  { title: 'Entorno', sub: 'Claude Code, Node, git' },
  { title: 'Cuentas', sub: 'Iniciar sesión' },
  { title: 'Repo', sub: 'Y config del equipo' },
  { title: 'Primer espacio', sub: 'Y tres tips' }
]
const TICKET_RE = /^[A-Z][A-Z0-9]*-\d+$/

// ---------- Paso 1: entorno ----------

function StateBadge({ s, optional }: { s: CheckState; optional?: boolean }): React.JSX.Element {
  if (s === 'ok')
    return (
      <span className="f-onboarding-badge ok">
        <CheckCircle size={14} weight="fill" aria-hidden="true" /> Listo
      </span>
    )
  if (s === 'warn')
    return (
      <span className="f-onboarding-badge warn">
        <Warning size={14} weight="fill" aria-hidden="true" /> {optional ? 'Opcional' : 'Revisar'}
      </span>
    )
  return (
    <span className="f-onboarding-badge missing">
      <XCircle size={14} weight="fill" aria-hidden="true" /> Falta
    </span>
  )
}

function EnvStep(): React.JSX.Element {
  const ui = useUi()
  const [items, setItems] = useState<CheckItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const run = useCallback(() => {
    setBusy(true)
    ui.invoke<{ items: CheckItem[] }>('feat:onboarding:env')
      .then((r) => setItems(r.items))
      .catch((e) => ui.notifyError(cleanMsg(e)))
      .finally(() => setBusy(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(run, [run])
  const copy = (c: string): void => {
    window.sloth.clipboardWrite(c)
    setCopied(c)
    setTimeout(() => setCopied((x) => (x === c ? null : x)), 1500)
  }
  return (
    <>
      <p className="f-onboarding-lead">Sloth usa lo que ya tenés instalado. Revisamos que esté todo; lo opcional lo podés dejar para después.</p>
      <ul className="f-onboarding-checks" aria-busy={busy}>
        {(items ?? []).map((it) => (
          <li key={it.id} className={`is-${it.state}`}>
            <div className="f-onboarding-check-top">
              <span className="grow-min">
                <span className="item-title">{it.label}</span>
                {it.detail && <span className="item-sub mono">{it.detail}</span>}
              </span>
              <StateBadge s={it.state} optional={it.optional} />
            </div>
            {it.state !== 'ok' && (it.fix || it.command) && (
              <div className="f-onboarding-fix">
                {it.fix && <p>{it.fix}</p>}
                <div className="f-onboarding-fix-row">
                  {it.command && (
                    <code className="mono" title="Comando para PowerShell">
                      {it.command}
                    </code>
                  )}
                  {it.command && (
                    <button type="button" className="icon-btn" onClick={() => copy(it.command!)} aria-label={`Copiar «${it.command}»`} title="Copiar">
                      {copied === it.command ? <CheckCircle size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                    </button>
                  )}
                  {it.doc && (
                    <button type="button" className="btn sm ghost" onClick={() => void ui.invoke('feat:onboarding:openDoc', it.doc).catch((e) => ui.notifyError(cleanMsg(e)))}>
                      Guía oficial <ArrowSquareOut size={12} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            )}
          </li>
        ))}
        {!items && <li className="f-onboarding-loading">Revisando tu PC…</li>}
      </ul>
      <button type="button" className="btn sm ghost" disabled={busy} onClick={run}>
        <ArrowClockwise size={13} aria-hidden="true" className={busy ? 'spin' : ''} /> {busy ? 'Revisando…' : 'Volver a revisar'}
      </button>
    </>
  )
}

// ---------- Paso 2: cuentas ----------

function useLiveStatuses(active: boolean): Record<string, AccountStatus> {
  const ui = useUi()
  const [st, setSt] = useState<Record<string, AccountStatus>>(ui.statuses)
  useEffect(() => setSt((s) => ({ ...s, ...ui.statuses })), [ui.statuses])
  // Mientras esperamos el login, cada 3 s y solo con la ventana visible (lee dos archivos chicos).
  useVisiblePolling(() => {
    if (active) void window.sloth.accountStatuses().then(setSt).catch(() => undefined)
  }, 3000, [active])
  return st
}

function AccountsStep({ onLogin, statuses }: { onLogin: (id: string) => void; statuses: Record<string, AccountStatus> }): React.JSX.Element {
  const ui = useUi()
  const [label, setLabel] = useState(ui.accounts.length ? '' : 'Trabajo')
  const [busy, setBusy] = useState(false)
  const add = async (): Promise<void> => {
    if (!label.trim()) return
    setBusy(true)
    try {
      const acc = await window.sloth.addAccount(label.trim())
      await ui.reload()
      setLabel('')
      onLogin(acc.id)
    } catch (e) {
      ui.notifyError(cleanMsg(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <p className="f-onboarding-lead">Cada cuenta de Claude vive en su carpeta, con su propia sesión. Agregá una o más (por ejemplo, Trabajo y Personal).</p>
      {ui.accounts.length > 0 && (
        <ul className="f-onboarding-accs">
          {ui.accounts.map((a) => {
            const s = statuses[a.id]
            return (
              <li key={a.id}>
                <span className="acc-chip" aria-hidden="true">
                  {a.label.slice(0, 1).toUpperCase()}
                </span>
                <span className="grow-min">
                  <span className="item-title">{a.label}</span>
                  <span className={`item-sub ${s?.loggedIn ? '' : 'warn'}`}>{s?.loggedIn ? (s.email ?? 'Sesión iniciada') : 'Sin sesión'}</span>
                </span>
                {s?.loggedIn ? (
                  <span className="f-onboarding-badge ok">
                    <CheckCircle size={14} weight="fill" aria-hidden="true" /> Sesión iniciada
                  </span>
                ) : (
                  <button type="button" className="btn sm" onClick={() => onLogin(a.id)}>
                    <SignIn size={13} aria-hidden="true" /> Iniciar sesión
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <form
        className="f-onboarding-add"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <label htmlFor="f-ob-acc" className="sr-only">
          Nombre de la cuenta
        </label>
        <input id="f-ob-acc" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} placeholder="Nombre: Trabajo, Personal…" />
        <button type="submit" className="btn primary" disabled={!label.trim() || busy}>
          <Plus size={13} weight="bold" aria-hidden="true" /> {ui.accounts.length ? 'Agregar otra cuenta' : 'Agregar cuenta'}
        </button>
      </form>
      <div className="f-onboarding-note">
        <Info size={15} aria-hidden="true" />
        <p>
          Se abre una terminal con Claude: elegí iniciar sesión y se abre el navegador. <strong>Para la segunda cuenta</strong>, el navegador ya tiene la primera
          iniciada: copiá el link que muestra la terminal y pegalo en una <strong>ventana de incógnito</strong> (Ctrl+Shift+N), así entrás con la otra.
        </p>
      </div>
    </>
  )
}

/** Mientras se inicia sesión, el asistente se achica a una tarjeta y deja ver la terminal. */
function LoginDock({ accountId, statuses, onBack }: { accountId: string; statuses: Record<string, AccountStatus>; onBack: () => void }): React.JSX.Element {
  const ui = useUi()
  const acc = ui.accounts.find((a) => a.id === accountId)
  const st = statuses[accountId]
  const second = ui.accounts.length > 1
  useEffect(() => {
    if (!st?.loggedIn) return
    const t = setTimeout(onBack, 1400)
    return () => clearTimeout(t)
  }, [st?.loggedIn, onBack])
  return (
    <aside className="f-onboarding-dock" aria-label="Asistente de bienvenida: inicio de sesión" aria-live="polite">
      <div className="f-onboarding-dock-head">
        <LogoMark size={20} />
        <strong className="grow-min">Iniciá sesión en «{acc?.label ?? 'la cuenta'}»</strong>
      </div>
      {st?.loggedIn ? (
        <p className="f-onboarding-dock-ok">
          <CheckCircle size={16} weight="fill" aria-hidden="true" /> Sesión iniciada{st.email ? ` como ${st.email}` : ''}. Volviendo al asistente…
        </p>
      ) : (
        <ol className="f-onboarding-dock-steps">
          <li>En la terminal, elegí el método de inicio de sesión y apretá Enter.</li>
          <li>{second ? 'Copiá el link que aparece y abrilo en una ventana de incógnito (Ctrl+Shift+N).' : 'Se abre el navegador: autorizá a Claude Code.'}</li>
          <li>Cuando termine, esta tarjeta se marca sola.</li>
        </ol>
      )}
      <div className="f-onboarding-dock-foot">
        {!st?.loggedIn && (
          <span className="f-onboarding-wait">
            <Circle size={10} weight="fill" aria-hidden="true" className="f-onboarding-pulse" /> Esperando…
          </span>
        )}
        <button type="button" className="btn sm" onClick={onBack}>
          Volver al asistente
        </button>
      </div>
      <span className="sr-only">{ui.openPanes.includes(loginPaneId(accountId)) ? '' : 'La terminal de la cuenta está cerrada.'}</span>
    </aside>
  )
}

// ---------- Paso 3: repo ----------

function RepoStep({ repo, setRepo }: { repo: string; setRepo: (p: string) => void }): React.JSX.Element {
  const ui = useUi()
  const [list, setList] = useState<string[]>([])
  const [preferred, setPreferred] = useState('')
  const [info, setInfo] = useState<{ isGit: boolean } | null>(null)
  const [team, setTeam] = useState<TeamStatus | null>(null)
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [withSettings, setWithSettings] = useState(true)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    ui.invoke<{ list: string[]; preferred: string }>('feat:onboarding:suggestRepos').then((r) => {
      setList(r.list)
      setPreferred(r.preferred)
      if (!repo && r.list[0]) setRepo(r.list[0])
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setInfo(null)
    setTeam(null)
    setPlan(null)
    setDone(null)
    setErr(null)
    if (!repo) return
    let alive = true
    ui.invoke<{ isGit: boolean }>('feat:onboarding:inspectRepo', repo)
      .then(async (r) => {
        if (!alive) return
        setInfo(r)
        const t = await ui.invoke<TeamStatus | null>('feat:team-config:inspect', repo)
        if (!alive) return
        setTeam(t)
        if (t?.state === 'ok') setPlan(await ui.invoke<ImportPlan>('feat:team-config:plan', repo))
      })
      .catch((e) => alive && setErr(cleanMsg(e)))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo])

  const pick = async (): Promise<void> => {
    const p = await window.sloth.pickFolder()
    if (p) setRepo(p)
  }
  const load = async (): Promise<void> => {
    if (!team || !plan) return
    setBusy(true)
    setErr(null)
    try {
      const r = await importTeam(ui, repo, plan)
      if (withSettings && team.ajustes && team.settingsPending) await applyTeamSettings(ui, repo, team.ajustes)
      await scanTeams(ui, [repo])
      setDone(`Listo: ${r.created + r.updated} plantilla${r.created + r.updated === 1 ? '' : 's'} del equipo en tu lista.`)
      if (r.errors.length) setErr(r.errors.join('\n'))
    } catch (e) {
      setErr(cleanMsg(e))
    } finally {
      setBusy(false)
    }
  }
  const todo = plan?.items.filter((i) => !i.error && i.action !== 'same').length ?? 0

  return (
    <>
      <p className="f-onboarding-lead">Elegí la carpeta del repo con el que vas a trabajar. Si el repo trae la configuración del equipo, la cargamos.</p>
      <div className="f-onboarding-repos" role="radiogroup" aria-label="Repos encontrados">
        {list.map((p) => (
          <button key={p} type="button" role="radio" aria-checked={repo === p} className={`f-onboarding-repo ${repo === p ? 'on' : ''}`} onClick={() => setRepo(p)}>
            {repo === p ? <CheckCircle size={15} weight="fill" aria-hidden="true" /> : <Circle size={15} aria-hidden="true" />}
            <span className="grow-min">
              <span className="item-title">{repoName(p)}</span>
              <span className="item-sub mono">{p}</span>
            </span>
          </button>
        ))}
        {list.length === 0 && (
          <p className="hint">
            No encontré <span className="mono">{preferred}</span> ni otras rutas comunes. Elegí la carpeta a mano.
          </p>
        )}
      </div>
      <div className="input-row">
        <input aria-label="Carpeta del repo" className="mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder={preferred} />
        <button type="button" className="btn" onClick={() => void pick()}>
          <FolderOpen size={15} aria-hidden="true" /> Elegir
        </button>
      </div>
      {info && !info.isGit && (
        <p className="f-onboarding-warn">
          <Warning size={14} weight="fill" aria-hidden="true" /> Esa carpeta no parece un repo de git (no tiene .git). Igual podés usarla.
        </p>
      )}
      {team?.state === 'invalid' && (
        <p className="f-onboarding-warn">
          <Warning size={14} weight="fill" aria-hidden="true" /> Este repo trae .sloth/team.json pero tiene un error: {team.error}
        </p>
      )}
      {team?.state === 'ok' && (
        <div className="f-onboarding-team">
          <div className="f-onboarding-team-head">
            <UsersThree size={18} weight="duotone" aria-hidden="true" />
            <span className="grow-min">
              <strong>Configuración del equipo «{team.equipo}»</strong>
              <span className="item-sub">
                {team.total} plantilla{team.total === 1 ? '' : 's'}
                {team.links.length ? ` · ${team.links.map((l) => l.nombre).join(', ')}` : ''}
              </span>
            </span>
          </div>
          {plan && plan.items.length > 0 && (
            <ul className="f-onboarding-team-list">
              {plan.items.map((i) => (
                <li key={i.key}>
                  {i.error ? <Warning size={12} aria-hidden="true" /> : <CheckCircle size={12} aria-hidden="true" />} {i.savedName}
                  {i.error ? ` — ${i.error}` : ''}
                </li>
              ))}
            </ul>
          )}
          {team.ajustes && team.settingsPending && (
            <label className="check">
              <input type="checkbox" checked={withSettings} onChange={(e) => setWithSettings(e.target.checked)} />
              <span>
                Aplicar los ajustes que recomienda el equipo
                <small>{settingsText(team.ajustes)}</small>
              </span>
            </label>
          )}
          {done ? (
            <p className="f-onboarding-okline" role="status">
              <CheckCircle size={14} weight="fill" aria-hidden="true" /> {done}
            </p>
          ) : (
            <button type="button" className="btn primary sm" disabled={busy || !plan || (todo === 0 && !(withSettings && team.settingsPending))} onClick={() => void load()}>
              {busy ? 'Cargando…' : todo ? `Cargar configuración del equipo` : 'Ya está cargada'}
            </button>
          )}
        </div>
      )}
      {err && <p className="form-error f-onboarding-pre">{err}</p>}
    </>
  )
}

// ---------- Paso 4: primer espacio y tour ----------

function SpaceStep({ repo, statuses, onCreated }: { repo: string; statuses: Record<string, AccountStatus>; onCreated: (ws: Workspace) => void }): React.JSX.Element {
  const ui = useUi()
  const logged = ui.accounts.filter((a) => statuses[a.id]?.loggedIn)
  const [mode, setMode] = useState<'normal' | 'ticket'>('normal')
  const [name, setName] = useState(repo ? repoName(repo) : '')
  const [ticket, setTicket] = useState('')
  const [accountId, setAccountId] = useState((logged[0] ?? ui.accounts[0])?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const tk = ticket.trim().toUpperCase()
  const tkOk = TICKET_RE.test(tk)
  const can = Boolean(repo && accountId && (mode === 'ticket' ? tkOk : name.trim()))

  const create = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const ws = await window.sloth.addWorkspace(
        mode === 'ticket'
          ? { name: name.trim() && name.trim() !== repoName(repo) ? name.trim() : tk, repoPath: repo, accountId, autoStartClaude: true, ticket: tk, initialPrompt: `/ticket ${tk}`, resume: true }
          : { name: name.trim(), repoPath: repo, accountId, autoStartClaude: true, resume: true }
      )
      await ui.reload()
      ui.openPane(ws.id)
      onCreated(ws)
    } catch (e) {
      setErr(cleanMsg(e))
    } finally {
      setBusy(false)
    }
  }

  if (!ui.accounts.length)
    return <p className="f-onboarding-warn">Agregá una cuenta primero (paso 2) para poder crear un espacio.</p>
  return (
    <>
      <p className="f-onboarding-lead">
        Un espacio = un repo + una cuenta + una PowerShell con Claude. {repo ? <>Va en <span className="mono">{repoName(repo)}</span>.</> : 'Elegí el repo en el paso anterior.'}
      </p>
      <div className="f-onboarding-seg" role="radiogroup" aria-label="Tipo de espacio">
        <button type="button" role="radio" aria-checked={mode === 'normal'} className={mode === 'normal' ? 'on' : ''} onClick={() => setMode('normal')}>
          <TerminalIcon size={15} aria-hidden="true" /> Normal
        </button>
        <button type="button" role="radio" aria-checked={mode === 'ticket'} className={mode === 'ticket' ? 'on' : ''} onClick={() => setMode('ticket')}>
          <Ticket size={15} aria-hidden="true" /> Desde ticket
        </button>
      </div>
      {mode === 'ticket' && (
        <div className="field">
          <label htmlFor="f-ob-tk">Ticket</label>
          <input id="f-ob-tk" className="mono" value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="TCK-1234" aria-invalid={ticket.trim() !== '' && !tkOk} />
          <p className={ticket.trim() && !tkOk ? 'field-error' : 'field-help'}>
            {ticket.trim() && !tkOk ? 'Tiene que ser tipo TCK-1234.' : `Arranca Claude con «/ticket ${tkOk ? tk : 'TCK-…'}».`}
          </p>
        </div>
      )}
      <div className="f-onboarding-grid2">
        <div className="field">
          <label htmlFor="f-ob-name">Nombre{mode === 'ticket' ? ' (opcional)' : ''}</label>
          <input id="f-ob-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="f-ob-accsel">Cuenta</label>
          <select id="f-ob-accsel" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {ui.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
                {statuses[a.id]?.loggedIn ? '' : ' (sin sesión)'}
              </option>
            ))}
          </select>
        </div>
      </div>
      {err && <p className="form-error">{err}</p>}
      <button type="button" className="btn primary" disabled={!can || busy} onClick={() => void create()}>
        <Plus size={13} weight="bold" aria-hidden="true" /> {busy ? 'Creando…' : 'Crear espacio'}
      </button>
    </>
  )
}

const TIPS = [
  { icon: CommandIcon, title: 'Ctrl+K para todo', text: 'La paleta busca espacios, plantillas y acciones. También reabre este asistente.' },
  { icon: ShieldCheck, title: 'Permisos desde la app', text: 'Cuando Claude pide usar una herramienta, aparece una tarjeta en su panel: permitir, siempre o negar.' },
  { icon: TerminalIcon, title: 'Las terminales siguen vivas', text: 'Si cerrás Sloth, Claude sigue trabajando. Al volver a abrir, cada panel se reconecta donde estaba.' }
]

function Tour(): React.JSX.Element {
  return (
    <>
      <p className="f-onboarding-lead">¡Listo! Tres cosas que conviene saber:</p>
      <ol className="f-onboarding-tips">
        {TIPS.map((t, i) => (
          <li key={t.title}>
            <span className="f-onboarding-tip-ic" aria-hidden="true">
              <t.icon size={18} weight="duotone" />
            </span>
            <span>
              <strong>
                {i + 1}. {t.title}
              </strong>
              <span>{t.text}</span>
            </span>
          </li>
        ))}
      </ol>
    </>
  )
}

// ---------- El asistente ----------

function Wizard({ initial, onClose }: { initial: ObState; onClose: (completed: boolean) => void }): React.JSX.Element {
  const ui = useUi()
  const [step, setStepState] = useState(initial.step)
  const [repo, setRepoState] = useState(initial.repoPath ?? '')
  const [docked, setDocked] = useState<string | null>(null)
  const [tour, setTour] = useState(false)
  const headRef = useRef<HTMLHeadingElement>(null)
  const statuses = useLiveStatuses(step === 1 || docked !== null)

  const persist = (patch: Record<string, unknown>): void => void ui.invoke('feat:onboarding:save', patch).catch(() => undefined)
  const setStep = (n: number): void => {
    setStepState(n)
    setTour(false)
    persist({ step: n })
  }
  const setRepo = (p: string): void => {
    setRepoState(p)
    if (/^[A-Za-z]:\\/.test(p)) persist({ repoPath: p })
  }
  const finish = (skipped: boolean): void => {
    void ui.invoke('feat:onboarding:save', { completed: true, skipped, step: 0 }).catch(() => undefined)
    onClose(true)
  }
  const login = (id: string): void => {
    ui.openPane(loginPaneId(id))
    setDocked(id)
  }
  const undock = useCallback(() => setDocked(null), [])

  useEffect(() => {
    if (!docked) headRef.current?.focus()
  }, [step, tour, docked])
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || docked || document.querySelector('.modal-backdrop')) return
      onClose(false)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [docked, onClose])

  if (docked) return <LoginDock accountId={docked} statuses={statuses} onBack={undock} />

  const loggedCount = ui.accounts.filter((a) => statuses[a.id]?.loggedIn).length
  const doneFlags = [step > 0, loggedCount > 0, Boolean(repo) && step > 2, ui.workspaces.length > 0]
  const last = step === STEPS.length - 1
  const title = tour ? 'Tres tips y a trabajar' : ['Revisemos tu PC', 'Tus cuentas de Claude', 'El repo del equipo', 'Tu primer espacio'][step]

  const renderBody = (): React.JSX.Element => (
    <div className="f-onboarding-body">
      {step === 0 && <EnvStep />}
      {step === 1 && <AccountsStep onLogin={login} statuses={statuses} />}
      {step === 2 && <RepoStep repo={repo} setRepo={setRepo} />}
      {step === 3 && (tour ? <Tour /> : <SpaceStep repo={repo} statuses={statuses} onCreated={() => setTour(true)} />)}
    </div>
  )
  const renderFoot = (): React.JSX.Element => (
    <footer className="f-onboarding-foot">
      {step > 0 && (
        <button type="button" className="btn ghost" onClick={() => (tour ? setTour(false) : setStep(step - 1))}>
          <ArrowLeft size={14} aria-hidden="true" /> Atrás
        </button>
      )}
      <span className="spacer" />
      {last && tour ? (
        <button type="button" className="btn primary" onClick={() => finish(false)}>
          Empezar a usar Sloth
        </button>
      ) : last ? (
        <button type="button" className="btn ghost" onClick={() => setTour(true)}>
          {ui.workspaces.length ? 'Ver los tips' : 'Saltar paso'}
        </button>
      ) : (
        <>
          <button type="button" className="btn ghost" onClick={() => setStep(step + 1)}>
            Saltar paso
          </button>
          <button type="button" className="btn primary" onClick={() => setStep(step + 1)}>
            Siguiente <ArrowRight size={14} aria-hidden="true" />
          </button>
        </>
      )}
    </footer>
  )

  return (
    <div className="f-onboarding" role="dialog" aria-modal="true" aria-labelledby="f-ob-title">
      <div className="f-onboarding-card">
        <div className="f-onboarding-hero">
          <img className="f-onboarding-hero-img" src={heroUrl} alt="" aria-hidden="true" draggable={false} />
          <div className="f-onboarding-hero-text">
            <p className="f-onboarding-hero-title">Bienvenido a Sloth</p>
            <p className="f-onboarding-hero-sub">Trabajá con varias cuentas de Claude al mismo tiempo, cada una en su carpeta y su terminal. Sin apuro, sin mezclar nada.</p>
          </div>
          <button type="button" className="f-onboarding-skip" onClick={() => finish(true)}>
            Saltar asistente
          </button>
        </div>
        <section className="f-onboarding-main">
          <header className="f-onboarding-head">
            <div className="f-onboarding-topbar">
              <span className="f-onboarding-kicker">
                Paso {step + 1} de {STEPS.length}
              </span>
              <div className="f-onboarding-progress" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={step + 1} aria-label={`Paso ${step + 1} de ${STEPS.length}`}>
                <span style={{ width: `${((step + (tour ? 1 : 0.5)) / STEPS.length) * 100}%` }} />
              </div>
              <button type="button" className="icon-btn" onClick={() => onClose(false)} aria-label="Cerrar el asistente (seguís después desde Ctrl+K)" title="Cerrar (Esc)">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <h2 className="f-onboarding-section">Empezá en cuatro pasos</h2>
          </header>
          <ol className="f-onboarding-steps">
            {STEPS.map((s, i) => {
              if (i === step)
                return (
                  <li key={s.title} className="f-onboarding-step is-current" aria-current="step">
                    <div className="f-onboarding-step-card">
                      <div className="f-onboarding-step-top">
                        <span className="f-onboarding-n on" aria-hidden="true">
                          {i + 1}
                        </span>
                        <h1 id="f-ob-title" ref={headRef} tabIndex={-1}>
                          {title}
                        </h1>
                      </div>
                      {renderBody()}
                      {renderFoot()}
                    </div>
                  </li>
                )
              const done = doneFlags[i]
              return (
                <li key={s.title} className="f-onboarding-step">
                  <button type="button" className={`f-onboarding-step-btn ${done ? 'is-done' : ''}`} onClick={() => setStep(i)}>
                    <span className={`f-onboarding-n ${done ? 'ok' : ''}`} aria-hidden="true">
                      {done ? <CheckCircle size={14} weight="bold" /> : i + 1}
                    </span>
                    <span className="grow-min">
                      <span className="item-title">{s.title}</span>
                      <span className={`item-sub ${done ? 'ok' : ''}`}>{done ? 'Listo' : s.sub}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
          <p className="f-onboarding-keys">
            <kbd>Ctrl K</kbd> buscar cualquier cosa · <kbd>Ctrl ,</kbd> configuración · <kbd>?</kbd> atajos
          </p>
        </section>
      </div>
    </div>
  )
}

function Global(): React.JSX.Element | null {
  const ui = useUi()
  const [state, setState] = useState<ObState | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    ui.invoke<ObState>('feat:onboarding:state')
      .then((s) => {
        setState(s)
        if (s.show) setOpen(true)
      })
      .catch(() => undefined)
    return onOpen(() => {
      void ui.invoke<ObState>('feat:onboarding:state').then((s) => {
        setState({ ...s, step: s.completed ? 0 : s.step })
        setOpen(true)
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const close = useCallback(() => setOpen(false), [])
  if (!open || !state) return null
  return <Wizard initial={state} onClose={close} />
}

const ui: FeatureUi = {
  name: 'onboarding',
  Global,
  commands: (): Command[] => [
    {
      id: 'onboarding:open',
      title: 'Asistente de bienvenida',
      subtitle: 'Revisar el entorno, agregar cuentas, elegir el repo y crear un espacio',
      group: 'Ayuda',
      keywords: 'bienvenida onboarding asistente configurar inicio primeros pasos',
      run: requestOpen
    }
  ]
}

export default ui
