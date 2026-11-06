import type { FeatureUi } from './host'
import rotation from './rotation'
import history from './history'
import git from './git'
import worktrees from './worktrees'
import palette from './palette'
import broadcast from './broadcast'
import templates from './templates'
import updater from './updater'
import exportImport from './export-import'
import gruv from './gruv'
import settings from './settings'
import onboarding from './onboarding'
import teamConfig from './team-config'
import team from './team'

/** Todas las funciones de la interfaz, en el orden en que aparecen en cada lugar. */
export const FEATURE_UIS: FeatureUi[] = [rotation, history, git, worktrees, palette, broadcast, templates, updater, exportImport, gruv, settings, onboarding, teamConfig, team]
