import { useEffect, useRef, useState } from 'react'

/** Input para renombrar. Enter o salir guardan (si hay texto); Escape cancela. Responde una sola vez. */
export function RenameInput({
  initial,
  label,
  className,
  onDone
}: {
  initial: string
  label: string
  className: string
  onDone(next: string | null): void
}): React.JSX.Element {
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (next: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(next)
  }
  const value = (): string | null => text.trim() || null
  return (
    <input
      ref={ref}
      className={className}
      value={text}
      maxLength={80}
      aria-label={label}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(value())
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish(null)
        }
      }}
      onBlur={() => finish(value())}
    />
  )
}
