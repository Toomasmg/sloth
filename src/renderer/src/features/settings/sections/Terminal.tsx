import { useMemo } from 'react'
import { hayFuenteNerd, termFontStack, useSettings } from '../store'
import { LINE_HEIGHT, SCROLLBACK, SHELLS, TERM_FONTS, TERM_FONT, type CursorShape, type ShellChoice, type TermFont } from '../../../../../shared/settings-model'
import { Group, Row, Slider, ToggleRow, useSave } from '../ui'
import { Segmented, Select } from '../../../ui'
/* ---------- Terminal ---------- */

const CURSOR_LABEL: Record<CursorShape, string> = { bloque: 'Bloque', barra: 'Línea', subrayado: 'Subrayado' }
const CURSOR_ORDER: CursorShape[] = ['bloque', 'barra', 'subrayado']

export function TerminalSection(): React.JSX.Element {
  const p = useSettings()
  const t = p.settings.terminal
  const conNerd = useMemo(() => hayFuenteNerd(), [])
  const save = useSave()
  const th = termTheme(p)
  const cursor =
    t.cursorStyle === 'bloque'
      ? { w: '0.6em', h: '1.15em' }
      : t.cursorStyle === 'barra'
        ? { w: '2px', h: '1.15em' }
        : { w: '0.6em', h: '2px' }
  return (
    <>
      {p.settings.lightMode ? (
        <p className="f-set-hint">La vista previa de la terminal está apagada en el modo liviano.</p>
      ) : (
      <pre
        className="f-set-term"
        aria-label="Vista previa de la terminal"
        style={{ fontFamily: termFontStack(t.fontFamily), fontSize: `${t.fontSize}px`, lineHeight: t.lineHeight, background: th.background, color: th.foreground }}
      >
        <span style={{ color: th.brightBlack }}>~/mi-app/front</span>
        {'\n'}
        <span style={{ color: th.blue }}>›</span> Corré los tests de la tabla{'\n'}
        <span style={{ color: th.green }}>●</span> PASS TicketTable.test.tsx (12){'\n'}
        <span style={{ color: th.blue }}>›</span>{' '}
        <span
          className={`f-set-cursor ${t.cursorBlink ? 'blink' : ''}`}
          style={{ display: 'inline-block', verticalAlign: 'text-bottom', width: cursor.w, height: cursor.h, background: th.cursor }}
          aria-hidden="true"
        />
      </pre>
      )}
      <Group id="g-term" label="Texto y cursor">
        <Row
          title={<label htmlFor="f-set-tfont">Fuente</label>}
          hint={
            conNerd
              ? undefined
              : 'Si el prompt muestra recuadros en lugar de íconos, instalá una fuente Nerd (por ejemplo «Symbols Nerd Font Mono») en Windows: Sloth la usa sola.'
          }
        >
          <Select id="f-set-tfont" value={t.fontFamily} onChange={(e) => save({ terminal: { fontFamily: e.target.value as TermFont } })}>
            {TERM_FONTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </Row>
        <Row title={<label htmlFor="f-set-tsize">Tamaño de letra</label>}>
          <Slider id="f-set-tsize" label="Tamaño de letra de la terminal" value={t.fontSize} min={TERM_FONT.min} max={TERM_FONT.max} format={(v) => `${v} px`} onChange={(fontSize) => save({ terminal: { fontSize } })} />
        </Row>
        <Row title={<label htmlFor="f-set-tline">Altura de línea</label>} hint="Con más de 1, los recuadros de Claude se ven con cortes.">
          <Slider
            id="f-set-tline"
            label="Altura de línea"
            value={t.lineHeight}
            min={LINE_HEIGHT.min}
            max={LINE_HEIGHT.max}
            step={LINE_HEIGHT.step}
            format={(v) => v.toFixed(2).replace('.', ',')}
            onChange={(v) => save({ terminal: { lineHeight: Math.round(v * 100) / 100 } })}
          />
        </Row>
        <Row title="Cursor">
          <Segmented<CursorShape> aria-label="Forma del cursor" value={t.cursorStyle} options={CURSOR_ORDER.map((c) => ({ value: c, label: CURSOR_LABEL[c] }))} onChange={(cursorStyle) => save({ terminal: { cursorStyle } })} />
        </Row>
        <ToggleRow title="Cursor que parpadea" checked={t.cursorBlink} onChange={(cursorBlink) => save({ terminal: { cursorBlink } })} />
        <ToggleRow
          title="Dictado más preciso"
          hint="Usa un modelo más grande: se equivoca mucho menos, pero tarda bastante más en transcribir. La primera vez baja 574 MB."
          checked={t.dictadoPreciso}
          onChange={(dictadoPreciso) => save({ terminal: { dictadoPreciso } })}
        />
        <Row title={<label htmlFor="f-set-tscroll">Historial</label>} hint="Líneas que se guardan para subir con la rueda. Más líneas, más memoria.">
          <Slider
            id="f-set-tscroll"
            label="Líneas de historial de la terminal"
            value={t.scrollback}
            min={SCROLLBACK.min}
            max={SCROLLBACK.max}
            step={SCROLLBACK.step}
            format={(v) => `${v.toLocaleString('es-AR')} líneas`}
            onChange={(scrollback) => save({ terminal: { scrollback } })}
          />
        </Row>
        <Row title={<label htmlFor="f-set-shell">Shell</label>} hint="Se aplica a los espacios nuevos.">
          <Select id="f-set-shell" value={t.shell} onChange={(e) => save({ terminal: { shell: e.target.value as ShellChoice } })}>
            {SHELLS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
        </Row>
      </Group>
    </>
  )
}

/** Colores de xterm para la vista previa: los mismos que usa la terminal real. */
function termTheme(p: ReturnType<typeof useSettings>): { background: string; foreground: string; cursor: string; blue: string; green: string; brightBlack: string } {
  const dark = p.dark
  return dark
    ? { background: '#12141a', foreground: '#c9cdd6', cursor: '#8ab4ff', blue: '#8ab4ff', green: '#5fd4a6', brightBlack: '#6f7480' }
    : { background: '#ffffff', foreground: '#1f2430', cursor: '#2f6fe0', blue: '#2f6fe0', green: '#1a7f57', brightBlack: '#6b7280' }
}
