import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowsLeftRight, X } from '@phosphor-icons/react'
import { isLoginPane, type Account } from '../../../../shared/types'
import { useUi, type Command, type FeatureUi, type UiCtx } from '../host'
import { cleanError } from '../../format'
import './move-account.css'

// ---------- Estado compartido: qué espacio se está moviendo (lo lee Global) ----------

interface MoveTarget {
  wsId: string
  /** Elemento que tenía el foco al abrir: vuelve a tenerlo al cerrar. */
  returnFocus: HTMLElement | null
}

let current: MoveTarget | null = null
const listeners = new Set<() => void>()

function setCurrent(v: MoveTarget | null): void {
  current = v
  for (const l of listeners) l()
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
const getCurrent = (): MoveTarget | null => current
const useMoveTarget = (): MoveTarget | null => useSyncExternalStore(subscribe, getCurrent)

function openMove(wsId: string): void {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  setCurrent({ wsId, returnFocus: active })
}

function closeMove(): void {
  const t = current
  setCurrent(null)
  t?.returnFocus?.focus?.()
}

// ---------- Reglas ----------

/** Solo espacios (no paneles de login) y solo si hay 2 o más cuentas. */
function canMove(ui: UiCtx, paneId: string): boolean {
  if (isLoginPane(paneId)) return false
  return ui.workspaces.some((w) => w.id === paneId) && ui.accounts.length >= 2
}

/** Otras cuentas con sesión iniciada, por nombre y en orden alfabético. */
function otherAccounts(ui: UiCtx, exceptId: string): Account[] {
  return ui.accounts
    .filter((a) => a.id !== exceptId && ui.statuses[a.id]?.loggedIn)
    .sort((x, y) => x.label.localeCompare(y.label, 'es'))
}

// ---------- Botón del header del panel ----------

function PaneHeader({ paneId }: { paneId: string }): React.JSX.Element | null {
  const ui = useUi()
  if (!canMove(ui, paneId)) return null
  return (
    <button type="button" className="icon-btn" onClick={() => openMove(paneId)} aria-label="Mover a otra cuenta" title="Mover a otra cuenta">
      <ArrowsLeftRight size={15} aria-hidden="true" />
    </button>
  )
}

// ---------- Diálogo (Global) ----------

function MoveDialog({ wsId }: { wsId: string }): React.JSX.Element {
  const ui = useUi()
  const ws = ui.workspaces.find((w) => w.id === wsId)
  const from = ws ? ui.accounts.find((a) => a.id === ws.accountId) : undefined
  const options = ws ? otherAccounts(ui, ws.accountId) : []

  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /** null mientras se pregunta si el espacio tiene conversación (solo se miran nombres de archivo). */
  const [hasConv, setHasConv] = useState<boolean | null>(null)
  const busyRef = useRef(false)
  const firstRef = useRef<HTMLInputElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    let alive = true
    ui.invoke<{ hasConversation: boolean }>('feat:move-account:peek', wsId)
      .then((r) => {
        if (alive) setHasConv(r.hasConversation)
      })
      .catch((e) => {
        if (alive) setErr(cleanError(e))
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId])

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

  const confirm = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!choice || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setErr(null)
    try {
      await ui.invoke<{ ok: boolean; resumed: boolean }>('feat:move-account:move', wsId, choice)
      closeMove()
    } catch (e2) {
      setErr(cleanError(e2))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const explain =
    hasConv === null
      ? null
      : !hasConv
        ? 'Se cierra la terminal y el espacio pasa a usar la cuenta elegida.'
        : ws.autoStartClaude
          ? 'Se cierra la terminal y Claude retoma esta conversación con la cuenta elegida.'
          : 'Se cierra la terminal y la conversación se copia a la cuenta elegida. Este espacio no arranca Claude solo: para seguirla, escribí «claude --continue» en la terminal.'

  return (
    <div className="modal-backdrop" onMouseDown={() => !busyRef.current && closeMove()}>
      <form
        className="modal f-move-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="f-move-title"
        aria-describedby="f-move-now"
        aria-busy={busy || undefined}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => void confirm(e)}
      >
        <header className="modal-head">
          <ArrowsLeftRight size={18} aria-hidden="true" className="f-move-head-icon" />
          <h2 id="f-move-title">Mover «{ws.name}» a otra cuenta</h2>
          <button type="button" className="icon-btn" onClick={closeMove} disabled={busy} aria-label="Cerrar" title="Cerrar">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <p id="f-move-now" className="f-move-now">
          Ahora usa <strong>{from?.label ?? 'una cuenta borrada'}</strong>.
        </p>

        {options.length === 0 ? (
          <p className="hint">No hay otra cuenta con sesión iniciada. Iniciá sesión en otra cuenta desde la barra lateral.</p>
        ) : (
          <fieldset className="f-move-list" disabled={busy}>
            <legend>Cuenta destino</legend>
            {options.map((a, i) => (
              <label key={a.id} className={`f-move-opt${choice === a.id ? ' on' : ''}`}>
                <input
                  ref={i === 0 ? firstRef : undefined}
                  type="radio"
                  name="f-move-acc"
                  value={a.id}
                  checked={choice === a.id}
                  onChange={() => setChoice(a.id)}
                />
                <span className="f-move-opt-title">{a.label}</span>
                <span className="f-move-opt-sub">{ui.statuses[a.id]?.email ?? 'Sesión iniciada'}</span>
              </label>
            ))}
          </fieldset>
        )}

        {explain && <p className="f-move-explain">{explain}</p>}
        {err && (
          <p className="form-error" role="alert">
            {err}
          </p>
        )}

        <footer className="modal-actions">
          <button type="button" className="btn ghost" onClick={closeMove} disabled={busy} ref={cancelRef}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={!choice || busy || options.length === 0}>
            {busy ? 'Moviendo…' : 'Confirmar'}
          </button>
        </footer>
      </form>
    </div>
  )
}

function Global(): React.JSX.Element | null {
  const ui = useUi()
  const t = useMoveTarget()
  if (!t || !ui.workspaces.some((w) => w.id === t.wsId)) return null
  return <MoveDialog wsId={t.wsId} />
}

// ---------- Paleta ----------

function commands(ui: UiCtx): Command[] {
  return [
    {
      id: 'move-account.focused',
      title: 'Mover espacio enfocado a otra cuenta',
      group: 'Espacios',
      keywords: 'cuenta cambiar mover',
      icon: <ArrowsLeftRight size={16} aria-hidden="true" />,
      run() {
        const id = ui.focused
        if (!id || !canMove(ui, id)) {
          ui.notifyError('Enfocá un espacio para moverlo. Hace falta tener al menos dos cuentas.')
          return
        }
        openMove(id)
      }
    }
  ]
}

const ui: FeatureUi = {
  name: 'move-account',
  PaneHeader,
  Global,
  commands
}

export default ui
