import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from '../../api'
import { useUi } from '../host'
import { AddAccountIcon, MoreIcon, TeamIcon, UpdateIcon } from '../../icons/SlothIcons'
import { fmtTok, totalTok, usageTitle } from '../../format'
import { LogoMark } from '../../Logo'
import { loginPaneId, type Account } from '../../../../shared/types'
import type { ChatConfigView, ChatSnapshot } from '../../../../shared/chat'
import { SHORTCUT_ACTIONS, bindingOf, comboFromEvent, findConflict, keyTokenOf, setShortcutCapture, type ShortcutAction } from '../../shortcuts'
import { openReport } from '../report/bus'
import { request as requestExportImport } from '../export-import/bus'
import { openHelp } from '../help/bus'
import { setPhase } from '../updater/phase'
import { useUpdateDot } from '../updater/useUpdateStatus'
import { SoundTest } from '../sound/SoundTest'
import { resolveAccountColor, pickProjectsDir, projectsDirOf, useSettings } from './store'
import { errText, Group, Row, Seg, Slider, ToggleRow, useSave, SectionHint } from './ui'
import { ACCENTS, ACCOUNT_PALETTE, DENSITIES, EDITORS, LINE_HEIGHT, PLAN_SUGGESTIONS, SCROLLBACK, SHELLS, TERM_FONTS, TERM_FONT, UI_FONT, UPDATE_CHANNELS, type AccentChoice, type CursorShape, type Density, type EditorChoice, type ShellChoice, type ShortcutId, type SoundName, type TermFont, type ThemeChoice, type UpdateChannel } from '../../../../main/features/settings-model'

/* ---------- General ---------- */

interface TrayState {
  closeToTray: boolean
}

