import { useEffect, useRef, useState } from 'react'
import { useUi } from '../host'
import { cleanError, shortPath } from '../../format'
import { applyVars, BRANCH_VARS, TEMPLATE_COLOR_KEYS, TEMPLATE_ICON_KEYS, SUGGESTED, today, unknownVars, validBranch, varsIn, type VarValues } from '../../../../shared/templates-shared'
import { colorHex, iconPath, TEMPLATE_COLORS, TEMPLATE_ICONS, VAR_CHIPS } from './catalog'
import { loadTemplates, openDialog, setPreselect, useTemplates, type TemplateDto } from './store'
import { Modal } from '../../Modal'
import { SearchIcon } from '../../icons/SlothIcons'

/** Campos que se editan en el formulario (lo que el usuario puede cambiar de una plantilla propia). */
interface Fields {
  name: string
  description: string
  icon: string
  color: string
  accountId: string
  wt: boolean
  br: string
  prompt: string
}

interface ShareState {
  repo: string
  equipo: string
  notice: string
  preview: null | { text: string; skipped: { name: string; reason: string }[]; count: number; path: string }
}

const toFields = (t: TemplateDto): Fields => ({
  name: t.name,
  description: t.description ?? '',
  icon: t.icon ?? 'rama',
  color: t.color ?? 'cielo',
  accountId: t.accountId,
  wt: Boolean(t.useWorktree),
  br: t.useWorktree?.branchPattern ?? '',
  prompt: t.initialPrompt ?? ''
})

const sameFields = (a: Fields, b: Fields): boolean =>
  a.name === b.name &&
  a.description === b.description &&
  a.icon === b.icon &&
  a.color === b.color &&
  a.accountId === b.accountId &&
  a.wt === b.wt &&
  a.br === b.br &&
  a.prompt === b.prompt

const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

function nameMsg(name: string, id: string, list: TemplateDto[]): string {
  const n = name.trim()
  if (!n) return 'Poné un nombre para la plantilla.'
  if (list.some((t) => t.id !== id && norm(t.name.trim()) === norm(n))) return 'Ya hay una plantilla con ese nombre.'
  return ''
}

function brMsg(br: string, name: string): string {
  const b = br.trim()
  if (!b) return 'Poné un patrón, por ejemplo fix/{ticket}.'
  if (/\s/.test(b)) return 'El patrón no puede tener espacios.'
  if (varsIn(b).some((v) => !(BRANCH_VARS as readonly string[]).includes(v)))
    return 'En la rama solo podés usar {ticket}, {fecha}, {n} o {plantilla}.'
  const sample = applyVars(b, { ticket: 'PROJ-123', fecha: today(), n: 1, plantilla: name })
  if (!validBranch(sample)) return 'Git no acepta ese nombre de rama. Usá letras, números, guiones o barras.'
  return ''
}

/** Tramos del texto: las variables conocidas van resueltas con el ejemplo. */
function previewSegments(text: string, sample: VarValues): { t: string; v: boolean }[] {
  const parts = text.split(/(\{(?:ticket|ticketmin|carpeta|rama|fecha|n|plantilla)\})/)
  return parts
    .filter((p) => p !== '')
    .map((p) => {
      const isVar = /^\{(ticket|ticketmin|carpeta|rama|fecha|n|plantilla)\}$/.test(p)
      return isVar ? { t: applyVars(p, sample), v: true } : { t: p, v: false }
    })
}

interface Props {
  initialId?: string
  onClose: () => void
}

