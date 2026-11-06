import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowsLeftRight, HourglassMedium, X } from '@phosphor-icons/react'
import { isLoginPane, type Account } from '../../../../shared/types'
import { useUi, type FeatureUi, type UiCtx } from '../host'
import { cleanError, fmtTok, totalTok } from '../../format'
import './rotation.css'

/** Lo que manda main (ver src/main/features/rotation.ts). */
interface LimitState {
  wsId: string
  accountId: string
  at: number
  resetsAt?: number
  resetsLabel?: string
  kind?: string
  text: string
  source: 'transcript' | 'terminal'
}

// ---------- Estado compartido (lo carga Global, que se monta una sola vez) ----------

type Listener = () => void
function createStore<T>(initial: T): { get: () => T; set: (v: T) => void; sub: (l: Listener) => () => void } {
  let value = initial
  const ls = new Set<Listener>()
  return {
    get: () => value,
    set: (v) => {
      value = v
      for (const l of ls) l()
    },
    sub: (l) => {
      ls.add(l)
      return () => ls.delete(l)
    }
  }
}

const limitsStore = createStore<Record<string, LimitState>>({})
/** Diálogo de mover: espacio y cuenta sugerida. */
const moveStore = createStore<{ wsId: string; preselect?: string } | null>(null)

const useLimits = (): Record<string, LimitState> => useSyncExternalStore(limitsStore.sub, limitsStore.get)
const useMove = (): { wsId: string; preselect?: string } | null => useSyncExternalStore(moveStore.sub, moveStore.get)

export function openMoveDialog(wsId: string, preselect?: string): void {
  moveStore.set({ wsId, preselect })
}

// ---------- Utilidades ----------

/** «2:30pm» → «14:30». */
function labelTo24h(label: string): string | undefined {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])/i.exec(label)
  if (!m) return undefined
  let h = Number(m[1]) % 12
  if (m[3].toLowerCase() === 'p') h += 12
  return `${String(h).padStart(2, '0')}:${m[2] ?? '00'}`
}

function resetText(l: LimitState): string | undefined {
  if (l.resetsAt) {
    const d = new Date(l.resetsAt)
    const hm = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })
    const sameDay = new Date().toDateString() === d.toDateString()
    return sameDay ? `a las ${hm}` : `el ${d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric' })} a las ${hm}`
  }
  const hm = l.resetsLabel ? labelTo24h(l.resetsLabel) : undefined
  return hm ? `a las ${hm}` : undefined
}

interface Candidate {
  acc: Account
  used5h: number
  limited: boolean
}

/** Otras cuentas con sesión iniciada, de menor a mayor uso en las últimas 5 h (las que están al límite, al final). */
function candidates(ui: UiCtx, exceptId: string | undefined, limits: Record<string, LimitState>): Candidate[] {
  const now = Date.now()
  const limitedAcc = new Set(
    Object.values(limits)
      .filter((l) => !l.resetsAt || l.resetsAt > now)
      .map((l) => l.accountId)
  )
  return ui.accounts
    .filter((a) => a.id !== exceptId && ui.statuses[a.id]?.loggedIn)
    .map((acc) => ({ acc, used5h: ui.usage[acc.id] ? totalTok(ui.usage[acc.id].last5h) : 0, limited: limitedAcc.has(acc.id) }))
    .sort((x, y) => Number(x.limited) - Number(y.limited) || x.used5h - y.used5h)
}

const candLabel = (c: Candidate): string => `${c.acc.label} · ${fmtTok(c.used5h)} en 5 h${c.limited ? ' · también al límite' : ''}`

// ---------- Banner del panel ----------

