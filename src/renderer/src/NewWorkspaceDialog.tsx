import { useEffect, useMemo, useRef, useState } from 'react'
import type { Account, AccountStatus, AccountUsage, NewWorkspaceInput, Workspace } from '../../shared/types'
import { api } from './api'
import { Modal } from './Modal'
import { Button, Chip, Input, Select, Tabs, Textarea, tabPanelProps } from './ui'
import { FolderIcon, TemplatesIcon, TicketIcon } from './icons/SlothIcons'
import { cleanError, emptyTotals, totalTok } from './format'
import type { NewWorkspacePreset } from './features/host'
import { useUi } from './features/host'
import { useTemplates, openDialog, peekPreselect, takePreselect, usesTicket, type TemplateDto } from './features/templates/store'
import { TEMPLATE_COLORS, colorHex } from './features/templates/catalog'
import { setBoardOpen, useSnapshot } from './features/tickets/model'
import { applyVars, folderLabel, missingVars, normTicketId, TEMPLATE_COLOR_KEYS, TICKET_RE, today, validBranch, type VarValues } from '../../shared/templates-shared'
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

type Origin = 'carpeta' | 'ticket' | 'plantilla'

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
  const tk = useSnapshot()
  const { accounts, statuses, usage, mode, onClose } = props
  const tplState = useTemplates()

  // Sugerida: con sesión y la que menos usó en las últimas 5 h.
  const suggested = useMemo(() => {
    const logged = accounts.filter((a) => statuses[a.id]?.loggedIn)
    const pool = logged.length ? logged : accounts
    const used = (a: Account): number => totalTok(usage[a.id]?.last5h ?? emptyTotals)
    return [...pool].sort((a, b) => used(a) - used(b))[0]?.id ?? ''
  }, [accounts, statuses, usage])

  // Plantilla inicial: la que pidió la barra o la predeterminada. Se lee una vez.
  const [origin, setOrigin] = useState<Origin>(() => (mode === 'ticket' ? 'ticket' : peekPreselect() || tplState.defaultId ? 'plantilla' : 'carpeta'))
  const [tplId, setTplId] = useState<string>(() => peekPreselect() ?? tplState.defaultId ?? '')
  useEffect(() => {
    takePreselect()
  }, [])
  const ticketMode = origin === 'ticket'
  const tpl: TemplateDto | undefined = origin === 'plantilla' ? tplState.list.find((t) => t.id === tplId) : undefined
  const tplTicket = Boolean(tpl && usesTicket(tpl))

  const [ticket, setTicket] = useState('')
  const [carpeta, setCarpeta] = useState(props.preset?.repoPath ?? (ticketMode ? props.defaultRepo : ''))
  const initialCarpeta = useRef(carpeta)
  const [nameRaw, setNameRaw] = useState(props.preset?.name ?? '')
  const [nameTouched, setNameTouched] = useState(Boolean(props.preset?.name))
  const [accountId, setAccountId] = useState(() => (props.preset?.accountId && accounts.some((a) => a.id === props.preset?.accountId) ? props.preset.accountId : suggested))
  const [colorKey, setColorKey] = useState<(typeof TEMPLATE_COLOR_KEYS)[number]>('cielo')
  const [wtOn, setWtOn] = useState(false)
  const [branchRaw, setBranchRaw] = useState('')
  const [base, setBase] = useState('')
  const [msgEdit, setMsgEdit] = useState<string | null>(null)
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

  // Si el conector usa la skill /ticket, el id tiene que tener la forma ABC-123.
  const normId = normTicketId(ticket) ?? ''
  const ticketId = tk?.conector.comandoTicket && !TICKET_RE.test(normId) ? '' : normId
  const ticketOk = ticketId !== ''

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
    if (!ticketOk) errs.ticket = ticket.trim() ? `Tiene que ser un id como ${tk?.conector.ejemploId || 'PROJ-123'}.` : ticketMode ? 'Poné el ticket.' : 'Esta plantilla usa {ticket}: poné el ticket.'
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
            // La skill /ticket abre su propio worktree desde origin/staging.
            initialPrompt: tk?.conector.comandoTicket ? `/ticket ${ticketId}` : undefined,
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

  const pick = async (): Promise<void> => {
    const p = await api.pickFolder()
    if (!p) return
    setCarpeta(p)
    setDupAck(false)
  }

  const chooseFolder = (p: string): void => {
    setCarpeta(p)
    setDupAck(false)
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
  // Tickets: el tablero crea el espacio desde el ticket elegido. Cierra este diálogo para no encimarlo.
  const openTickets = (): void => {
    onClose()
    setBoardOpen(true)
  }

  // ---- Piezas visuales ----
  const folderRows = recent?.folders ?? []
  const counts = recent?.counts ?? {}
  const canCreate = accounts.length > 0

  const colorSwatch = (k: (typeof TEMPLATE_COLOR_KEYS)[number], on: boolean): React.JSX.Element => {
    const hex = TEMPLATE_COLORS[k].hex
    return (
      <button
        key={k}
        type="button"
        role="radio"
        aria-checked={on}
        aria-label={TEMPLATE_COLORS[k].name}
        title={TEMPLATE_COLORS[k].name}
        className={`nw-color${on ? ' on' : ''}`}
        style={{ background: `${hex}2e`, color: hex }}
        onClick={() => setColorKey(k)}
      >
        {(name.trim().charAt(0) || '?').toUpperCase()}
      </button>
    )
  }

  const dirty =
    (carpetaTrim !== '' && carpeta !== initialCarpeta.current) ||
    (nameTouched && nameRaw.trim() !== (props.preset?.name ?? '').trim()) ||
    ticket.trim() !== '' ||
    (msgEdit ?? '').trim() !== ''

  const acc = accounts.find((a) => a.id === accountId)
  const accNoSession = Boolean(acc && statuses[acc.id] && !statuses[acc.id].loggedIn)

  const changeOrigin = (o: Origin): void => {
    if (o === origin) return
    setOrigin(o)
    setTried(false)
    if (o === 'plantilla') {
      if (!tplState.list.some((t) => t.id === tplId) && tplState.list[0]) pickTemplate(tplState.list[0])
    } else setMsgEdit(null)
  }

  const gitHint = !carpetaTrim
    ? 'Escribí la ruta, elegí una reciente o soltá una carpeta en la ventana.'
    : cur && !cur.exists
      ? 'No encontramos esa carpeta en esta PC.'
      : cur?.isGit
        ? `Repo git · rama ${cur.branch ?? 'sin rama (HEAD suelto)'}`
        : cur
          ? 'No es un repositorio Git.'
          : 'Revisando la carpeta…'

  const ticketField = (
    <div className="nw-field">
      <label htmlFor="nw-ticket">
        Ticket <span className="nw-req" aria-hidden="true">*</span>
      </label>
      <Input
        id="nw-ticket"
        mono
        autoFocus={ticketMode}
        value={ticket}
        onChange={(e) => setTicket(e.target.value)}
        placeholder={tk?.conector.ejemploId || 'PROJ-123'}
        error={showErr('ticket')}
      />
      <span className="nw-hint">
        {ticketMode ? (tk?.conector.comandoTicket ? 'Claude arranca con /ticket: tu skill se encarga del worktree, el PR y las horas.' : 'El id del ticket va en el nombre del espacio.') : 'Reemplaza {ticket} en el nombre, la rama y el primer mensaje.'}{' '}
        <button type="button" className="nw-link" onClick={openTickets}>
          {tk?.conector.disponible ? `Elegir de ${tk.conector.nombre}` : 'Elegir de la lista'}
        </button>
      </span>
    </div>
  )

  const footer = (
    <>
      <span className="nw-summary">
        {canCreate ? (
          <>
            Se crea en <strong>{acc?.label ?? 'tu cuenta'}</strong> y se abre en un panel.
          </>
        ) : (
          'Agregá una cuenta de Claude para poder crear espacios.'
        )}
      </span>
      <Button variant="ghost" onClick={onClose} disabled={busy}>
        Cancelar
      </Button>
      <Button variant="primary" type="submit" loading={busy} kbd="Ctrl+Enter">
        {busy ? 'Creando…' : 'Crear espacio'}
      </Button>
    </>
  )

  return (
    <Modal
      size="lg"
      className="nw-modal"
      title={ticketMode ? 'Espacio desde ticket' : 'Nuevo espacio'}
      subtitle="Una carpeta, una cuenta de Claude y su propia terminal."
      dirty={dirty}
      locked={busy}
      onClose={onClose}
      footer={footer}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          void submit()
        }
      }}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="nw-body">
        <Tabs
          aria-label="Origen del espacio"
          idBase="nw-origin"
          value={origin}
          onChange={changeOrigin}
          tabs={[
            { id: 'carpeta', label: <span className="nw-tab"><FolderIcon size={14} /> Carpeta</span> },
            { id: 'ticket', label: <span className="nw-tab"><TicketIcon size={14} /> Ticket</span> },
            { id: 'plantilla', label: <span className="nw-tab"><TemplatesIcon size={14} /> Plantilla</span> }
          ]}
        />

        <div className="nw-panel" {...tabPanelProps('nw-origin', origin)}>
          {origin === 'ticket' && ticketField}

          {origin === 'plantilla' && (
            <div className="nw-field">
              <span id="nw-tpl-lbl" className="nw-lbl">
                Plantilla
              </span>
              {tplState.list.length === 0 ? (
                <span className="nw-hint">
                  Todavía no tenés plantillas.{' '}
                  <button type="button" className="nw-link" onClick={openTemplates}>
                    Crear una
                  </button>
                </span>
              ) : (
                <div role="group" aria-labelledby="nw-tpl-lbl" className="nw-chips">
                  {tplState.list.map((t) => (
                    <Chip key={t.id} selected={tpl?.id === t.id} onClick={() => pickTemplate(t)}>
                      {t.name}
                    </Chip>
                  ))}
                </div>
              )}
              {tpl?.description && <span className="nw-hint">{tpl.description}</span>}
              {tplState.list.length > 0 && (
                <span className="nw-hint">
                  <button type="button" className="nw-link" onClick={openTemplates}>
                    Administrar plantillas
                  </button>
                </span>
              )}
            </div>
          )}
          {origin === 'plantilla' && tplTicket && ticketField}

          <div className="nw-field">
            <label htmlFor="nw-carpeta">
              Carpeta del proyecto <span className="nw-req" aria-hidden="true">*</span>
            </label>
            <div className="nw-row">
              <Input
                id="nw-carpeta"
                mono
                className="nw-grow"
                autoComplete="off"
                spellCheck={false}
                autoFocus={origin === 'carpeta'}
                value={carpeta}
                onChange={(e) => {
                  setCarpeta(e.target.value)
                  setDupAck(false)
                }}
                placeholder="Ruta de la carpeta"
                error={showErr('carpeta')}
                aria-describedby="nw-carpeta-hint"
              />
              <Button onClick={() => void pick()}>Elegir…</Button>
            </div>
            {folderRows.length > 0 && (
              <div className="nw-recents" role="group" aria-label="Carpetas recientes">
                <span className="nw-hint">Recientes:</span>
                {folderRows.slice(0, 5).map((f) => (
                  <Chip key={f.path} selected={carpetaTrim === f.path} onClick={() => chooseFolder(f.path)}>
                    {f.name}
                  </Chip>
                ))}
              </div>
            )}
          </div>

          {hasDup && !dupAck && (
            <div className="nw-dup" role="group" aria-label="Espacio existente en esta carpeta">
              <span>
                Ya tenés un espacio en esta carpeta: <strong>{dupSpaces[0].name}</strong> ({dupSpaces[0].accountLabel}). ¿Abrir ese o crear otro?
              </span>
              <div className="nw-dup-actions">
                <Button
                  size="sm"
                  onClick={() => {
                    ctx.openPane(dupSpaces[0].id)
                    onClose()
                  }}
                >
                  Abrir ese
                </Button>
                <Button id="nw-dup-otro" size="sm" onClick={() => setDupAck(true)}>
                  Crear otro
                </Button>
              </div>
              {showErr('dup') && (
                <span className="nw-err" role="alert">
                  {showErr('dup')}
                </span>
              )}
            </div>
          )}
          {hasDup && dupAck && <span className="nw-warn-line">Vas a crear otro espacio en esta carpeta.</span>}

          <div className="nw-pair">
            <div className="nw-field">
              <label htmlFor="nw-nombre">{ticketMode ? 'Nombre (opcional)' : 'Nombre'}</label>
              <Input
                id="nw-nombre"
                autoComplete="off"
                value={name}
                onChange={(e) => {
                  setNameRaw(e.target.value)
                  setNameTouched(true)
                }}
                placeholder={ticketMode ? ticketId || 'PROJ-123' : 'Ej.: front'}
                error={showErr('nombre')}
              />
              <span className="nw-hint">{ticketMode ? 'Si lo dejás vacío, usa el id del ticket.' : 'Sale de la carpeta; lo podés cambiar.'}</span>
            </div>
            {!ticketMode ? (
              <div className="nw-field">
                <label htmlFor="nw-rama-modo">Rama</label>
                <Select
                  id="nw-rama-modo"
                  value={wtOn ? 'nueva' : 'actual'}
                  onChange={(e) => setWtOn(e.target.value === 'nueva')}
                  options={[
                    { value: 'actual', label: cur?.isGit ? `Rama actual · ${cur.branch ?? 'sin rama'}` : 'Rama actual' },
                    { value: 'nueva', label: 'Rama aparte nueva (worktree)' }
                  ]}
                />
                <span id="nw-carpeta-hint" className={`nw-hint${cur?.isGit ? ' ok' : ''}`}>
                  {gitHint}
                </span>
              </div>
            ) : (
              <span id="nw-carpeta-hint" className="nw-hint nw-hint--alone">
                {gitHint}
              </span>
            )}
          </div>

          {!ticketMode && wtOn && (
            <div className="nw-pair">
              <div className="nw-field">
                <label htmlFor="nw-rama">Rama nueva</label>
                <Input
                  id="nw-rama"
                  mono
                  spellCheck={false}
                  autoComplete="off"
                  value={branchRaw}
                  onChange={(e) => setBranchRaw(e.target.value)}
                  placeholder="feat/mi-cambio"
                  error={showErr('rama')}
                />
                <span className="nw-hint">{branchResolved && branchResolved !== branchRaw.trim() ? `Se va a crear: ${branchResolved}` : 'Sin espacios: usá guiones o barras.'}</span>
              </div>
              <div className="nw-field">
                <label htmlFor="nw-base">Desde</label>
                <Select id="nw-base" value={base} onChange={(e) => setBase(e.target.value)} disabled={!hasGit}>
                  {!branches?.list.length && <option value={base}>{base || 'Elegí una carpeta Git'}</option>}
                  {(branches?.list ?? []).map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          )}

          <div className="nw-field">
            <span id="nw-acc-lbl" className="nw-lbl">
              Cuenta de Claude
            </span>
            <div role="radiogroup" aria-labelledby="nw-acc-lbl" className="nw-accs">
              {accounts.map((a, i) => {
                const on = a.id === accountId
                const n = recent ? (counts[a.id] ?? 0) : null
                const st = statuses[a.id]
                return (
                  <button key={a.id} type="button" role="radio" aria-checked={on} className={`nw-acc${on ? ' on' : ''}`} onClick={() => setAccountId(a.id)}>
                    <span className={`nw-acc-ini${i % 2 ? ' alt' : ''}`} aria-hidden="true">
                      {a.label.charAt(0).toUpperCase()}
                    </span>
                    <span className="nw-acc-text">
                      <span className="nw-acc-name">{a.label}</span>
                      <span className="nw-acc-sub">{n === null ? '…' : n === 1 ? '1 espacio abierto' : `${n} espacios abiertos`}</span>
                      {st && !st.loggedIn && <span className="nw-acc-warn">Sin sesión: vas a iniciarla en la terminal</span>}
                    </span>
                  </button>
                )
              })}
            </div>
            {accounts.length === 0 && <span className="nw-err">Agregá una cuenta de Claude antes de crear un espacio.</span>}
            {accNoSession && <span className="nw-hint">Al abrir el espacio, Claude te pide iniciar sesión en esa terminal.</span>}
          </div>

          {!ticketMode && (
            <div className="nw-field">
              <label htmlFor="nw-msg">
                Primer mensaje para Claude <span className="nw-opt">· opcional</span>
              </label>
              <Textarea
                id="nw-msg"
                rows={3}
                value={msg}
                onChange={(e) => setMsgEdit(e.target.value)}
                placeholder="Ej.: revisá los tests que fallan"
                error={showErr('msg')}
                aria-describedby="nw-msg-hint"
              />
              <span id="nw-msg-hint" className="nw-hint">
                Se manda solo la primera vez que se abre el espacio.
              </span>
            </div>
          )}

          <details className="nw-adv">
            <summary>
              <span className="nw-adv-title">Más opciones</span> <span className="nw-hint">color del ícono</span>
            </summary>
            <div className="nw-adv-body">
              <span id="nw-col-lbl" className="nw-lbl">
                Color del ícono
              </span>
              <div role="radiogroup" aria-labelledby="nw-col-lbl" className="nw-colors">
                {TEMPLATE_COLOR_KEYS.map((k) => colorSwatch(k, colorKey === k))}
              </div>
            </div>
          </details>

          {err && (
            <p className="nw-form-err" role="alert">
              {err}
            </p>
          )}
        </div>
      </div>
    </Modal>
  )
}
