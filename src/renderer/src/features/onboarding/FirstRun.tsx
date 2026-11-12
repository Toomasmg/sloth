import { useCallback, useEffect, useState } from 'react'
import { AccountIcon, AddAccountIcon, ChangesIcon, ChevronDownIcon, DoneIcon, ErrorIcon, ExportIcon, HelpIcon, KeyboardIcon, TeamIcon, TicketIcon, UpdateIcon } from '../../icons/SlothIcons'
import { loginPaneId, type AccountStatus } from '../../../../shared/types'
import { useUi } from '../host'
import { useVisiblePolling } from '../../visibility'
import { setBoardOpen } from '../tickets/model'
import { setTeamOpen } from '../team/model'
import { openHelp } from '../help/bus'
import { cleanMsg } from '../team-config/store'
import { Button, EmptyState, IconButton, Input } from '../../ui'
import { setDocked } from './bus'
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
  skipped?: boolean
}

const SHORT: Record<string, string> = { claude: 'Claude Code', node: 'Node', git: 'Git', gh: 'gh' }

function useLiveStatuses(active: boolean): Record<string, AccountStatus> {
  const ui = useUi()
  const [st, setSt] = useState<Record<string, AccountStatus>>(ui.statuses)
  useEffect(() => setSt((s) => ({ ...s, ...ui.statuses })), [ui.statuses])
  // Mientras se espera el login, cada 3 s y solo con la ventana visible (lee dos archivos chicos).
  useVisiblePolling(
    () => {
      if (active) void window.sloth.accountStatuses().then(setSt).catch(() => undefined)
    },
    3000,
    [active]
  )
  return st
}

