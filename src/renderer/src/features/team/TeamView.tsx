import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowClockwise,
  ArrowSquareOut,
  CheckCircle,
  ChatCircleDots,
  CircleDashed,
  CircleNotch,
  GitPullRequest,
  LinkSimple,
  Play,
  Prohibit,
  Robot,
  Ticket,
  UsersThree,
  WarningCircle,
  X,
  XCircle
} from '@phosphor-icons/react'
import { useUi } from '../host'
import { cleanError, fmtTok } from '../../format'
import type { Workspace } from '../../../../shared/types'
import {
  age,
  initials,
  NADIE,
  personColor,
  PR_URL_RE,
  setTeamOpen,
  setTeamSnapshot,
  timeAgo,
  useTeamSnapshot,
  type Person,
  type TeamPr,
  type TeamSnapshot,
  type TeamTicket
} from './model'

const CI = {
  pass: { label: 'pasa', Icon: CheckCircle, cls: 'ok' },
  fail: { label: 'falla', Icon: XCircle, cls: 'bad' },
  running: { label: 'corriendo', Icon: CircleNotch, cls: 'run' },
  none: { label: 'sin CI', Icon: CircleDashed, cls: 'mute' }
} as const
const REVIEW = {
  approved: { label: 'aprobado', Icon: CheckCircle, cls: 'ok' },
  changes: { label: 'cambios pedidos', Icon: ChatCircleDots, cls: 'warn' },
  pending: { label: 'review pendiente', Icon: CircleDashed, cls: 'mute' }
} as const
const ESTADO_CLS: Record<TeamTicket['categoria'], string> = { en_curso: 'run', revision: 'info', bloqueado: 'bad' }