export function TemplatesScreen({ initialId, onClose }: Props): React.JSX.Element {
  const ctx = useUi()
  const { list, defaultId } = useTemplates()
  const [sel, setSel] = useState<string | null>(initialId ?? null)
  const [q, setQ] = useState('')
  const [drafts, setDrafts] = useState<Record<string, Fields>>({})
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newFrom, setNewFrom] = useState('')
  const [newErr, setNewErr] = useState('')
  const [share, setShare] = useState<ShareState | null>(null)
  const [toast, setToast] = useState('')
  const [err, setErr] = useState('')
  const toastTimer = useRef<number | undefined>(undefined)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)

  const cur = list.find((t) => t.id === sel) ?? list[0] ?? null
  const base = cur ? toFields(cur) : null
  const ed: Fields | null = cur && base ? (drafts[cur.id] ?? base) : null
  const dirty = Boolean(cur && base && drafts[cur.id] && !sameFields(drafts[cur.id], base))
  const isTeam = Boolean(cur?.team)
  const isMine = Boolean(cur && !cur.team)

  // Esc y la X cierran de adentro hacia afuera: primero el panel de compartir o el alta, y recién después la pantalla.
  const hasDrafts = Object.keys(drafts).length > 0
  const requestClose = (): void => {
    if (share) setShare(null)
    else if (creating) setCreating(false)
    else onClose()
  }

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  const flash = (msg: string): void => {
    setToast(msg)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2400)
  }

  const select = (id: string): void => {
    setSel(id)
    setTried(false)
    setConfirmDel(false)
    setShare(null)
    setErr('')
  }

  const setField = <K extends keyof Fields>(k: K, v: Fields[K]): void => {
    if (!cur || !base) return
    setDrafts((d) => ({ ...d, [cur.id]: { ...(d[cur.id] ?? base), [k]: v } }))
  }

  const accountLabel = (id: string): string =>
    id === SUGGESTED ? 'Sugerida (con sesión y menos uso en 5 h)' : (ctx.accounts.find((a) => a.id === id)?.label ?? 'Cuenta borrada')

  const payloadOf = (t: TemplateDto, f: Fields, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: t.id,
    name: f.name.trim(),
    description: f.description.trim(),
    icon: f.icon,
    color: f.color,
    accountId: f.accountId,
    repoPath: t.repoPath,
    namePattern: t.namePattern,
    initialPrompt: f.prompt.trim() || undefined,
    useWorktree: f.wt ? { branchPattern: f.br.trim() } : undefined,
    autoStartClaude: t.autoStartClaude,
    resume: t.resume,
    ...over
  })

  const save = async (): Promise<void> => {
    if (!cur || !ed || !base || isTeam) return
    if (!dirty) {
      flash('No hay cambios para guardar')
      return
    }
    const nm = nameMsg(ed.name, cur.id, list)
    const bm = ed.wt ? brMsg(ed.br, ed.name) : ''
    if (nm || bm) {
      setTried(true)
      document.getElementById(nm ? 'tp-name' : 'tp-br')?.focus()
      return
    }
    setSaving(true)
    setErr('')
    try {
      await ctx.invoke('feat:templates:save', payloadOf(cur, ed))
      setDrafts((d) => {
        const n = { ...d }
        delete n[cur.id]
        return n
      })
      setTried(false)
      flash('Plantilla guardada')
    } catch (e) {
      setErr(cleanError(e))
    } finally {
      setSaving(false)
    }
  }

  const discard = (): void => {
    if (!cur) return
    if (!drafts[cur.id]) {
      flash('No hay cambios para descartar')
      return
    }
    setDrafts((d) => {
      const n = { ...d }
      delete n[cur.id]
      return n
    })
    setTried(false)
    setErr('')
    flash('Cambios descartados')
  }

  const dup = async (): Promise<void> => {
    if (!cur) return
    try {
      const copy = await ctx.invoke<TemplateDto>('feat:templates:duplicate', cur.id)
      select(copy.id)
      flash(cur.team ? 'Copia lista: es tuya y la podés editar' : 'Copia creada')
    } catch (e) {
      setErr(cleanError(e))
    }
  }

  const toggleDefault = async (): Promise<void> => {
    if (!cur) return
    const isDef = defaultId === cur.id
    try {
      await ctx.invoke('feat:templates:setDefault', isDef ? null : cur.id)
      flash(isDef ? 'Ya no es la predeterminada' : `«${cur.name}» es la predeterminada`)
    } catch (e) {
      setErr(cleanError(e))
    }
  }

  const remove = async (): Promise<void> => {
    if (!cur) return
    try {
      await ctx.invoke('feat:templates:remove', cur.id)
      setConfirmDel(false)
      setSel(null)
      flash('Plantilla borrada')
    } catch (e) {
      setErr(cleanError(e))
      setConfirmDel(false)
    }
  }

  const useNow = (): void => {
    if (!cur) return
    setPreselect(cur.id)
    openDialog(null)
    ctx.openNewWorkspace('normal')
  }

  const insertVar = (v: string): void => {
    if (!cur || !base) return
    const el = promptRef.current
    const current = (drafts[cur.id] ?? base).prompt
    const a = el?.selectionStart ?? current.length
    const b = el?.selectionEnd ?? a
    const next = current.slice(0, a) + v + current.slice(b)
    setField('prompt', next)
    window.setTimeout(() => {
      const e2 = document.getElementById('tp-prompt') as HTMLTextAreaElement | null
      if (e2) {
        e2.focus()
        e2.setSelectionRange(a + v.length, a + v.length)
      }
    }, 20)
  }

  const createNew = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const n = newName.trim()
    const msg = nameMsg(n, '', list)
    if (msg) {
      setNewErr(msg)
      document.getElementById('tp-new-name')?.focus()
      return
    }
    const from = newFrom ? list.find((t) => t.id === newFrom) : undefined
    const payload: Record<string, unknown> = from
      ? {
          ...payloadOf(from, toFields(from), { id: undefined }),
          name: n,
          repoPath: from.repoPath,
          namePattern: from.namePattern,
          autoStartClaude: from.autoStartClaude,
          resume: from.resume
        }
      : { name: n, accountId: SUGGESTED, icon: 'rama', color: 'cielo', autoStartClaude: true, resume: true, initialPrompt: undefined }
    delete payload.id
    try {
      const t = await ctx.invoke<TemplateDto>('feat:templates:save', payload)
      setCreating(false)
      setNewName('')
      setNewFrom('')
      setNewErr('')
      select(t.id)
      flash('Plantilla creada')
    } catch (e2) {
      setNewErr(cleanError(e2))
    }
  }

  // ---- Compartir con el equipo (team-config escribe .sloth/team.json del repo) ----
  const pickRepo = async (): Promise<void> => {
    const p = await window.sloth.pickFolder()
    if (p && share) setShare({ ...share, repo: p, notice: '', preview: null })
  }

  const shareCheck = async (): Promise<void> => {
    if (!cur || !share) return
    const repo = share.repo.trim()
    const equipo = share.equipo.trim()
    if (!repo) return setShare({ ...share, notice: 'Elegí la carpeta del repo.', preview: null })
    if (!equipo) return setShare({ ...share, notice: 'Poné el nombre del equipo.', preview: null })
    if (dirty) return setShare({ ...share, notice: 'Guardá o descartá los cambios antes de compartir.', preview: null })
    try {
      const info = await ctx.invoke<{ exists: boolean }>('feat:team-config:repoTemplates', repo)
      if (info.exists) {
        return setShare({
          ...share,
          notice: 'Ese repo ya tiene .sloth/team.json. No lo piso desde acá: exportá desde Configuración del equipo.',
          preview: null
        })
      }
      // El archivo del equipo guarda la plantilla dentro del repo: la liga a esa carpeta.
      if (cur.repoPath !== repo) await ctx.invoke('feat:templates:save', payloadOf(cur, toFields(cur), { repoPath: repo }))
      const pv = await ctx.invoke<{ text: string; skipped: { name: string; reason: string }[]; count: number; path: string }>(
        'feat:team-config:exportPreview',
        repo,
        { equipo, include: [cur.name] }
      )
      setShare({
        ...share,
        repo,
        equipo,
        preview: pv,
        notice: pv.count === 0 ? 'No se puede compartir: ' + (pv.skipped[0]?.reason ?? 'revisá la plantilla.') : ''
      })
    } catch (e) {
      setShare({ ...share, notice: cleanError(e), preview: null })
    }
  }

  const shareWrite = async (): Promise<void> => {
    if (!cur || !share?.preview) return
    try {
      const res = await ctx.invoke<{ path: string }>('feat:team-config:exportWrite', share.repo, { equipo: share.equipo, include: [cur.name] }, share.preview.text)
      setShare(null)
      await loadTemplates(ctx)
      flash(`Compartida con el equipo en ${shortPath(res.path)}`)
    } catch (e) {
      setShare({ ...share, notice: cleanError(e) })
    }
  }

  // ---- Listas ----
  const q0 = norm(q.trim())
  const visible = list.filter((t) => !q0 || norm(`${t.name} ${t.description ?? ''}`).includes(q0))
  const teamRows = visible.filter((t) => t.team)
  const mineRows = visible.filter((t) => !t.team)
  const rowOf = (t: TemplateDto): React.JSX.Element => {
    const on = cur?.id === t.id
    const dr = drafts[t.id]
    const changedRow = Boolean(dr && !sameFields(dr, toFields(t)))
    return (
      <button key={t.id} type="button" className="tp-row" aria-current={on ? 'true' : undefined} onClick={() => select(t.id)}>
        <span className="tp-row-tile" style={{ background: colorHex(t.color) }}>
          <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
            <path d={iconPath(t.icon)} />
          </svg>
        </span>
        <span className="tp-row-text">
          <span className="tp-row-name">
            <span className="tp-row-title">{t.name || 'Sin nombre'}</span>
            {defaultId === t.id && <span className="tp-badge ok">Predeterminada</span>}
            {changedRow && <span className="tp-unsaved">· sin guardar</span>}
          </span>
          <span className="tp-row-desc">{t.description || 'Sin descripción'}</span>
        </span>
      </button>
    )
  }

  // ---- Vista previa ----
  const brResolved = ed?.wt ? applyVars(ed.br, { ticket: 'PROJ-123', fecha: today(), n: (cur?.counter ?? 0) + 1, plantilla: ed.name }) : ''
  const sample = {
    ticket: 'PROJ-123',
    carpeta: 'mi-app/front',
    rama: ed?.wt ? brResolved || '…' : 'main',
    fecha: today(),
    n: (cur?.counter ?? 0) + 1,
    plantilla: ed?.name || '…'
  }
  const brErr = tried && ed?.wt ? brMsg(ed.br, ed.name) : ''
  const nameErr = tried && ed && cur ? nameMsg(ed.name, cur.id, list) : ''
  const unknown = ed ? unknownVars(ed.prompt) : []
  const segs = ed ? previewSegments(ed.prompt, sample) : []

  return (
    <Modal
      title="Plantillas de espacio"
      subtitle={`${list.length} ${list.length === 1 ? 'plantilla' : 'plantillas'} · ${list.filter((t) => t.team).length} del equipo`}
      onClose={requestClose}
      dirty={hasDrafts && !share && !creating}
      className="tp-screen"
      headClassName="tp-head"
      titlesClassName="tp-titles"
    >
      <div className="tp-body">
        <aside className="tp-list" aria-label="Lista de plantillas">
          <label className="tp-search">
            <SearchIcon size={14} />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar plantilla" aria-label="Buscar plantilla" />
          </label>

          <button type="button" className="btn primary tp-new-btn" aria-expanded={creating} onClick={() => setCreating((v) => !v)}>
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Nueva plantilla
          </button>

          {creating && (
            <form className="tp-new" onSubmit={(e) => void createNew(e)} noValidate>
              <div className="tp-new-title">Nueva plantilla</div>
              <div className="field">
                <label htmlFor="tp-new-name">Nombre</label>
                <input
                  id="tp-new-name"
                  autoFocus
                  value={newName}
                  maxLength={80}
                  onChange={(e) => {
                    setNewName(e.target.value)
                    setNewErr('')
                  }}
                  placeholder="Ej.: Hotfix de staging"
                  aria-invalid={Boolean(newErr)}
                  aria-describedby={newErr ? 'tp-new-err' : undefined}
                />
              </div>
              <div className="field">
                <label htmlFor="tp-new-from">Empezar desde</label>
                <select id="tp-new-from" value={newFrom} onChange={(e) => setNewFrom(e.target.value)}>
                  <option value="">Vacía</option>
                  {list.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              {newErr && (
                <p className="tp-err" id="tp-new-err" role="alert">
                  {newErr}
                </p>
              )}
              <div className="tp-new-actions">
                <button type="button" className="btn ghost sm" onClick={() => setCreating(false)}>
                  Cancelar
                </button>
                <button type="submit" className="btn primary sm">
                  Crear
                </button>
              </div>
            </form>
          )}

          {teamRows.length > 0 && (
            <section aria-labelledby="tp-team-h" className="tp-group">
              <h3 id="tp-team-h">Del equipo · {teamRows.length}</h3>
              {teamRows.map(rowOf)}
            </section>
          )}
          {mineRows.length > 0 && (
            <section aria-labelledby="tp-mine-h" className="tp-group">
              <h3 id="tp-mine-h">Mías · {mineRows.length}</h3>
              {mineRows.map(rowOf)}
            </section>
          )}
          {q0 && visible.length === 0 && (
            <p className="tp-empty" role="status">
              Ninguna plantilla coincide con «{q.trim()}».
            </p>
          )}
          {list.length === 0 && <p className="tp-empty">Todavía no hay plantillas. Creá una con «Nueva plantilla».</p>}
          <p className="tp-foot">Las plantillas del equipo no se editan ni se borran. Duplicalas para tener tu versión.</p>
        </aside>

        <main className="tp-main">
          {!cur && (
            <div className="tp-none">
              <span className="tp-none-title">Elegí una plantilla de la lista</span>
              <span className="tp-none-sub">Una plantilla define cómo arranca un espacio: nombre, cuenta, rama y el primer mensaje para Claude.</span>
            </div>
          )}

          {cur && ed && (
            <div className="tp-detail">
              <header className="tp-title-row">
                <span className="tp-big-tile" style={{ background: colorHex(isMine ? ed.color : cur.color) }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                    <path d={iconPath(isMine ? ed.icon : cur.icon)} />
                  </svg>
                </span>
                <div className="tp-title-text">
                  <h2>{cur.name}</h2>
                  <div className="tp-badges">
                    <span className={`tp-badge ${cur.team ? 'team' : 'mine'}`}>{cur.team ? 'Del equipo' : 'Mía'}</span>
                    {defaultId === cur.id && <span className="tp-badge ok">Predeterminada</span>}
                  </div>
                </div>
              </header>

              {dirty && (
                <div className="tp-dirty" role="status">
                  <span className="tp-dirty-dot" aria-hidden="true" />
                  <strong>Cambios sin guardar</strong>
                  <span>Guardá o descartá antes de salir de esta plantilla.</span>
                </div>
              )}

              <div className="tp-actions">
                <button type="button" className="btn primary" onClick={useNow}>
                  Usar esta plantilla
                </button>
                <button type="button" className="btn tp-def" aria-pressed={defaultId === cur.id} onClick={() => void toggleDefault()}>
                  {defaultId === cur.id ? 'Es la predeterminada' : 'Fijar como predeterminada'}
                </button>
                <button type="button" className="btn" onClick={() => void dup()}>
                  Duplicar
                </button>
                {isMine && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setShare(share ? null : { repo: cur.repoPath ?? '', equipo: '', notice: '', preview: null })
                    }}
                    aria-expanded={Boolean(share)}
                  >
                    Compartir con el equipo
                  </button>
                )}
              </div>

              {isTeam && (
                <section className="tp-card tp-readonly" aria-label="Datos de la plantilla del equipo">
                  <div className="tp-kv">
                    <span>Descripción</span>
                    <span>{cur.description || '—'}</span>
                  </div>
                  <div className="tp-kv">
                    <span>Cuenta sugerida</span>
                    <span>{accountLabel(cur.accountId)}</span>
                  </div>
                  <div className="tp-kv">
                    <span>Rama</span>
                    <span className="mono">{cur.useWorktree ? cur.useWorktree.branchPattern : 'Sin rama aparte'}</span>
                  </div>
                  <div className="tp-kv">
                    <span>Primer mensaje</span>
                    <span className="mono pre">{cur.initialPrompt || 'Sin primer mensaje: el espacio arranca vacío.'}</span>
                  </div>
                  <p className="tp-hint">Esta plantilla es del equipo: no se edita ni se borra. Si la necesitás distinta, duplicala y cambiá tu copia.</p>
                </section>
              )}

              {isMine && (
                <form
                  className="tp-card tp-editor"
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault()
                    void save()
                  }}
                >
                  <div className="field">
                    <label htmlFor="tp-name">Nombre</label>
                    <input
                      id="tp-name"
                      value={ed.name}
                      maxLength={80}
                      onChange={(e) => setField('name', e.target.value)}
                      placeholder="Ej.: Ticket del tablero"
                      aria-invalid={Boolean(nameErr)}
                      aria-describedby={nameErr ? 'tp-name-err' : undefined}
                    />
                    {nameErr && (
                      <p className="field-error" id="tp-name-err">
                        {nameErr}
                      </p>
                    )}
                  </div>

                  <div className="field">
                    <label htmlFor="tp-desc">Descripción</label>
                    <input id="tp-desc" value={ed.description} maxLength={140} onChange={(e) => setField('description', e.target.value)} placeholder="Una línea para reconocerla en la lista" />
                  </div>

                  <div className="tp-field-group">
                    <span id="tp-icon-lbl">Ícono</span>
                    <div role="radiogroup" aria-labelledby="tp-icon-lbl" className="tp-icons">
                      {TEMPLATE_ICON_KEYS.map((k) => {
                        const on = ed.icon === k
                        return (
                          <button
                            key={k}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            aria-label={TEMPLATE_ICONS[k].label}
                            title={TEMPLATE_ICONS[k].label}
                            className={`tp-icon-pick${on ? ' on' : ''}`}
                            onClick={() => setField('icon', k)}
                          >
                            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                              <path d={TEMPLATE_ICONS[k].path} />
                            </svg>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="tp-field-group">
                    <span id="tp-col-lbl">Color</span>
                    <div role="radiogroup" aria-labelledby="tp-col-lbl" className="tp-colors">
                      {TEMPLATE_COLOR_KEYS.map((k) => {
                        const on = ed.color === k
                        return (
                          <button
                            key={k}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            aria-label={TEMPLATE_COLORS[k].name}
                            title={TEMPLATE_COLORS[k].name}
                            className={`tp-color-pick${on ? ' on' : ''}`}
                            style={{ background: TEMPLATE_COLORS[k].hex, color: TEMPLATE_COLORS[k].hex }}
                            onClick={() => setField('color', k)}
                          />
                        )
                      })}
                    </div>
                  </div>

                  <div className="field">
                    <label htmlFor="tp-acc">Cuenta sugerida</label>
                    <select id="tp-acc" value={ed.accountId} onChange={(e) => setField('accountId', e.target.value)}>
                      <option value={SUGGESTED}>Sugerida (con sesión y menos uso en 5 h)</option>
                      {ctx.accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="tp-wt">
                    <div className="tp-wt-text">
                      <span id="tp-wt-lbl">Crear rama aparte (worktree)</span>
                      <small>Abre una copia de la carpeta con su propia rama, así no pisa lo que tenés abierto.</small>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={ed.wt}
                      aria-labelledby="tp-wt-lbl"
                      className={`switch-btn${ed.wt ? ' on' : ''}`}
                      onClick={() => setField('wt', !ed.wt)}
                    >
                      <span aria-hidden="true" />
                    </button>
                  </div>

                  {ed.wt && (
                    <div className="field indent">
                      <label htmlFor="tp-br">Patrón de rama</label>
                      <input
                        id="tp-br"
                        className="mono"
                        spellCheck={false}
                        value={ed.br}
                        onChange={(e) => setField('br', e.target.value)}
                        placeholder="fix/{ticket}"
                        aria-invalid={Boolean(brErr)}
                        aria-describedby="tp-br-hint"
                      />
                      {brErr && (
                        <p className="field-error" role="alert">
                          {brErr}
                        </p>
                      )}
                      <p className="field-help" id="tp-br-hint">
                        Sin espacios. Podés usar {'{ticket}'}. Ejemplo con PROJ-123:<span className="mono">{brResolved || '…'}</span>
                      </p>
                    </div>
                  )}

                  <div className="field">
                    <label htmlFor="tp-prompt">Primer mensaje para Claude</label>
                    <textarea
                      id="tp-prompt"
                      ref={promptRef}
                      rows={5}
                      className="mono"
                      value={ed.prompt}
                      onChange={(e) => setField('prompt', e.target.value)}
                      placeholder="Ej.: Leé el ticket {ticket} y resumí qué pide."
                      aria-describedby="tp-prompt-hint"
                    />
                    <div className="tp-chips" role="group" aria-label="Insertar variable">
                      <span className="tp-chips-lbl">Insertar:</span>
                      {VAR_CHIPS.map((v) => (
                        <button key={v} type="button" className="tp-chip mono" onClick={() => insertVar(v)} aria-label={`Insertar ${v} en el cursor`}>
                          {v}
                        </button>
                      ))}
                    </div>
                    <p className="field-help" id="tp-prompt-hint">
                      Las variables se reemplazan al crear el espacio: {'{ticket}'} es el número del ticket, {'{carpeta}'} la carpeta y {'{rama}'} la rama que se crea.
                    </p>
                    {unknown.length > 0 && (
                      <p className="field-warn">
                        Variable que no existe: {unknown.map((u) => `{${u}}`).join(', ')}. Las que hay son {'{ticket}'}, {'{carpeta}'} y {'{rama}'}.
                      </p>
                    )}
                  </div>

                  <div className="tp-preview" aria-labelledby="tp-pv-h">
                    <h3 id="tp-pv-h">Vista previa con PROJ-123 en mi-app/front</h3>
                    <div className="tp-preview-box">
                      {segs.length > 0 ? (
                        segs.map((s, i) => (
                          <span key={i} className={s.v ? 'tp-seg-var' : undefined}>
                            {s.t}
                          </span>
                        ))
                      ) : (
                        <span className="tp-muted">Sin primer mensaje: el espacio arranca vacío.</span>
                      )}
                    </div>
                  </div>

                  <div className="tp-save-bar">
                    <span className="tp-save-hint" role="status">
                      {tried && (nameErr || brErr) ? 'Revisá los campos marcados.' : err}
                    </span>
                    <button type="button" className="btn ghost" onClick={discard} disabled={!dirty}>
                      Descartar cambios
                    </button>
                    <button type="submit" className="btn primary" disabled={saving}>
                      {saving ? 'Guardando…' : 'Guardar'}
                    </button>
                  </div>
                </form>
              )}

              {isTeam && err && (
                <p className="tp-err" role="alert">
                  {err}
                </p>
              )}

              {isMine && share && (
                <section className="tp-card tp-share" aria-label="Compartir con el equipo">
                  <h3>Compartir con el equipo</h3>
                  <p className="tp-hint">Se escribe en .sloth/team.json del repo que elijas. Solo se puede si el repo todavía no tiene ese archivo.</p>
                  <div className="field">
                    <label htmlFor="tp-share-repo">Carpeta del repo</label>
                    <div className="input-row">
                      <input id="tp-share-repo" className="mono" value={share.repo} onChange={(e) => setShare({ ...share, repo: e.target.value, preview: null })} placeholder="C:\repos\…" />
                      <button type="button" className="btn" onClick={() => void pickRepo()}>
                        Elegir…
                      </button>
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="tp-share-team">Nombre del equipo</label>
                    <input id="tp-share-team" value={share.equipo} maxLength={60} onChange={(e) => setShare({ ...share, equipo: e.target.value, preview: null })} placeholder="Ej.: Mi equipo" />
                  </div>
                  {share.notice && (
                    <p className="tp-err" role="alert">
                      {share.notice}
                    </p>
                  )}
                  {share.preview && (
                    <>
                      <p className="tp-hint">
                        Se va a escribir <span className="mono">{shortPath(share.preview.path)}</span> con {share.preview.count} plantilla(s).
                      </p>
                      {share.preview.skipped.length > 0 && (
                        <ul className="tp-skipped">
                          {share.preview.skipped.map((s) => (
                            <li key={s.name}>
                              «{s.name}»: {s.reason}
                            </li>
                          ))}
                        </ul>
                      )}
                      <pre className="tp-pre mono">{share.preview.text}</pre>
                    </>
                  )}
                  <div className="tp-share-actions">
                    <button type="button" className="btn ghost" onClick={() => setShare(null)}>
                      Cerrar
                    </button>
                    {!share.preview ? (
                      <button type="button" className="btn" onClick={() => void shareCheck()}>
                        Ver qué se comparte
                      </button>
                    ) : (
                      <button type="button" className="btn primary" disabled={share.preview.count === 0} onClick={() => void shareWrite()}>
                        Guardar en el repo
                      </button>
                    )}
                  </div>
                </section>
              )}

              {isMine && (
                <div className="tp-danger">
                  {confirmDel ? (
                    <div className="tp-confirm" role="alertdialog" aria-labelledby="tp-del-t">
                      <span id="tp-del-t">¿Borrar «{cur.name}»? No se puede deshacer.</span>
                      <button type="button" className="btn ghost sm" onClick={() => setConfirmDel(false)}>
                        Cancelar
                      </button>
                      <button type="button" className="btn danger sm" onClick={() => void remove()}>
                        Sí, borrar
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="tp-del-link" onClick={() => setConfirmDel(true)}>
                      Borrar plantilla
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {toast && (
        <div className="tp-toast" role="status">
          {toast}
        </div>
      )}
    </Modal>
  )
}