export function GeneralSection(): React.JSX.Element {
  const ui = useUi()
  const p = useSettings()
  const s = p.settings
  const save = useSave()
  const [tray, setTray] = useState<boolean | null>(null)
  useEffect(() => {
    ui.invoke<TrayState>('feat:tray:get').then(
      (t) => setTray(t.closeToTray),
      () => setTray(null)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const toggleTray = (v: boolean): void => {
    save(async () => {
      const r = await ui.invoke<TrayState>('feat:tray:set', { closeToTray: v })
      setTray(r.closeToTray)
    })
  }
  return (
    <>
      <Group id="g-al" title="Al abrir y cerrar Sloth">
        <ToggleRow
          title="Reabrir los espacios de la última vez"
          hint="Vuelven con la misma distribución y la misma cuenta."
          checked={s.reopenSpaces}
          onChange={(reopenSpaces) => save({ reopenSpaces })}
        />
        <ToggleRow
          title="Dejar las terminales vivas al cerrar la ventana"
          hint="Claude sigue trabajando en segundo plano; usa muy poca memoria."
          checked={s.keepTerminalsAlive}
          onChange={(keepTerminalsAlive) => save({ keepTerminalsAlive })}
        />
        <ToggleRow
          title="Abrir Sloth al iniciar Windows"
          hint={p.loginItemSupported ? 'Arranca minimizado en la bandeja del sistema.' : 'Solo en la app instalada (esta es una versión de desarrollo).'}
          checked={s.openAtLogin}
          disabled={!p.loginItemSupported}
          onChange={(openAtLogin) => save({ openAtLogin })}
        />
        <ToggleRow
          title="Al cerrar, seguir en la bandeja"
          hint={tray === null ? 'No disponible.' : 'La ventana se oculta y Sloth sigue avisándote desde la bandeja.'}
          checked={tray === true}
          disabled={tray === null}
          onChange={toggleTray}
        />
        <ToggleRow
          title="Confirmar al cerrar paneles con Claude trabajando"
          hint="Pregunta antes de ocultar o reiniciar un panel mientras Claude está trabajando."
          checked={s.confirmClosePanes}
          onChange={(confirmClosePanes) => save({ confirmClosePanes })}
        />
      </Group>
      <Group id="g-ed" title="Carpetas y editor">
        <Row title={<>Editor para «Abrir en editor»</>} hint="Se usa desde el menú de cada espacio." htmlFor="f-set-editor">
          <select id="f-set-editor" className="f-set-select" value={s.editor} onChange={(e) => save({ editor: e.target.value as EditorChoice })}>
            {EDITORS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Carpeta de proyectos" hint={<span className="mono">{projectsDirOf(p)}</span>}>
          <button type="button" className="btn sm" onClick={() => save(() => pickProjectsDir())}>
            Cambiar…
          </button>
        </Row>
      </Group>
    </>
  )
}

/* ---------- Cuentas ---------- */

const ACC_COLORS = ACCOUNT_PALETTE

export function AccountsSection({ onClose }: { onClose(): void }): React.JSX.Element {
  const ui = useUi()
  const p = useSettings()
  const save = useSave()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [nameErr, setNameErr] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)
  /** Fila con el menú «más» abierto (usar mi setup, quitar). */
  const [menu, setMenu] = useState<string | null>(null)

  /** «Usar mi setup de ~/.claude» de una cuenta: guarda y recarga la lista. */
  const toggleShare = (acc: Account): void => {
    save(async () => {
      await api.setShareSetup(acc.id, acc.shareSetup === false)
      await ui.reload()
    })
  }

  const addAccount = (e: FormEvent): void => {
    e.preventDefault()
    const n = name.trim()
    if (!n) {
      setNameErr(true)
      return
    }
    setNameErr(false)
    save(async () => {
      const acc: Account = await api.addAccount(n)
      await ui.reload()
      setAdding(false)
      setName('')
      onClose()
      ui.openPane(loginPaneId(acc.id))
    })
  }

  const remove = (id: string): void => {
    save(async () => {
      await api.removeAccount(id)
      setConfirm(null)
      await ui.reload()
      ui.closePane(loginPaneId(id))
    })
  }

  return (
    <>
      <div className="f-set-toolbar">
        <button type="button" className="btn primary sm" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
          <AddAccountIcon size={14} /> Agregar cuenta
        </button>
      </div>
      {adding && (
        <form className="f-set-card f-set-form" onSubmit={addAccount} noValidate>
          <div className="f-set-form-title">Nueva cuenta de Claude</div>
          <label className="f-set-stack">
            <span className="f-set-hint">Nombre para reconocerla</span>
            <input className="f-set-input" value={name} placeholder="Ej.: Cosmos de Mateo" onChange={(e) => setName(e.target.value)} aria-invalid={nameErr} />
          </label>
          {nameErr && (
            <p role="alert" className="form-error">
              Poné un nombre para la cuenta.
            </p>
          )}
          <div className="f-set-actions">
            <span className="f-set-hint grow">Después vas a iniciar sesión en el navegador. Sloth no guarda contraseñas.</span>
            <button type="button" className="btn ghost sm" onClick={() => setAdding(false)}>
              Cancelar
            </button>
            <button type="submit" className="btn primary sm">
              Agregar
            </button>
          </div>
        </form>
      )}

      <datalist id="f-set-plan-list">
        {PLAN_SUGGESTIONS.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
      <Group id="g-cuentas" title={`Tus cuentas · ${ui.accounts.length}`}>
        {ui.accounts.length === 0 && <p className="f-set-row f-set-hint">Todavía no agregaste cuentas.</p>}
        {ui.accounts.map((a, i) => {
          const st = ui.statuses[a.id]
          const logged = !!st?.loggedIn
          const color = resolveAccountColor(a.id, i, p)
          const custom = p.settings.accountColors[a.id]
          const spaces = ui.workspaces.filter((w) => w.accountId === a.id).length
          const busy = confirm === a.id
          const u = ui.usage[a.id]
          return (
            <div key={a.id} className="f-set-acc" style={{ '--acc': color } as React.CSSProperties}>
              <div className="f-set-row">
                <span className="f-set-avatar" aria-hidden="true">
                  {a.label.slice(0, 1).toUpperCase()}
                </span>
                <div className="f-set-row-text">
                  <span className="f-set-row-title">{a.label}</span>
                  <span className="f-set-hint">
                    {spaces === 1 ? '1 espacio' : `${spaces} espacios`}
                    {logged && st?.email ? ` · ${st.email}` : ''}
                  </span>
                  {u && (
                    <dl className="sl-usage" title={usageTitle(u)}>
                      <div>
                        <dt>5 h</dt>
                        <dd>{fmtTok(totalTok(u.last5h))}</dd>
                      </div>
                      <div>
                        <dt>Hoy</dt>
                        <dd>{fmtTok(totalTok(u.today))}</dd>
                      </div>
                      <div>
                        <dt>7 días</dt>
                        <dd>{fmtTok(totalTok(u.last7d))}</dd>
                      </div>
                    </dl>
                  )}
                </div>
                <PlanField key={`${a.id}-${p.settings.accountPlans[a.id] ?? ''}`} label={a.label} value={p.settings.accountPlans[a.id] ?? ''} onCommit={(plan) => save({ accountPlans: { [a.id]: plan || null } })} />
                <span className={`f-set-state ${logged ? 'ok' : 'warn'}`}>
                  <span className="f-set-dot" aria-hidden="true" />
                  {logged ? 'Sesión iniciada' : 'Hay que iniciar sesión'}
                </span>
                <div className="f-set-row-ctl">
                  {busy ? (
                    <>
                      <button type="button" className="btn sm" onClick={() => setConfirm(null)}>
                        Cancelar
                      </button>
                      <button type="button" className="btn sm danger" onClick={() => remove(a.id)}>
                        Sí, quitar
                      </button>
                    </>
                  ) : (
                    <>
                      {logged ? (
                        <button
                          type="button"
                          className="btn sm"
                          aria-label={`Abrir terminal de ${a.label}`}
                          onClick={() => {
                            onClose()
                            ui.openPane(loginPaneId(a.id))
                          }}
                        >
                          Terminal
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn primary sm"
                          onClick={() => {
                            onClose()
                            ui.openPane(loginPaneId(a.id))
                          }}
                        >
                          Iniciar sesión
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn ghost sm icon-only"
                        aria-haspopup="menu"
                        aria-expanded={menu === a.id}
                        aria-label={`Más acciones de ${a.label}`}
                        title="Más"
                        onClick={() => setMenu(menu === a.id ? null : a.id)}
                      >
                        <MoreIcon size={15} aria-hidden="true" />
                      </button>
                    </>
                  )}
                </div>
              </div>
              {menu === a.id && !busy && (
                <div className="f-set-acc-menu" role="menu" aria-label={`Acciones de ${a.label}`}>
                  <label className="switch" role="menuitem" title="Enlaza tus skills, agents, hooks, plugins, settings y MCP de ~/.claude">
                    <span className="switch-text">
                      Usar mi setup de <span className="mono">~/.claude</span>
                    </span>
                    <input type="checkbox" role="switch" checked={a.shareSetup !== false} onChange={() => toggleShare(a)} />
                    <span className="switch-track" aria-hidden="true" />
                  </label>
                  <button
                    type="button"
                    role="menuitem"
                    className="btn sm danger"
                    onClick={() => {
                      setMenu(null)
                      setConfirm(a.id)
                    }}
                  >
                    Quitar cuenta
                  </button>
                </div>
              )}
              <AccountSwatches acc={a} index={i} custom={custom} onPick={(hex) => save({ accountColors: { [a.id]: hex } })} onAuto={() => save({ accountColors: { [a.id]: null } })} />
            </div>
          )
        })}
      </Group>
      <SectionHint>Sloth nunca lee tus contraseñas ni tus tokens. Para pasar un espacio a otra cuenta usá «Mover a otra cuenta» en el menú del espacio.</SectionHint>
    </>
  )
}

/** Plan escrito a mano: etiqueta opcional, con sugerencias. Se guarda al salir del campo o al Enter. */
function PlanField({ label, value, onCommit }: { label: string; value: string; onCommit(plan: string): void }): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const commit = (): void => {
    const t = draft.trim()
    if (t !== value) onCommit(t)
  }
  return (
    <label className="f-set-plan">
      <span className="sr-only">Plan de {label}</span>
      <input
        className="f-set-input f-set-plan-input"
        list="f-set-plan-list"
        value={draft}
        maxLength={20}
        placeholder="Plan"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
      />
    </label>
  )
}

function AccountSwatches({
  acc,
  index,
  custom,
  onPick,
  onAuto
}: {
  acc: Account
  index: number
  custom: string | undefined
  onPick(hex: string): void
  onAuto(): void
}): React.JSX.Element {
  const gid = `f-set-sw-${acc.id}`
  return (
    <div className="f-set-swatches" role="radiogroup" aria-labelledby={gid}>
      <span id={gid} className="f-set-hint">
        Color
      </span>
      <button type="button" role="radio" aria-checked={!custom} aria-label="Automático" title="Automático" className={`f-set-sw ${!custom ? 'on' : ''}`} onClick={onAuto}>
        <span style={{ background: resolveAccountColor(acc.id, index) }} />
        <span className="sr-only">Automático</span>
      </button>
      {ACC_COLORS.map((c) => (
        <button key={c.hex} type="button" role="radio" aria-checked={custom === c.hex} aria-label={c.name} title={c.name} className={`f-set-sw ${custom === c.hex ? 'on' : ''}`} onClick={() => onPick(c.hex)}>
          <span style={{ background: c.hex }} />
        </button>
      ))}
    </div>
  )
}

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
                <span className="f-set-accent-dot" style={{ background: ACCENT_HEX[a].hex }} aria-hidden="true" />
                {ACCENT_HEX[a].name}
              </button>
            )
          })}
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

      <Group id="g-de" title="Densidad y tamaño">
        <Row title="Densidad de las listas">
          <Seg<Density>
            label="Densidad"
            value={s.density}
            options={DENSITIES.map((d) => ({ value: d, label: d === 'cómoda' ? 'Cómoda' : 'Compacta' })).reverse()}
            onPick={(density) => save({ density })}
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
    </>
  )
}

