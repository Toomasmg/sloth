import { createContext, useContext, type ReactNode } from 'react'
import type { SettingsPatch } from './store'

/** Guarda un cambio parcial o corre una acción async; la pantalla muestra «Guardado» (o el error). */
export type SaveFn = (what: SettingsPatch | (() => Promise<unknown>)) => void
export const SaveContext = createContext<SaveFn>(() => undefined)
export const useSave = (): SaveFn => useContext(SaveContext)

export const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Título de grupo + tarjeta con filas (el lenguaje visual del diseño de Configuración). */
export function Group({ title, children, id }: { title?: string; children: ReactNode; id: string }): React.JSX.Element {
  return (
    <section className="f-set-group" aria-labelledby={title ? `${id}-h` : undefined} aria-label={title ? undefined : id}>
      {title && (
        <h2 id={`${id}-h`} className="f-set-group-h">
          {title}
        </h2>
      )}
      <div className="f-set-card">{children}</div>
    </section>
  )
}

/** Fila con texto a la izquierda y control a la derecha. `htmlFor` asocia el título al control. */
export function Row({
  title,
  hint,
  htmlFor,
  children,
  stack
}: {
  title: ReactNode
  hint?: ReactNode
  htmlFor?: string
  children?: ReactNode
  stack?: boolean
}): React.JSX.Element {
  return (
    <div className={`f-set-row ${stack ? 'stack' : ''}`}>
      <div className="f-set-row-text">
        {htmlFor ? (
          <label className="f-set-row-title" htmlFor={htmlFor}>
            {title}
          </label>
        ) : (
          <span className="f-set-row-title">{title}</span>
        )}
        {hint && <span className="f-set-hint">{hint}</span>}
      </div>
      {children && <div className="f-set-row-ctl">{children}</div>}
    </div>
  )
}

/** Fila entera que es un interruptor (role=switch). */
export function ToggleRow({
  title,
  hint,
  checked,
  onChange,
  disabled
}: {
  title: ReactNode
  hint?: ReactNode
  checked: boolean
  onChange(v: boolean): void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} className="f-set-row f-set-toggle" onClick={() => onChange(!checked)}>
      <span className="f-set-row-text">
        <span className="f-set-row-title">{title}</span>
        {hint && <span className="f-set-hint">{hint}</span>}
      </span>
      <span className={`f-set-track ${checked ? 'on' : ''}`} aria-hidden="true">
        <span className="f-set-knob" />
      </span>
    </button>
  )
}

/** Segmentado de opciones (radiogroup). */
export function Seg<T extends string>({
  label,
  value,
  options,
  onPick
}: {
  label: string
  value: T
  options: readonly { value: T; label: string; style?: React.CSSProperties }[]
  onPick(v: T): void
}): React.JSX.Element {
  return (
    <div className="f-set-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} className={on ? 'on' : ''} style={o.style} onClick={() => onPick(o.value)}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Control deslizante con su valor a la derecha. */
export function Slider({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  format,
  onChange
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  step?: number
  format(v: number): string
  onChange(v: number): void
}): React.JSX.Element {
  return (
    <div className="f-set-slider">
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        aria-valuetext={format(value)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output htmlFor={id} className="mono">
        {format(value)}
      </output>
    </div>
  )
}

/** Título y texto de cada sección (la cabecera de la página). */
export function SectionHint({ children }: { children: ReactNode }): React.JSX.Element {
  return <p className="f-set-note">{children}</p>
}
