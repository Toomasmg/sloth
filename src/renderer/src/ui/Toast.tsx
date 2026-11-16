import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { CloseIcon, WarningIcon } from '../icons/SlothIcons'
import { Button } from './Button'
import { IconButton } from './IconButton'
import { addToast, dismissToast, type ToastInput, type ToastItem, type ToastTone } from './toast-queue'
import { useExit } from './useExit'
import './ui.css'

let list: ToastItem[] = []
let nextId = 1
const subs = new Set<() => void>()
const emit = (): void => subs.forEach((f) => f())

/** Cola global de avisos: se llama desde cualquier lado y `<ToastHost />` los dibuja. Devuelve el id para poder cerrarlo. */
export function toast(input: ToastInput): number {
  const id = nextId++
  list = addToast(list, input, id)
  emit()
  return id
}

export function dismissToastById(id: number): void {
  list = dismissToast(list, id)
  emit()
}

const subscribe = (f: () => void): (() => void) => {
  subs.add(f)
  return () => {
    subs.delete(f)
  }
}
const snapshot = (): ToastItem[] => list

function ToastCard({ t }: { t: ToastItem }): React.JSX.Element {
  const [closing, leave] = useExit(() => dismissToastById(t.id))
  useEffect(() => {
    if (!t.duration) return
    const h = window.setTimeout(leave, t.duration)
    return () => window.clearTimeout(h)
  }, [t.duration, leave])
  return (
    <div className={`ui-toast ui-toast--${t.tone}${closing ? ' is-closing' : ''}`} inert={closing} role={t.tone === 'danger' ? 'alert' : 'status'}>
      {(t.tone === 'danger' || t.tone === 'warning') && <WarningIcon size={16} />}
      <span className="ui-toast-msg">{t.message}</span>
      {t.actionLabel && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            t.onAction?.()
            leave()
          }}
        >
          {t.actionLabel}
        </Button>
      )}
      <IconButton label="Cerrar aviso" size="sm" icon={<CloseIcon size={14} />} onClick={leave} />
    </div>
  )
}

// Si alguien monta un segundo ToastHost, dibuja solo el primero: cada aviso se ve una vez.
let hosts: number[] = []
let nextHost = 1

export function ToastHost(): React.JSX.Element | null {
  const [me] = useState(() => nextHost++)
  useLayoutEffect(() => {
    hosts = [...hosts, me]
    emit()
    return () => {
      hosts = hosts.filter((h) => h !== me)
      emit()
    }
  }, [me])
  const items = useSyncExternalStore(subscribe, snapshot)
  const primary = useSyncExternalStore(subscribe, () => hosts[0] === me)
  if (!primary || !items.length) return null
  return (
    <div className="ui-toasts">
      {items.map((t) => (
        <ToastCard key={t.id} t={t} />
      ))}
    </div>
  )
}

/** Aviso dentro de una pantalla o formulario (no flota). */
export function InlineAlert({ tone = 'info', children, action }: { tone?: ToastTone; children: ReactNode; action?: ReactNode }): React.JSX.Element {
  return (
    <div className={`ui-alert ui-alert--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="ui-alert-msg">{children}</span>
      {action}
    </div>
  )
}
