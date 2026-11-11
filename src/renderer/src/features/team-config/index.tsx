import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowSquareOut, CheckCircle, DownloadSimple, Export, Plus, Sliders, Trash, UsersThree, Warning, X } from '@phosphor-icons/react'
import { useUi, type Command, type FeatureUi, type UiCtx } from '../host'
import { useDocumentVisible } from '../../visibility'
import {
  ACTION_LABEL,
  applyTeamSettings,
  cleanMsg,
  getTeams,
  importTeam,
  openTeamDialog,
  repoName,
  scanTeams,
  settingsText,
  setTeams,
  useTeam,
  type ImportPlan,
  type TeamLink,
  type TeamStatus
} from './store'
import './team-config.css'

/** Devuelve el foco a donde estaba cuando se cierra un diálogo. */
function useReturnFocus(): void {
  useLayoutEffect(() => {
    const a = document.activeElement
    const prev = a instanceof HTMLElement && a !== document.body ? a : null
    return () => {
      if (prev?.isConnected) prev.focus()
    }
  }, [])
}

function useEscape(fn: () => void): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        ref.current()
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])
}

// ---------- Importar ----------

function ImportDialog({ repoPath, onClose }: { repoPath: string; onClose: () => void }): React.JSX.Element {
  const ctx = useUi()
  useReturnFocus()
  useEscape(onClose)
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    ctx.invoke<ImportPlan>('feat:team-config:plan', repoPath).then(setPlan, (e) => setErr(cleanMsg(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath])

  const todo = plan?.items.filter((i) => !i.error && i.action !== 'same').length ?? 0
  const run = async (): Promise<void> => {
    if (!plan) return
    setBusy(true)
    setErr(null)
    try {
      const r = await importTeam(ctx, repoPath, plan)
      const parts = [r.created ? `${r.created} nueva${r.created > 1 ? 's' : ''}` : '', r.updated ? `${r.updated} actualizada${r.updated > 1 ? 's' : ''}` : ''].filter(Boolean)
      setDone(parts.length ? `Listo: ${parts.join(' y ')}.` : 'Ya estaba todo al día.')
      if (r.errors.length) setErr(r.errors.join('\n'))
    } catch (e) {
      setErr(cleanMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal f-team-config-modal" role="dialog" aria-modal="true" aria-labelledby="f-tc-imp-h" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <UsersThree size={18} weight="duotone" aria-hidden="true" className="f-team-config-icon" />
          <h2 id="f-tc-imp-h">Plantillas del equipo{plan ? ` · ${plan.equipo}` : ''}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <p className="field-help">
          Desde <span className="mono">{repoName(repoPath)}\.sloth\team.json</span>. Se guardan en tus plantillas con la cuenta sugerida; las que ya importaste se actualizan, no se duplican.
        </p>
        {!plan && !err && <p className="hint">Leyendo…</p>}
        {plan && (
          <ul className="f-team-config-plan">
            {plan.items.map((it) => (
              <li key={it.key} className={it.error ? 'is-error' : it.action === 'same' ? 'is-same' : ''}>
                {it.error ? <Warning size={14} weight="fill" aria-hidden="true" /> : it.action === 'same' ? <CheckCircle size={14} aria-hidden="true" /> : <DownloadSimple size={14} aria-hidden="true" />}
                <span className="grow-min">
                  <span className="item-title">{it.savedName}</span>
                  {it.error && <span className="item-sub">{it.error}</span>}
                  {it.action === 'renamed' && !it.error && <span className="item-sub">Ya tenés una plantilla tuya con ese nombre: la del equipo se guarda aparte.</span>}
                </span>
                <span className="f-team-config-act">{it.error ? 'No se puede' : ACTION_LABEL[it.action]}</span>
              </li>
            ))}
            {plan.items.length === 0 && <li className="is-same">El archivo no trae plantillas.</li>}
          </ul>
        )}
        {plan && plan.orphans.length > 0 && (
          <p className="field-help">El equipo ya no tiene: {plan.orphans.join(', ')}. Quedan en tus plantillas; borralas si no las usás.</p>
        )}
        {done && (
          <p className="f-team-config-ok" role="status">
            <CheckCircle size={14} weight="fill" aria-hidden="true" /> {done}
          </p>
        )}
        {err && <p className="form-error f-team-config-pre-wrap">{err}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {done ? 'Cerrar' : 'Cancelar'}
          </button>
          {!done && (
            <button type="button" className="btn primary" disabled={!plan || busy || todo === 0} onClick={() => void run()}>
              <DownloadSimple size={14} aria-hidden="true" />
              {busy ? 'Importando…' : todo ? `Importar ${todo} plantilla${todo > 1 ? 's' : ''}` : 'Todo al día'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- Exportar ----------

interface RepoTemplates {
  templates: string[]
  current: { equipo: string; links: TeamLink[]; ajustes?: { densidad?: string; tamañoTerminal?: number } } | null
  exists: boolean
}
interface Preview {
  text: string
  skipped: { name: string; reason: string }[]
  count: number
  path: string
  exists: boolean
}

const DEFAULT_LINKS: TeamLink[] = [
  { nombre: 'Tickets', url: '' },
  { nombre: 'Staging', url: '' },
  { nombre: 'Docs', url: '' }
]

function ExportDialog({ initialRepo, onClose }: { initialRepo?: string; onClose: () => void }): React.JSX.Element {
  const ctx = useUi()
  useReturnFocus()
  useEscape(onClose)
  const repos = useMemo(() => {
    const seen = new Map<string, string>()
    for (const p of [initialRepo, ...getTeams().map((t) => t.repoPath), ...ctx.workspaces.map((w) => w.repoPath)]) if (p && !seen.has(p.toLowerCase())) seen.set(p.toLowerCase(), p)
    return [...seen.values()]
  }, [initialRepo, ctx.workspaces])
  const [repo, setRepo] = useState(repos[0] ?? '')
  const [info, setInfo] = useState<RepoTemplates | null>(null)
  const [equipo, setEquipo] = useState('')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [links, setLinks] = useState<TeamLink[]>(DEFAULT_LINKS)
  const [withSettings, setWithSettings] = useState(false)
  const [mySettings, setMySettings] = useState<{ densidad?: string; tamañoTerminal?: number } | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [written, setWritten] = useState<string | null>(null)

  useEffect(() => {
    ctx
      .invoke<{ settings: { density: string; terminal: { fontSize: number } } }>('feat:settings:get')
      .then((p) => setMySettings({ densidad: p.settings.density, tamañoTerminal: p.settings.terminal.fontSize }))
      .catch(() => setMySettings(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setPreview(null)
    setInfo(null)
    if (!repo) return
    ctx.invoke<RepoTemplates>('feat:team-config:repoTemplates', repo).then(
      (r) => {
        setInfo(r)
        setChosen(new Set(r.templates))
        setEquipo(r.current?.equipo ?? repoName(repo))
        if (r.current?.links.length) setLinks(r.current.links)
        setWithSettings(Boolean(r.current?.ajustes))
      },
      (e) => setErr(cleanMsg(e))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo])

  const input = (): Record<string, unknown> => ({
    equipo,
    include: [...chosen],
    links: links.filter((l) => l.nombre.trim() || l.url.trim()).map((l) => ({ nombre: l.nombre.trim(), url: l.url.trim() })),
    ajustes: withSettings && mySettings ? mySettings : undefined
  })

  const doPreview = async (): Promise<void> => {
    setErr(null)
    setBusy(true)
    try {
      setPreview(await ctx.invoke<Preview>('feat:team-config:exportPreview', repo, input()))
    } catch (e) {
      setErr(cleanMsg(e))
    } finally {
      setBusy(false)
    }
  }
  const doWrite = async (): Promise<void> => {
    if (!preview) return
    setErr(null)
    setBusy(true)
    try {
      const r = await ctx.invoke<{ path: string }>('feat:team-config:exportWrite', repo, input(), preview.text)
      setWritten(r.path)
    } catch (e) {
      setErr(cleanMsg(e))
    } finally {
      setBusy(false)
    }
  }
  const setLink = (i: number, patch: Partial<TeamLink>): void => {
    setPreview(null)
    setLinks((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal f-team-config-modal wide" role="dialog" aria-modal="true" aria-labelledby="f-tc-exp-h" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <Export size={18} weight="duotone" aria-hidden="true" className="f-team-config-icon" />
          <h2 id="f-tc-exp-h">Exportar como configuración del equipo</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        {written ? (
          <>
            <p className="f-team-config-ok" role="status">
              <CheckCircle size={14} weight="fill" aria-hidden="true" /> Guardado en <span className="mono">{written}</span>
            </p>
            <p className="field-help">
              Commitealo cuando quieras: <span className="mono">git add .sloth/team.json</span>. Tus compañeros lo ven al abrir un espacio en ese repo.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn primary" onClick={onClose}>
                Listo
              </button>
            </div>
          </>
        ) : preview ? (
          <>
            <p className="field-help">
              Esto se guarda en <span className="mono">{preview.path}</span>
              {preview.exists ? ' y reemplaza el archivo actual.' : '.'} No lleva cuentas, rutas absolutas ni ids.
            </p>
            <pre className="f-team-config-pre mono" tabIndex={0} aria-label="Contenido de team.json">
              {preview.text}
            </pre>
            {preview.skipped.length > 0 && (
              <p className="field-help">
                <Warning size={13} weight="fill" aria-hidden="true" className="f-team-config-warn" /> Quedan afuera:{' '}
                {preview.skipped.map((s) => `«${s.name}» (${s.reason})`).join(', ')}.
              </p>
            )}
            {err && <p className="form-error">{err}</p>}
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setPreview(null)}>
                Volver
              </button>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void doWrite()}>
                {preview.exists ? 'Reemplazar team.json' : 'Guardar team.json'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="f-tc-repo">Repo del equipo</label>
              {repos.length ? (
                <select id="f-tc-repo" value={repo} onChange={(e) => setRepo(e.target.value)}>
                  {repos.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="hint">Creá un espacio en el repo del equipo primero.</p>
              )}
            </div>
            <div className="field">
              <label htmlFor="f-tc-name">Nombre del equipo</label>
              <input id="f-tc-name" value={equipo} maxLength={60} onChange={(e) => (setEquipo(e.target.value), setPreview(null))} />
            </div>
            <fieldset className="f-team-config-fs">
              <legend>Plantillas de este repo</legend>
              {info && info.templates.length === 0 && <p className="hint">No tenés plantillas que apunten a este repo.</p>}
              {info?.templates.map((name) => (
                <label key={name} className="check">
                  <input
                    type="checkbox"
                    checked={chosen.has(name)}
                    onChange={() =>
                      setChosen((s) => {
                        const n = new Set(s)
                        if (n.has(name)) n.delete(name)
                        else n.add(name)
                        return n
                      })
                    }
                  />
                  <span>{name}</span>
                </label>
              ))}
            </fieldset>
            <fieldset className="f-team-config-fs">
              <legend>Links útiles</legend>
              {links.map((l, i) => (
                <div key={i} className="f-team-config-link-row">
                  <input aria-label={`Nombre del link ${i + 1}`} value={l.nombre} maxLength={40} placeholder="Nombre" onChange={(e) => setLink(i, { nombre: e.target.value })} />
                  <input aria-label={`URL del link ${i + 1}`} className="mono" value={l.url} placeholder="https://…" onChange={(e) => setLink(i, { url: e.target.value })} />
                  <button type="button" className="icon-btn danger" aria-label={`Quitar link ${l.nombre || i + 1}`} onClick={() => (setLinks((ls) => ls.filter((_, j) => j !== i)), setPreview(null))}>
                    <Trash size={13} aria-hidden="true" />
                  </button>
                </div>
              ))}
              {links.length < 12 && (
                <button type="button" className="btn sm ghost f-team-config-add" onClick={() => setLinks((ls) => [...ls, { nombre: '', url: '' }])}>
                  <Plus size={12} weight="bold" aria-hidden="true" /> Link
                </button>
              )}
              <p className="field-help">Solo https. Los vacíos no se guardan.</p>
            </fieldset>
            <label className="check">
              <input type="checkbox" checked={withSettings} disabled={!mySettings} onChange={(e) => (setWithSettings(e.target.checked), setPreview(null))} />
              <span>
                Recomendar mis ajustes
                <small>{mySettings ? settingsText(mySettings as never) : 'No se pudieron leer tus ajustes.'} — cada uno decide si los acepta.</small>
              </span>
            </label>
            {err && <p className="form-error">{err}</p>}
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={onClose}>
                Cancelar
              </button>
              <button type="button" className="btn primary" disabled={!repo || !equipo.trim() || busy} onClick={() => void doPreview()}>
                Ver contenido
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------- Sidebar: sección «Equipo» compacta ----------

function TeamBlock({ t }: { t: TeamStatus }): React.JSX.Element {
  const ctx = useUi()
  const [busy, setBusy] = useState(false)
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      ctx.notifyError(cleanMsg(e))
    } finally {
      setBusy(false)
    }
  }
  if (t.state === 'invalid')
    return (
      <div className="f-team-config-block">
        <p className="f-team-config-invalid" title={t.repoPath}>
          <Warning size={13} weight="fill" aria-hidden="true" />
          <span>
            <span className="mono">{repoName(t.repoPath)}\.sloth\team.json</span> tiene un error: {t.error}
          </span>
        </p>
      </div>
    )
  return (
    <div className="f-team-config-block">
      {t.notify && (
        <div className="f-team-config-chip-row">
          <button type="button" className="f-team-config-chip" onClick={() => openTeamDialog({ kind: 'import', repoPath: t.repoPath })} title={`Ver qué cambia (${t.repoPath})`}>
            <DownloadSimple size={12} weight="bold" aria-hidden="true" />
            Hay plantillas nuevas del equipo
            <span className="count">{t.pending}</span>
          </button>
          <button type="button" className="icon-btn" disabled={busy} aria-label="Ahora no (avisar en el próximo cambio)" title="Ahora no" onClick={() => void act(async () => setTeams(await ctx.invoke('feat:team-config:dismiss', t.repoPath)))}>
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}
      {t.settingsPending && t.ajustes && (
        <div className="f-team-config-sugg">
          <Sliders size={13} aria-hidden="true" />
          <span className="grow-min" title={`El equipo recomienda: ${settingsText(t.ajustes)}`}>
            Sugerido: {settingsText(t.ajustes)}
          </span>
          <button type="button" className="btn sm ghost" disabled={busy} onClick={() => void act(() => applyTeamSettings(ctx, t.repoPath, t.ajustes!))}>
            Aplicar
          </button>
          <button type="button" className="icon-btn" disabled={busy} aria-label="No aplicar los ajustes sugeridos" title="No, gracias" onClick={() => void act(async () => setTeams(await ctx.invoke('feat:team-config:settingsDone', t.repoPath)))}>
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}
      {t.links.length > 0 && (
        <div className="f-team-config-links">
          {t.links.map((l, i) => (
            <button key={`${l.nombre}-${i}`} type="button" className="f-team-config-link" title={l.url} onClick={() => void act(() => ctx.invoke('feat:team-config:openLink', t.repoPath, i))}>
              {l.nombre}
              <ArrowSquareOut size={11} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Sidebar(): React.JSX.Element | null {
  const { teams } = useTeam()
  if (!teams.length) return null
  const names = [...new Set(teams.map((t) => t.equipo).filter(Boolean))]
  return (
    <section className="section f-team-config" aria-labelledby="f-team-config-h">
      <div className="section-row">
        <h2 id="f-team-config-h" className="section-title">
          <UsersThree size={13} aria-hidden="true" /> Equipo
          {names.length > 0 && <span className="f-team-config-name">{names.join(' · ')}</span>}
        </h2>
        <button className="icon-btn" onClick={() => openTeamDialog({ kind: 'export', repoPath: teams[0]?.repoPath })} aria-label="Exportar mi configuración como la del equipo" title="Exportar como configuración del equipo">
          <Export size={14} aria-hidden="true" />
        </button>
      </div>
      {teams.map((t) => (
        <TeamBlock key={t.repoPath} t={t} />
      ))}
    </section>
  )
}

// ---------- Global: chequeos (al iniciar y al volver la ventana visible) y diálogos ----------

function Global(): React.JSX.Element | null {
  const ctx = useUi()
  const { dialog } = useTeam()
  const visible = useDocumentVisible()
  const repoKey = [...new Set(ctx.workspaces.map((w) => w.repoPath.toLowerCase()))].sort().join('|')

  useEffect(() => ctx.on('feat:team-config:changed', (list: unknown) => setTeams(list)), [ctx])
  // Nada de polling: se revisa al iniciar, al volver a ver la ventana y cuando cambian los repos de los espacios.
  useEffect(() => {
    if (!visible) return
    scanTeams(ctx).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, repoKey])

  if (!dialog) return null
  const close = (): void => openTeamDialog(null)
  return dialog.kind === 'import' ? <ImportDialog repoPath={dialog.repoPath} onClose={close} /> : <ExportDialog initialRepo={dialog.repoPath} onClose={close} />
}

const ui: FeatureUi = {
  name: 'team-config',
  Sidebar,
  Global,
  commands: (ctx: UiCtx): Command[] => {
    const ok = getTeams().filter((t) => t.state === 'ok')
    return [
      {
        id: 'team-config:import',
        title: 'Importar/actualizar plantillas del equipo',
        subtitle: ok.length ? ok.map((t) => `${t.equipo} · ${t.pending ? `${t.pending} para importar` : 'al día'}`).join(' · ') : 'Ningún repo abierto trae .sloth/team.json',
        group: 'Equipo',
        keywords: 'equipo team plantillas importar actualizar team.json',
        run: () => {
          if (ok.length) openTeamDialog({ kind: 'import', repoPath: (ok.find((t) => t.pending) ?? ok[0]).repoPath })
          else ctx.notifyError('Ningún repo de tus espacios trae .sloth/team.json.')
        }
      },
      {
        id: 'team-config:export',
        title: 'Exportar mi configuración como configuración del equipo',
        subtitle: 'Genera <repo>\\.sloth\\team.json con tus plantillas (sin cuentas ni rutas)',
        group: 'Equipo',
        keywords: 'equipo team exportar compartir team.json',
        run: () => openTeamDialog({ kind: 'export', repoPath: ok[0]?.repoPath })
      }
    ]
  }
}

export default ui
