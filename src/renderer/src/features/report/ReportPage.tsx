import { useEffect, useRef, useState } from 'react'
import { useUi } from '../host'
import { CloseIcon, PlusIcon, WarningIcon } from '../../icons/SlothIcons'
import { PageShell } from '../help/PageShell'
import './report.css'

/** Mismos límites que main (report-core.ts). */
const TITLE_MIN = 8
const TITLE_MAX = 200
const WHAT_MAX = 1500
const EXPECT_MAX = 800
const STEP_MAX = 200
const STEPS_MAX = 8
const STEP_PH = ['Ej.: abrí el espacio «Back · migración de horas»', 'Ej.: apreté Ctrl K y escribí «mover»', 'Ej.: aparece el error en la barra de estado']

type ReportType = 'error' | 'idea' | 'otra'
const TYPES: { id: ReportType; name: string; hint: string }[] = [
  { id: 'error', name: 'Error', hint: 'Algo no funciona o se comporta mal.' },
  { id: 'idea', name: 'Idea', hint: 'Una mejora o una función que te gustaría ver.' },
  { id: 'otra', name: 'Otra cosa', hint: 'Cualquier otra cosa que quieras contarnos.' }
]

interface Preview {
  sys: string[]
  logs: string[]
}
interface Shot {
  dataUrl: string
  name: string
}
interface Sent {
  title: string
  shot: string | null
  /** La URL del issue prellenado que se abrió en GitHub. */
  url: string
}

const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

interface StepRow {
  id: number
  text: string
}

