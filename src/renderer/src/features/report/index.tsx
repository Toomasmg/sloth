import { useEffect, useRef, useState } from 'react'
import { Bug, CheckCircle, Copy, GithubLogo, X } from '@phosphor-icons/react'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
import { onOpenReport, openReport } from './bus'
import './report.css'

/** Mismo límite que main (report-core.ts). */
const BODY_MAX = 6000

interface Preview {
  title: string
  body: string
  logLines: number
}

const errText = (e: unknown): string =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function ReportModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const ui = useUi()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [logLines, setLogLines] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    let alive = true
    ui.invoke<Preview>('feat:report:preview').then(
      (p) => {
        if (!alive) return
        setTitle(p.title)
        setBody(p.body)
        setLogLines(p.logLines)
        setLoaded(true)
        bodyRef.current?.focus()
      },
      (e) => {
        if (!alive) return
        setErr(errText(e))
        setLoaded(true)
      }
    )
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      alive = false
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Lo que se abre es exactamente lo que el usuario ve en el textarea (main vuelve a filtrarlo).
  const openGithub = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      await ui.invoke('feat:report:open', title, body)
      onClose()
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const copy = (): void => {
    window.sloth.clipboardWrite(`${title}\n\n${body}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="modal f-report-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="f-report-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2 id="f-report-title">Reportar un problema</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <p className="f-report-note">
          Se abre GitHub en tu navegador con esto prellenado. No se envía nada hasta que toques «Submit new issue».
          Revisá que no haya nada privado.
        </p>

        {!loaded && (
          <p className="hint" role="status">
            Preparando el texto…
          </p>
        )}

        {loaded && (
          <>
            <div className="field">
              <label htmlFor="f-report-title-in">Título</label>
              <input
                id="f-report-title-in"
                type="text"
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="f-report-body">Texto del reporte</label>
              <textarea
                id="f-report-body"
                ref={bodyRef}
                className="f-report-body mono"
                value={body}
                spellCheck={false}
                onChange={(e) => setBody(e.target.value)}
              />
              <span className="hint">
                {logLines} líneas del registro incluidas · {body.length} de {BODY_MAX} caracteres
              </span>
            </div>
          </>
        )}

        {err && (
          <p className="form-error" role="alert">
            {err}
          </p>
        )}

        <footer className="modal-actions f-report-actions">
          <button type="button" className="btn" onClick={copy} disabled={!loaded}>
            {copied ? <CheckCircle size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            {copied ? 'Copiado' : 'Copiar'}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void openGithub()}
            disabled={!loaded || busy || title.trim().length === 0}
          >
            <GithubLogo size={14} aria-hidden="true" />
            {busy ? 'Abriendo…' : 'Abrir en GitHub'}
          </button>
        </footer>
      </div>
    </div>
  )
}

function Global(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  useEffect(() => onOpenReport(() => setOpen(true)), [])
  return open ? <ReportModal onClose={() => setOpen(false)} /> : null
}

const ui: FeatureUi = {
  name: 'report',
  Global,
  commands: () => [
    {
      id: 'report:open',
      title: 'Reportar un problema',
      subtitle: 'Revisás el texto antes de abrir GitHub',
      group: 'Sloth',
      keywords: 'bug error problema issue reportar falla',
      icon: <Bug size={16} aria-hidden="true" />,
      run: () => openReport()
    }
  ]
}

export default ui
