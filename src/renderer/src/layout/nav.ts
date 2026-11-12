import { useSyncExternalStore } from 'react'
import { closeAllViews, subscribeViews, topViewId } from '../ui/view-stack'
import { setBoardOpen } from '../features/tickets/model'
import { setTeamOpen } from '../features/team/model'
import { openHistory } from '../features/history/index'
import { openRamas } from '../features/worktrees/store'
import { openHelp } from '../features/help/bus'
import { openSettings } from '../features/settings/bus'
import { destOf, type NavDest } from './nav-model'

/** Destino que se ve ahora (lo marca el riel). */
export const useNavDest = (): NavDest => destOf(useSyncExternalStore(subscribeViews, topViewId))

/**
 * Va a un destino del riel: cierra la Vista que esté abierta (si tiene cambios sin guardar pregunta y
 * no navega) y abre la del destino. Espacios es no tener ninguna Vista.
 */
export function goTo(dest: NavDest): void {
  if (destOf(topViewId()) === dest) return
  if (!closeAllViews()) return
  if (dest === 'tickets') setBoardOpen(true)
  else if (dest === 'equipo') setTeamOpen(true)
  else if (dest === 'historial') openHistory()
  else if (dest === 'ramas') openRamas()
  else if (dest === 'ayuda') openHelp('ayuda')
  else if (dest === 'ajustes') openSettings()
}
