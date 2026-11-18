import { useEffect, useRef, useState } from 'react'
import { SHORTCUT_ACTIONS, bindingOf, comboFromEvent, findConflict, keyTokenOf, setShortcutCapture, type ShortcutAction } from '../../../shortcuts'
import { useSettings } from '../store'
import { type ShortcutId } from '../../../../../shared/settings-model'
import { Group, useSave, SectionHint } from '../ui'
import { Button } from '../../../ui'
/* ---------- Atajos ---------- */

const showCombo = (c: string): string => c.split(' ').join('+')

export function ShortcutsSection(): React.JSX.Element {
  const p = useSettings()
  const save = useSave()
  const [cap, setCap] = useState<ShortcutId | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const custom = p.settings.shortcuts
  const customRef = useRef(custom)
  customRef.current = custom

  // Mientras se graba: captura en window (antes que nadie) para que la combinación no dispare su función.
  useEffect(() => {
    if (!cap) return
    setShortcutCapture(true)
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      if (e.key === 'Escape') {
        setCap(null)
        setMsg(null)
        return
      }
      const combo = comboFromEvent(e)
      if (!combo) {
        if (keyTokenOf(e) && !e.ctrlKey && !e.altKey) setMsg('Usá Ctrl o Alt en la combinación (o una tecla F sola).')
        return
      }
      const conflict = findConflict(cap, combo, customRef.current)
      if (conflict) {
        setMsg(`${showCombo(combo)} ya lo usa «${conflict}». Elegí otra.`)
        return
      }
      setCap(null)
      setMsg(null)
      save({ shortcuts: { [cap]: combo } })
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      setShortcutCapture(false)
      window.removeEventListener('keydown', onKey, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cap])

  return (
    <>
      <Group id="g-atajos">
        {SHORTCUT_ACTIONS.map((a: ShortcutAction) => {
          const isCap = cap === a.id
          const changed = !a.fixed && custom[a.id] !== undefined
          const label = isCap ? 'Apretá la combinación…' : showCombo(bindingOf(a.id, custom))
          return (
            <div key={a.id} className="f-set-row">
              <span className="f-set-row-text">
                <span className="f-set-row-title">{a.name}</span>
                {a.fixed && <span className="f-set-hint">Fijo: 1 a 4 eligen la distribución.</span>}
              </span>
              <div className="f-set-row-ctl">
                <button
                  type="button"
                  className={`f-set-key ${isCap ? 'capturing' : ''}`}
                  disabled={a.fixed}
                  aria-label={`Cambiar el atajo de ${a.name}`}
                  onClick={() => {
                    setMsg(null)
                    setCap(isCap ? null : a.id)
                  }}
                  onBlur={() => {
                    if (isCap) {
                      setCap(null)
                      setMsg(null)
                    }
                  }}
                >
                  {label}
                </button>
                {changed && (
                  <Button variant="ghost" size="sm" onClick={() => save({ shortcuts: { [a.id]: null } })}>
                    Restaurar
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </Group>
      {msg && (
        <p role="alert" className="form-error">
          {msg}
        </p>
      )}
      <SectionHint>Tocá un atajo y apretá la combinación nueva. Esc cancela.</SectionHint>
    </>
  )
}
