import { useEffect, useRef, useState } from 'react'
import {
  ArrowCircleUp,
  ArrowCounterClockwise,
  Check,
  CircleHalf,
  DownloadSimple,
  Keyboard,
  Moon,
  Palette,
  SlidersHorizontal,
  Sun,
  TerminalWindow,
  UploadSimple,
  UserCircle,
  UsersThree,
  X
} from '@phosphor-icons/react'
import { useUi } from '../host'
import { openAbout } from '../updater/bus'
import { request as requestExportImport } from '../export-import/bus'
import {
  ACCOUNT_PALETTE,
  CURSORS,
  DENSITIES,
  LINE_HEIGHT,
  TERM_FONT,
  TERM_FONTS,
  THEMES,
  UI_FONT,
  type SettingsSection
} from '../../../../main/features/settings-model'
import { accountColor } from '../../format'
import { SHORTCUTS } from '../../shortcuts'
import { ChatSettings } from '../chat/ChatSettings'
import type { SettingsTab } from './bus'
import { resetSettings, termOptions, updateSettings, useSettings } from './store'

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: 'apariencia', label: 'Apariencia', icon: <Palette size={16} aria-hidden="true" /> },
  { id: 'terminal', label: 'Terminal', icon: <TerminalWindow size={16} aria-hidden="true" /> },
  { id: 'cuentas', label: 'Cuentas', icon: <UserCircle size={16} aria-hidden="true" /> },
  { id: 'comportamiento', label: 'Comportamiento', icon: <SlidersHorizontal size={16} aria-hidden="true" /> },
  { id: 'atajos', label: 'Atajos', icon: <Keyboard size={16} aria-hidden="true" /> },
  { id: 'datos', label: 'Equipo y datos', icon: <UsersThree size={16} aria-hidden="true" /> }
]

const errText = (e: unknown): string =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/* ---------- Controles ---------- */