/* ---------- Terminal ---------- */

const CURSOR_LABEL: Record<CursorShape, string> = { bloque: 'Bloque', barra: 'Línea', subrayado: 'Subrayado' }
const CURSOR_ORDER: CursorShape[] = ['bloque', 'barra', 'subrayado']

export function TerminalSection(): React.JSX.Element {
  const p = useSettings()
  const t = p.settings.terminal
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
        style={{ fontFamily: `'${t.fontFamily}', 'JetBrains Mono', Consolas, monospace`, fontSize: `${t.fontSize}px`, lineHeight: t.lineHeight, background: th.background, color: th.foreground }}
      >
        <span style={{ color: th.brightBlack }}>~/Cosmos-Ai/front</span>
        {'\n'}
        <span style={{ color: th.blue }}>›</span> Corré los tests de la tabla{'\n'}
        <span style={{ color: th.green }}>●</span> PASS TicketTable.test.tsx (12){'\n'}
        <span style={{ color: th.blue }}>›</span>{' '}
        <span
          className={`f-set-cursor ${t.cursorBlink ? 'blink' : ''}`}
          style={{ display: 'inline-block', verticalAlign: 'text-bottom', width: cursor.w, height: cursor.h, background: t.cursorStyle === 'subrayado' ? 'transparent' : th.cursor, borderBottom: t.cursorStyle === 'subrayado' ? `2px solid ${th.cursor}` : undefined }}
          aria-hidden="true"
        />
      </pre>
      )}
      <Group id="g-term" title="Texto y cursor">
        <Row title={<label htmlFor="f-set-tfont">Fuente</label>}>
          <select id="f-set-tfont" className="f-set-select" value={t.fontFamily} onChange={(e) => save({ terminal: { fontFamily: e.target.value as TermFont } })}>
            {TERM_FONTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </Row>
        <Row title={<label htmlFor="f-set-tsize">Tamaño de letra</label>}>
          <Slider id="f-set-tsize" label="Tamaño de letra de la terminal" value={t.fontSize} min={TERM_FONT.min} max={TERM_FONT.max} format={(v) => `${v} px`} onChange={(fontSize) => save({ terminal: { fontSize } })} />
        </Row>
        <Row title={<label htmlFor="f-set-tline">Altura de línea</label>}>
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
          <Seg<CursorShape> label="Forma del cursor" value={t.cursorStyle} options={CURSOR_ORDER.map((c) => ({ value: c, label: CURSOR_LABEL[c] }))} onPick={(cursorStyle) => save({ terminal: { cursorStyle } })} />
        </Row>
        <ToggleRow title="Cursor que parpadea" checked={t.cursorBlink} onChange={(cursorBlink) => save({ terminal: { cursorBlink } })} />
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
          <select id="f-set-shell" className="f-set-select" value={t.shell} onChange={(e) => save({ terminal: { shell: e.target.value as ShellChoice } })}>
            {SHELLS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
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
              <span className="f-set-row-title grow">{a.name}</span>
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
                  {isCap ? label : label.split('+').map((k, i) => <kbd key={i}>{k}</kbd>)}
                </button>
                {changed && (
                  <button type="button" className="btn ghost sm" onClick={() => save({ shortcuts: { [a.id]: null } })}>
                    Restaurar
                  </button>
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
      <SectionHint>Tocá un atajo y apretá la combinación nueva. Ctrl o Alt son obligatorios, salvo en F1 a F12. Esc cancela. «Cambiar distribución» es fijo: 1 a 4 eligen la distribución.</SectionHint>
    </>
  )
}

/* ---------- Notificaciones y sonido ---------- */

const SOUND_OPTIONS: { value: SoundName | 'Sin sonido'; label: string }[] = [
  { value: 'Gota', label: 'Gota' },
  { value: 'Campana suave', label: 'Campana suave' },
  { value: 'Clic', label: 'Clic' },
  { value: 'Sin sonido', label: 'Sin sonido' }
]

export function NotificationsSection(): React.JSX.Element {
  const p = useSettings()
  const s = p.settings
  const save = useSave()
  const selected = s.sounds ? s.soundName : 'Sin sonido'
  return (
    <>
      <Group id="g-av" title="Avisarme cuando…">
        <ToggleRow title="Claude termina una tarea" hint="Aviso de Windows y el estado «Listo» en la barra." checked={s.notify.done} onChange={(done) => save({ notify: { done } })} />
        <ToggleRow title="Claude pide permiso" hint="Te recomendamos dejarlo prendido: si no, Claude queda esperando." checked={s.notify.perm} onChange={(perm) => save({ notify: { perm } })} />
        <ToggleRow title="Me escriben en el chat del equipo" hint="Mensajes directos y menciones." checked={s.notify.team} onChange={(team) => save({ notify: { team } })} />
        <ToggleRow title="No molestar" hint="Silencia todo hasta que lo apagues." checked={s.noMolestar} onChange={(noMolestar) => save({ noMolestar })} />
      </Group>
      {s.noMolestar && <SectionHint>«No molestar» está activo: no suena nada ni avisa.</SectionHint>}
      <Group id="g-so" title="Sonido">
        <Row title={<label htmlFor="f-set-sound">Sonido de aviso</label>} hint="Suena aunque la ventana esté en segundo plano.">
          <select
            id="f-set-sound"
            className="f-set-select"
            value={selected}
            onChange={(e) => {
              const v = e.target.value
              save(v === 'Sin sonido' ? { sounds: false } : { sounds: true, soundName: v as SoundName })
            }}
          >
            {SOUND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <SoundTest name={s.soundName} disabled={!s.sounds} />
        </Row>
      </Group>
    </>
  )
}

/* ---------- Equipo y chat ---------- */

export function TeamSection(): React.JSX.Element {
  const ui = useUi()
  const [snap, setSnap] = useState<ChatSnapshot | null>(null)
  const [cfg, setCfg] = useState<ChatConfigView | null>(null)
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const loadCfg = useCallback(
    () =>
      ui.invoke<ChatConfigView>('feat:chat:getConfig').then(
        (c) => {
          setCfg(c)
          setUrl((u) => u || c.active?.supabaseUrl || '')
        },
        (e) => setMsg({ ok: false, text: errText(e) })
      ),
    [ui]
  )
  const reloadState = useCallback(() => ui.invoke<ChatSnapshot>('feat:chat:state').then(setSnap, () => undefined), [ui])

  useEffect(() => {
    void loadCfg()
    void reloadState()
    return ui.on('feat:chat:snapshot', (s: ChatSnapshot) => setSnap(s))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const act = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
      if (ok) setMsg({ ok: true, text: ok })
      await loadCfg()
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    } finally {
      setBusy(false)
    }
  }

  const saveCfg = (e: FormEvent): void => {
    e.preventDefault()
    const supabaseUrl = url.trim()
    const anonKey = key.trim()
    if (!/^https:\/\//.test(supabaseUrl)) return setMsg({ ok: false, text: 'La URL tiene que empezar con https://.' })
    if (!anonKey) return setMsg({ ok: false, text: 'Falta la clave publicable.' })
    void act(async () => {
      await ui.invoke('feat:chat:setConfig', { supabaseUrl, anonKey })
      setKey('')
    }, 'Guardado.')
  }

  const auth = snap?.auth
  const conn = snap?.connection
  const host = (() => {
    try {
      return cfg?.active ? new URL(cfg.active.supabaseUrl).host : ''
    } catch {
      return ''
    }
  })()
  let title = 'Cargando…'
  let sub = ''
  let tone: 'ok' | 'warn' | 'err' | 'info' = 'info'
  if (snap && auth) {
    if (auth.status === 'unconfigured') {
      title = 'Sin configurar'
      sub = 'Pegá la URL y la clave del proyecto de Supabase para usar el chat.'
      tone = 'warn'
    } else if (auth.status === 'error') {
      title = 'Hay un problema con la conexión'
      sub = auth.message
      tone = 'err'
    } else if (auth.status === 'signedOut') {
      title = 'Falta iniciar sesión con GitHub'
      sub = 'Sin sesión no se puede usar el chat.'
      tone = 'warn'
    } else if (auth.status === 'signingIn') {
      title = 'Esperando GitHub…'
      sub = 'Terminá el inicio de sesión en el navegador.'
      tone = 'info'
    } else {
      const who = `sesión de ${auth.me.login}`
      sub = host ? `${host} · ${who}` : who
      if (conn === 'live') {
        title = 'Conectado al chat del equipo'
        tone = 'ok'
      } else if (conn === 'connecting') {
        title = 'Conectando…'
        tone = 'info'
      } else if (conn === 'retrying') {
        title = 'Reintentando la conexión…'
        tone = 'warn'
      } else {
        title = 'Sin conexión en vivo'
        tone = 'warn'
      }
    }
  }
  // Tokens del tema (oscuro y claro): cada par fondo/texto cumple contraste sobre la tarjeta.
  const toneColor = {
    ok: ['var(--success-soft)', 'var(--ok-fg)'],
    warn: ['var(--warn-soft)', 'var(--warn-fg)'],
    err: ['var(--danger-soft)', 'var(--danger-fg)'],
    info: ['var(--info-soft)', 'var(--info)']
  }[tone]
  const signedIn = auth?.status === 'signedIn'
  const signingIn = auth?.status === 'signingIn'
  const offered = cfg?.offered
  const repoName = offered?.repo.split(/[\\/]/).filter(Boolean).pop() ?? ''

  const gh = (fn: string, ok?: string): void => {
    void act(() => ui.invoke(fn), ok)
  }

  return (
    <>
      <div className="f-set-card f-set-status">
        <span className="f-set-status-ico" style={{ background: toneColor[0], color: toneColor[1] }} aria-hidden="true">
          <TeamIcon size={18} />
        </span>
        <div className="grow">
          <div className="f-set-row-title">{title}</div>
          <div className="f-set-hint">{sub}</div>
        </div>
        <button type="button" className="btn sm" onClick={() => void reloadState()}>
          Actualizar estado
        </button>
      </div>

      {offered && (
        <div className="f-set-card f-set-offer" role="group" aria-label="Configuración propuesta por el repo">
          <p>
            El repo <strong title={repoName}>{repoName}</strong> propone usar el chat en <strong>{new URL(offered.supabaseUrl).host}</strong>. ¿Usarlo?
          </p>
          <button type="button" className="btn primary sm" disabled={busy} onClick={() => void act(() => ui.invoke('feat:chat:acceptTeamConfig', offered.repo), 'Usando la configuración del repo.')}>
            Usar
          </button>
        </div>
      )}

      <form className="f-set-card f-set-form" onSubmit={saveCfg} noValidate>
        <label className="f-set-stack">
          <span className="f-set-hint">URL del proyecto de Supabase</span>
          <input className="f-set-input mono" type="url" value={url} placeholder="https://xxxx.supabase.co" autoComplete="off" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="f-set-stack">
          <span className="f-set-hint">Clave publicable (la que empieza con sb_publishable)</span>
          <span className="f-set-inline">
            <input
              className="f-set-input mono"
              type={showKey ? 'text' : 'password'}
              value={key}
              placeholder={cfg?.active ? `Actual: ${cfg.active.keyPreview}` : 'sb_publishable_…'}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setKey(e.target.value)}
            />
            <button type="button" className="btn sm" aria-pressed={showKey} onClick={() => setShowKey((v) => !v)}>
              {showKey ? 'Ocultar' : 'Mostrar'}
            </button>
          </span>
        </label>
        <p className="f-set-note warn">Nunca pegues acá la clave service_role: Sloth la rechaza porque daría acceso total a la base.</p>
        <div className="f-set-actions">
          {cfg?.active?.source === 'settings' && (
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void act(() => ui.invoke('feat:chat:setConfig', null), 'Configuración borrada.')}>
              Borrar configuración
            </button>
          )}
          <button type="submit" className="btn primary sm" disabled={busy || !url.trim() || !key.trim()}>
            Guardar
          </button>
        </div>
      </form>

      <div className="f-set-card f-set-row">
        <div className="f-set-row-text">
          <span className="f-set-row-title">Sesión de GitHub</span>
          <span className="f-set-hint">{signedIn ? `Conectado como ${auth.me.login}` : signingIn ? 'Esperando la respuesta del navegador' : 'No conectado · necesario para el chat'}</span>
        </div>
        <div className="f-set-row-ctl">
          {signingIn && (
            <button type="button" className="btn ghost sm" onClick={() => gh('feat:chat:cancelSignIn')}>
              Cancelar
            </button>
          )}
          {signedIn ? (
            <button type="button" className="btn sm" disabled={busy} onClick={() => gh('feat:chat:signOut', 'Sesión de GitHub cerrada.')}>
              Cerrar sesión
            </button>
          ) : (
            <button type="button" className="btn primary sm" disabled={busy || signingIn || auth?.status === 'unconfigured'} onClick={() => gh('feat:chat:signIn')}>
              Conectar con GitHub
            </button>
          )}
        </div>
      </div>

      {msg && (
        <p className={msg.ok ? 'f-set-ok' : 'form-error'} role={msg.ok ? 'status' : 'alert'}>
          {msg.text}
        </p>
      )}
    </>
  )
}

/* ---------- Actualizaciones ---------- */

interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  error?: string
  upToDate?: boolean
  enabled: boolean
  current: string
}

export function UpdatesSection(): React.JSX.Element {
  const ui = useUi()
  const p = useSettings()
  const save = useSave()
  const [st, setSt] = useState<UpdateStatus | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** «Más tarde» dejó una versión pendiente: mismo dato que el punto del engranaje. */
  const pendiente = useUpdateDot()

  useEffect(() => {
    ui.invoke<UpdateStatus>('feat:updater:status').then(setSt, () => undefined)
    return ui.on('feat:updater:status', (s: UpdateStatus) => setSt(s))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const check = (): void => {
    setBusy(true)
    setMsg(null)
    ui.invoke<UpdateStatus>('feat:updater:check').then(
      (s) => {
        setSt(s)
        setMsg(s.state === 'available' ? `Hay una versión nueva: ${s.version ?? ''}.` : s.upToDate ? 'Tenés la última versión.' : null)
      },
      (e) => setMsg(errText(e))
    ).finally(() => setBusy(false))
  }

  const busyNow = st?.state === 'checking' || st?.state === 'downloading'
  const title = !st
    ? 'Cargando…'
    : !st.enabled
      ? 'Las actualizaciones están apagadas en desarrollo'
      : st.state === 'checking'
        ? 'Buscando una versión nueva…'
        : st.state === 'available'
          ? `Hay una versión nueva: ${st.version ?? ''}`
          : st.state === 'downloading'
            ? `Descargando ${st.version ?? ''} · ${st.percent ?? 0}%`
            : st.state === 'ready'
              ? `Versión ${st.version ?? ''} lista para instalar`
              : st.state === 'error'
                ? (st.error ?? 'No se pudo buscar actualizaciones')
                : 'Sloth está al día'

  return (
    <>
      <div className="f-set-card f-set-status">
        <span className="f-set-status-ico" style={{ background: 'var(--success-soft)', color: 'var(--ok-fg)' }} aria-hidden="true">
          <UpdateIcon size={18} />
        </span>
        <div className="grow">
          <div className="f-set-row-title">{title}</div>
          <div className="f-set-hint">Versión instalada: {st?.current ?? '…'}</div>
        </div>
        {st?.state === 'ready' ? (
          <button type="button" className="btn primary sm" onClick={() => void ui.invoke('feat:updater:install')}>
            Reiniciar e instalar
          </button>
        ) : (
          <button type="button" className="btn primary sm" disabled={busy || busyNow || st?.enabled === false} onClick={check}>
            Buscar ahora
          </button>
        )}
      </div>
      {msg && (
        <p role="status" className="f-set-ok">
          {msg}
        </p>
      )}
      {pendiente && st?.version && (
        <div role="status" className="f-set-card f-set-status">
          <div className="grow">
            <div className="f-set-row-title">Dejaste para después la versión {st.version}</div>
            <div className="f-set-hint">No te vuelve a avisar hasta mañana. Podés verla cuando quieras.</div>
          </div>
          <button type="button" className="btn sm" onClick={() => setPhase('notes')}>
            Ver novedades
          </button>
        </div>
      )}
      <Group id="g-canal" title="Canal">
        {UPDATE_CHANNELS.map((c: UpdateChannel) => {
          const on = p.settings.updateChannel === c
          const hint = c === 'estable' ? 'Recomendado. Recibís las versiones probadas.' : 'Recibís las novedades antes, pueden tener errores.'
          return (
            <button key={c} type="button" role="radio" aria-checked={on} className="f-set-row f-set-toggle" onClick={() => save({ updateChannel: c })}>
              <span className={`f-set-radio ${on ? 'on' : ''}`} aria-hidden="true" />
              <span className="f-set-row-text">
                <span className="f-set-row-title">{c === 'estable' ? 'Estable' : 'Beta'}</span>
                <span className="f-set-hint">{hint}</span>
              </span>
            </button>
          )
        })}
      </Group>
    </>
  )
}

/* ---------- Acerca de ---------- */

export function AboutSection({ onClose }: { onClose(): void }): React.JSX.Element {
  const ui = useUi()
  const [version, setVersion] = useState<string>('…')
  useEffect(() => {
    ui.invoke<{ current: string }>('feat:updater:status').then((s) => setVersion(s.current), () => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Las otras ventanas se abren después de cerrar la Configuración, para que tomen el foco.
  const go = (fn: () => void) => (): void => {
    onClose()
    requestAnimationFrame(fn)
  }
  return (
    <>
      <div className="f-set-card f-set-about">
        <LogoMark size={96} />
        <div className="f-set-about-name">Sloth {version}</div>
        <div className="f-set-hint">Varias cuentas de Claude, sin apuro.</div>
        <div className="f-set-actions center">
          <a className="btn sm" href="https://github.com/Toomasmg/sloth" target="_blank" rel="noreferrer">
            Repositorio
          </a>
          <button type="button" className="btn sm" onClick={go(() => openReport())}>
            Reportar un problema
          </button>
        </div>
      </div>
      <Group id="g-mas" title="Más">
        <ToggleLikeButton title="Exportar configuración…" hint="Espacios, plantillas, apariencia, atajos y reglas de permisos en un archivo .sloth (sin sesiones ni credenciales)." onClick={go(() => requestExportImport({ kind: 'export' }))} />
        <ToggleLikeButton title="Importar configuración…" hint="Desde un archivo .sloth de otra PC; antes te muestra qué va a agregar, y las reglas de permisos una por una." onClick={go(() => requestExportImport({ kind: 'import' }))} />
        <ToggleLikeButton title="Ayuda y atajos" hint="Cómo se usa Sloth y la lista de atajos de teclado." onClick={go(() => openHelp('ayuda'))} />
        <ToggleLikeButton title="Novedades" hint="Qué cambió en la última versión de Sloth." onClick={go(() => openHelp('whatsnew'))} />
        <ToggleLikeButton title="Invitar a un compañero" hint="Copia un texto con los pasos para instalar Sloth y empezar." onClick={go(() => openHelp('invite'))} />
      </Group>
    </>
  )
}

function ToggleLikeButton({ title, hint, onClick }: { title: string; hint: string; onClick(): void }): React.JSX.Element {
  return (
    <button type="button" className="f-set-row f-set-toggle" onClick={onClick}>
      <span className="f-set-row-text">
        <span className="f-set-row-title">{title}</span>
        <span className="f-set-hint">{hint}</span>
      </span>
    </button>
  )
}