function CheckList({ items, onRecheck, busy }: { items: CheckItem[]; onRecheck: () => void; busy: boolean }): React.JSX.Element {
  const ui = useUi()
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (c: string): void => {
    window.sloth
      .clipboardWrite(c)
      .then(() => {
        setCopied(c)
        setTimeout(() => setCopied((x) => (x === c ? null : x)), 1500)
      })
      .catch((e) => ui.notifyError(cleanMsg(e)))
  }
  return (
    <div className="fr-detail">
      <ul className="fr-checks" aria-busy={busy}>
        {items.map((it) => (
          <li key={it.id} className={`is-${it.state}`}>
            <div className="fr-check-top">
              <span className="fr-grow">
                <span className="fr-item-title">{it.label}</span>
                {it.detail && <span className="fr-item-sub mono">{it.detail}</span>}
              </span>
              {it.state === 'ok' ? (
                <span className="fr-badge ok">
                  <DoneIcon size={14} /> Listo
                </span>
              ) : (
                <span className={`fr-badge ${it.optional ? 'opt' : 'bad'}`}>
                  <ErrorIcon size={14} /> {it.optional ? 'Opcional' : it.state === 'missing' ? 'Falta' : 'Revisar'}
                </span>
              )}
            </div>
            {it.state !== 'ok' && (it.fix || it.command) && (
              <div className="fr-fix">
                {it.fix && <p>{it.fix}</p>}
                <div className="fr-fix-row">
                  {it.command && <code className="mono">{it.command}</code>}
                  {it.command && <IconButton label={`Copiar «${it.command}»`} icon={copied === it.command ? <DoneIcon size={14} /> : <ChangesIcon size={14} />} onClick={() => copy(it.command!)} />}
                  {it.doc && (
                    <Button variant="ghost" size="sm" onClick={() => void ui.invoke('feat:onboarding:openDoc', it.doc).catch((e) => ui.notifyError(cleanMsg(e)))}>
                      Guía oficial <ExportIcon size={12} />
                    </Button>
                  )}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onRecheck}>
        <UpdateIcon size={13} className={busy ? 'spin' : ''} /> {busy ? 'Revisando…' : 'Volver a revisar'}
      </Button>
    </div>
  )
}

function AccountsBody({ statuses }: { statuses: Record<string, AccountStatus> }): React.JSX.Element {
  const ui = useUi()
  const [label, setLabel] = useState(ui.accounts.length ? '' : 'Trabajo')
  const [busy, setBusy] = useState(false)
  const login = (id: string): void => {
    ui.openPane(loginPaneId(id))
    setDocked(id)
  }
  const add = async (): Promise<void> => {
    if (!label.trim()) return
    setBusy(true)
    try {
      const acc = await window.sloth.addAccount(label.trim())
      await ui.reload()
      setLabel('')
      login(acc.id)
    } catch (e) {
      ui.notifyError(cleanMsg(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="fr-detail">
      {ui.accounts.length > 0 && (
        <ul className="fr-accs">
          {ui.accounts.map((a) => {
            const s = statuses[a.id]
            return (
              <li key={a.id}>
                <span className="fr-acc-chip" aria-hidden="true">
                  {a.label.slice(0, 1).toUpperCase()}
                </span>
                <span className="fr-grow">
                  <span className="fr-item-title">{a.label}</span>
                  <span className={`fr-item-sub${s?.loggedIn ? '' : ' warn'}`}>{s?.loggedIn ? (s.email ?? 'Sesión iniciada') : 'Sin sesión'}</span>
                </span>
                {s?.loggedIn ? (
                  <span className="fr-badge ok">
                    <DoneIcon size={14} /> Sesión iniciada
                  </span>
                ) : (
                  <Button size="sm" variant="primary" icon={<AccountIcon size={13} />} onClick={() => login(a.id)}>
                    Iniciar sesión
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <form
        className="fr-add"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <div className="fr-add-field">
          <label htmlFor="fr-acc">Nombre para reconocerla</label>
          <Input id="fr-acc" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} placeholder="Ej.: Tomy" />
        </div>
        <Button variant={ui.accounts.length ? 'secondary' : 'primary'} type="submit" loading={busy} disabled={!label.trim()} icon={<AddAccountIcon size={13} />}>
          {ui.accounts.length ? 'Agregar otra cuenta' : 'Agregar cuenta'}
        </Button>
      </form>
      <p className="fr-note">
        <HelpIcon size={15} />
        <span>
          Se abre una terminal con Claude: elegí iniciar sesión y se abre el navegador. <strong>Para la segunda cuenta</strong>, el navegador ya tiene la primera iniciada: copiá el link que muestra la
          terminal y pegalo en una <strong>ventana de incógnito</strong> (Ctrl+Shift+N).
        </span>
      </p>
    </div>
  )
}

/** «Empecemos»: la guía de primer uso, dentro del área principal. Sin espacios abiertos reemplaza al estado vacío. */
export function FirstRun({ embedded = false }: { embedded?: boolean }): React.JSX.Element {
  const ui = useUi()
  const [items, setItems] = useState<CheckItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState(false)
  const [hidden, setHidden] = useState<boolean | null>(embedded ? false : null)
  const statuses = useLiveStatuses(true)

  const run = useCallback(() => {
    setBusy(true)
    ui.invoke<{ items: CheckItem[] }>('feat:onboarding:env')
      .then((r) => setItems(r.items))
      .catch((e) => ui.notifyError(cleanMsg(e)))
      .finally(() => setBusy(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(run, [run])

  useEffect(() => {
    if (embedded) return
    ui.invoke<ObState>('feat:onboarding:state')
      .then((s) => setHidden(Boolean(s.skipped)))
      .catch(() => setHidden(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded])

  const hide = (): void => {
    setHidden(true)
    void ui.invoke('feat:onboarding:save', { completed: true, skipped: true }).catch(() => undefined)
  }

  if (hidden === null) return <div className="fr-wrap" aria-busy="true" />
  if (hidden)
    return (
      <div className="fr-wrap">
        <EmptyState
          size="lg"
          title="No hay espacios abiertos"
          description="Elegí uno de la barra lateral o creá uno nuevo."
          action={
            <Button variant="primary" onClick={() => ui.openNewWorkspace('normal')}>
              Nuevo espacio
            </Button>
          }
        />
      </div>
    )

  const blocking = (items ?? []).filter((i) => i.state !== 'ok' && !i.optional)
  const pcOk = items !== null && blocking.length === 0
  const accountOk = ui.accounts.some((a) => statuses[a.id]?.loggedIn)
  const spaceOk = ui.workspaces.length > 0
  const current = !pcOk ? 0 : !accountOk ? 1 : 2
  const found = (items ?? []).filter((i) => i.state === 'ok' && SHORT[i.id]).map((i) => SHORT[i.id])
  const pcSub = items === null ? 'Revisando lo que ya tenés instalado…' : pcOk ? `${found.length ? found.join(', ') : 'Todo'} encontrados.` : `Falta: ${blocking.map((i) => SHORT[i.id] ?? i.label).join(', ')}.`
  const openDetail = detail || (items !== null && !pcOk)

  const marker = (n: number, done: boolean): React.JSX.Element => (
    <span className={`fr-n${done ? ' done' : n - 1 === current ? ' on' : ''}`} aria-hidden="true">
      {done ? <DoneIcon size={14} /> : n}
    </span>
  )

  return (
    <div className="fr-wrap">
      <div className="fr-col">
        <h1 className="fr-title">Empecemos</h1>
        <p className="fr-lead">Tres pasos y tenés a Claude trabajando en tu repo. Podés usar varias cuentas a la vez, cada una en su terminal.</p>

        <ol className="fr-steps" aria-label="Pasos para empezar">
          <li className={`fr-step${current === 0 ? ' is-current' : ''}${pcOk ? ' is-done' : ''}`}>
            <div className="fr-step-row">
              {marker(1, pcOk)}
              <div className="fr-grow">
                <h2 className="fr-step-title">{pcOk ? 'Tu PC está lista' : 'Revisá tu PC'}</h2>
                <p className="fr-step-sub" aria-live="polite">
                  {pcSub}
                </p>
              </div>
              <Button variant={current === 0 ? 'primary' : 'ghost'} size="sm" aria-expanded={openDetail} aria-controls="fr-pc-detail" onClick={() => setDetail((v) => !v)} icon={<ChevronDownIcon size={14} />}>
                {openDetail ? 'Ocultar detalle' : 'Ver detalle'}
              </Button>
            </div>
            {openDetail && items && (
              <div id="fr-pc-detail">
                <CheckList items={items} onRecheck={run} busy={busy} />
              </div>
            )}
          </li>

          <li className={`fr-step${current === 1 ? ' is-current' : ''}${accountOk ? ' is-done' : ''}`}>
            <div className="fr-step-row">
              {marker(2, accountOk)}
              <div className="fr-grow">
                <h2 className="fr-step-title">{accountOk ? 'Tu cuenta de Claude' : 'Agregá tu cuenta de Claude'}</h2>
                <p className="fr-step-sub">{accountOk ? `${ui.accounts.filter((a) => statuses[a.id]?.loggedIn).length} con sesión iniciada.` : 'Se abre una terminal para iniciar sesión. Sloth nunca ve tu contraseña.'}</p>
              </div>
            </div>
            {(current === 1 || !accountOk) && <AccountsBody statuses={statuses} />}
          </li>

          <li className={`fr-step${current === 2 ? ' is-current' : ''}${spaceOk ? ' is-done' : ''}`}>
            <div className="fr-step-row">
              {marker(3, spaceOk)}
              <div className="fr-grow">
                <h2 className="fr-step-title">Creá tu primer espacio</h2>
                <p className="fr-step-sub">Elegí la carpeta de un repo o soltala en la ventana.</p>
              </div>
              <Button variant={current === 2 ? 'primary' : 'secondary'} size="sm" onClick={() => ui.openNewWorkspace('normal')}>
                Nuevo espacio
              </Button>
            </div>
          </li>
        </ol>

        <h2 className="fr-later">Después, si querés</h2>
        <div className="fr-cards">
          <button type="button" className="fr-card" onClick={() => setBoardOpen(true)}>
            <span className="fr-card-title">
              <TicketIcon size={14} /> Conectar tus tickets
            </span>
            <span className="fr-card-sub">Jira, GitHub, Linear y más</span>
          </button>
          <button type="button" className="fr-card" onClick={() => setTeamOpen(true)}>
            <span className="fr-card-title">
              <TeamIcon size={14} /> Sumar a tu equipo
            </span>
            <span className="fr-card-sub">PRs, tickets y chat compartidos</span>
          </button>
          <button type="button" className="fr-card" onClick={() => openHelp('shortcuts')}>
            <span className="fr-card-title">
              <KeyboardIcon size={14} /> Aprender los atajos
            </span>
            <span className="fr-card-sub">Ctrl K abre todo</span>
          </button>
        </div>
        {!embedded && (
          <p className="fr-hide">
            <button type="button" className="fr-link" onClick={hide}>
              No mostrar más esta guía
            </button>
            <span> · queda en la paleta (Ctrl K) como «Primeros pasos».</span>
          </p>
        )}
      </div>
    </div>
  )
}
