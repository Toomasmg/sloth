import { useEffect, useMemo, useRef, useState } from 'react'
import { loginPaneId, type Account } from '../../../../shared/types'
import { useUi } from '../host'
import { cleanError } from '../../format'
import { CloseIcon, DoneIcon, MoveAccountIcon, PermissionIcon } from '../../icons/SlothIcons'
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
    <div className="modal-backdrop" onMouseDown={() => !busyRef.current && closeMove()}>
      <form
        className="modal f-move-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="f-move-title"
        aria-busy={phase === 'moving' || undefined}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => void confirm(e)}
      >
        <header className="modal-head">
          <MoveAccountIcon size={18} className="f-move-head-icon" />
          <h2 id="f-move-title">Mover espacio a otra cuenta</h2>
          <button type="button" className="icon-btn" onClick={closeMove} disabled={phase === 'moving'} aria-label="Cerrar" title="Cerrar">
            <CloseIcon size={16} />
          </button>
        </header>
        <p className="f-move-lead">Vos elegís la cuenta. Sloth no cambia de cuenta sola ni detecta límites.</p>

        <div className="f-move-space">
          <span className="f-move-space-icon" aria-hidden="true">
            <MoveAccountIcon size={18} />
          </span>
          <div className="f-move-space-text">
            <span className="f-move-space-name">{ws.name}</span>
            <span className="f-move-space-path mono">
              {ws.cwd}
              {ws.branch ? ` · ${ws.branch}` : ''}
            </span>
          </div>
          <div className="f-move-space-acc">
            <span className="hint">Cuenta actual</span>
            <strong>{from?.label ?? 'una cuenta borrada'}</strong>
          </div>
        </div>

        {phase === 'form' && (
          <>
            <section aria-labelledby="f-move-dest" className="f-move-section">
              <h3 id="f-move-dest">Cuenta destino</h3>
              {accounts.length < 2 ? (
                <p className="hint">Necesitás al menos otra cuenta. Creala desde la barra lateral.</p>
              ) : (
                <div role="radiogroup" aria-labelledby="f-move-dest" className="f-move-list">
                  {rows.map((r, i) => {
                    const pickable = !r.current && r.logged
                    const picked = pickable && choice === r.a.id
                    return (
                      <div key={r.a.id} className={`f-move-row${i > 0 ? ' sep' : ''}`}>
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
                          <span className="f-move-opt-main">
                            <span className="f-move-opt-title">{r.a.label}</span>
                            <span className={`f-move-opt-sub${r.logged ? '' : ' warn'}`}>
                              {`${spacesTxt(r.spaces)} · ${r.logged ? (ui.statuses[r.a.id]?.email ?? 'Sesión iniciada') : 'Iniciá sesión primero'}`}
                            </span>
                          </span>
                          {r.current && <span className="f-move-badge">Cuenta actual</span>}
                        </label>
                        {!r.current && !r.logged && (
                          <button type="button" className="btn sm primary f-move-login" onClick={() => login(r.a)}>
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
              <h3 id="f-move-que">Qué pasa</h3>
              <p className="f-move-box">
                La terminal se reinicia con la otra cuenta y Claude sigue la misma conversación. Tus archivos no cambian.
              </p>
            </section>

            <section aria-label="Resumen para Claude" className="f-move-section">
              <label className="f-move-box f-move-keep">
                <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
                <span className="f-move-keep-text">
                  <span className="f-move-keep-title">Además, dejarle a Claude un resumen de lo que estaba haciendo</span>
                  <span className="hint">Claude lo lee al arrancar en la cuenta nueva.</span>
                </span>
              </label>
              {keep && (
                <label className="f-move-field">
                  <span className="hint">Vista previa del resumen (podés editarlo)</span>
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
                <PermissionIcon size={16} />
                <span className="f-move-banner-text">Claude está trabajando ahora: si lo movés se corta lo que está haciendo</span>
                <button type="button" ref={waitRef} className="btn sm" onClick={wait}>
                  Esperar a que termine
                </button>
              </div>
            )}
            {working && waiting && (
              <div role="status" className="f-move-banner warn">
                <span className="f-move-spin" aria-hidden="true" />
                <span className="f-move-banner-text">Esperando a que Claude termine…</span>
                <button type="button" ref={waitRef} className="btn sm" disabled>
                  Esperando…
                </button>
              </div>
            )}
            {!working && freed && (
              <div role="status" className="f-move-banner ok">
                <DoneIcon size={15} />
                <span>Claude terminó lo que estaba haciendo. Ya podés moverlo.</span>
              </div>
            )}

            {err && (
              <p className="form-error f-move-err" role="alert">
                {err}
              </p>
            )}
            {copyFailed && (
              <div role="alert" className="f-move-banner warn">
                <span className="f-move-banner-text">Podés seguir sin la conversación: Claude arranca de cero en la cuenta nueva (con el resumen, si lo dejaste).</span>
                <button type="button" className="btn sm" onClick={() => void move(false)}>
                  Seguir sin conversación
                </button>
              </div>
            )}

            <footer className="f-move-actions">
              <button type="button" className="btn ghost" onClick={closeMove} ref={cancelRef}>
                Cancelar
              </button>
              <span className="spacer" />
              <button type="submit" className={`btn ${blocked ? '' : 'primary'}`} aria-disabled={blocked || undefined} disabled={accounts.length < 2}>
                {choice ? `Mover a ${destLabel}` : 'Mover a…'}
              </button>
            </footer>
          </>
        )}

        {phase === 'moving' && (
          <div role="status" className="f-move-banner info f-move-big">
            <span className="f-move-spin" aria-hidden="true" />
            <div>
              <div className="f-move-banner-title">Reiniciando la terminal…</div>
              <div className="hint">
                Se cierra la terminal de {ws.name} y se abre con {destLabel}.
              </div>
            </div>
          </div>
        )}

        {phase === 'done' && (
          <div className="f-move-done">
            <div role="status" className="f-move-banner ok f-move-big">
              <span className="f-move-check">
                <DoneIcon size={15} />
              </span>
              <div>
                <div className="f-move-banner-title">«{ws.name}» ya está en {destLabel}</div>
                <p className="f-move-p">
                  {resumed
                    ? 'La terminal arrancó de nuevo con la otra cuenta y Claude sigue la misma conversación.'
                    : `La terminal arrancó de nuevo con la otra cuenta. Claude empieza de cero en ${ws.cwd}.`}
                </p>
                {keep && summary && <p className="hint f-move-p">Le dejamos el resumen para que lo lea al arrancar.</p>}
              </div>
            </div>
            <footer className="f-move-actions">
              <span className="spacer" />
              <button type="button" className="btn primary" onClick={closeMove} autoFocus>
                Volver al espacio
              </button>
            </footer>
          </div>
        )}
      </form>
    </div>
  )
}

