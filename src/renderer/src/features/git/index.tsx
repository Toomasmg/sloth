import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ChangesIcon } from '../../icons/SlothIcons'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
import { isLoginPane } from '../../../../shared/types'
import { useDocumentVisible } from '../../visibility'
import { closeDrawer, onRefresh, openDrawer, requestRefresh, useDrawer } from './store'
import './git.css'

const PROTECTED = ['main', 'master', 'staging']

// El panel (cambios, historial, ramas, PR) se carga recién al abrirlo: el botón del header siempre está montado.
const Drawer = lazy(() => import('./Drawer').then((m) => ({ default: m.Drawer })))

function DrawerGate(): React.JSX.Element | null {
  const { wsId } = useDrawer()
  return wsId ? (
    <Suspense fallback={null}>
      <Drawer />
    </Suspense>
  ) : null
}

// ---------- Botón del header ----------

function ChangesButton({ paneId }: { paneId: string }): React.JSX.Element | null {
  const ui = useUi()
  const ws = isLoginPane(paneId) ? undefined : ui.workspaces.find((w) => w.id === paneId)
  const wsId = ws?.id
  const [count, setCount] = useState<number | null>(null)
  const visible = useDocumentVisible()
  const pending = useRef(false)

  const refresh = useCallback(() => {
    if (!wsId || pending.current) return
    pending.current = true
    ui.invoke<number | null>('feat:git:count', wsId)
      .then((n) => setCount(typeof n === 'number' ? n : null))
      .catch(() => setCount(null))
      .finally(() => (pending.current = false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId])

  // Al abrir el panel y cada vez que la ventana vuelve a verse.
  useEffect(() => {
    if (visible) refresh()
  }, [visible, refresh])

  // Cuando Claude termina un turno en este espacio (hook Stop) o después de una operación de git.
  useEffect(() => {
    if (!wsId) return
    let t: ReturnType<typeof setTimeout> | undefined
    const later = (id: string): void => {
      if (id !== wsId) return
      clearTimeout(t)
      t = setTimeout(() => {
        if (document.visibilityState === 'visible') refresh()
      }, 400)
    }
    const off1 = ui.on('feat:git:changed', later)
    const off2 = onRefresh(later)
    return () => {
      clearTimeout(t)
      off1()
      off2()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, refresh])

  if (!ws || count === null) return null
  const label = count === 0 ? 'Cambios: sin archivos modificados' : `Cambios: ${count} archivo${count === 1 ? '' : 's'} modificado${count === 1 ? '' : 's'}`
  return (
    <button className={`f-git-btn ${count > 0 ? 'has' : ''}`} onClick={() => openDrawer(ws.id)} aria-label={label} title={label}>
      <ChangesIcon size={14} />
      <span className="f-git-btn-label">Cambios</span>
      <span className="f-git-btn-n mono">{count}</span>
    </button>
  )
}

const ui: FeatureUi = {
  name: 'git',
  PaneHeader: ChangesButton,
  Global: DrawerGate,
  commands(ctx) {
    const ws = ctx.workspaces.find((w) => w.id === ctx.focused)
    const need = (): string | null => {
      if (!ws) {
        ctx.notifyError('Enfocá el panel de un espacio primero.')
        return null
      }
      return ws.id
    }
    return [
      {
        id: 'git:changes',
        title: 'Ver cambios del espacio enfocado',
        subtitle: ws ? ws.name : undefined,
        group: 'Git',
        keywords: 'git diff status cambios archivos modificados',
        run() {
          const id = need()
          if (id) openDrawer(id, 'changes')
        }
      },
      {
        id: 'git:pr',
        title: 'Crear PR del espacio enfocado',
        subtitle: ws ? ws.name : undefined,
        group: 'Git',
        keywords: 'git pull request pr github gh push',
        run() {
          const id = need()
          if (!id) return
          if (ws?.branch && PROTECTED.includes(ws.branch)) ctx.notifyError(`El espacio está en ${ws.branch}: creá una rama antes del PR.`)
          openDrawer(id, 'pr')
        }
      }
    ]
  }
}

export default ui