export function TeamView(): React.JSX.Element {
  const ui = useUi()
  const snap = useTeamSnapshot()
  const [err, setErr] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [confirmar, setConfirmar] = useState(false)
  const [panel, setPanel] = useState<'none' | 'link'>('none')
  const [starting, setStarting] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const firstBtn = useRef<HTMLButtonElement>(null)

  const accLabel = (id?: string): string => ui.accounts.find((a) => a.id === id)?.label ?? '—'
  const conector = snap?.tickets.conector ?? null
  const n = conector?.nombre ?? ''

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    firstBtn.current?.focus()
    return () => prev?.focus?.()
  }, [])

  const close = (): void => setTeamOpen(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (confirmar) setConfirmar(false)
      else if (starting) setStarting(null)
      else if (panel !== 'none') setPanel('none')
      else close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [confirmar, starting, panel])

  const wsByTicket = useMemo(() => {
    const m = new Map<string, Workspace>()
    for (const w of ui.workspaces) if (w.ticket) m.set(w.ticket.toUpperCase(), w)
    return m
  }, [ui.workspaces])

  const run = async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(label)
    setErr(null)
    try {
      return await fn()
    } catch (e) {
      setErr(cleanError(e))
      return undefined
    } finally {
      setBusy(null)
    }
  }
  const apply = (s: unknown): void => {
    if (s && typeof s === 'object' && 'people' in s) setTeamSnapshot(s as TeamSnapshot)
  }

  const refreshGithub = async (): Promise<void> => apply(await run('gh', () => ui.invoke('feat:team:refreshGithub')))
  const traer = async (): Promise<void> => {
    setConfirmar(false)
    setInfo(null)
    const r = await run('tickets', () => ui.invoke<{ count: number; tokens?: number }>('feat:tickets:refresh'))
    if (r) setInfo(`${n} trajo ${r.count} ${r.count === 1 ? 'ticket' : 'tickets'}${r.tokens ? ` · ~${fmtTok(r.tokens)} tokens` : ''}.`)
  }
  const pedirTraer = (): void => {
    if (conector?.via === 'mcp' && snap?.tickets.confirmar) setConfirmar(true)
    else void traer()
  }
  const noPreguntar = (checked: boolean): void => {
    ui.invoke('feat:tickets:setConfig', { confirmRefresh: !checked }).catch((e) => setErr(cleanError(e)))
  }

  const openPr = (p: TeamPr): void => {
    if (!PR_URL_RE.test(p.url)) return setErr('Ese link no es de un PR de GitHub.')
    void run(`pr:${p.url}`, () => ui.invoke('feat:team:openPr', p.url))
  }
  const clickTicket = (t: TeamTicket): void => {
    const ws = wsByTicket.get(t.id)
    if (ws) {
      ui.openPane(ws.id)
      close()
    } else setStarting((cur) => (cur === t.id ? null : t.id))
  }
  const start = async (id: string): Promise<void> => {
    // Crea el espacio del ticket con el conector activo.
    const r = await run(`start:${id}`, () => ui.invoke<{ id: string; created: boolean }>('feat:tickets:start', id))
    if (r) {
      setStarting(null)
      await ui.reload()
      close()
    }
  }

  if (!snap) {
    return (
      <div className="f-team-backdrop">
        <aside className="f-team-drawer" role="dialog" aria-modal="true" aria-label="Equipo">
          <p className="hint f-team-pad">Cargando…</p>
        </aside>
      </div>
    )
  }

  const ghRunning = snap.githubRunning || busy === 'gh'
  const ticketsRunning = snap.tickets.running || busy === 'tickets'
  const active = snap.people.filter((p) => !p.isBot && (p.prs.length || p.tickets.length))
  const idle = snap.people.filter((p) => p.isBot || (!p.prs.length && !p.tickets.length))
  const repoErrors = Object.entries(snap.github.errors)

  const ticketRow = (t: TeamTicket): React.JSX.Element => {
    const ws = wsByTicket.get(t.id)
    const E = ESTADO_CLS[t.categoria]
    return (
      <li key={t.id} className="f-team-row">
        <button
          type="button"
          className="f-team-rowbtn"
          onClick={() => clickTicket(t)}
          aria-expanded={ws ? undefined : starting === t.id}
          title={ws ? `Abrir el espacio ${ws.name}` : `No hay espacio para ${t.id}: tocá para empezarlo`}
        >
          <span className={`f-team-chip ${E}`}>
            {t.categoria === 'bloqueado' ? <Prohibit size={11} weight="bold" aria-hidden="true" /> : <Ticket size={11} weight="bold" aria-hidden="true" />}
            {t.estadoNombre}
          </span>
          <span className="mono f-team-id">{t.id}</span>
          <span className="f-team-title">{t.titulo}</span>
          {ws && (
            <span className="f-team-has">
              <ArrowSquareOut size={12} aria-hidden="true" /> espacio
            </span>
          )}
        </button>
        {t.url && /^https?:\/\//.test(t.url) && (
          <a className="icon-btn f-team-ext" href={t.url} target="_blank" rel="noreferrer" aria-label={`Abrir ${t.id} en ${n}`} title={`Abrir en ${n}`}>
            <ArrowSquareOut size={13} aria-hidden="true" />
          </a>
        )}
        {starting === t.id && (
          <div className="f-team-start" role="group" aria-label={`Empezar ${t.id}`}>
            <span>
              Crea el espacio <b className="mono">{t.id}</b> y arranca Claude ahí.
            </span>
            <button type="button" className="btn sm primary" autoFocus disabled={Boolean(busy)} onClick={() => void start(t.id)}>
              {busy === `start:${t.id}` ? <CircleNotch size={13} className="spin" aria-hidden="true" /> : <Play size={13} weight="fill" aria-hidden="true" />}
              Empezar
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setStarting(null)}>
              Cancelar
            </button>
          </div>
        )}
      </li>
    )
  }

  const prRow = (p: TeamPr): React.JSX.Element => {
    const c = CI[p.ci]
    const r = REVIEW[p.review]
    const ciTitle =
      p.ci === 'none'
        ? 'Sin checks'
        : `${p.checks.pass} pasan · ${p.checks.fail} fallan · ${p.checks.running} corriendo${p.failing?.length ? `\nFallan: ${p.failing.join(', ')}` : ''}`
    return (
      <li key={p.url} className="f-team-row">
        <button type="button" className="f-team-rowbtn" onClick={() => openPr(p)} title={`Abrir en GitHub: ${p.url}`}>
          <span className={`f-team-chip ${c.cls}`} title={ciTitle}>
            <c.Icon size={11} weight="bold" aria-hidden="true" className={p.ci === 'running' ? 'spin' : undefined} />
            CI {c.label}
          </span>
          {p.isDraft ? (
            <span className="f-team-chip mute">borrador</span>
          ) : (
            <span className={`f-team-chip ${r.cls}`}>
              <r.Icon size={11} weight="bold" aria-hidden="true" />
              {r.label}
            </span>
          )}
          <span className="f-team-title">{p.title}</span>
          <span className="mono f-team-repo">
            {p.repo.split('/')[1]}#{p.number}
          </span>
          {(p.createdAt ?? p.updatedAt) && (
            <span
              className="f-team-age"
              title={`${p.createdAt ? `Abierto ${timeAgo(p.createdAt)}` : ''}${p.updatedAt ? ` · actualizado ${timeAgo(p.updatedAt)}` : ''}`}
            >
              {age((p.createdAt ?? p.updatedAt)!)}
            </span>
          )}
        </button>
      </li>
    )
  }

  const card = (p: Person): React.JSX.Element => (
    <article key={p.key} className="f-team-card" aria-labelledby={`f-team-n-${p.key}`}>
      <header className="f-team-card-head">
        <span className="f-team-avatar" style={{ background: personColor(p.key) }} aria-hidden="true">
          {p.isBot ? <Robot size={14} weight="bold" /> : initials(p.nombre)}
        </span>
        <div className="f-team-who">
          <h3 id={`f-team-n-${p.key}`}>{p.nombre}</h3>
          <p className="f-team-sub">
            {p.logins.map((l) => `@${l}`).join(' · ')}
            {p.logins.length ? ' · ' : ''}
            {p.enConector ? (p.matchedBy === 'manual' ? `${n} (vinculado a mano)` : n) : p.isBot ? 'bot' : 'solo GitHub'}
          </p>
        </div>
        <span className="f-team-counts" aria-label={`${p.tickets.length} tickets activos, ${p.prs.length} PRs abiertos`}>
          <Ticket size={12} aria-hidden="true" /> {p.tickets.length}
          <GitPullRequest size={12} aria-hidden="true" /> {p.prs.length}
        </span>
      </header>
      {p.tickets.length > 0 && (
        <section>
          <h4 className="f-team-h4">Trabajando en</h4>
          <ul className="f-team-list">{p.tickets.map(ticketRow)}</ul>
        </section>
      )}
      {p.prs.length > 0 && (
        <section>
          <h4 className="f-team-h4">PRs abiertos</h4>
          <ul className="f-team-list">{p.prs.map(prRow)}</ul>
        </section>
      )}
      {!p.tickets.length && !p.prs.length && <p className="hint f-team-none">Sin tickets activos ni PRs abiertos.</p>}
    </article>
  )

  return (
    <div className="f-team-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <aside className="f-team-drawer" role="dialog" aria-modal="true" aria-labelledby="f-team-title">
        <header className="f-team-head">
          <UsersThree size={18} weight="bold" aria-hidden="true" className="f-team-head-ic" />
          <h2 id="f-team-title">Equipo</h2>
          <span className="f-team-meta" aria-live="polite">
            {ghRunning ? (
              <>
                <CircleNotch size={12} className="spin" aria-hidden="true" /> Leyendo GitHub…
              </>
            ) : snap.github.fetchedAt ? (
              `GitHub ${timeAgo(snap.github.fetchedAt)} · ${snap.github.repos.length} ${snap.github.repos.length === 1 ? 'repo' : 'repos'}`
            ) : (
              'GitHub sin leer'
            )}
            {conector && ' · '}
            {conector &&
              (ticketsRunning ? (
                <>
                  <CircleNotch size={12} className="spin" aria-hidden="true" /> Consultando {n}…{conector.via === 'mcp' ? ' (hasta 3 min)' : ''}
                </>
              ) : snap.tickets.fetchedAt ? (
                `${n} ${timeAgo(snap.tickets.fetchedAt)}${snap.tickets.fetchedBy ? ` con ${accLabel(snap.tickets.fetchedBy)}` : ''}${snap.tickets.lastRun?.tokens ? ` (~${fmtTok(snap.tickets.lastRun.tokens)} tokens)` : ''}`
              ) : (
                `${n} sin consultar`
              ))}
          </span>
          <div className="f-team-actions">
            <button ref={firstBtn} type="button" className="btn sm" disabled={ghRunning} onClick={() => void refreshGithub()} title="Vuelve a leer los PRs abiertos con gh (no usa tokens)">
              <ArrowClockwise size={14} aria-hidden="true" className={ghRunning ? 'spin' : undefined} /> Actualizar
            </button>
            {conector &&
              (ticketsRunning ? (
                <button type="button" className="btn sm" onClick={() => void ui.invoke('feat:tickets:cancel')}>
                  <X size={14} aria-hidden="true" /> Cancelar
                </button>
              ) : (
                <button
                  type="button"
                  className="btn sm"
                  onClick={pedirTraer}
                  title={conector.via === 'mcp' ? 'Usa tokens de la cuenta de Tickets' : 'Lee con GitHub CLI (no usa tokens)'}
                >
                  <Ticket size={14} aria-hidden="true" /> Traer de {n}
                  {conector.via === 'mcp' && <span className="f-team-subbtn">usa tokens</span>}
                </button>
              ))}
            {conector && (
              <button type="button" className="btn sm ghost" aria-expanded={panel === 'link'} onClick={() => setPanel(panel === 'link' ? 'none' : 'link')}>
                <LinkSimple size={14} aria-hidden="true" /> Vincular
              </button>
            )}
            <button type="button" className="icon-btn" aria-label="Cerrar equipo (Esc)" title="Cerrar (Esc)" onClick={close}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        {confirmar && conector?.via === 'mcp' && (
          <div className="f-team-bar f-team-confirm" role="alertdialog" aria-label={`Confirmar consulta a ${n}`}>
            <WarningCircle size={16} weight="fill" aria-hidden="true" className="f-team-warn" />
            <span>
              Para leer {n} se abre Claude sin ventana con la cuenta de Tickets (modelo {snap.tickets.model}) y usa tokens de esa cuenta. Trae los tickets
              de todo el equipo; acá se ven los que están en curso, en revisión y bloqueados. Solo lee: no cambia nada en {n}.
            </span>
            <label className="check">
              <input type="checkbox" onChange={(e) => noPreguntar(e.target.checked)} />
              No volver a preguntar (también en Tickets)
            </label>
            <button type="button" className="btn sm primary" autoFocus onClick={() => void traer()}>
              Consultar
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setConfirmar(false)}>
              Cancelar
            </button>
          </div>
        )}

        {panel === 'link' && conector && <LinkPanel snap={snap} n={n} apply={apply} onError={setErr} />}

        <div className="f-team-body">
          {err && (
            <p className="form-error f-team-msg" role="alert">
              {err}
            </p>
          )}
          {snap.github.fatal && !ghRunning && (
            <p className="form-error f-team-msg" role="alert">
              <WarningCircle size={14} weight="fill" aria-hidden="true" /> {snap.github.fatal}
            </p>
          )}
          {conector && snap.tickets.lastError && !ticketsRunning && (
            <p className="form-error f-team-msg" role="alert">
              {n}: {snap.tickets.lastError}
            </p>
          )}
          {info && !err && (
            <p className="f-team-msg f-team-ok" role="status">
              {info}
            </p>
          )}

          <div className="f-team-summary" role="list" aria-label="Resumen del equipo">
            <Stat n={snap.summary.ciFailing} label={snap.summary.ciFailing === 1 ? 'PR con CI fallando' : 'PRs con CI fallando'} Icon={XCircle} tone="bad" />
            <Stat n={snap.summary.waitingReview} label={snap.summary.waitingReview === 1 ? 'PR esperando review' : 'PRs esperando review'} Icon={CircleDashed} tone="warn" />
            {conector && <Stat n={snap.summary.blocked} label={snap.summary.blocked === 1 ? 'ticket bloqueado' : 'tickets bloqueados'} Icon={Prohibit} tone="bad" />}
            <p className="f-team-tot hint">
              {snap.summary.prs} PRs abiertos
              {conector && ` · ${snap.tickets.fetchedAt ? `${snap.summary.tickets} tickets activos` : `tickets: tocá «Traer de ${n}»`}`}
            </p>
          </div>

          {!ghRunning && snap.github.fetchedAt && !snap.github.repos.length && !snap.github.fatal && (
            <p className="hint f-team-msg">Ningún espacio tiene un repo con remoto de GitHub (origin), así que no hay PRs para mostrar.</p>
          )}
          {repoErrors.length > 0 && (
            <details className="f-team-repoerr">
              <summary>
                <WarningCircle size={13} aria-hidden="true" /> {repoErrors.length} {repoErrors.length === 1 ? 'repo no se pudo leer' : 'repos no se pudieron leer'}
              </summary>
              <ul>
                {repoErrors.map(([repo, msg]) => (
                  <li key={repo}>
                    <span className="mono">{repo}</span>: {msg}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="f-team-grid">
            {active.map(card)}
            {snap.unassigned.length > 0 && (
              <article className="f-team-card" aria-labelledby="f-team-n-unassigned">
                <header className="f-team-card-head">
                  <span className="f-team-avatar f-team-avatar-empty" aria-hidden="true">
                    ?
                  </span>
                  <div className="f-team-who">
                    <h3 id="f-team-n-unassigned">Sin asignar</h3>
                    <p className="f-team-sub">Tickets activos sin responsable en {n}</p>
                  </div>
                </header>
                <ul className="f-team-list">{snap.unassigned.map(ticketRow)}</ul>
              </article>
            )}
            {idle.map(card)}
          </div>
          {!snap.people.length && !ghRunning && (
            <p className="hint f-team-empty">
              Todavía no hay nadie para mostrar. Tocá «Actualizar» para leer los PRs abiertos de los repos de tus espacios.
              {conector ? ` Tocá «Traer de ${n}» para ver en qué ticket anda cada uno.` : ' Elegí un conector en los ajustes de Tickets para ver en qué ticket anda cada uno.'}
            </p>
          )}
        </div>
      </aside>
    </div>
  )
}

function Stat({ n, label, Icon, tone }: { n: number; label: string; Icon: typeof XCircle; tone: 'bad' | 'warn' }): React.JSX.Element {
  return (
    <div role="listitem" className={`f-team-stat ${n ? tone : 'zero'}`}>
      <Icon size={16} weight="bold" aria-hidden="true" />
      <b>{n}</b>
      <span>{label}</span>
    </div>
  )
}

function LinkPanel({ snap, n, apply, onError }: { snap: TeamSnapshot; n: string; apply: (s: unknown) => void; onError: (m: string) => void }): React.JSX.Element {
  const ui = useUi()
  const autoOf = (login: string): string | undefined =>
    snap.people.find((p) => p.enConector && p.matchedBy === 'auto' && p.logins.some((l) => l.toLowerCase() === login.toLowerCase()))?.nombre
  return (
    <div className="f-team-bar f-team-link" role="region" aria-label={`Vincular GitHub con ${n}`}>
      <p className="hint">
        Quién es quién: cada login de GitHub con su persona de {n}. «Automático» cruza por nombre cuando hay un solo parecido.
        {!snap.personasConector.length && ` Traé los tickets de ${n} para tener personas con quién vincular.`}
      </p>
      {snap.authors.length === 0 ? (
        <p className="hint">Todavía no hay autores de PRs.</p>
      ) : (
        <ul className="f-team-links">
          {snap.authors.map((a) => {
            const val = snap.mapping[a.login.toLowerCase()] ?? ''
            const auto = autoOf(a.login)
            return (
              <li key={a.login}>
                <span className="mono">@{a.login}</span>
                {a.name && <span className="f-team-sub">{a.name}</span>}
                <select
                  aria-label={`Persona de ${n} para @${a.login}`}
                  value={val}
                  onChange={(e) => ui.invoke('feat:team:setMapping', a.login, e.target.value || null).then(apply, (er) => onError(cleanError(er)))}
                >
                  <option value="">Automático{auto ? ` (${auto})` : ' (sin pareja)'}</option>
                  <option value={NADIE}>No es de {n}</option>
                  {snap.personasConector.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.nombre}
                    </option>
                  ))}
                  {val && val !== NADIE && !snap.personasConector.some((p) => p.key === val) && <option value={val}>(persona que {n} ya no trajo)</option>}
                </select>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
