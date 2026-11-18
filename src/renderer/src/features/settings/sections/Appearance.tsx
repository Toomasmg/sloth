import { useSettings } from '../store'
import { ACCENTS, DENSITIES, UI_FONT, type AccentChoice, type Density, type ThemeChoice } from '../../../../../shared/settings-model'
import { Group, Row, Slider, ToggleRow, useSave, SectionHint } from '../ui'
import { Segmented } from '../../../ui'
/* ---------- Apariencia ---------- */

const TH: { id: ThemeChoice; name: string; bg: string; side: string; line: string }[] = [
  { id: 'oscuro', name: 'Oscuro', bg: '#0c0e13', side: '#111319', line: '#2a2f3b' },
  { id: 'noche', name: 'Más oscuro', bg: '#050608', side: '#0a0b0e', line: '#1f232c' },
  { id: 'claro', name: 'Claro', bg: '#f6f6f4', side: '#ededea', line: '#e2e2dd' },
  { id: 'sistema', name: 'Según Windows', bg: 'linear-gradient(135deg, #0c0e13 50%, #f6f6f4 50%)', side: '#1a1d26', line: '#3a4152' }
]

const ACCENT_HEX: Record<AccentChoice, { name: string; hex: string }> = {
  cielo: { name: 'Cielo', hex: '#8ab4ff' },
  hoja: { name: 'Hoja', hex: '#5fd4a6' },
  lila: { name: 'Lila', hex: '#b59cff' },
  ambar: { name: 'Ámbar', hex: '#f0b45a' }
}

export function AppearanceSection(): React.JSX.Element {
  const p = useSettings()
  const s = p.settings
  const save = useSave()
  const accent = ACCENT_HEX[s.accent].hex
  return (
    <>
      <section className="f-set-group" aria-labelledby="a-te">
        <h2 id="a-te" className="f-set-group-h">
          Tema
        </h2>
        <div className="f-set-themes" role="radiogroup" aria-labelledby="a-te">
          {TH.map((t) => {
            const on = s.theme === t.id
            return (
              <button key={t.id} type="button" role="radio" aria-checked={on} className={`f-set-theme ${on ? 'on' : ''}`} onClick={() => save({ theme: t.id })}>
                <span className="f-set-pv" style={{ background: t.bg }}>
                  <span className="f-set-pv-side" style={{ background: t.side }} />
                  <span className="f-set-pv-main">
                    <i style={{ background: t.id === 'claro' ? ACCENT_HEX[s.accent].hex : accent, width: '60%' }} />
                    <i style={{ background: t.line, width: '80%' }} />
                    <i style={{ background: t.line, width: '50%' }} />
                  </span>
                </span>
                <span className="f-set-theme-name">{t.name}</span>
              </button>
            )
          })}
        </div>
        {s.theme === 'sistema' && <SectionHint>Sigue a Windows: ahora está en {p.dark ? 'oscuro' : 'claro'}.</SectionHint>}
      </section>

      <Group id="g-ac" title="Color de acento">
        <div className="f-set-accents" role="radiogroup" aria-label="Color de acento">
          {ACCENTS.map((a) => {
            const on = s.accent === a
            return (
              <button key={a} type="button" role="radio" aria-checked={on} className={`f-set-accent ${on ? 'on' : ''}`} onClick={() => save({ accent: a })}>
                <span className="f-set-accent-dot" style={{ background: ACCENT_HEX[a].hex, boxShadow: on ? `0 0 0 2px var(--raised), 0 0 0 4px ${ACCENT_HEX[a].hex}` : undefined }} aria-hidden="true" />
                {ACCENT_HEX[a].name}
              </button>
            )
          })}
        </div>
      </Group>

      <Group id="g-de" title="Densidad y tamaño">
        <Row title="Densidad de las listas">
          <Segmented<Density>
            aria-label="Densidad"
            value={s.density}
            options={DENSITIES.map((d) => ({ value: d, label: d === 'cómoda' ? 'Cómoda' : 'Compacta' })).reverse()}
            onChange={(density) => save({ density })}
          />
        </Row>
        <Row title={<label htmlFor="f-set-uifont">Tamaño del texto de la interfaz</label>}>
          <Slider
            id="f-set-uifont"
            label="Tamaño del texto"
            value={s.uiFontSize}
            min={UI_FONT.min}
            max={UI_FONT.max}
            format={(v) => `${v} px`}
            onChange={(uiFontSize) => save({ uiFontSize })}
          />
        </Row>
        <div className="f-set-preview" style={{ fontSize: `${s.uiFontSize}px` }}>
          Así se ve el texto: «Front · filtros de tickets» está trabajando.
        </div>
      </Group>

      <Group id="g-lite" title="Rendimiento">
        <ToggleRow
          title="Modo liviano"
          hint="Para PCs con pocos recursos: menos efectos y menos trabajo en segundo plano."
          checked={s.lightMode}
          onChange={(lightMode) => save({ lightMode })}
        />
      </Group>
    </>
  )
}
