import { useEffect, useMemo, useState } from 'react'
import type { Account, AccountStatus, AccountUsage, NewWorkspaceInput, Workspace } from '../../shared/types'
import { api } from './api'
import { cleanError, emptyTotals, fmtTok, totalTok } from './format'
import type { NewWorkspacePreset } from './features/host'
import { useUi } from './features/host'
import { useTemplates, openDialog, peekPreselect, takePreselect, usesTicket, type TemplateDto } from './features/templates/store'
import { TEMPLATE_COLORS, colorHex } from './features/templates/catalog'
import { applyVars, folderLabel, missingVars, TEMPLATE_COLOR_KEYS, TICKET_RE, today, validBranch, type VarValues } from '../../shared/templates-shared'
import './NewWorkspaceDialog.css'

interface Props {
  mode: 'normal' | 'ticket'
  accounts: Account[]
  statuses: Record<string, AccountStatus>
  usage: Record<string, AccountUsage>
  defaultRepo: string
  /** Valores iniciales (p. ej. carpeta soltada sobre la ventana). */
  preset?: NewWorkspacePreset
  onClose: () => void
  onCreated: (ws: Workspace) => void
}

/** Lo que main acepta de un espacio nuevo (color y rama base se suman en la integración). */
type NewInput = NewWorkspaceInput

interface FolderInfo {
  path: string
  name: string
  exists: boolean
  isGit: boolean
  branch: string | null
  spaces: { id: string; name: string; accountId: string; accountLabel: string }[]
}

interface RecentData {
  folders: FolderInfo[]
  counts: Record<string, number>
}

type FieldKey = 'carpeta' | 'nombre' | 'ticket' | 'rama' | 'msg' | 'dup'

const lastSegment = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? ''

/** Error de la rama aparte. Si depende de un ticket todavía vacío, lo cubre el error del ticket. */
function branchError(raw: string, resolved: string, values: VarValues): string {
  const b = raw.trim()
  if (!b) return 'Poné un nombre para la rama nueva.'
  if (/\s/.test(b)) return 'Sin espacios: usá guiones o barras (feat/filtros).'
  if (missingVars(b, values).length) return ''
  if (!validBranch(resolved)) return 'Esa rama no es válida. Usá letras, números, guiones, puntos o barras.'
  return ''
}