function Banner({ paneId }: { paneId: string }): React.JSX.Element | null {
  const ui = useUi()
  const limits = useLimits()
  const l = limits[paneId]
  const ws = ui.workspaces.find((w) => w.id === paneId)
  const [, force] = useState(0)
  // Un solo temporizador hasta la hora de renovación (no es polling): ahí el aviso se va solo.
  useEffect(() => {
    if (!l?.resetsAt) return
    const ms = l.resetsAt - Date.now()
    if (ms <= 0 || ms > 2 ** 31 - 1) return
    const t = setTimeout(() => force((n) => n + 1), ms + 1000)
    return () => clearTimeout(t)
  }, [l?.resetsAt])
  const cands = useMemo(() => candidates(ui, ws?.accountId, limits), [ui, ws?.accountId, limits])
  const [choice, setChoice] = useState('')
  const selected = cands.find((c) => c.acc.id === choice) ?? cands[0]

  if (!l || !ws || ws.accountId !== l.accountId) return null
  if (l.resetsAt && l.resetsAt <= Date.now()) return null
  const acc = ui.accounts.find((a) => a.id === l.accountId)
  const when = resetText(l)
  const dismiss = (): void => void ui.invoke('feat:rotation:dismiss', paneId)

  return (
    <div className="f-rotation-banner" role="status">
      <HourglassMedium size={16} weight="fill" className="f-rotation-icon" aria-hidden="true" />
      <p className="f-rotation-text">
        La cuenta <strong>{acc?.label ?? '?'}</strong> llegó al límite
        {when && (
          <>
            {' '}
            · se renueva {when}
          </>
        )}
      </p>
      <span className="f-rotation-actions">
        {cands.length > 0 ? (
          <>
            <label className="sr-only" htmlFor={`f-rot-sel-${paneId}`}>
              Cuenta para seguir
            </label>
            <select id={`f-rot-sel-${paneId}`} className="f-rotation-select" value={selected?.acc.id ?? ''} onChange={(e) => setChoice(e.target.value)}>
              {cands.map((c) => (
                <option key={c.acc.id} value={c.acc.id}>
                  {candLabel(c)}
                </option>
              ))}
            </select>
            <button type="button" className="btn sm primary" onClick={() => selected && openMoveDialog(paneId, selected.acc.id)}>
              <ArrowsLeftRight size={14} aria-hidden="true" />
              Seguir en {selected?.acc.label}
            </button>
          </>
        ) : (
          <span className="hint">No hay otra cuenta con sesión iniciada.</span>
        )}
        <button type="button" className="btn sm ghost" onClick={dismiss}>
          Descartar
        </button>
      </span>
    </div>
  )
}

// ---------- Botón del header ----------

function HeaderButton({ paneId }: { paneId: string }): React.JSX.Element | null {
  const ui = useUi()
  if (isLoginPane(paneId) || !ui.workspaces.some((w) => w.id === paneId)) return null
  if (ui.accounts.length < 2) return null
  return (
    <button type="button" className="icon-btn" onClick={() => openMoveDialog(paneId)} aria-label="Mover a otra cuenta" title="Mover a otra cuenta">
      <ArrowsLeftRight size={15} aria-hidden="true" />
    </button>
  )
}

// ---------- Diálogo de mover (Global) ----------

