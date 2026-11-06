import { useEffect, useRef } from 'react'
import { useUi, type FeatureUi } from '../host'
import { getSettings } from '../settings/store'
import { canPlay, chimesFor, type AgentLike } from './logic'
import { disposeSound, playChime } from './audio'
import './sound.css'

/** Tiempo tras montar la app en el que solo se toma la línea base (lo que ya estaba pendiente no suena). */
const WARM_UP_MS = 2000

/**
 * Función «sound» (interfaz). Observa agentes y permisos y, en las transiciones, suena si el ajuste
 * «sounds» está activo. Sin nada de polling: reacciona a los cambios que ya llegan por useUi().
 */
const Global = (): null => {
  const ui = useUi()
  const mountedAt = useRef(Date.now())
  const prevAgents = useRef<Record<string, AgentLike> | undefined>(undefined)
  const prevPerms = useRef<string[] | undefined>(undefined)
  const lastPlayed = useRef(0)

  useEffect(() => {
    const permIds = ui.permissions.map((p) => p.id)
    const now = Date.now()
    const warm = now - mountedAt.current < WARM_UP_MS
    // Primera carga: solo se guarda la línea base, sin sonar.
    const chimes = warm || !prevAgents.current ? [] : chimesFor(prevAgents.current, ui.agents, prevPerms.current, permIds)
    prevAgents.current = ui.agents
    prevPerms.current = permIds
    if (chimes.length === 0 || !getSettings().settings.sounds) return
    if (!canPlay(lastPlayed.current, now)) return
    lastPlayed.current = now
    playChime(chimes[0])
  }, [ui.agents, ui.permissions])

  useEffect(() => () => disposeSound(), [])

  return null
}

const ui: FeatureUi = { name: 'sound', Global }

export default ui