export function NewWorkspaceDialog(props: Props): React.JSX.Element {
  const ctx = useUi()
  const { accounts, statuses, usage, mode, onClose } = props
  const ticketMode = mode === 'ticket'
  const tplState = useTemplates()

  // Sugerida: con sesión y la que menos usó en las últimas 5 h.
  const suggested = useMemo(() => {
    const logged = accounts.filter((a) => statuses[a.id]?.loggedIn)
    const pool = logged.length ? logged : accounts
    const used = (a: Account): number => totalTok(usage[a.id]?.last5h ?? emptyTotals)
    return [...pool].sort((a, b) => used(a) - used(b))[0]?.id ?? ''
  }, [accounts, statuses, usage])

  // Plantilla inicial: la que pidió la barra o la predeterminada. Se lee una vez.
  const [tplId, setTplId] = useState<string>(() => peekPreselect() ?? tplState.defaultId ?? '')
  useEffect(() => {
    takePreselect()
  }, [])
  const tpl: TemplateDto | undefined = tplState.list.find((t) => t.id === tplId)
  const tplTicket = Boolean(tpl && usesTicket(tpl))

  const [ticket, setTicket] = useState('')
  const [carpeta, setCarpeta] = useState(props.preset?.repoPath ?? (ticketMode ? props.defaultRepo : ''))
  const [nameRaw, setNameRaw] = useState(props.preset?.name ?? '')
  const [nameTouched, setNameTouched] = useState(Boolean(props.preset?.name))
  const [accountId, setAccountId] = useState(suggested)
  const [colorKey, setColorKey] = useState<(typeof TEMPLATE_COLOR_KEYS)[number]>('cielo')
  const [wtOn, setWtOn] = useState(false)
  const [branchRaw, setBranchRaw] = useState('')
  const [base, setBase] = useState('')
  const [msgEdit, setMsgEdit] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [dupAck, setDupAck] = useState(false)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const [recent, setRecent] = useState<RecentData | null>(null)
  const [info, setInfo] = useState<FolderInfo | null>(null)
  const [branches, setBranches] = useState<{ list: string[]; defaultBase: string | null } | null>(null)

  // Los que no tienen cuenta o no tienen carpeta no pueden crear: igual se muestra el formulario.
  useEffect(() => {
    let alive = true
    void ctx
      .invoke<RecentData>('feat:templates:recent')
      .then((r) => alive && setRecent(r))
      .catch(() => alive && setRecent({ folders: [], counts: {} }))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const carpetaTrim = carpeta.trim()

  // Datos reales de la carpeta (repo, rama, espacios abiertos). Espera a que se deje de escribir.
  useEffect(() => {
    if (!carpetaTrim) return
    let alive = true
    const t = window.setTimeout(() => {
      ctx
        .invoke<FolderInfo>('feat:templates:folder', carpetaTrim)
        .then((i) => alive && setInfo(i))
        .catch(() => alive && setInfo(null))
    }, 200)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carpetaTrim])

  // Solo vale la info de la carpeta actual (la anterior puede seguir mientras se escribe).
  const cur = info && info.path === carpetaTrim ? info : null
  const hasGit = Boolean(cur?.isGit)

  useEffect(() => {
    if (!cur?.isGit) {
      setBranches(null)
      return
    }
    let alive = true
    void ctx
      .invoke<{ list: string[]; defaultBase: string | null }>('feat:templates:branches', cur.path)
      .then((b) => {
        if (!alive) return
        setBranches(b)
        setBase((prev) => prev || b.defaultBase || '')
      })
      .catch(() => alive && setBranches(null))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.path, cur?.isGit])

  const ticketId = ticket.trim().toUpperCase()
  const ticketOk = TICKET_RE.test(ticketId)

  // Valores de las variables (los que ya se conocen).
  const branchPattern = wtOn ? branchRaw.trim() : ''
  const valuesNoRama: VarValues = {
    ticket: ticketOk ? ticketId : undefined,
    carpeta: folderLabel(carpetaTrim),
    fecha: today(),
    n: (tpl?.counter ?? 0) + 1,
    plantilla: tpl?.name
  }
  const branchResolved = branchPattern ? applyVars(branchPattern, valuesNoRama) : ''
  const ramaValue = wtOn ? branchResolved || undefined : (cur?.branch ?? undefined)
  const values: VarValues = { ...valuesNoRama, rama: ramaValue }

  // Nombre: el de la carpeta (o el patrón de la plantilla), editable.
  const autoName = tpl?.namePattern ? applyVars(tpl.namePattern, values) : lastSegment(carpetaTrim)
  const name = nameTouched ? nameRaw : autoName

  // Primer mensaje: el de la plantilla resuelto, o lo que el usuario escribió.
  const rawPrompt = tpl?.initialPrompt ?? ''
  const msgAuto = applyVars(rawPrompt, values)
  const msg = msgEdit ?? msgAuto

  const dupSpaces = cur?.spaces ?? []
  const hasDup = dupSpaces.length > 0

  const colorIdx = TEMPLATE_COLOR_KEYS.indexOf(colorKey)
  const sw = colorHex(colorKey)

  // Validación: solo se muestra después de intentar crear.
  const errs: Partial<Record<FieldKey, string>> = {}
  if (!carpetaTrim) errs.carpeta = 'Falta la carpeta. Escribí la ruta o elegila con «Elegir…».'
  else if (info && info.path === carpetaTrim && !info.exists) errs.carpeta = 'No encontramos esa carpeta en esta PC.'
  if (!name.trim()) errs.nombre = ticketMode ? '' : 'Ponele un nombre al espacio.'
  if (ticketMode || tplTicket) {
    if (!ticketOk) errs.ticket = ticket.trim() ? 'Tiene que ser tipo TCK-1234.' : ticketMode ? 'Poné el ticket.' : 'Esta plantilla usa {ticket}: poné el ticket.'
  }
  if (!ticketMode && wtOn) {
    if (cur && cur.exists && !cur.isGit) errs.rama = 'Las ramas aparte solo sirven en repositorios Git.'
    else if (!errs.rama) {
      const be = branchError(branchRaw, branchResolved, valuesNoRama)
      if (be) errs.rama = be
    }
  }
  if (!ticketMode && msg && missingVars(msg, values).length) {
    errs.msg = `El primer mensaje usa ${missingVars(msg, values)
      .map((v) => `{${v}}`)
      .join(', ')} y todavía no tiene valor.`
  }
  if (hasDup && !dupAck) errs.dup = 'Elegí si abrir ese espacio o crear otro.'
  const showErr = (k: FieldKey): string => (tried && errs[k] ? (errs[k] as string) : '')
  const invalidOf = (k: FieldKey): boolean => showErr(k) !== ''

  const focusKey = (k: FieldKey): void => {
    const id: Record<FieldKey, string> = { carpeta: 'nw-carpeta', nombre: 'nw-nombre', ticket: 'nw-ticket', rama: 'nw-rama', msg: 'nw-msg', dup: 'nw-dup-otro' }
    window.setTimeout(() => document.getElementById(id[k])?.focus(), 0)
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    const order: FieldKey[] = ['carpeta', 'nombre', 'ticket', 'rama', 'msg', 'dup']
    const first = order.find((k) => errs[k])
    if (first) {
      setTried(true)
      focusKey(first)
      return
    }
    setTried(false)
    setBusy(true)
    setErr(null)
    try {
      const input: NewInput = ticketMode
        ? {
            name: name.trim() || ticketId,
            repoPath: carpetaTrim,
            accountId,
            autoStartClaude: true,
            ticket: ticketId,
            // La skill /ticket ya abre su propio worktree desde origin/staging.
            initialPrompt: `/ticket ${ticketId}`,
            resume: true,
            color: colorKey
          }
        : {
            name: name.trim(),
            repoPath: carpetaTrim,
            accountId,
            branch: wtOn ? branchResolved : undefined,
            baseBranch: wtOn && base ? base : undefined,
            autoStartClaude: true,
            initialPrompt: msg.trim() || undefined,
            resume: true,
            color: colorKey
          }
      const ws = await api.addWorkspace(input)
      if (tpl && !ticketMode) void ctx.invoke('feat:templates:used', tpl.id).catch(() => undefined)
      props.onCreated(ws)
    } catch (e) {
      setErr(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  // Escape cierra; Enter (en los campos) crea.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pick = async (): Promise<void> => {
    const p = await api.pickFolder()
    if (!p) return
    setCarpeta(p)
    setDupAck(false)
    setPickerOpen(false)
  }

  const chooseFolder = (p: string): void => {
    setCarpeta(p)
    setDupAck(false)
    setPickerOpen(false)
  }

  const pickTemplate = (t: TemplateDto | undefined): void => {
    setTplId(t?.id ?? '')
    setMsgEdit(null)
    if (t) {
      setColorKey((TEMPLATE_COLOR_KEYS as readonly string[]).includes(t.color ?? '') ? (t.color as (typeof TEMPLATE_COLOR_KEYS)[number]) : 'cielo')
      if (t.accountId !== 'sugerida' && accounts.some((a) => a.id === t.accountId)) setAccountId(t.accountId)
      else setAccountId(suggested)
      if (t.useWorktree) {
        setWtOn(true)
        setBranchRaw(t.useWorktree.branchPattern)
      } else setWtOn(false)
      if (t.repoPath && !carpetaTrim) setCarpeta(t.repoPath)
    }
  }

  const openTemplates = (): void => {
    onClose()
    openDialog({ kind: 'manage' })
  }

  // ---- Piezas visuales ----
  const folderRows = recent?.folders ?? []
  const counts = recent?.counts ?? {}
  const canCreate = accounts.length > 0

  const previewBranch = wtOn ? branchResolved || 'rama nueva' : cur ? (cur.isGit ? (cur.branch ?? 'sin rama') : 'sin Git') : 'sin carpeta'
  const previewName = name.trim() || 'Sin nombre'
  const previewIni = (name.trim().charAt(0) || '?').toUpperCase()
  const acc = accounts.find((a) => a.id === accountId)
  const accStatus = acc ? statuses[acc.id] : undefined

  return (
    <div className="nw-backdrop" onMouseDown={onClose}>
      <form
        className="nw-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nw-title"
        noValidate
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="nw-head">
          <h2 id="nw-title">{ticketMode ? 'Espacio desde ticket' : 'Nuevo espacio'}</h2>
          <p>{ticketMode ? 'Arranca Claude con /ticket. Tu skill se encarga del worktree, el PR y las horas.' : 'Una carpeta, una cuenta de Claude y su propia terminal.'}</p>
        </div>

        <div className="nw-body">
          <div className="nw-main">
            {ticketMode && (
              <div className="nw-field">
                <label htmlFor="nw-ticket">Ticket</label>
                <input
                  id="nw-ticket"
                  className="nw-input mono"
                  autoFocus
                  value={ticket}
                  onChange={(e) => setTicket(e.target.value)}
                  placeholder="TCK-1234"
                  aria-invalid={invalidOf('ticket')}
                  aria-describedby={showErr('ticket') ? 'nw-ticket-err' : undefined}
                />
                {showErr('ticket') && (
                  <span id="nw-ticket-err" className="nw-err" role="alert">
                    {showErr('ticket')}
                  </span>
                )}
              </div>
            )}

            {/* Carpeta */}
            <div className="nw-field">
              <label htmlFor="nw-carpeta">Carpeta del proyecto</label>
              <div className="nw-row">
                <input
                  id="nw-carpeta"
                  className="nw-input mono"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus={!ticketMode}
                  value={carpeta}
                  onChange={(e) => {
                    setCarpeta(e.target.value)
                    setDupAck(false)
                  }}
                  placeholder="Ruta de la carpeta"
                  aria-invalid={invalidOf('carpeta')}
                  aria-describedby="nw-carpeta-hint"
                />
                <button type="button" className="nw-btn" onClick={() => void pick()}>
                  Elegir…
                </button>
                {folderRows.length > 0 && (
                  <button type="button" className="nw-btn ghost" onClick={() => setPickerOpen((v) => !v)} aria-expanded={pickerOpen} aria-controls="nw-recent">
                    Recientes
                  </button>
                )}
              </div>
              {showErr('carpeta') && (
                <span className="nw-err" role="alert">
                  {showErr('carpeta')}
                </span>
              )}
              <span id="nw-carpeta-hint" className="nw-hint">
                {!carpetaTrim
                  ? 'Escribí la ruta o elegí una carpeta.'
                  : cur && !cur.exists
                    ? 'No encontramos esa carpeta en esta PC.'
                    : cur?.isGit
                      ? (
                          <>
                            Repositorio de Git, rama <span className="mono strong">{cur.branch ?? 'sin rama (HEAD suelto)'}</span>
                          </>
                        )
                      : cur
                        ? 'No es un repositorio Git.'
                        : 'Revisando la carpeta…'}
              </span>

              {pickerOpen && folderRows.length > 0 && (
                <div id="nw-recent" className="nw-recent" role="group" aria-label="Carpetas recientes">
                  {folderRows.map((f) => (
                    <button key={f.path} type="button" className="nw-recent-row" onClick={() => chooseFolder(f.path)}>
                      <span className="nw-recent-name">{f.name}</span>
                      <span className="nw-recent-path mono">{f.path}</span>
                      <span className={`nw-recent-git${f.isGit ? ' ok' : ''}`}>{f.isGit ? `Git · ${f.branch ?? 'sin rama'}` : 'Sin Git'}</span>
                      {f.spaces.length > 0 && <span className="nw-recent-dup">Ya tiene espacio</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Espacio existente en la carpeta */}
            {hasDup && !dupAck && (
              <div className="nw-dup" role="group" aria-label="Espacio existente en esta carpeta">
                <span>
                  Ya tenés un espacio en esta carpeta: <strong>{dupSpaces[0].name}</strong> ({dupSpaces[0].accountLabel}). ¿Abrir ese o crear otro?
                </span>
                <div className="nw-dup-actions">
                  <button
                    type="button"
                    className="nw-btn"
                    onClick={() => {
                      ctx.openPane(dupSpaces[0].id)
                      onClose()
                    }}
                  >
                    Abrir ese
                  </button>
                  <button id="nw-dup-otro" type="button" className="nw-btn warn" onClick={() => setDupAck(true)}>
                    Crear otro
                  </button>
                </div>
                {showErr('dup') && (
                  <span className="nw-err" role="alert">
                    {showErr('dup')}
                  </span>
                )}
              </div>
            )}
            {hasDup && dupAck && <span className="nw-warn-line">Vas a crear otro espacio en esta carpeta.</span>}

            {!ticketMode && (
              <div className="nw-field">
                <label htmlFor="nw-nombre">Nombre</label>
                <input
                  id="nw-nombre"
                  className="nw-input"
                  type="text"
                  autoComplete="off"
                  value={name}
                  onChange={(e) => {
                    setNameRaw(e.target.value)
                    setNameTouched(true)
                  }}
                  placeholder="Ej.: front"
                  aria-invalid={invalidOf('nombre')}
                  aria-describedby="nw-nombre-hint"
                />
                <span id="nw-nombre-hint" className="nw-hint">
                  Se completa con el nombre de la carpeta. Lo podés cambiar.
                </span>
                {showErr('nombre') && (
                  <span className="nw-err" role="alert">
                    {showErr('nombre')}
                  </span>
                )}
              </div>
            )}

            {ticketMode && (
              <div className="nw-field">
                <label htmlFor="nw-nombre">Nombre (opcional)</label>
                <input id="nw-nombre" className="nw-input" value={name} onChange={(e) => { setNameRaw(e.target.value); setNameTouched(true) }} placeholder={ticketId || 'TCK-1234'} />
              </div>
            )}

            {/* Cuenta */}
            <div className="nw-field">
              <span id="nw-acc-lbl" className="nw-lbl">
                Cuenta de Claude
              </span>
              <div role="radiogroup" aria-labelledby="nw-acc-lbl" className="nw-accs">
                {accounts.map((a) => {
                  const on = a.id === accountId
                  const st = statuses[a.id]
                  const n = recent ? (counts[a.id] ?? 0) : null
                  return (
                    <button key={a.id} type="button" role="radio" aria-checked={on} className={`nw-acc${on ? ' on' : ''}`} onClick={() => setAccountId(a.id)}>
                      <span className="nw-acc-ini" aria-hidden="true">
                        {a.label.charAt(0).toUpperCase()}
                      </span>
                      <span className="nw-acc-text">
                        <span className="nw-acc-name">{a.label}</span>
                        <span className="nw-acc-sub">
                          {st?.email ?? (st?.loggedIn ? 'con sesión' : 'sin sesión')}
                          {' · '}
                          {n === null ? '…' : `${n} ${n === 1 ? 'espacio' : 'espacios'}`}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
              {accounts.length === 0 && <span className="nw-err">Agregá una cuenta de Claude antes de crear un espacio.</span>}
              {!ticketMode && (
                <span className="nw-hint">
                  Sugerimos la cuenta con sesión que menos usaste en las últimas 5 h.{' '}
                  {usage[accountId] ? `Uso 5 h: ${fmtTok(totalTok(usage[accountId].last5h))}.` : ''}
                </span>
              )}
            </div>

            {!ticketMode && (
              <>
                {/* Plantilla */}
                <div className="nw-field">
                  <span id="nw-tpl-lbl" className="nw-lbl">
                    Plantilla <span className="nw-opt">· opcional</span>
                  </span>
                  <div role="group" aria-labelledby="nw-tpl-lbl" className="nw-chips">
                    <button type="button" className="nw-chip" aria-pressed={!tpl} onClick={() => pickTemplate(undefined)}>
                      Ninguna
                    </button>
                    {tplState.list.map((t) => (
                      <button key={t.id} type="button" className="nw-chip" aria-pressed={tpl?.id === t.id} onClick={() => pickTemplate(t)}>
                        <span className="nw-chip-dot" style={{ background: colorHex(t.color) }} aria-hidden="true" />
                        {t.name}
                        {t.team && <span className="nw-chip-team">equipo</span>}
                      </button>
                    ))}
                    <button type="button" className="nw-chip ghost" onClick={openTemplates}>
                      Administrar…
                    </button>
                  </div>
                  {tpl?.description && <span className="nw-hint">{tpl.description}</span>}
                </div>

                <div className="nw-field">
                  <label htmlFor="nw-msg">Primer mensaje para Claude (editable, opcional)</label>
                  <textarea
                    id="nw-msg"
                    className="nw-input nw-textarea"
                    rows={3}
                    value={msg}
                    onChange={(e) => setMsgEdit(e.target.value)}
                    placeholder="Ej.: revisá los tests que fallan"
                    aria-invalid={invalidOf('msg')}
                    aria-describedby="nw-msg-hint"
                  />
                  <span id="nw-msg-hint" className="nw-hint">
                    Se manda solo la primera vez que se abre el espacio.
                  </span>
                  {showErr('msg') && (
                    <span className="nw-err" role="alert">
                      {showErr('msg')}
                    </span>
                  )}
                </div>

                {tplTicket && (
                  <div className="nw-field">
                    <label htmlFor="nw-ticket">Ticket</label>
                    <input
                      id="nw-ticket"
                      className="nw-input mono"
                      value={ticket}
                      onChange={(e) => setTicket(e.target.value)}
                      placeholder="TCK-1234"
                      aria-invalid={invalidOf('ticket')}
                      aria-describedby="nw-ticket-hint"
                    />
                    <span id="nw-ticket-hint" className={showErr('ticket') ? 'nw-err' : 'nw-hint'} role={showErr('ticket') ? 'alert' : undefined}>
                      {showErr('ticket') || 'Reemplaza {ticket} en el nombre, la rama y el primer mensaje.'}
                    </span>
                  </div>
                )}

                {/* Color */}
                <div className="nw-field">
                  <span id="nw-col-lbl" className="nw-lbl">
                    Color del ícono
                  </span>
                  <div role="radiogroup" aria-labelledby="nw-col-lbl" className="nw-colors">
                    {TEMPLATE_COLOR_KEYS.map((k, i) => {
                      const on = colorIdx === i
                      return (
                        <button
                          key={k}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          aria-label={TEMPLATE_COLORS[k].name}
                          title={TEMPLATE_COLORS[k].name}
                          className={`nw-color${on ? ' on' : ''}`}
                          style={{ background: TEMPLATE_COLORS[k].hex }}
                          onClick={() => setColorKey(k)}
                        />
                      )
                    })}
                  </div>
                </div>
              </>
            )}

            {ticketMode && (
              <div className="nw-field">
                <span className="nw-lbl">Color del ícono</span>
                <div role="radiogroup" aria-label="Color del ícono" className="nw-colors">
                  {TEMPLATE_COLOR_KEYS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={colorKey === k}
                      aria-label={TEMPLATE_COLORS[k].name}
                      className={`nw-color${colorKey === k ? ' on' : ''}`}
                      style={{ background: TEMPLATE_COLORS[k].hex }}
                      onClick={() => setColorKey(k)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Opciones avanzadas */}
            {!ticketMode && (
              <details className="nw-adv" open>
                <summary>Opciones avanzadas</summary>
                <div className="nw-adv-body">
                  <div className="nw-wt">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={wtOn}
                      aria-labelledby="nw-wt-lbl"
                      className={`nw-switch${wtOn ? ' on' : ''}`}
                      onClick={() => setWtOn((v) => !v)}
                    >
                      <span aria-hidden="true" />
                    </button>
                    <span className="nw-wt-text">
                      <span id="nw-wt-lbl">Trabajar en una rama aparte</span>
                      <small>Crea una copia de trabajo (worktree) para no pisar tus cambios.</small>
                    </span>
                  </div>
                  {wtOn && (
                    <div className="nw-wt-fields">
                      <div className="nw-field grow">
                        <label htmlFor="nw-rama">Rama nueva</label>
                        <input
                          id="nw-rama"
                          className="nw-input mono"
                          spellCheck={false}
                          autoComplete="off"
                          value={branchRaw}
                          onChange={(e) => setBranchRaw(e.target.value)}
                          placeholder="feat/mi-cambio"
                          aria-invalid={invalidOf('rama')}
                          aria-describedby="nw-rama-hint"
                        />
                        <span id="nw-rama-hint" className={showErr('rama') ? 'nw-err' : 'nw-hint'} role={showErr('rama') ? 'alert' : undefined}>
                          {showErr('rama') || (branchResolved && branchResolved !== branchRaw.trim() ? `Se va a crear: ${branchResolved}` : 'Sin espacios: usá guiones o barras.')}
                        </span>
                      </div>
                      <div className="nw-field grow">
                        <label htmlFor="nw-base">Desde</label>
                        <select id="nw-base" className="nw-input mono" value={base} onChange={(e) => setBase(e.target.value)} disabled={!hasGit}>
                          {!branches?.list.length && <option value={base}>{base || 'Elegí una carpeta Git'}</option>}
                          {(branches?.list ?? []).map((b) => (
                            <option key={b} value={b}>
                              {b}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              </details>
            )}

            {err && (
              <p className="nw-form-err" role="alert">
                {err}
              </p>
            )}
          </div>

          <aside className="nw-preview" aria-label="Vista previa del espacio">
            <span className="nw-lbl">Así se va a ver en la barra lateral</span>
            <div className="nw-pv-box">
              <div className="nw-pv-acc">
                <span className="nw-pv-acc-ini" aria-hidden="true">
                  {(acc?.label ?? '?').charAt(0).toUpperCase()}
                </span>
                <span className="nw-pv-acc-name">{acc?.label ?? 'Sin cuenta'}</span>
                <span className="nw-pv-acc-sub">{accStatus?.email ?? (accStatus?.loggedIn ? 'con sesión' : 'sin sesión')}</span>
              </div>
              <div className="nw-pv-row">
                <span className="nw-pv-tile" style={{ background: `${sw}2e`, color: sw }} aria-hidden="true">
                  {previewIni}
                </span>
                <span className="nw-pv-text">
                  <span className="nw-pv-name">{previewName}</span>
                  <span className="nw-pv-branch mono">{previewBranch}</span>
                </span>
                <span className="nw-pv-new">Nuevo</span>
              </div>
            </div>
          </aside>
        </div>

        <footer className="nw-foot">
          <span className="nw-keys">Enter crea · Esc cancela</span>
          <span className="nw-grow" />
          <button type="button" className="nw-btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="nw-btn primary" aria-busy={busy} disabled={busy}>
            {busy ? 'Creando…' : 'Crear espacio'}
          </button>
        </footer>
      </form>
    </div>
  )
}