function MoveDialog({ wsId, preselect }: { wsId: string; preselect?: string }): React.JSX.Element | null {
  const ui = useUi()
  const limits = useLimits()
  const ws = ui.workspaces.find((w) => w.id === wsId)
  const cands = useMemo(() => candidates(ui, ws?.accountId, limits), [ui, ws?.accountId, limits])
  const [choice, setChoice] = useState<string>(preselect ?? '')
  const [peek, setPeek] = useState<{ sessionId?: string; autoStartClaude: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const firstRef = useRef<HTMLInputElement | null>(null)
  const close = (): void => moveStore.set(null)

  useEffect(() => {
    void ui
      .invoke<{ sessionId?: string; autoStartClaude: boolean }>('feat:rotation:peek', wsId)
      .then(setPeek)
      .catch((e) => setErr(cleanError(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId])
  useEffect(() => {
    if (!choice && cands[0]) setChoice(cands[0].acc.id)
  }, [choice, cands])
  useEffect(() => firstRef.current?.focus(), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  if (!ws) return null
  const from = ui.accounts.find((a) => a.id === ws.accountId)
  const target = cands.find((c) => c.acc.id === choice)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!target) return
    setBusy(true)
    setErr(null)
    try {
      const r = await ui.invoke<{ sessionId?: string; manualCommand?: string }>('feat:rotation:move', { wsId, toAccountId: target.acc.id })
      await ui.reload()
      if (r.manualCommand) setDone(r.manualCommand)
      else close()
    } catch (e2) {
      setErr(cleanError(e2))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <form
        className="modal f-rotation-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="f-rot-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
      >
        <header className="modal-head">
          <ArrowsLeftRight size={18} aria-hidden="true" className="f-rotation-head-icon" />
          <h2 id="f-rot-title">Mover «{ws.name}» a otra cuenta</h2>
          <button type="button" className="icon-btn" onClick={close} aria-label="Cerrar">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        {done ? (
          <>
            <p className="f-rotation-p">
              Listo: el espacio ya usa la otra cuenta. Como no arranca Claude solo, para retomar la conversación corré en su terminal:
            </p>
            <code className="mono f-rotation-cmd">{done}</code>
            <footer className="modal-actions">
              <button type="button" className="btn primary" onClick={close}>
                Entendido
              </button>
            </footer>
          </>
        ) : (
          <>
            <p className="f-rotation-p">
              Ahora usa <strong>{from?.label ?? 'una cuenta borrada'}</strong>. Elegí con qué cuenta seguir:
            </p>
            {cands.length === 0 ? (
              <p className="hint">No hay otra cuenta con sesión iniciada. Iniciá sesión en otra cuenta desde la barra lateral.</p>
            ) : (
              <fieldset className="f-rotation-list">
                <legend className="sr-only">Cuenta destino</legend>
                {cands.map((c, i) => (
                  <label key={c.acc.id} className={`f-rotation-opt ${choice === c.acc.id ? 'on' : ''}`}>
                    <input
                      ref={i === 0 ? firstRef : undefined}
                      type="radio"
                      name="f-rot-acc"
                      value={c.acc.id}
                      checked={choice === c.acc.id}
                      onChange={() => setChoice(c.acc.id)}
                    />
                    <span className="grow-min">
                      <span className="f-rotation-opt-title">{c.acc.label}</span>
                      <span className="f-rotation-opt-sub">{ui.statuses[c.acc.id]?.email ?? 'Sesión iniciada'}</span>
                    </span>
                    <span className="f-rotation-opt-use" title="Tokens usados en las últimas 5 h">
                      {fmtTok(c.used5h)} <small>5 h</small>
                    </span>
                    {c.limited && (
                      <span className="tag f-rotation-tag">
                        <HourglassMedium size={11} aria-hidden="true" /> Al límite
                      </span>
                    )}
                  </label>
                ))}
              </fieldset>
            )}
            {target && (
              <p className="f-rotation-confirm" role="note">
                {peek?.sessionId ? (
                  <>
                    Se cierra la terminal y Claude retoma la conversación en <strong>{target.acc.label}</strong>.
                  </>
                ) : (
                  <>
                    Este espacio no tiene conversación guardada: se cambia a <strong>{target.acc.label}</strong> y se reinicia la terminal.
                  </>
                )}
              </p>
            )}
            {err && (
              <p className="form-error" role="alert">
                {err}
              </p>
            )}
            <footer className="modal-actions">
              <button type="button" className="btn ghost" onClick={close}>
                Cancelar
              </button>
              <button className="btn primary" type="submit" disabled={busy || !target || !peek}>
                <ArrowsLeftRight size={14} aria-hidden="true" />
                {busy ? 'Moviendo…' : `Mover a ${target?.acc.label ?? '…'}`}
              </button>
            </footer>
          </>
        )}
      </form>
    </div>
  )
}

function Global(): React.JSX.Element | null {
  const ui = useUi()
  const move = useMove()
  useEffect(() => {
    let alive = true
    void ui
      .invoke<LimitState[]>('feat:rotation:list')
      .then((list) => {
        if (!alive || !Array.isArray(list)) return
        limitsStore.set(Object.fromEntries(list.map((l) => [l.wsId, l])))
      })
      .catch(() => undefined)
    const offL = ui.on('feat:rotation:limit', (l: LimitState) => limitsStore.set({ ...limitsStore.get(), [l.wsId]: l }))
    const offC = ui.on('feat:rotation:clear', (wsId: string) => {
      const next = { ...limitsStore.get() }
      delete next[wsId]
      limitsStore.set(next)
    })
    return () => {
      alive = false
      offL()
      offC()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return move ? <MoveDialog key={move.wsId} wsId={move.wsId} preselect={move.preselect} /> : null
}

const ui: FeatureUi = {
  name: 'rotation',
  PaneBanner: Banner,
  PaneHeader: HeaderButton,
  Global,
  commands(ctx) {
    const ws = ctx.focused ? ctx.workspaces.find((w) => w.id === ctx.focused) : undefined
    if (!ws || ctx.accounts.length < 2) return []
    return [
      {
        id: 'rotation:move-focused',
        title: 'Mover espacio enfocado a otra cuenta',
        subtitle: ws.name,
        group: 'Cuentas',
        keywords: 'rotar cuenta limite cambiar mover resume',
        run: () => openMoveDialog(ws.id)
      }
    ]
  }
}

export default ui
