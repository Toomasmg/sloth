import { useEffect, useRef, useState } from 'react'
import type { UiCtx } from '../host'
import { errText, fmtKb, type Overview, type Preview, type Selection } from './types'
import { Ico, P } from './ico'

const MIN_PW = 8
const LINE = 'inset 0 -1px 0 var(--line)'

const dayStamp = (): string => new Date().toISOString().slice(0, 10)

/** Pestaña «Exportar»: qué incluir (con tamaño), contraseña opcional, vista previa y guardar. */
export function ExportTab({ ui }: { ui: UiCtx }): React.JSX.Element {
  const [ov, setOv] = useState<Overview | null>(null)
  const [sel, setSel] = useState<Selection | null>(null)
  const [prev, setPrev] = useState<Preview | null>(null)
  const [pwOn, setPwOn] = useState(false)
  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  const [attempt, setAttempt] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const pw1 = useRef<HTMLInputElement>(null)
  const pw2 = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ui.invoke<Overview>('feat:export-import:overview').then(
      (o) => {
        setOv(o)
        setSel({
          espacios: o.espacios.map((e) => e.id),
          plantillas: true,
          apariencia: true,
          atajos: o.atajos > 0,
          equipo: !!o.equipo,
          permisos: o.reglasTotal > 0
        })
      },
      (e) => setErr(errText(e))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // La vista previa y los tamaños se recalculan con cada cambio de selección (sin escribir nada).
  const key = sel ? JSON.stringify(sel) : ''
  useEffect(() => {
    if (!sel) return
    let alive = true
    ui.invoke<Preview>('feat:export-import:preview', sel).then(
      (p) => alive && setPrev(p),
      () => {}
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // El aviso de «Archivo guardado» dura 6 s (como en el artboard).
  useEffect(() => {
    if (!saved) return
    const t = window.setTimeout(() => setSaved(null), 6000)
    return () => window.clearTimeout(t)
  }, [saved])

  if (!ov || !sel || !prev) return <p className="f-ei-help">Leyendo tu configuración…</p>

  const allSpaces = ov.espacios.length > 0 && sel.espacios.length === ov.espacios.length
  const selSpaces = ov.espacios.filter((e) => sel.espacios.includes(e.id))
  const reglasSel = selSpaces.reduce((a, e) => a + e.reglas, 0)
  const anyOn = sel.espacios.length > 0 || sel.plantillas || sel.apariencia || sel.atajos || sel.equipo || sel.permisos

  const ok1 = p1.length >= MIN_PW
  const e1 = !pwOn ? '' : p1.length === 0 ? (attempt ? 'Escribí una contraseña de 8 caracteres o más.' : '') : !ok1 ? `Faltan ${MIN_PW - p1.length} caracteres para llegar a 8.` : ''
  const e2 = !pwOn ? '' : p2.length === 0 ? (attempt ? 'Repetí la contraseña.' : '') : p2 !== p1 ? 'No coinciden todavía.' : ''
  const okMatch = pwOn && ok1 && p2.length > 0 && p2 === p1
  const pwValid = !pwOn || okMatch

  const toggleSpace = (id: string): void => setSel({ ...sel, espacios: sel.espacios.includes(id) ? sel.espacios.filter((x) => x !== id) : [...sel.espacios, id] })
  const toggleAllSpaces = (): void => setSel({ ...sel, espacios: allSpaces ? [] : ov.espacios.map((e) => e.id) })
  const flag = (k: 'plantillas' | 'apariencia' | 'atajos' | 'equipo' | 'permisos'): void => setSel({ ...sel, [k]: !sel[k] })

  const doExport = async (): Promise<void> => {
    setAttempt(true)
    setErr(null)
    setSaved(null)
    if (!anyOn) {
      setErr('Marcá al menos un grupo para exportar.')
      return
    }
    if (!pwValid) {
      setErr('Corregí la contraseña para exportar.')
      ;(ok1 ? pw2 : pw1).current?.focus()
      return
    }
    setBusy(true)
    try {
      const r = await ui.invoke<{ file: string } | null>('feat:export-import:export', sel, pwOn ? p1 : undefined)
      if (r) {
        setSaved(r.file.split(/[\\/]/).pop() ?? r.file)
        setAttempt(false)
      }
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="f-ei-tab">
      <div role="note" className="f-ei-lock">
        <span className="f-ei-lock-ico" aria-hidden="true">
          <Ico d={P.lock} size={16} />
        </span>
        <span>Las sesiones de tus cuentas de Claude no se exportan nunca: en la otra PC vas a iniciar sesión de nuevo.</span>
      </div>

      <section className="f-ei-sec" aria-labelledby="ex-qi">
        <h2 id="ex-qi" className="f-ei-h">
          Qué incluir
        </h2>
        <div className="f-ei-card">
          {/* Espacios: el grupo tiene selección individual por espacio. */}
          <div style={{ boxShadow: LINE }}>
            <label className="f-ei-row">
              <input type="checkbox" checked={allSpaces} disabled={ov.espacios.length === 0} onChange={toggleAllSpaces} />
              <span className="f-ei-grow">
                <span className="f-ei-name">Espacios</span>
                <span className="f-ei-desc">Ruta, nombre, color y cuenta asignada de cada espacio. No se exportan los archivos del proyecto.</span>
              </span>
              <span className="f-ei-size">
                {ov.espacios.length === 0 ? 'No hay espacios' : `${sel.espacios.length} de ${ov.espacios.length} · ${fmtKb(prev.kb.espacios)}`}
              </span>
            </label>
            {ov.espacios.map((e) => (
              <label key={e.id} className="f-ei-row sub">
                <input type="checkbox" checked={sel.espacios.includes(e.id)} onChange={() => toggleSpace(e.id)} />
                <span className="f-ei-dot" style={{ background: e.color ?? 'var(--fg-muted)' }} aria-hidden="true" />
                <span className="f-ei-name">{e.nombre}</span>
                <span className="f-ei-chip">{e.cuenta}</span>
                <span className="f-ei-path mono">{e.ruta}</span>
              </label>
            ))}
          </div>

          <div style={{ boxShadow: LINE }}>
            <label className="f-ei-row">
              <input type="checkbox" checked={sel.plantillas} onChange={() => flag('plantillas')} />
              <span className="f-ei-grow">
                <span className="f-ei-name">Plantillas</span>
                <span className="f-ei-desc">Las plantillas para crear espacios, con sus nombres, ramas y primer mensaje.</span>
              </span>
              <span className="f-ei-size">{ov.plantillas === 0 ? 'Ninguna' : `${ov.plantillas} · ${fmtKb(prev.kb.plantillas)}`}</span>
            </label>
          </div>

          <div style={{ boxShadow: LINE }}>
            <label className={`f-ei-row${ov.atajos === 0 ? ' f-ei-disabled' : ''}`}>
              <input type="checkbox" checked={sel.atajos && ov.atajos > 0} disabled={ov.atajos === 0} onChange={() => flag('atajos')} />
              <span className="f-ei-grow">
                <span className="f-ei-name">Atajos</span>
                <span className="f-ei-desc">Solo los que cambiaste. Los de fábrica no se guardan.</span>
              </span>
              <span className="f-ei-size">{ov.atajos === 0 ? 'No hay cambios' : `${ov.atajos} ${ov.atajos === 1 ? 'cambiado' : 'cambiados'} · ${fmtKb(prev.kb.atajos)}`}</span>
            </label>
          </div>

          <div style={{ boxShadow: LINE }}>
            <label className="f-ei-row">
              <input type="checkbox" checked={sel.apariencia} onChange={() => flag('apariencia')} />
              <span className="f-ei-grow">
                <span className="f-ei-name">Apariencia</span>
                <span className="f-ei-desc">Tema, color de acento, densidad y tamaño del texto.</span>
              </span>
              <span className="f-ei-size">{fmtKb(prev.kb.apariencia)}</span>
            </label>
          </div>

          <div style={{ boxShadow: LINE }}>
            <label className={`f-ei-row${ov.equipo ? '' : ' f-ei-disabled'}`}>
              <input type="checkbox" checked={sel.equipo && !!ov.equipo} disabled={!ov.equipo} onChange={() => flag('equipo')} />
              <span className="f-ei-grow">
                <span className="f-ei-name">Equipo y chat</span>
                <span className="f-ei-desc">Solo la URL del proyecto de Supabase. Nunca tu sesión.</span>
              </span>
              <span className="f-ei-size">{ov.equipo ? fmtKb(prev.kb.equipo) : 'No hay equipo configurado'}</span>
            </label>
          </div>

          <div>
            <label className={`f-ei-row${reglasSel === 0 ? ' f-ei-disabled' : ''}`}>
              <input type="checkbox" checked={sel.permisos && reglasSel > 0} disabled={reglasSel === 0} onChange={() => flag('permisos')} />
              <span className="f-ei-grow">
                <span className="f-ei-name">Reglas de permisos</span>
                <span className="f-ei-desc">Los «Permitir siempre aquí» de cada espacio seleccionado.</span>
              </span>
              <span className="f-ei-size">{reglasSel === 0 ? 'Ninguna' : `${reglasSel} ${reglasSel === 1 ? 'regla' : 'reglas'} · ${fmtKb(prev.kb.permisos)}`}</span>
            </label>
          </div>
        </div>
      </section>

      <section className="f-ei-sec" aria-labelledby="ex-se">
        <h2 id="ex-se" className="f-ei-h">
          Seguridad
        </h2>
        <div className="f-ei-card">
          <label className="f-ei-row">
            <input type="checkbox" checked={pwOn} onChange={() => { setPwOn(!pwOn); setAttempt(false) }} />
            <span className="f-ei-grow">
              <span className="f-ei-name">Proteger con contraseña</span>
              <span className="f-ei-desc">Sin contraseña, cualquiera que tenga el archivo puede leerlo. Sloth no guarda la contraseña.</span>
            </span>
          </label>
          {pwOn && (
            <div className="f-ei-pw">
              <label className="f-ei-pwfield">
                <span>Contraseña</span>
                <input
                  ref={pw1}
                  type="password"
                  autoComplete="new-password"
                  value={p1}
                  aria-invalid={!!e1}
                  aria-describedby="ex-pw1-h"
                  onChange={(e) => setP1(e.target.value)}
                />
                <span id="ex-pw1-h" className={e1 ? 'f-ei-fieldmsg bad' : 'f-ei-fieldmsg'}>
                  {e1 || 'Mínimo 8 caracteres.'}
                </span>
              </label>
              <label className="f-ei-pwfield">
                <span>Repetir contraseña</span>
                <input
                  ref={pw2}
                  type="password"
                  autoComplete="new-password"
                  value={p2}
                  aria-invalid={!!e2}
                  aria-describedby="ex-pw2-h"
                  onChange={(e) => setP2(e.target.value)}
                />
                <span id="ex-pw2-h" className={e2 ? 'f-ei-fieldmsg bad' : okMatch ? 'f-ei-fieldmsg ok' : 'f-ei-fieldmsg'}>
                  {e2 || (okMatch ? 'Coinciden.' : 'Escribila igual que la anterior.')}
                </span>
              </label>
            </div>
          )}
        </div>
      </section>

      <details className="f-ei-card f-ei-preview">
        <summary>
          <Ico d={P.chevDown} size={14} />
          Vista previa del archivo
          <span className="f-ei-hint">{pwOn ? 'Así queda el contenido antes de cifrarlo' : 'Cambia según lo que marcás'}</span>
        </summary>
        <pre aria-label="Vista previa del contenido del archivo">{prev.json}</pre>
      </details>

      <div className="f-ei-foot">
        <span className="f-ei-size">
          Tamaño aproximado: {prev.totalTxt} · sloth-config-{dayStamp()}.sloth
        </span>
        {err && (
          <span role="alert" className="f-ei-err">
            {err}
          </span>
        )}
        <span className="f-ei-grow" />
        <button type="button" className="f-ei-btn primary" onClick={() => void doExport()} disabled={busy} aria-busy={busy}>
          {busy ? 'Guardando…' : 'Exportar…'}
        </button>
      </div>

      {saved && (
        <div role="status" className="f-ei-toast">
          <Ico d={P.check} size={15} sw={2.2} />
          <span className="f-ei-toast-text">Archivo guardado: {saved}</span>
          <button type="button" className="f-ei-btn secondary sm" onClick={() => void ui.invoke('feat:export-import:reveal').catch((e) => setErr(errText(e)))}>
            Mostrar en la carpeta
          </button>
        </div>
      )}
    </div>
  )
}