export function ReportPage({ onClose }: { onClose: () => void }): React.JSX.Element {
  const ui = useUi()
  const [type, setType] = useState<ReportType>('error')
  const [title, setTitle] = useState('')
  const [touched, setTouched] = useState(false)
  const [tried, setTried] = useState(false)
  const [what, setWhat] = useState('')
  const [expect, setExpect] = useState('')
  const [steps, setSteps] = useState<StepRow[]>([
    { id: 1, text: '' },
    { id: 2, text: '' }
  ])
  const nextId = useRef(3)
  const [sys, setSys] = useState(true)
  const [logs, setLogs] = useState(false)
  const [sysView, setSysView] = useState(false)
  const [shot, setShot] = useState(false)
  const [shotData, setShotData] = useState<Shot | null>(null)
  const [shotBusy, setShotBusy] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sent, setSent] = useState<Sent | null>(null)
  const [reopenErr, setReopenErr] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const invokeRef = useRef(ui.invoke)
  invokeRef.current = ui.invoke

  useEffect(() => {
    let alive = true
    invokeRef
      .current<Preview>('feat:report:preview')
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setPreviewErr(errText(e)))
    return () => {
      alive = false
    }
  }, [])

  const tLen = title.trim().length
  const titleBad = tLen < TITLE_MIN
  const showTitleErr = titleBad && (tried || touched)
  const titleErr = tLen === 0 ? 'Poné un título para el reporte.' : `Te faltan ${TITLE_MIN - tLen} caracteres (mínimo ${TITLE_MIN}).`

  const setStepText = (id: number, text: string): void => setSteps((cur) => cur.map((s) => (s.id === id ? { ...s, text } : s)))
  const addStep = (): void => {
    if (steps.length >= STEPS_MAX) return
    const id = nextId.current++
    setSteps((cur) => [...cur, { id, text: '' }])
    window.setTimeout(() => document.getElementById(`rp-step-${id}`)?.focus(), 30)
  }
  const removeStep = (id: number): void => {
    setSteps((cur) => (cur.length <= 1 ? [{ id, text: '' }] : cur.filter((s) => s.id !== id)))
  }

  const toggleShot = async (): Promise<void> => {
    if (shot) {
      setShot(false)
      setShotData(null)
      return
    }
    setShot(true)
    setShotBusy(true)
    setErr(null)
    try {
      setShotData(await ui.invoke<Shot>('feat:report:capture'))
    } catch (e) {
      setShot(false)
      setErr(errText(e))
    } finally {
      setShotBusy(false)
    }
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (sending || shotBusy) return
    if (titleBad) {
      setTried(true)
      titleRef.current?.focus()
      return
    }
    setSending(true)
    setErr(null)
    try {
      const r = await ui.invoke<{ shot: string | null; url: string }>('feat:report:submit', {
        type,
        title: title.trim(),
        what,
        expect,
        steps: steps.map((s) => s.text.trim()).filter(Boolean),
        sys,
        logs,
        shot: shot && shotData !== null
      })
      setSent({ title: title.trim(), shot: r.shot, url: r.url })
      setReopenErr(null)
    } catch (e2) {
      setErr(errText(e2))
    } finally {
      setSending(false)
    }
  }

  const viewOnGithub = async (url: string): Promise<void> => {
    setReopenErr(null)
    try {
      await ui.invoke('feat:report:open', url)
    } catch (e) {
      setReopenErr(errText(e))
    }
  }

  const reset = (): void => {
    setReopenErr(null)
    setType('error')
    setTitle('')
    setTouched(false)
    setTried(false)
    setWhat('')
    setExpect('')
    setSteps([
      { id: 1, text: '' },
      { id: 2, text: '' }
    ])
    nextId.current = 3
    setSys(true)
    setLogs(false)
    setShot(false)
    setShotData(null)
    setErr(null)
    setSent(null)
  }

  const typeHint = TYPES.find((t) => t.id === type)?.hint ?? ''

  if (sent) {
    return (
      <PageShell labelId="rp-title" title="Reportar un problema" onClose={onClose}>
        <div className="rp-wrap">
          <section role="status" aria-labelledby="rp-title" className="rp-thanks">
            <span className="rp-thanks-ico" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </span>
            <h1 id="rp-title">¡Gracias! Falta un paso en GitHub</h1>
            <p>
              Abrimos GitHub con el reporte «{sent.title}». Revisalo y tocá «Submit new issue». Recién ahí queda creado el issue.
            </p>
            {sent.shot && (
              <p className="rp-shot-note">
                La captura se guardó como <strong>{sent.shot}</strong> y se abrió su carpeta. Arrastrala al issue en GitHub.
              </p>
            )}
            {reopenErr && (
              <p className="form-error" role="alert">
                {reopenErr}
              </p>
            )}
            <div className="rp-thanks-actions">
              <button type="button" className="btn" onClick={() => void viewOnGithub(sent.url)}>
                Ver en GitHub
              </button>
              <button type="button" className="btn primary" onClick={onClose}>
                Volver a Sloth
              </button>
              <button type="button" className="btn ghost" onClick={reset}>
                Enviar otro reporte
              </button>
            </div>
          </section>
        </div>
      </PageShell>
    )
  }

  return (
    <PageShell labelId="rp-title" title="Reportar un problema" onClose={onClose}>
      <div className="rp-wrap">
        <header className="rp-head">
          <h1 id="rp-title">Reportar un problema</h1>
          <p>Contanos qué pasó o qué te gustaría. Se abre GitHub con el reporte listo para enviar, y revisás todo antes.</p>
        </header>

        <form className="rp-form" onSubmit={(e) => void submit(e)}>
          <section className="rp-sec" aria-labelledby="rp-tipo">
            <h2 id="rp-tipo" className="rp-h">
              Tipo
            </h2>
            <div role="radiogroup" aria-labelledby="rp-tipo" className="rp-types">
              {TYPES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={type === t.id}
                  className={type === t.id ? 'on' : ''}
                  onClick={() => setType(t.id)}
                >
                  {t.name}
                </button>
              ))}
            </div>
            <p className="hint rp-hint0">{typeHint}</p>
          </section>

          <section className="rp-card rp-que" aria-labelledby="rp-que">
            <h2 id="rp-que" className="rp-h">
              Qué pasó
            </h2>
            <div className="field">
              <label htmlFor="rp-titulo">Título · obligatorio</label>
              <input
                id="rp-titulo"
                ref={titleRef}
                type="text"
                className="input"
                value={title}
                maxLength={TITLE_MAX}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => setTouched(true)}
                aria-invalid={showTitleErr}
                aria-describedby="rp-titulo-ayuda"
                placeholder="Ej.: El panel se congela al mover el espacio"
              />
              <span id="rp-titulo-ayuda" role="status" className={showTitleErr ? 'field-error' : 'field-help'}>
                {showTitleErr ? titleErr : `Mínimo ${TITLE_MIN} caracteres. Que se entienda de un vistazo.`}
              </span>
            </div>

            <div className="field">
              <label htmlFor="rp-que-pasa">¿Qué pasó?</label>
              <textarea
                id="rp-que-pasa"
                className="input rp-area"
                rows={3}
                maxLength={WHAT_MAX}
                value={what}
                onChange={(e) => setWhat(e.target.value)}
                placeholder="Contá qué viste en la pantalla"
              />
            </div>

            <div className="field">
              <label htmlFor="rp-que-esperabas">¿Qué esperabas?</label>
              <textarea
                id="rp-que-esperabas"
                className="input rp-area"
                rows={2}
                maxLength={EXPECT_MAX}
                value={expect}
                onChange={(e) => setExpect(e.target.value)}
                placeholder="Qué debería haber pasado"
              />
            </div>
          </section>

          <section className="rp-sec" aria-labelledby="rp-pasos">
            <h2 id="rp-pasos" className="rp-h">
              Pasos para reproducirlo
            </h2>
            <div className="rp-card rp-steps">
              {steps.map((st, i) => (
                <div key={st.id} className="rp-step">
                  <span className="rp-step-n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <input
                    id={`rp-step-${st.id}`}
                    className="input rp-step-in"
                    aria-label={`Paso ${i + 1}`}
                    value={st.text}
                    maxLength={STEP_MAX}
                    placeholder={STEP_PH[i % STEP_PH.length]}
                    onChange={(e) => setStepText(st.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addStep()
                      }
                    }}
                  />
                  <button type="button" className="rp-step-x" onClick={() => removeStep(st.id)} aria-label={`Quitar el paso ${i + 1}`} title="Quitar el paso">
                    <CloseIcon size={14} />
                  </button>
                </div>
              ))}
              <div className="rp-steps-foot">
                <button type="button" className="btn sm rp-add" onClick={addStep} disabled={steps.length >= STEPS_MAX}>
                  <PlusIcon size={13} />
                  Agregar paso
                </button>
                <span className="hint">
                  {steps.length >= STEPS_MAX ? `Llegaste al máximo de ${STEPS_MAX} pasos.` : `Hasta ${STEPS_MAX} pasos. Enter en un paso agrega otro.`}
                </span>
              </div>
            </div>
          </section>

          <section className="rp-sec" aria-labelledby="rp-adj">
            <h2 id="rp-adj" className="rp-h">
              Qué adjuntar
            </h2>
            <div className="group">
              <div className="rp-att">
                <div className="rp-att-top">
                  <Check label="Información del sistema" hint="Versión de Sloth, Windows y cantidad de espacios abiertos." on={sys} onToggle={() => setSys(!sys)} />
                  {sys && (
                    <button type="button" className="rp-view" aria-expanded={sysView} onClick={() => setSysView(!sysView)}>
                      {sysView ? 'Ocultar' : 'Ver qué se manda'}
                    </button>
                  )}
                </div>
                {sys && sysView && <PreviewLines title="Esto es lo que se manda:" lines={preview?.sys} err={previewErr} />}
              </div>
              <div className="rp-att">
                <Check
                  label="Registros de los últimos 30 minutos"
                  hint="Se quitan las rutas personales. Nunca se incluyen tokens ni contraseñas."
                  on={logs}
                  onToggle={() => setLogs(!logs)}
                />
                {logs && (
                  <>
                    <p role="note" className="rp-warn">
                      <WarningIcon size={14} />
                      <span>Aviso: las rutas personales se reemplazan por «C:\Users\…». Nunca van tokens ni contraseñas.</span>
                    </p>
                    <PreviewLines title={`Vista previa · ${preview?.logs.length ?? 0} líneas`} lines={preview?.logs} err={previewErr} />
                  </>
                )}
              </div>
              <div className="rp-att">
                <Check
                  label="Captura de la ventana"
                  hint="Una imagen de lo que ves en Sloth, para entender el problema más rápido."
                  on={shot}
                  onToggle={() => void toggleShot()}
                  busy={shotBusy}
                />
                {shot && shotData && (
                  <figure className="rp-shot">
                    <img src={shotData.dataUrl} alt="Captura de la ventana de Sloth que se va a adjuntar" />
                    <figcaption className="hint">Se guarda en tu PC y se abre su carpeta al enviar. No se sube sola. Revisala: puede mostrar lo que hay en las terminales.</figcaption>
                  </figure>
                )}
              </div>
            </div>
          </section>

          {err && (
            <p className="form-error" role="alert">
              {err}
            </p>
          )}

          <div className="rp-send">
            <span role="status" className={tried && titleBad ? 'rp-send-hint bad' : 'rp-send-hint'}>
              {tried && titleBad ? 'Revisá el título para poder enviar.' : 'Revisá lo que se manda antes de enviar.'}
            </span>
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn primary" aria-busy={sending} disabled={sending || shotBusy}>
              {sending ? 'Abriendo GitHub…' : 'Enviar reporte'}
            </button>
          </div>
        </form>
      </div>
    </PageShell>
  )
}

/** Casilla con texto (role=checkbox). */
function Check({
  label,
  hint,
  on,
  onToggle,
  busy
}: {
  label: string
  hint: string
  on: boolean
  onToggle: () => void
  busy?: boolean
}): React.JSX.Element {
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-busy={busy} onClick={onToggle} className="rp-check">
      <span className={`rp-box ${on ? 'on' : ''}`} aria-hidden="true">
        {on && (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        )}
      </span>
      <span className="rp-check-text">
        <span>{busy ? 'Tomando la captura…' : label}</span>
        <span className="hint">{hint}</span>
      </span>
    </button>
  )
}

/** Lo que se va a mandar (ya sanitizado por main). */
function PreviewLines({ title, lines, err }: { title: string; lines?: string[]; err: string | null }): React.JSX.Element {
  return (
    <div className="rp-preview">
      <span className="hint">{title}</span>
      {err && <span className="form-error">{err}</span>}
      {!err && !lines && <span className="hint">Preparando…</span>}
      {lines?.map((l, i) => (
        <div key={i} className="rp-line mono">
          {l || ' '}
        </div>
      ))}
    </div>
  )
}
