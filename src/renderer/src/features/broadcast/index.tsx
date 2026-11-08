import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { isLoginPane } from '../../../../shared/types'
import { useUi, type FeatureUi, type UiCtx } from '../host'
import { resolveAccountColor } from '../settings/store'
import { shortPath } from '../../format'
import { CloseIcon, BroadcastIcon, DoneIcon, WaitingIcon, PermissionIcon, IdleIcon, WorkingIcon } from '../../icons/SlothIcons'
import { cancelQueued, releaseQueued, startBatch, useBatches, type Batch } from './store'
import { canReceive, isReady, SPACE_CHIP, SPACE_LABEL, spaceStatus, type SpaceStatus } from './state'
import './broadcast.css'

// Estado abierto/cerrado compartido entre el comando de la paleta, el atajo y el modal.
let isOpen = false
const subs = new Set<() => void>()
const setOpen = (v: boolean): void => {
  if (isOpen === v) return
  isOpen = v
  subs.forEach((f) => f())
}
const useOpen = (): boolean =>
  useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => isOpen
  )

const CONFIRM_OVER = 3
/** Lo mismo que el diseño: se corta en 2000 caracteres. */
const MAX_TEXT = 2000
const CHIPS = ['Corré los tests y avisame', 'Hacé commit de lo que tengas', 'Resumime en qué estás', 'Actualizá desde staging']
const VARS = ['{espacio}', '{rama}']
const SPACE_ICON = { perm: PermissionIcon, working: WorkingIcon, waiting: WaitingIcon, done: DoneIcon, idle: IdleIcon, closed: IdleIcon }

/** Lo que devuelve main para «Últimos envíos». */
interface SentEntry {
  id: string
  time: number
  text: string
  ids: string[]
  names: string[]
}

export interface Target {
  id: string
  name: string
  /** Carpeta del espacio (corta) y rama, para la línea de cada destino y para {rama}. */
  path: string
  branch?: string
  accountId: string
  accIndex: number
  status: SpaceStatus
  ticket?: string
  hidden: boolean
}

/** Espacios con terminal: los abiertos en paneles y los ocultos que siguen vivos. */
function targetsOf(ctx: UiCtx): Target[] {
  const accIdx = new Map(ctx.accounts.map((a, i) => [a.id, i]))
  const open = new Set(ctx.openPanes.filter((p) => !isLoginPane(p)))
  const out: Target[] = []
  for (const ws of ctx.workspaces) {
    const ag = ctx.agents[ws.id]
    const isOpenPane = open.has(ws.id)
    const aliveHidden = !isOpenPane && ag && ag.state !== 'exited'
    if (!isOpenPane && !aliveHidden) continue
    out.push({
      id: ws.id,
      name: ws.name,
      path: shortPath(ws.cwd || ws.repoPath),
      branch: ws.branch,
      accountId: ws.accountId,
      accIndex: accIdx.get(ws.accountId) ?? 0,
      status: spaceStatus(ws.id, ctx.agents, ctx.permissions),
      ticket: ws.ticket,
      hidden: !isOpenPane
    })
  }
  // Primero los abiertos, en el orden de los paneles.
  const order = ctx.openPanes
  return out.sort((a, b) => (a.hidden === b.hidden ? order.indexOf(a.id) - order.indexOf(b.id) : a.hidden ? 1 : -1))
}

