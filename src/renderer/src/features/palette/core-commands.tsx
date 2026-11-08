import {
  ArrowCounterClockwise,
  ArrowsInSimple,
  ArrowsOutSimple,
  Check,
  EyeSlash,
  FolderOpen,
  Plus,
  Tag,
  UserCircle,
  X
} from '@phosphor-icons/react'
import { isLoginPane, loginPaneId } from '../../../../shared/types'
import { STATE_LABEL, cleanError, shortPath } from '../../format'
import { toolLabel } from '../../PermissionCard'
import { decidePermission } from '../permissions/api'
import type { Command, UiCtx } from '../host'

/** Enfoca la terminal de un panel apenas exista (si se acaba de abrir, tarda un par de cuadros). */
export function focusPaneTerminal(id: string, tries = 10): void {
  const pane = document.querySelector(`[data-pane-id="${CSS.escape(id)}"]`)
  const ta = pane?.querySelector<HTMLElement>('.xterm-helper-textarea')
  if (ta) ta.focus()
  else if (tries > 0) requestAnimationFrame(() => focusPaneTerminal(id, tries - 1))
}

/** Comandos propios del núcleo: espacios, paneles, cuentas y permisos. */
export function coreCommands(ctx: UiCtx): Command[] {
  const cmds: Command[] = []
  const accById = new Map(ctx.accounts.map((a) => [a.id, a]))
  const wsById = new Map(ctx.workspaces.map((w) => [w.id, w]))

  for (const ws of ctx.workspaces) {
    const ag = ctx.agents[ws.id]
    const acc = accById.get(ws.accountId)
    cmds.push({
      id: `palette:go:${ws.id}`,
      title: `Ir a ${ws.name}`,
      subtitle: [acc?.label ?? 'cuenta borrada', ag ? STATE_LABEL[ag.state] : 'sin abrir', ws.branch ?? shortPath(ws.cwd)].join(' · '),
      group: 'Espacios',
      icon: <FolderOpen size={16} aria-hidden="true" />,
      keywords: [ws.ticket, ws.branch, ws.repoPath].filter(Boolean).join(' '),
      run: () => {
        ctx.openPane(ws.id)
        focusPaneTerminal(ws.id)
      }
    })
  }

  if (ctx.accounts.length) {
    cmds.push(
      {
        id: 'palette:new-ws',
        title: 'Nuevo espacio',
        subtitle: 'Un repo, una cuenta y una PowerShell',
        group: 'General',
        icon: <Plus size={16} aria-hidden="true" />,
        keywords: 'crear agregar workspace',
        run: () => ctx.openNewWorkspace('normal')
      },
      {
        id: 'palette:new-ws-ticket',
        title: 'Espacio desde ticket',
        subtitle: 'Abre Claude con /ticket TCK-…',
        group: 'General',
        icon: <Tag size={16} aria-hidden="true" />,
        keywords: 'crear tck gruv',
        run: () => ctx.openNewWorkspace('ticket')
      }
    )
  }

  const f = ctx.focused && ctx.openPanes.includes(ctx.focused) ? ctx.focused : null
  if (f) {
    const name = isLoginPane(f) ? 'Terminal de cuenta' : (wsById.get(f)?.name ?? f)
    const isMax = ctx.maximized === f
    cmds.push(
      {
        id: 'palette:max',
        title: isMax ? 'Restaurar panel (volver a la grilla)' : 'Maximizar panel enfocado',
        subtitle: name,
        group: 'Panel',
        icon: isMax ? <ArrowsInSimple size={16} aria-hidden="true" /> : <ArrowsOutSimple size={16} aria-hidden="true" />,
        keywords: 'maximizar restaurar grilla agrandar',
        run: () => ctx.setMaximized(isMax ? null : f)
      },
      {
        id: 'palette:restart',
        title: 'Reiniciar terminal enfocada',
        subtitle: `${name} · cierra el proceso y abre otra terminal`,
        group: 'Panel',
        icon: <ArrowCounterClockwise size={16} aria-hidden="true" />,
        keywords: 'reiniciar matar kill terminal',
        run: async () => {
          if (ctx.agents[f]?.state === 'working' && !window.confirm(`«${name}» está trabajando. ¿Reiniciar la terminal igual?`)) return
          await ctx.restartPane(f)
        }
      },
      {
        id: 'palette:hide',
        title: 'Ocultar panel enfocado',
        subtitle: `${name} · la terminal sigue corriendo`,
        group: 'Panel',
        icon: <EyeSlash size={16} aria-hidden="true" />,
        keywords: 'cerrar ocultar panel',
        run: () => ctx.closePane(f)
      }
    )
  }

  for (const acc of ctx.accounts) {
    const st = ctx.statuses[acc.id]
    cmds.push({
      id: `palette:acc:${acc.id}`,
      title: `Terminal de la cuenta ${acc.label}`,
      subtitle: st?.loggedIn ? (st.email ?? 'Sesión iniciada') : 'Sin sesión: iniciar sesión',
      group: 'Cuentas',
      icon: <UserCircle size={16} aria-hidden="true" />,
      keywords: 'login sesion cuenta',
      run: () => {
        const id = loginPaneId(acc.id)
        ctx.openPane(id)
        focusPaneTerminal(id)
      }
    })
  }

  const now = Date.now()
  const oldest = [...ctx.permissions]
    .filter((p) => p.expiresAt > now && wsById.has(p.workspaceId))
    .sort((a, b) => a.at - b.at)[0]
  if (oldest) {
    const where = `${wsById.get(oldest.workspaceId)?.name ?? 'Espacio'}: ${toolLabel(oldest.tool)}`
    const answer = (a: 'allow' | 'deny') => async () => {
      try {
        await decidePermission(oldest, a)
      } catch (e) {
        ctx.notifyError(cleanError(e))
      }
    }
    cmds.push(
      { id: 'palette:perm-allow', title: 'Aprobar el permiso más viejo', subtitle: where, group: 'Permisos', icon: <Check size={16} aria-hidden="true" />, keywords: 'permitir aceptar si allow', run: answer('allow') },
      { id: 'palette:perm-deny', title: 'Rechazar el permiso más viejo', subtitle: where, group: 'Permisos', icon: <X size={16} aria-hidden="true" />, keywords: 'denegar no deny', run: answer('deny') }
    )
  }
  return cmds
}
