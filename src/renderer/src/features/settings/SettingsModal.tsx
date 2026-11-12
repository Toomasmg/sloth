import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AddAccountIcon, SearchIcon, SLOTH_ICONS } from '../../icons/SlothIcons'
import { useUi } from '../host'
import { View } from '../../ui/View'
import type { SectionId, SettingsTab } from './bus'
import { NAV, navOf, normalizeTab, searchSettings } from './search'
import { updateSettings, type SettingsPatch } from './store'
import { SaveContext, errText, type SaveFn } from './ui'
import { AboutSection, AccountsSection, AppearanceSection, BackupSection, GeneralSection, NotificationsSection, ShortcutsSection, TeamSection, TerminalSection, UpdatesSection } from './sections'

interface Toast {
  text: string
  err: boolean
}

/**
 * Configuración: Vista con barra lateral de secciones y buscador. Cada cambio se guarda solo y
 * muestra «Guardado». Esc, el foco y Tab los maneja la Vista.
 */
export function SettingsModal({ initialTab, onClose }: { initialTab: SettingsTab; onClose(): void }): React.JSX.Element {
  const ui = useUi()
  const [sec, setSec] = useState<SectionId>(() => normalizeTab(initialTab))
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => setSec(normalizeTab(initialTab)), [initialTab])
  useEffect(() => () => clearTimeout(timer.current), [])

  const flash = useCallback((text: string, err = false) => {
    setToast({ text, err })
    clearTimeout(timer.current)
    // Un error no se va solo: quien miraba para otro lado se perdería qué falló.
    if (!err) timer.current = setTimeout(() => setToast(null), 2000)
  }, [])

  const run: SaveFn = useCallback(
    (what: SettingsPatch | (() => Promise<unknown>)) => {
      const p = typeof what === 'function' ? what() : updateSettings(what)
      p.then(() => flash('Guardado'), (e) => flash(errText(e), true))
    },
    [flash]
  )

  // Foco al entrar: el título de la sección (sin recuadro de foco, y no el buscador ni «Volver»).
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('#f-set-title')?.focus()
  }, [])

  const results = useMemo(() => searchSettings(q), [q])
  const searching = q.trim().length > 0
  const pendingLogins = ui.accounts.filter((a) => !ui.statuses[a.id]?.loggedIn).length
  const meta = navOf(sec)

  const pick = (id: SectionId): void => {
    setSec(id)
    setQ('')
    setAdding(false)
  }

  return (
    <View labelId="f-set-view-title" title="Configuración" onClose={onClose} flush className="f-set-view">
      <div className="f-set-page" ref={dialogRef}>
        <nav className="f-set-nav" aria-label="Secciones de configuración">
          <label className="f-set-search">
            <SearchIcon size={14} />
            <input type="search" value={q} placeholder="Buscar un ajuste" aria-label="Buscar un ajuste" onChange={(e) => setQ(e.target.value)} />
          </label>

          {searching ? (
            <div className="f-set-results">
              <div className="f-set-results-h">{results.length ? `${results.length} ajustes encontrados` : 'Ningún ajuste coincide'}</div>
              {results.map((r) => (
                <button key={`${r.section}-${r.title}`} type="button" className="f-set-result" onClick={() => pick(r.section)}>
                  <span>{r.title}</span>
                  <span className="f-set-hint">{navOf(r.section).name}</span>
                </button>
              ))}
            </div>
          ) : (
            <ul className="f-set-list">
              {NAV.map((s) => {
                const on = s.id === sec
                const Tile = SLOTH_ICONS[s.icon]
                return (
                  <li key={s.id} className={s.sepBefore ? 'sep' : undefined}>
                    <button type="button" className={`f-set-item ${on ? 'on' : ''}`} aria-current={on ? 'page' : undefined} onClick={() => pick(s.id)}>
                      <span className="f-set-tile" style={{ background: s.color }} aria-hidden="true">
                        <Tile size={14} />
                      </span>
                      <span className="f-set-item-name">{s.name}</span>
                      {s.id === 'cuentas' && pendingLogins > 0 && <span className="f-set-badge">{pendingLogins}</span>}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </nav>

        <main className="f-set-main">
          <div className="f-set-col">
            <header className="f-set-head">
              <div className="f-set-head-text">
                <h1 id="f-set-title" tabIndex={-1}>
                  {meta.name}
                </h1>
                <p>{meta.sub}</p>
              </div>
              {sec === 'cuentas' && (
                <button type="button" className="btn primary sm f-set-add" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
                  <AddAccountIcon size={14} /> Agregar cuenta
                </button>
              )}
            </header>
            <SaveContext.Provider value={run}>
              <div className="f-set-body" role="region" aria-label={meta.name}>
                {sec === 'general' && <GeneralSection />}
                {sec === 'cuentas' && <AccountsSection onClose={onClose} adding={adding} setAdding={setAdding} />}
                {sec === 'apariencia' && <AppearanceSection />}
                {sec === 'terminal' && <TerminalSection />}
                {sec === 'atajos' && <ShortcutsSection />}
                {sec === 'notif' && <NotificationsSection onClose={onClose} />}
                {sec === 'equipo' && <TeamSection onClose={onClose} />}
                {sec === 'updates' && <UpdatesSection />}
                {sec === 'backup' && <BackupSection onClose={onClose} />}
                {sec === 'about' && <AboutSection onClose={onClose} />}
              </div>
            </SaveContext.Provider>
          </div>
        </main>

        {toast && (
          <div role={toast.err ? 'alert' : 'status'} aria-live="polite" className={`f-set-toast ${toast.err ? 'err' : ''}`}>
            {!toast.err && <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" className="f-set-toast-ok" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>}
            {toast.text}
            {toast.err && (
              <button type="button" className="f-set-toast-x" aria-label="Cerrar aviso" onClick={() => setToast(null)}>
                ×
              </button>
            )}
          </div>
        )}
      </div>
    </View>
  )
}