/** {espacio} y {rama} se resuelven por destino. Sin rama (carpeta suelta) queda «sin rama». */
function resolveVars(text: string, t: Pick<Target, 'name' | 'branch'>): string {
  return text.split('{espacio}').join(t.name).split('{rama}').join(t.branch || 'sin rama')
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

/** Avión de papel (el set de íconos de Sloth no tiene uno). */
function PaperPlane({ size }: { size: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
      <path d="M4 12.5l16-7.5-5.5 15-2.8-6-7.7-1.5z" />
    </svg>
  )
}

function BroadcastDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const ctx = useUi()
  const batches = useBatches()
  const targets = useMemo(() => targetsOf(ctx), [ctx.workspaces, ctx.openPanes, ctx.agents, ctx.accounts, ctx.permissions]) // eslint-disable-line react-hooks/exhaustive-deps
  const receivable = targets.filter((t) => canReceive(t.status))
  const [sel, setSel] = useState<Set<string>>(() => new Set(receivable.filter((t) => !t.hidden).map((t) => t.id)))
  const [text, setText] = useState('')
  const [interrupt, setInterrupt] = useState(false)
  const [tried, setTried] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [preview, setPreview] = useState(false)
  const [note, setNote] = useState('')
  const [batchId, setBatchId] = useState<string | null>(null)
  const [hist, setHist] = useState<SentEntry[]>([])
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    void ctx.invoke<SentEntry[]>('feat:broadcast:list').then((l) => setHist(Array.isArray(l) ? l : []), () => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => setConfirming(false), [sel, text])

  const batch: Batch | undefined = batchId ? batches.find((b) => b.id === batchId) : undefined
  const chosen = receivable.filter((t) => sel.has(t.id))
  const nWorking = chosen.filter((t) => t.status === 'working').length
  const trimmed = text.trim()
  const destErr = tried && chosen.length === 0
  const msgErr = tried && !trimmed

  const toggle = (id: string): void => {
    setNote('')
    setSel((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }
  const pick = (ids: string[]): void => {
    setNote('')
    setSel(new Set(ids))
  }

  const insertAt = (piece: string): void => {
    const el = taRef.current
    const a = el ? el.selectionStart : text.length
    const b = el ? el.selectionEnd : a
    setText(text.slice(0, a) + piece + text.slice(b))
    setNote('')
    setTimeout(() => {
      el?.focus()
      el?.setSelectionRange(a + piece.length, a + piece.length)
    }, 0)
  }

  const send = (): void => {
    setTried(true)
    if (!chosen.length || !trimmed) {
      if (!trimmed) taRef.current?.focus()
      return
    }
    if (chosen.length > CONFIRM_OVER && !confirming) {
      setConfirming(true)
      return
    }
    const id = `b${Date.now().toString(36)}`
    startBatch(
      id,
      trimmed,
      chosen.map((t) => ({
        wsId: t.id,
        name: t.name,
        message: resolveVars(trimmed, t),
        now: interrupt || isReady(t.status)
      }))
    )
    setBatchId(id)
    setTried(false)
    setConfirming(false)
    setPreview(false)
    void ctx
      .invoke<SentEntry[]>('feat:broadcast:add', {
        id,
        time: Date.now(),
        text: trimmed,
        ids: chosen.map((t) => t.id),
        names: chosen.map((t) => t.name)
      })
      .then((l) => setHist(Array.isArray(l) ? l : []), () => {})
  }

  const repeat = (h: SentEntry): void => {
    const okIds = h.ids.filter((id) => receivable.some((t) => t.id === id))
    const skipped = h.ids.filter((id) => !okIds.includes(id)).map((id) => h.names[h.ids.indexOf(id)] ?? 'un espacio')
    setSel(new Set(okIds))
    setText(h.text)
    setBatchId(null)
    setTried(false)
    setInterrupt(false)
    setNote(
      skipped.length
        ? `Cargamos el mensaje y ${okIds.length} ${plural(okIds.length, 'destino', 'destinos')}. No se eligió «${skipped.join('», «')}»: ahora pide permiso o no tiene la terminal abierta.`
        : `Cargamos el mensaje y los ${okIds.length} ${plural(okIds.length, 'destino', 'destinos')} de ese envío.`
    )
    setTimeout(() => taRef.current?.focus(), 0)
  }

  const newSend = (): void => {
    setBatchId(null)
    setText('')
    setTried(false)
    setTimeout(() => taRef.current?.focus(), 0)
  }

  // Agrupado por cuenta, en el orden de Configuración. Las terminales sin cuenta van aparte.
  const groups = [
    ...ctx.accounts.map((a, i) => ({ id: a.id, name: a.label, accIndex: i, rows: targets.filter((t) => t.accountId === a.id) })),
    { id: '', name: 'Cuenta borrada', accIndex: ctx.accounts.length, rows: targets.filter((t) => !ctx.accounts.some((a) => a.id === t.accountId)) }
  ].filter((g) => g.rows.length)

  const shorts = [
    { label: 'Todos', ids: receivable.map((t) => t.id) },
    { label: 'Ninguno', ids: [] as string[] },
    { label: 'Solo los que te esperan', ids: receivable.filter((t) => t.status === 'waiting').map((t) => t.id) },
    ...groups
      .filter((g) => g.id)
      .map((g) => ({ label: `Solo de ${g.name}`, ids: receivable.filter((t) => t.accountId === g.id).map((t) => t.id) }))
  ]

  const warn =
    nWorking === 0
      ? ''
      : interrupt
        ? `${nWorking} ${plural(nWorking, 'está trabajando', 'están trabajando')}: le mandás el mensaje ahora.`
        : `${nWorking} ${plural(nWorking, 'está trabajando', 'están trabajando')}: el mensaje le llega cuando termine lo que hace.`

  const sendLabel = chosen.length
    ? confirming
      ? `Confirmar envío a ${chosen.length}`
      : `Enviar a ${chosen.length} ${plural(chosen.length, 'espacio', 'espacios')}`
    : 'Enviar'

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal f-broadcast-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="f-broadcast-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (batch) return
          send()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !batch) {
            e.preventDefault()
            send()
          }
        }}
      >
        <header className="f-broadcast-head">
          <span className="f-broadcast-badge" aria-hidden="true">
            <BroadcastIcon size={18} />
          </span>
          <div className="f-broadcast-titles">
            <h2 id="f-broadcast-title">Enviar a varios espacios</h2>
            <p>
              {batch
                ? 'Sloth lo manda espacio por espacio.'
                : 'El mismo mensaje llega a cada Claude que elijas, cada uno en su propia terminal.'}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <CloseIcon size={16} />
          </button>
        </header>

        {batch ? (
          <Progress batch={batch} onAgain={newSend} onClose={onClose} />
        ) : (
          <>
            {note && (
              <p className="f-broadcast-note" role="status">
                {note}
              </p>
            )}

            <section className="f-broadcast-dest" aria-labelledby="f-broadcast-dest-t">
              <div className="f-broadcast-dest-head">
                <h3 id="f-broadcast-dest-t">Destinos</h3>
                <span aria-live="polite" className="f-broadcast-count">
                  {chosen.length} de {targets.length} elegidos
                </span>
              </div>
              <div role="group" aria-label="Atajos de selección" className="f-broadcast-shorts">
                {shorts.map((s) => (
                  <button key={s.label} type="button" className="btn sm" onClick={() => pick(s.ids)} disabled={!s.ids.length && s.label !== 'Ninguno'}>
                    {s.label}
                  </button>
                ))}
              </div>

              {targets.length === 0 && (
                <p className="hint">No hay espacios con la terminal abierta. Abrí alguno desde el sidebar.</p>
              )}

              {groups.map((g) => (
                <div key={g.id || 'x'} role="group" aria-label={g.name} className="f-broadcast-group">
                  <div className="f-broadcast-group-head">
                    <span className="f-broadcast-dot" style={{ background: resolveAccountColor(g.id, g.accIndex) }} aria-hidden="true" />
                    {g.name}
                    <span className="f-broadcast-group-count">
                      {g.rows.length} {plural(g.rows.length, 'espacio', 'espacios')}
                    </span>
                  </div>
                  <ul className="f-broadcast-list">
                    {g.rows.map((t) => {
                      const ok = canReceive(t.status)
                      const Icon = SPACE_ICON[t.status]
                      const hint =
                        t.status === 'perm'
                          ? 'Primero respondé el permiso'
                          : t.status === 'closed'
                            ? 'Abrí el espacio para mandarle'
                            : ''
                      const hintId = `f-broadcast-h-${t.id}`
                      return (
                        <li key={t.id}>
                          <label className={`f-broadcast-row ${ok ? '' : 'dead'}`}>
                            <input
                              type="checkbox"
                              checked={ok && sel.has(t.id)}
                              disabled={!ok}
                              onChange={() => toggle(t.id)}
                              aria-describedby={hint ? hintId : undefined}
                            />
                            <span className="f-broadcast-main">
                              <span className="f-broadcast-name">
                                {t.name}
                                {t.ticket && <span className="tag">{t.ticket}</span>}
                                {t.hidden && <span className="f-broadcast-hidden">oculto</span>}
                              </span>
                              <span className="f-broadcast-path mono">
                                {t.path}
                                {t.branch ? ` · ${t.branch}` : ''}
                              </span>
                              {hint && (
                                <span id={hintId} className="f-broadcast-hint">
                                  {hint}
                                </span>
                              )}
                            </span>
                            <span className={`chip ${SPACE_CHIP[t.status]}`}>
                              <Icon size={12} />
                              {SPACE_LABEL[t.status]}
                            </span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}

              {destErr && (
                <p className="form-error" role="alert">
                  Elegí al menos un espacio para mandarle el mensaje.
                </p>
              )}
              {warn && (
                <div className="f-broadcast-warn" role="status">
                  <span className="f-broadcast-warn-text">{warn}</span>
                  <label className="f-broadcast-warn-check">
                    <input type="checkbox" checked={interrupt} onChange={(e) => setInterrupt(e.target.checked)} />
                    Mandar igual ahora (interrumpe)
                  </label>
                </div>
              )}
              {confirming && (
                <p className="f-broadcast-confirm" role="alert">
                  Vas a mandar este mensaje a {chosen.length} espacios: {chosen.map((t) => t.name).join(', ')}. Tocá «Confirmar envío» para enviarlo.
                </p>
              )}
            </section>

            <section className="f-broadcast-msg" aria-labelledby="f-broadcast-msg-t">
              <label id="f-broadcast-msg-t" htmlFor="f-broadcast-text">
                Mensaje
              </label>
              <textarea
                id="f-broadcast-text"
                ref={taRef}
                className="f-broadcast-text"
                rows={6}
                maxLength={MAX_TEXT}
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  setNote('')
                }}
                placeholder="Ej.: corré los tests y contame si algo falla en {espacio}"
                aria-invalid={msgErr}
                aria-describedby="f-broadcast-help"
                aria-errormessage={msgErr ? 'f-broadcast-msg-err' : undefined}
              />
              {msgErr && (
                <p id="f-broadcast-msg-err" className="form-error" role="alert">
                  Escribí el mensaje antes de enviarlo.
                </p>
              )}
              <div className="f-broadcast-tools">
                <span className="f-broadcast-tools-label">Rápidos</span>
                {CHIPS.map((c) => (
                  <button key={c} type="button" className="chip-btn" onClick={() => insertAt(c)}>
                    {c}
                  </button>
                ))}
                <span id="f-broadcast-help" className="f-broadcast-counter">
                  {text.length} / {MAX_TEXT} · Ctrl+Enter envía
                </span>
              </div>
              <div className="f-broadcast-tools">
                <span className="f-broadcast-tools-label">Variables</span>
                {VARS.map((v) => (
                  <button key={v} type="button" className="chip-btn var" onClick={() => insertAt(v)}>
                    {v}
                  </button>
                ))}
                <span className="f-broadcast-tools-label">Se reemplaza por el espacio o la rama de cada destino.</span>
              </div>
              <div>
                <button type="button" className="btn sm ghost" aria-expanded={preview} onClick={() => setPreview((p) => !p)}>
                  {preview ? 'Ocultar vista previa' : 'Ver cómo llega a cada espacio'}
                </button>
                {preview && (
                  <div className="f-broadcast-preview">
                    {chosen.length === 0 && <p className="hint">Elegí al menos un espacio para ver la vista previa.</p>}
                    {chosen.map((t) => (
                      <div key={t.id} className="f-broadcast-preview-row">
                        <span className="f-broadcast-tools-label">{t.name}</span>
                        <span className="mono f-broadcast-preview-body">
                          {trimmed ? resolveVars(trimmed, t) : 'Escribí el mensaje para ver cómo llega.'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <footer className="f-broadcast-foot">
              <button type="button" className="btn ghost" onClick={onClose}>
                Cancelar
              </button>
              <span className="f-broadcast-grow" />
              <button type="submit" className="btn primary">
                <PaperPlane size={14} />
                {sendLabel}
              </button>
            </footer>

            {hist.length > 0 && (
              <section className="f-broadcast-hist" aria-labelledby="f-broadcast-hist-t">
                <h3 id="f-broadcast-hist-t">Últimos envíos</h3>
                <ul>
                  {hist.slice(0, 3).map((h) => (
                    <li key={h.id}>
                      <span className="mono f-broadcast-time">{new Date(h.time).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</span>
                      <span className="f-broadcast-hist-main">
                        <span className="f-broadcast-hist-text">{h.text.length > 70 ? `${h.text.slice(0, 69).trimEnd()}…` : h.text}</span>
                        <span className="f-broadcast-hist-meta">
                          a {h.ids.length} {plural(h.ids.length, 'espacio', 'espacios')} · {h.names.join(', ')}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="btn sm"
                        aria-label={`Repetir el envío de las ${new Date(h.time).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`}
                        onClick={() => repeat(h)}
                      >
                        Repetir
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </form>
    </div>
  )
}

/** Progreso por destino: Enviado / En cola (se actualiza solo cuando el espacio queda libre). */
function Progress({ batch, onAgain, onClose }: { batch: Batch; onAgain: () => void; onClose: () => void }): React.JSX.Element {
  const sent = batch.targets.filter((t) => t.status === 'sent').length
  const queued = batch.targets.filter((t) => t.status === 'queued').length
  const failed = batch.targets.filter((t) => t.status === 'failed').length
  const title = sent
    ? `Enviado a ${sent} ${plural(sent, 'espacio', 'espacios')}${queued ? ` · ${queued} en cola` : ''}${failed ? ` · ${failed} sin enviar` : ''}`
    : queued
      ? `En cola en ${queued} ${plural(queued, 'espacio', 'espacios')}`
      : 'No se pudo enviar a ningún espacio'
  return (
    <div className="f-broadcast-progress">
      <div className="f-broadcast-result" role="status" aria-live="polite">
        <span className="f-broadcast-result-ic" aria-hidden="true">
          <DoneIcon size={15} />
        </span>
        <span className="f-broadcast-result-title">{title}</span>
      </div>
      {queued > 0 && (
        <p className="f-broadcast-note">Los que están trabajando reciben el mensaje cuando terminen lo que hacen. Podés cerrar esta ventana: Sloth lo manda solo.</p>
      )}
      <ul className="f-broadcast-list f-broadcast-progress-list">
        {batch.targets.map((t) => {
          const cls = t.status === 'sent' ? 'chip-done' : t.status === 'queued' ? 'chip-waiting' : 'chip-error'
          const label = t.status === 'sent' ? 'Enviado' : t.status === 'queued' ? 'En cola hasta que termine' : 'No se envió'
          return (
            <li key={t.wsId} className="f-broadcast-progress-row">
              <span className="f-broadcast-main">
                <span className="f-broadcast-name">{t.name}</span>
                {t.error && <span className="f-broadcast-hint">{t.error}</span>}
              </span>
              <span className={`chip ${cls}`}>
                {t.status === 'queued' ? <WaitingIcon size={12} /> : t.status === 'sent' ? <DoneIcon size={12} /> : <PermissionIcon size={12} />}
                {label}
              </span>
              {t.status === 'queued' && (
                <button type="button" className="btn sm ghost" onClick={() => cancelQueued(batch.id, t.wsId)} aria-label={`Quitar a ${t.name} de la cola`}>
                  Quitar
                </button>
              )}
            </li>
          )
        })}
      </ul>
      <footer className="f-broadcast-foot">
        <button type="button" className="btn" onClick={onAgain}>
          Enviar otro
        </button>
        <span className="f-broadcast-grow" />
        <button type="button" className="btn primary" onClick={onClose}>
          Cerrar
        </button>
      </footer>
    </div>
  )
}

function Global(): React.JSX.Element | null {
  const ctx = useUi()
  const open = useOpen()
  const [toast, setToast] = useState<string | null>(null)
  const prevFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyB') {
        e.preventDefault()
        e.stopPropagation()
        setOpen(!isOpen)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useLayoutEffect(() => {
    if (open) {
      const a = document.activeElement
      prevFocus.current = a instanceof HTMLElement && a !== document.body ? a : null
    } else {
      const el = prevFocus.current
      prevFocus.current = null
      if (el?.isConnected) el.focus()
    }
  }, [open])

  // Cola: cada vez que cambia el estado real de las terminales se mandan los mensajes que estaban esperando.
  useEffect(() => {
    const released = releaseQueued((wsId) => {
      if (!ctx.workspaces.some((w) => w.id === wsId)) return 'gone'
      return spaceStatus(wsId, ctx.agents, ctx.permissions)
    })
    if (released.length) setToast(`Se envió el mensaje a ${released.join(', ')} (estaba en cola)`)
  }, [ctx.agents, ctx.permissions, ctx.workspaces])

  // El aviso se va solo (un único timer, solo mientras se muestra).
  useEffect(() => {
    if (toast === null) return
    const t = setTimeout(() => setToast(null), 3200)
    return () => clearTimeout(t)
  }, [toast])

  return (
    <>
      {open && <BroadcastDialog onClose={() => setOpen(false)} />}
      <div className="f-broadcast-live" role="status" aria-live="polite">
        {toast !== null && <span className="f-broadcast-toast">{toast}</span>}
      </div>
    </>
  )
}

const ui: FeatureUi = {
  name: 'broadcast',
  Global,
  commands: (ctx) =>
    ctx.workspaces.length
      ? [
          {
            id: 'broadcast:open',
            title: 'Enviar a varios espacios',
            subtitle: 'El mismo mensaje en varias terminales a la vez',
            group: 'Espacios',
            keywords: 'broadcast difundir prompt todos multiple',
            shortcut: 'Ctrl+Shift+B',
            run: () => setOpen(true)
          }
        ]
      : []
}

export default ui
