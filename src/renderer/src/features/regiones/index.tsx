import { useEffect } from 'react'
import { siguienteRegion } from '../../regiones'
import type { FeatureUi } from '../host'

const ZONAS = ['.sl-top', '.sl-rail', '.sl-side', '.sl-main']
const PRIMER_CONTROL = 'button:not([disabled]), input, a[href], [tabindex="0"]'

function visible(el: HTMLElement): boolean {
  return el.offsetParent !== null && !el.closest('[inert]')
}

function destino(zona: Element): HTMLElement | null {
  if (zona.matches('.sl-main')) {
    const term = zona.querySelector<HTMLElement>('.pane.focused .xterm-helper-textarea') ?? zona.querySelector<HTMLElement>('.xterm-helper-textarea')
    if (term) return term
  }
  return Array.from(zona.querySelectorAll<HTMLElement>(PRIMER_CONTROL)).find(visible) ?? null
}

function Global(): null {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'F6' || e.ctrlKey || e.altKey || e.metaKey) return
      if (document.querySelector('.modal-backdrop, [aria-modal="true"]')) return
      e.preventDefault()
      e.stopPropagation()
      const zonas = ZONAS.map((sel) => document.querySelector(sel)).filter((z): z is Element => z !== null && destino(z) !== null)
      const actual = zonas.findIndex((z) => z.contains(document.activeElement))
      const i = siguienteRegion(zonas.length, actual, e.shiftKey)
      if (i >= 0) destino(zonas[i])?.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return null
}

const ui: FeatureUi = { name: 'regiones', Global }
export default ui
