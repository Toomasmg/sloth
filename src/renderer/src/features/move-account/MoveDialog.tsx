import { useEffect, useMemo, useRef, useState } from 'react'
import { loginPaneId, type Account } from '../../../../shared/types'
import { useUi } from '../host'
import { cleanError } from '../../format'
import { CheckIcon, PermissionIcon, TerminalIcon } from '../../icons/SlothIcons'
import { closeMove, spacesTxt, type Phase, type MoveRes } from './state'

export function MoveDialog({ wsId }: { wsId: string }): React.JSX.Element {
  const ui = useUi()
  const ws = ui.workspaces.find((w) => w.id === wsId)
  const from = ws ? ui.accounts.find((a) => a.id === ws.accountId) : undefined
  const accounts = useMemo(() => [...ui.accounts].sort((x, y) => x.label.localeCompare(y.label, 'es')), [ui.accounts])
  const agent = ui.agents[wsId]?.state
  /** Estado real: Claude sigue trabajando (o pidiendo algo). */
  const working = agent === 'working' || agent === 'waiting'

  const [choice, setChoice] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('form')
  const [err, setErr] = useState<string | null>(null)
  /** Desmarcado por defecto: el resumen es opcional. */
  const [keep, setKeep] = useState(false)
  /** Tras un fallo al copiar la conversación: se ofrece seguir sin ella. */
  const [copyFailed, setCopyFailed] = useState(false)
  const [resumed, setResumed] = useState(false)
  /** null mientras se arma el resumen inicial desde el estado real del espacio. */
  const [summary, setSummary] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [freed, setFreed] = useState(false)
  const busyRef = useRef(false)
  const firstRef = useRef<HTMLInputElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const waitRef = useRef<HTMLButtonElement | null>(null)
  const uiRef = useRef(ui)
  uiRef.current = ui

  // Resumen inicial (con carpeta, rama y cambios reales).
  useEffect(() => {
    let alive = true
    uiRef.current
      .invoke<{ text: string }>('feat:move-account:summary', wsId)
      .then((r) => alive && setSummary(r.text))
      .catch((e) => {
        if (!alive) return
        setSummary('')
        setErr(cleanError(e))
      })
    return () => {
      alive = false
    }
  }, [wsId])

  // «Esperar a que termine»: cuando Claude deja de trabajar, se avisa que ya se puede mover.
  useEffect(() => {
    if (waiting && !working) {
      setWaiting(false)
      setFreed(true)
    }
  }, [waiting, working])

  // Foco inicial: la primera opción, o «Cancelar» si no hay ninguna.
  useEffect(() => {
    ;(firstRef.current ?? cancelRef.current)?.focus()
  }, [])

  // Escape cierra (salvo mientras se mueve). Captura: la terminal no se entera.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      if (!busyRef.current) closeMove()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  if (!ws) return <></>

  const rows = accounts.map((a) => ({
    a,
    current: a.id === ws.accountId,
    logged: Boolean(ui.statuses[a.id]?.loggedIn),
    spaces: ui.workspaces.filter((w) => w.accountId === a.id).length
  }))
  const firstPick = rows.find((r) => !r.current && r.logged)?.a.id ?? null
  const destLabel = accounts.find((a) => a.id === choice)?.label ?? ''
  const blocked = !choice || working || phase !== 'form' || summary === null

  const login = (acc: Account): void => {
    // Mismo login que el resto de la app: abre la terminal de la cuenta.
    ui.openPane(loginPaneId(acc.id))
    closeMove()
  }

  const move = async (keepConv: boolean): Promise<void> => {
    if (busyRef.current || phase !== 'form') return
    if (!choice) {
      setErr('Elegí una cuenta destino para mover el espacio.')
      ;(firstRef.current ?? cancelRef.current)?.focus()
      return
    }
    if (working) {
      setErr('Claude está trabajando. Esperá a que termine o movelo cuando esté libre.')
      waitRef.current?.focus()
      return
    }
    busyRef.current = true
    setPhase('moving')
    setErr(null)
    setCopyFailed(false)
    try {
      const text = keep && summary ? summary.trim() : ''
      const r = await ui.invoke<MoveRes>('feat:move-account:move', wsId, choice, text ? text : null, keepConv)
      if (!r.ok) {
        setErr(r.message)
        setCopyFailed(true)
        setPhase('form')
        return
      }
      setResumed(r.resumed)
      setPhase('done')
    } catch (e2) {
      setErr(cleanError(e2))
      setPhase('form')
    } finally {
      busyRef.current = false
    }
  }

  const confirm = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    await move(true)
  }

  const wait = (): void => {
    if (waiting || !working) return
    setErr(null)
    setFreed(false)
    setWaiting(true)
  }

  return (
    <div className="modal-backdrop f-move-backdrop" onMouseDown={() => !busyRef.current && closeMove()}>
      <form
        className="modal f-move-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="f-move-title"
        aria-busy={phase === 'moving' || undefined}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => void confirm(e)}
      >
        <div className="f-move-head">
          <h2 id="f-move-title" className="f-move-title">
            Mover espacio a otra cuenta
          </h2>
          <p className="f-move-lead">Vos elegís la cuenta. Sloth no cambia de cuenta sola ni detecta límites.</p>
        </div>

        <div className="f-move-space">
          <span className="f-move-space-icon" aria-hidden="true">
            <TerminalIcon size={18} strokeWidth={1.8} />
          </span>
          <div className="f-move-space-text">
            <span className="f-move-space-name">{ws.name}</span>
            <span className="f-move-space-path">
              {ws.cwd}
              {ws.branch ? ` · ${ws.branch}` : ''}
            </span>
          </div>
          <div className="f-move-space-acc">
            <span className="f-move-muted">Cuenta actual</span>
            <strong>{from?.label ?? 'una cuenta borrada'}</strong>
          </div>
        </div>

        {phase === 'form' && (
          <>
            <section aria-labelledby="f-move-dest" className="f-move-section">
              <h3 id="f-move-dest" className="f-move-h3">
                Cuenta destino
              </h3>
              {accounts.length < 2 ? (
                <p className="f-move-hint">Necesitás al menos otra cuenta. Creala desde la barra lateral.</p>
              ) : (
                <div role="radiogroup" aria-labelledby="f-move-dest" className="f-move-list">
                  {rows.map((r, i) => {
                    const pickable = !r.current && r.logged
                    const picked = pickable && choice === r.a.id
                    return (
                      <div key={r.a.id} className={`f-move-row${i < rows.length - 1 ? ' sep' : ''}`}>
                        <label className={`f-move-opt${picked ? ' on' : ''}${pickable ? '' : ' off'}`}>
                          <input
                            ref={pickable && r.a.id === firstPick ? firstRef : undefined}
                            type="radio"
                            name="f-move-acc"
                            value={r.a.id}
                            checked={picked}
                            disabled={!pickable}
                            onChange={() => {
                              setChoice(r.a.id)
                              setErr(null)
                            }}
                          />
                          <span className="f-move-ini" aria-hidden="true">
                            {r.a.label.charAt(0).toUpperCase()}
                          </span>
                          <span className="f-move-opt-main">
                            <span className="f-move-opt-title">{r.a.label}</span>
                            <span className={`f-move-opt-sub${r.logged ? '' : ' warn'}`}>
                              {`${spacesTxt(r.spaces)} · ${r.logged ? (ui.statuses[r.a.id]?.email ?? 'Sesión iniciada') : 'Iniciá sesión primero'}`}
                            </span>
                          </span>
                          {r.current && <span className="f-move-badge">Cuenta actual</span>}
                          {pickable && (
                            <span className={`f-move-mark${picked ? ' on' : ''}`} aria-hidden="true">
                              <span className="f-move-dot" />
                            </span>
                          )}
                        </label>
                        {!r.current && !r.logged && (
                          <button type="button" className="f-move-login" onClick={() => login(r.a)}>
                            Iniciar sesión
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            <section aria-labelledby="f-move-que" className="f-move-section">
              <h3 id="f-move-que" className="f-move-h3">
                Qué pasa
              </h3>
              <p className="f-move-box f-move-body">
                La terminal se reinicia con la otra cuenta y Claude sigue la misma conversación. Tus archivos no cambian.
              </p>
            </section>

            <section aria-label="Resumen para Claude" className="f-move-section">
              <label className="f-move-box f-move-keep">
                <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
                <span className="f-move-keep-text">
                  <span className="f-move-keep-title">Dejarle a Claude un resumen de lo que estaba haciendo</span>
                  <span className="f-move-muted">Claude lo lee al arrancar en la cuenta nueva.</span>
                </span>
              </label>
              {keep && (
                <label className="f-move-field">
                  <span className="f-move-label">Vista previa del resumen (podés editarlo)</span>
                  <textarea
                    className="f-move-text"
                    rows={4}
                    value={summary ?? ''}
                    disabled={summary === null}
                    placeholder={summary === null ? 'Preparando el resumen…' : ''}
                    onChange={(e) => setSummary(e.target.value)}
                  />
                </label>
              )}
            </section>

            {working && !waiting && !freed && (
              <div role="status" className="f-move-banner warn">
                <span className="f-move-warn-ico" aria-hidden="true">
                  <PermissionIcon size={16} strokeWidth={1.8} />
                </span>
                <span className="f-move-banner-text">Claude está trabajando ahora: si lo movés se corta lo que está haciendo</span>
                <button type="button" id="mc-wait" ref={waitRef} className="f-move-btn" onClick={wait}>
                  Esperar a que termine
                </button>
              </div>
            )}
            {working && waiting && (
              <div role="status" className="f-move-banner warn">
                <svg className="f-move-spin" width={18} height={18} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                  <path d="M12 4a8 8 0 1 1-8 8" />
                </svg>
                <span className="f-move-banner-text">Esperando a que Claude termine…</span>
                <button type="button" id="mc-wait" ref={waitRef} className="f-move-btn" disabled aria-disabled="true">
                  Esperando…
                </button>
              </div>
            )}
            {!working && freed && (
              <div role="status" className="f-move-ok">
                <CheckIcon size={15} strokeWidth={2.2} className="f-move-ok-ico" />
                <span>Claude terminó lo que estaba haciendo. Ya podés moverlo.</span>
              </div>
            )}

            <div className="f-move-foot">
              {err && (
                <div role="alert" className="f-move-err">
                  {err}
                </div>
              )}
              {copyFailed && (
                <div role="alert" className="f-move-banner warn">
                  <span className="f-move-banner-text">Podés seguir sin la conversación: Claude arranca de cero en la cuenta nueva (con el resumen, si lo dejaste).</span>
                  <button type="button" className="f-move-btn" onClick={() => void move(false)}>
                    Seguir sin conversación
                  </button>
                </div>
              )}

              <div className="f-move-actions">
                <button type="button" className="f-move-cancel" onClick={closeMove} ref={cancelRef}>
                  Cancelar
                </button>
                <span className="f-move-grow" />
                <button
                  type="submit"
                  className={`f-move-go${blocked ? ' blocked' : ''}`}
                  aria-disabled={blocked || undefined}
                  disabled={accounts.length < 2}
                >
                  {choice ? `Mover a ${destLabel}` : 'Mover a…'}
                </button>
              </div>
            </div>
          </>
        )}

        {phase === 'moving' && (
          <div role="status" className="f-move-running">
            <span className="f-move-run-ico" aria-hidden="true">
              <svg className="f-move-spin" width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <path d="M12 4a8 8 0 1 1-8 8" />
              </svg>
            </span>
            <div className="f-move-run-text">
              <div className="f-move-run-title">Reiniciando la terminal…</div>
              <div className="f-move-muted">
                Se cierra la terminal de {ws.name} y se abre con {destLabel}.
              </div>
            </div>
          </div>
        )}

        {phase === 'done' && (
          <div className="f-move-done">
            <div role="status" className="f-move-donebox">
              <div className="f-move-done-head">
                <span className="f-move-check" aria-hidden="true">
                  <CheckIcon size={15} strokeWidth={2.2} />
                </span>
                <span className="f-move-done-title">«{ws.name}» ya está en {destLabel}</span>
              </div>
              <p className="f-move-done-p">
                {resumed
                  ? 'La terminal arrancó de nuevo con la otra cuenta y Claude sigue la misma conversación.'
                  : `La terminal arrancó de nuevo con la otra cuenta. Claude empieza de cero en ${ws.cwd}.`}
              </p>
              {keep && summary && <p className="f-move-muted f-move-done-p">Le dejamos el resumen para que lo lea al arrancar.</p>}
            </div>
            <div className="f-move-actions end">
              <button type="button" className="f-move-go" onClick={closeMove} autoFocus>
                Volver al espacio
              </button>
            </div>
          </div>
        )}
      </form>
    </div>
  )
}