function Segmented<T extends string>({
  label,
  name,
  value,
  options,
  onChange
}: {
  label: string
  name: string
  value: T
  options: readonly { value: T; label: string; icon?: React.ReactNode }[]
  onChange(v: T): void
}): React.JSX.Element {
  return (
    <div className="f-settings-row">
      <span className="f-settings-label" id={`f-settings-${name}`}>
        {label}
      </span>
      <div className="f-settings-seg" role="radiogroup" aria-labelledby={`f-settings-${name}`}>
        {options.map((o) => (
          <label key={o.value} className={`f-settings-seg-opt ${o.value === value ? 'on' : ''}`}>
            <input type="radio" className="sr-only" name={name} checked={o.value === value} onChange={() => onChange(o.value)} />
            <span className="f-settings-seg-face">
              {o.icon}
              {o.label}
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}

function Range({
  label,
  id,
  value,
  min,
  max,
  step = 1,
  format,
  onChange
}: {
  label: string
  id: string
  value: number
  min: number
  max: number
  step?: number
  format(v: number): string
  onChange(v: number): void
}): React.JSX.Element {
  return (
    <div className="f-settings-row">
      <label className="f-settings-label" htmlFor={id}>
        {label}
      </label>
      <div className="f-settings-range">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-valuetext={format(value)}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <output htmlFor={id} className="mono">
          {format(value)}
        </output>
      </div>
    </div>
  )
}

function Switch({
  label,
  sub,
  checked,
  disabled,
  onChange
}: {
  label: string
  sub?: string
  checked: boolean
  disabled?: boolean
  onChange(v: boolean): void
}): React.JSX.Element {
  return (
    <label className={`switch f-settings-switch ${disabled ? 'disabled' : ''}`}>
      <span className="switch-text">
        {label}
        {sub && <span className="hint f-settings-sub">{sub}</span>}
      </span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden="true" />
    </label>
  )
}

function SectionHead({ title, lead, reset }: { title: string; lead: string; reset?: SettingsSection }): React.JSX.Element {
  const [err, setErr] = useState<string | null>(null)
  return (
    <header className="f-settings-sec-head">
      <div className="grow-min">
        <h3>{title}</h3>
        <p className="hint">{lead}</p>
        {err && (
          <p className="form-error" role="alert">
            {err}
          </p>
        )}
      </div>
      {reset && (
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            setErr(null)
            resetSettings(reset).catch((e) => setErr(errText(e)))
          }}
        >
          <ArrowCounterClockwise size={14} aria-hidden="true" /> Restaurar valores por defecto
        </button>
      )}
    </header>
  )
}

/* ---------- Secciones ---------- */

function useSave(): [string | null, (p: Parameters<typeof updateSettings>[0]) => void] {
  const [err, setErr] = useState<string | null>(null)
  return [
    err,
    (p) => {
      setErr(null)
      updateSettings(p).catch((e) => setErr(errText(e)))
    }
  ]
}

function SaveError({ err }: { err: string | null }): React.JSX.Element | null {
  return err ? (
    <p className="form-error" role="alert">
      {err}
    </p>
  ) : null
}

function Appearance(): React.JSX.Element {
  const { settings: s, dark } = useSettings()
  const [err, save] = useSave()
  return (
    <>
      <SectionHead title="Apariencia" lead="Se aplica al instante en toda la app." reset="apariencia" />
      <Segmented
        label="Tema"
        name="theme"
        value={s.theme}
        onChange={(theme) => save({ theme })}
        options={THEMES.map((t) => ({
          value: t,
          label: cap(t),
          icon: t === 'oscuro' ? <Moon size={14} aria-hidden="true" /> : t === 'claro' ? <Sun size={14} aria-hidden="true" /> : <CircleHalf size={14} aria-hidden="true" />
        }))}
      />
      {s.theme === 'sistema' && <p className="hint f-settings-note">Sigue a Windows: ahora está en {dark ? 'oscuro' : 'claro'}.</p>}
      <Segmented
        label="Densidad"
        name="density"
        value={s.density}
        onChange={(density) => save({ density })}
        options={DENSITIES.map((d) => ({ value: d, label: cap(d) }))}
      />
      <Range
        label="Tamaño de letra"
        id="f-settings-uifont"
        value={s.uiFontSize}
        min={UI_FONT.min}
        max={UI_FONT.max}
        format={(v) => `${v} px`}
        onChange={(uiFontSize) => save({ uiFontSize })}
      />
      <SaveError err={err} />

      <div className="f-settings-preview" aria-label="Vista previa" role="img">
        <div className="f-settings-pv-side">
          <div className="f-settings-pv-ws on">
            <span className="acc-dot" aria-hidden="true" />
            <span className="grow-min">
              <span className="f-settings-pv-title">cosmos-front</span>
              <span className="f-settings-pv-sub">Trabajo · feat/filtros</span>
            </span>
          </div>
          <div className="f-settings-pv-ws">
            <span className="acc-dot" style={{ '--acc': accountColor(1) } as React.CSSProperties} aria-hidden="true" />
            <span className="grow-min">
              <span className="f-settings-pv-title">sloth</span>
              <span className="f-settings-pv-sub">Personal · main</span>
            </span>
          </div>
        </div>
        <div className="f-settings-pv-pane">
          <div className="f-settings-pv-head">
            <span className="f-settings-pv-title">cosmos-front</span>
            <span className="tag">TCK-1234</span>
            <span className="spacer" />
            <span className="pill pill-working">Trabajando</span>
          </div>
          <div className="f-settings-pv-body">
            <p>Claude quiere correr los tests.</p>
            <div className="btn-group">
              <span className="btn sm primary">Permitir</span>
              <span className="btn sm">Denegar</span>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function TerminalSection(): React.JSX.Element {
  const p = useSettings()
  const t = p.settings.terminal
  const [err, save] = useSave()
  const o = termOptions(p)
  const th = o.theme
  return (
    <>
      <SectionHead title="Terminal" lead="Cambia las terminales abiertas sin reiniciarlas." reset="terminal" />
      <Segmented
        label="Fuente"
        name="tfont"
        value={t.fontFamily}
        onChange={(fontFamily) => save({ terminal: { fontFamily } })}
        options={TERM_FONTS.map((f) => ({ value: f, label: f }))}
      />
      <Range
        label="Tamaño"
        id="f-settings-tsize"
        value={t.fontSize}
        min={TERM_FONT.min}
        max={TERM_FONT.max}
        format={(v) => `${v} px`}
        onChange={(fontSize) => save({ terminal: { fontSize } })}
      />
      <Range
        label="Altura de línea"
        id="f-settings-tline"
        value={t.lineHeight}
        min={LINE_HEIGHT.min}
        max={LINE_HEIGHT.max}
        step={LINE_HEIGHT.step}
        format={(v) => v.toFixed(2).replace('.', ',')}
        onChange={(v) => save({ terminal: { lineHeight: Math.round(v * 100) / 100 } })}
      />
      <Segmented
        label="Cursor"
        name="tcursor"
        value={t.cursorStyle}
        onChange={(cursorStyle) => save({ terminal: { cursorStyle } })}
        options={CURSORS.map((c) => ({ value: c, label: cap(c) }))}
      />
      <Switch label="Cursor que parpadea" checked={t.cursorBlink} onChange={(cursorBlink) => save({ terminal: { cursorBlink } })} />
      <SaveError err={err} />

      <pre
        className="f-settings-term"
        aria-label="Vista previa de la terminal"
        style={{ fontFamily: o.fontFamily, fontSize: o.fontSize, lineHeight: o.lineHeight, background: th.background, color: th.foreground }}
      >
        <span style={{ color: th.cyan }}>PS C:\repos\cosmos&gt;</span> claude{'\n'}
        <span style={{ color: th.green }}>●</span> Voy a correr los tests del componente.{'\n'}
        {'  '}
        <span style={{ color: th.brightBlack }}>Bash(npm run test -- Ticket.test.tsx)</span>
        {'\n'}
        {'  '}
        <span style={{ color: th.green }}>✓ 12 pasaron</span> <span style={{ color: th.red }}>✗ 1 falló</span>{' '}
        <span style={{ color: th.yellow }}>⚠ 2 avisos</span>
        {'\n'}
        <span style={{ color: th.blue }}>&gt;</span>{' '}
        <span
          className={`f-settings-cursor ${t.cursorStyle} ${t.cursorBlink ? 'blink' : ''}`}
          style={{ '--cur': th.cursor } as React.CSSProperties}
          aria-hidden="true"
        >
          {' '}
        </span>
      </pre>
    </>
  )
}

function Accounts(): React.JSX.Element {
  const ui = useUi()
  const { settings: s } = useSettings()
  const [err, save] = useSave()
  return (
    <>
      <SectionHead title="Cuentas" lead="El color de cada cuenta en el sidebar, los paneles y los tableros." reset="cuentas" />
      {ui.accounts.length === 0 && <p className="hint">Todavía no agregaste cuentas.</p>}
      <ul className="f-settings-accs">
        {ui.accounts.map((acc, i) => {
          const custom = s.accountColors[acc.id]
          const current = custom ?? accountColor(i)
          const name = custom ? ACCOUNT_PALETTE.find((c) => c.hex === custom)?.name ?? custom : 'Automático'
          const gid = `f-settings-acc-${acc.id}`
          return (
            <li key={acc.id} className="f-settings-acc" style={{ '--acc': current } as React.CSSProperties}>
              <div className="f-settings-acc-top">
                <span className="acc-chip" aria-hidden="true">
                  {acc.label.slice(0, 1).toUpperCase()}
                </span>
                <span className="grow-min">
                  <span className="item-title" id={gid}>
                    {acc.label}
                  </span>
                  <span className="item-sub">{ui.statuses[acc.id]?.email ?? 'Sin sesión'}</span>
                </span>
                <span className="f-settings-acc-name">{name}</span>
              </div>
              <div className="f-settings-swatches" role="radiogroup" aria-labelledby={gid}>
                <label className={`f-settings-sw auto ${!custom ? 'on' : ''}`} title="Automático">
                  <input type="radio" className="sr-only" name={gid} checked={!custom} onChange={() => save({ accountColors: { [acc.id]: null } })} aria-label="Automático" />
                  <span style={{ '--sw': accountColor(i) } as React.CSSProperties}>{!custom ? <Check size={12} weight="bold" aria-hidden="true" /> : 'A'}</span>
                </label>
                {ACCOUNT_PALETTE.map((c) => (
                  <label key={c.hex} className={`f-settings-sw ${custom === c.hex ? 'on' : ''}`} title={c.name}>
                    <input
                      type="radio"
                      className="sr-only"
                      name={gid}
                      checked={custom === c.hex}
                      onChange={() => save({ accountColors: { [acc.id]: c.hex } })}
                      aria-label={c.name}
                    />
                    <span style={{ '--sw': c.hex } as React.CSSProperties}>{custom === c.hex && <Check size={12} weight="bold" aria-hidden="true" />}</span>
                  </label>
                ))}
              </div>
            </li>
          )
        })}
      </ul>
      <SaveError err={err} />
    </>
  )
}

function Behavior(): React.JSX.Element {
  const ui = useUi()
  const { settings: s, loginItemSupported } = useSettings()
  const [err, save] = useSave()
  const [tray, setTray] = useState<boolean | null>(null)
  const [trayErr, setTrayErr] = useState<string | null>(null)
  useEffect(() => {
    ui.invoke<{ closeToTray: boolean }>('feat:tray:get').then(
      (t) => setTray(t.closeToTray),
      () => setTray(null)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const toggleTray = async (v: boolean): Promise<void> => {
    setTray(v)
    setTrayErr(null)
    try {
      setTray((await ui.invoke<{ closeToTray: boolean }>('feat:tray:set', { closeToTray: v })).closeToTray)
    } catch (e) {
      setTray(!v)
      setTrayErr(errText(e))
    }
  }
  return (
    <>
      <SectionHead title="Comportamiento" lead="Cómo arranca y se cierra Sloth." reset="comportamiento" />
      <div className="f-settings-list">
        <Switch
          label="Abrir Sloth al iniciar Windows"
          sub={loginItemSupported ? 'Se abre solo cuando iniciás sesión en Windows.' : 'Solo en la app instalada (esta es una versión de desarrollo).'}
          checked={s.openAtLogin}
          disabled={!loginItemSupported}
          onChange={(openAtLogin) => save({ openAtLogin })}
        />
        <Switch
          label="Confirmar al cerrar paneles con agentes trabajando"
          sub="Pregunta antes de ocultar o reiniciar un panel mientras Claude está trabajando."
          checked={s.confirmClosePanes}
          onChange={(confirmClosePanes) => save({ confirmClosePanes })}
        />
        <Switch
          label="Al cerrar, seguir en la bandeja"
          sub={tray === null ? 'No disponible.' : 'La ventana se oculta y Sloth sigue avisándote desde la bandeja.'}
          checked={tray === true}
          disabled={tray === null}
          onChange={(v) => void toggleTray(v)}
        />
      </div>
      <SaveError err={err ?? trayErr} />
    </>
  )
}


function Shortcuts(): React.JSX.Element {
  return (
    <>
      <SectionHead title="Atajos" lead="Solo lectura por ahora: más adelante se van a poder cambiar." />
      <dl className="f-settings-keys">
        {SHORTCUTS.map((s) => (
          <div key={s.what}>
            <dt>
              {s.keys.map((combo, i) => (
                <span key={i} className="f-settings-combo">
                  {combo.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </span>
              ))}
            </dt>
            <dd>{s.what}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}

function Data({ onClose }: { onClose(): void }): React.JSX.Element {
  const go = (fn: () => void) => () => {
    onClose()
    // Después de que se desmonte este modal, para que el otro tome el foco.
    requestAnimationFrame(fn)
  }
  return (
    <>
      <SectionHead title="Equipo y datos" lead="Llevá tu configuración a otra PC y mantené Sloth al día." />
      <div className="f-settings-actions">
        <button type="button" className="f-settings-action" onClick={go(() => requestExportImport({ kind: 'export' }))}>
          <UploadSimple size={18} aria-hidden="true" />
          <span className="grow-min">
            <strong>Exportar configuración</strong>
            <span className="hint">Cuentas, espacios y plantillas a un JSON (sin sesiones ni credenciales).</span>
          </span>
        </button>
        <button type="button" className="f-settings-action" onClick={go(() => requestExportImport({ kind: 'import' }))}>
          <DownloadSimple size={18} aria-hidden="true" />
          <span className="grow-min">
            <strong>Importar configuración</strong>
            <span className="hint">Desde un JSON exportado en otra PC; antes te muestra qué va a agregar.</span>
          </span>
        </button>
        <button type="button" className="f-settings-action" onClick={go(openAbout)}>
          <ArrowCircleUp size={18} aria-hidden="true" />
          <span className="grow-min">
            <strong>Actualizaciones y versión</strong>
            <span className="hint">Abre «Acerca de Sloth»: versión instalada y búsqueda de actualizaciones.</span>
          </span>
        </button>
      </div>
      <ChatSettings />
      <p className="hint f-settings-note">
        La configuración se guarda en <span className="mono">%APPDATA%\Sloth\features\settings.json</span>.
      </p>
    </>
  )
}

/* ---------- Modal ---------- */

export function SettingsModal({ initialTab, onClose }: { initialTab: SettingsTab; onClose(): void }): React.JSX.Element {
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const dialogRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  useEffect(() => setTab(initialTab), [initialTab])
  useEffect(() => {
    tabRefs.current[tab]?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Escape cierra; Tab queda dentro del modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const f = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(
        (el) => el.offsetParent !== null || el.classList.contains('sr-only')
      )
      if (!f.length) return
      const first = f[0]
      const last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onTabKey = (e: React.KeyboardEvent): void => {
    const i = TABS.findIndex((t) => t.id === tab)
    let n = -1
    if (e.key === 'ArrowDown') n = (i + 1) % TABS.length
    else if (e.key === 'ArrowUp') n = (i - 1 + TABS.length) % TABS.length
    else if (e.key === 'Home') n = 0
    else if (e.key === 'End') n = TABS.length - 1
    if (n < 0) return
    e.preventDefault()
    setTab(TABS[n].id)
    tabRefs.current[TABS[n].id]?.focus()
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal f-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="f-settings-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2 id="f-settings-title">Configuración</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar configuración">
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="f-settings-body">
          <nav className="f-settings-nav" role="tablist" aria-orientation="vertical" aria-label="Secciones" onKeyDown={onTabKey}>
            {TABS.map((t) => (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[t.id] = el
                }}
                type="button"
                role="tab"
                id={`f-settings-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="f-settings-panel"
                tabIndex={tab === t.id ? 0 : -1}
                className={`f-settings-tab ${tab === t.id ? 'on' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </nav>
          <section className="f-settings-panel" id="f-settings-panel" role="tabpanel" aria-labelledby={`f-settings-tab-${tab}`} tabIndex={-1}>
            {tab === 'apariencia' && <Appearance />}
            {tab === 'terminal' && <TerminalSection />}
            {tab === 'cuentas' && <Accounts />}
            {tab === 'comportamiento' && <Behavior />}
            {tab === 'atajos' && <Shortcuts />}
            {tab === 'datos' && <Data onClose={onClose} />}
          </section>
        </div>
      </div>
    </div>
  )
}
