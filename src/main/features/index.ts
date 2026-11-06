import type { Feature } from './context'
import rotation from './rotation'
import history from './history'
import git from './git'
import worktrees from './worktrees'
import broadcast from './broadcast'
import templates from './templates'
import tray from './tray'
import updater from './updater'
import exportImport from './export-import'
import gruv from './gruv'
import settings from './settings'
import onboarding from './onboarding'
import teamConfig from './team-config'
import team from './team'

/** Todas las funciones del lado main. Para sumar una: crear su archivo y agregarla acá. */
export const FEATURES: Feature[] = [rotation, history, git, worktrees, broadcast, templates, tray, updater, exportImport, gruv, settings, onboarding, teamConfig, team]
