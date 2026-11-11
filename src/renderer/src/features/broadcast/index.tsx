import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ModalLoading } from '../../Modal'
import { useUi, type FeatureUi } from '../host'
import { comboLabel, isCapturingShortcut, matchShortcut } from '../../shortcuts'
import { releaseQueued } from './store'
import { spaceStatus } from './state'
import './broadcast.css'

// El diálogo (lista de espacios, mensaje, progreso) se carga recién al abrirlo.
const BroadcastDialog = lazy(() => import('./BroadcastDialog').then((m) => ({ default: m.BroadcastDialog })))

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

function Global(): React.JSX.Element | null {
  const ctx = useUi()
  const open = useOpen()
  const [toast, setToast] = useState<string | null>(null)
  const prevFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isCapturingShortcut() && matchShortcut('broadcast', e)) {
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
      {open && (
        <Suspense fallback={<ModalLoading />}>
          <BroadcastDialog onClose={() => setOpen(false)} />
        </Suspense>
      )}
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
            shortcut: comboLabel('broadcast'),
            run: () => setOpen(true)
          }
        ]
      : []
}

export default ui
