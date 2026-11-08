import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowSquareOut, CheckCircle, CircleNotch, GitPullRequest, Warning, X } from '@phosphor-icons/react'
import { useUi } from '../host'
import { errText, type PrPrep, type SessionPr } from './util'

interface GhRes {
  installed: boolean
  version: string
}

/** Diálogo para abrir el PR con gh: rama, base, título y cuerpo (con plantilla del repo). */
export function PrPanel({
  wsId,
  base,
  onClose,
  onPush,
  onCreated
}: {
  wsId: string
  base: string | null
  onClose: () => void
  onPush: (branch: string) => Promise<void>
  onCreated: (pr: SessionPr) => void
}): React.JSX.Element {
  const ui = useUi()
  const [prep, setPrep] = useState<PrPrep | null>(null)
  const [gh, setGh] = useState<GhRes | null>(null)
  const [err, setErr] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [prBase, setPrBase] = useState(base ?? '')
  const [step, setStep] = useState<'form' | 'confirm' | 'done'>('form')
  const [cmd, setCmd] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [url, setUrl] = useState('')

  const load = useCallback(() => {
    setErr('')
    ui.invoke<PrPrep>('feat:git:prPrepare', wsId, base ?? undefined).then(
      (p) => {
        setPrep(p)
        setTitle((t) => t || p.defaultTitle)
        setBody((b) => b || p.template?.body || '')
        setPrBase((b) => b || p.base || '')
      },
      (e) => setErr(errText(e))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, base])
  useEffect(load, [load])

  useEffect(() => {
    ui.invoke<GhRes>('feat:git:gh')
      .then(setGh)
      .catch(() => setGh({ installed: false, version: '' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const input = { base: prBase.trim(), head: prep?.branch ?? '', title: title.trim(), body }

  const review = async (): Promise<void> => {
    setErr('')
    try {
      setCmd(await ui.invoke<string[]>('feat:git:prCommand', input))
      setStep('confirm')
    } catch (e) {
      setErr(errText(e))
    }
  }

  const create = async (): Promise<void> => {
    setRunning(true)
    setErr('')
    try {
      const u = await ui.invoke<string>('feat:git:createPr', wsId, input)
      setUrl(u)
      const num = Number(/\/pull\/(\d+)/.exec(u)?.[1] ?? 0)
      onCreated({ url: u, number: num, from: input.head, to: input.base })
      setStep('done')
    } catch (e) {
      setErr(errText(e))
    } finally {
      setRunning(false)
    }
  }

  const open = (u: string): void => {
    ui.invoke('feat:git:openUrl', u).catch((e) => setErr(errText(e)))
  }

  const pushThenReload = async (): Promise<void> => {
    if (!prep?.branch) return
    setRunning(true)
    setErr('')
    try {
      await onPush(prep.branch)
      load()
    } catch (e) {
      setErr(errText(e))
    } finally {
      setRunning(false)
    }
  }

  const existingOpen = prep?.existing && prep.existing.state === 'OPEN' ? prep.existing : null
  const ghMissing = gh !== null && !gh.installed
  const blocked = !prep || prep.protected || !prep.branch || !prep.pushed || Boolean(existingOpen) || ghMissing

  return (
    <SubDialog title={step === 'confirm' ? 'Confirmar PR' : 'Abrir PR'} icon={<GitPullRequest size={16} aria-hidden="true" />} onClose={onClose} wide>
      {ghMissing && (
        <div className="f-git-warn">
          <Warning size={14} aria-hidden="true" />
          <span className="grow-min">
            No encuentro <span className="mono">gh</span> (la herramienta de GitHub) en este equipo. Instalala: en una terminal corré{' '}
            <span className="mono">winget install --id GitHub.cli</span> (o bajala de cli.github.com), después <span className="mono">gh auth login</span>, y volvé a intentar.
          </span>
        </div>
      )}
      {!prep && !err && <p className="hint">Revisando rama, PR existente y plantilla…</p>}
      {prep && step === 'form' && (
        <>
          {existingOpen ? (
            <div className="f-git-existing">
              <GitPullRequest size={16} aria-hidden="true" />
              <span className="grow-min">
                Ya hay un PR abierto para <span className="mono">{prep.branch}</span>: <strong>#{existingOpen.number}</strong> {existingOpen.title}
              </span>
              <button className="btn sm primary" onClick={() => open(existingOpen.url)}>
                <ArrowSquareOut size={13} aria-hidden="true" /> Abrir en GitHub
              </button>
            </div>
          ) : (
            <>
              {prep.existing && (
                <p className="hint">
                  Hubo un PR #{prep.existing.number} ({prep.existing.state === 'MERGED' ? 'mergeado' : 'cerrado'}) para esta rama.{' '}
                  <button className="f-git-link" onClick={() => open(prep.existing!.url)}>
                    Ver
                  </button>
                </p>
              )}
              {prep.protected && (
                <p className="form-error">
                  <Warning size={13} aria-hidden="true" /> Estás en {prep.branch ?? 'un HEAD separado'}: creá una rama nueva para abrir un PR.
                </p>
              )}
              {!prep.protected && !prep.pushed && (
                <div className="f-git-warn">
                  <Warning size={14} aria-hidden="true" />
                  <span className="grow-min">
                    {prep.upstream ? `Hay ${prep.unpushed} commit${prep.unpushed === 1 ? '' : 's'} sin subir.` : 'La rama todavía no está en origin.'} Subila antes de abrir el PR.
                  </span>
                  <button className="btn sm" onClick={() => void pushThenReload()} disabled={running}>
                    {running ? <CircleNotch size={13} className="spin" aria-hidden="true" /> : null} Subir
                  </button>
                </div>
              )}
              {prep.ghError && <p className="form-error">{prep.ghError}</p>}
              <div className="f-git-grid2">
                <div className="field">
                  <label htmlFor="f-git-pr-head">Rama</label>
                  <input id="f-git-pr-head" className="mono" value={prep.branch ?? ''} readOnly />
                </div>
                <div className="field">
                  <label htmlFor="f-git-pr-base">Base</label>
                  <input id="f-git-pr-base" className="mono" value={prBase} onChange={(e) => setPrBase(e.target.value)} spellCheck={false} />
                </div>
              </div>
              <div className="field">
                <label htmlFor="f-git-pr-title">Título</label>
                <input id="f-git-pr-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
              </div>
              <div className="field">
                <label htmlFor="f-git-pr-body">Descripción</label>
                <textarea id="f-git-pr-body" className="f-git-ta mono" rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
                <p className="field-help">
                  {prep.template ? (
                    <>
                      Precargada desde <span className="mono">{prep.template.path}</span>.
                    </>
                  ) : (
                    'El repo no tiene plantilla de PR.'
                  )}{' '}
                  {prep.commits.length > 0 && `${prep.commits.length} commit${prep.commits.length === 1 ? '' : 's'} respecto de ${prBase || 'la base'}.`}
                </p>
              </div>
            </>
          )}
        </>
      )}
      {prep && step === 'confirm' && (
        <>
          <p className="f-git-p">
            Se va a crear un PR en GitHub de <span className="mono">{input.head}</span> hacia <span className="mono">{input.base}</span>. Comando exacto:
          </p>
          <pre className="f-git-cmd mono">{cmd.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}</pre>
          <p className="f-git-p">Cuerpo (por stdin):</p>
          <pre className="f-git-body mono">{body || '(vacío)'}</pre>
        </>
      )}
      {step === 'done' && (
        <div className="f-git-existing">
          <CheckCircle size={16} aria-hidden="true" />
          <span className="grow-min mono">{url}</span>
          <button className="btn sm primary" onClick={() => open(url)}>
            <ArrowSquareOut size={13} aria-hidden="true" /> Abrir en GitHub
          </button>
        </div>
      )}
      {err && <p className="form-error">{err}</p>}
      <div className="f-git-sub-actions">
        {step === 'confirm' ? (
          <>
            <button className="btn ghost" onClick={() => setStep('form')} disabled={running}>
              Volver
            </button>
            <button className="btn primary" onClick={() => void create()} disabled={running}>
              {running ? <CircleNotch size={14} className="spin" aria-hidden="true" /> : <GitPullRequest size={14} aria-hidden="true" />}
              {running ? 'Creando…' : 'Crear PR'}
            </button>
          </>
        ) : (
          <>
            <button className="btn ghost" onClick={onClose}>
              {step === 'done' || existingOpen ? 'Cerrar' : 'Cancelar'}
            </button>
            {step === 'form' && !existingOpen && (
              <button className="btn primary" onClick={() => void review()} disabled={blocked || !title.trim() || !prBase.trim()}>
                Revisar…
              </button>
            )}
          </>
        )}
      </div>
    </SubDialog>
  )
}

export function SubDialog({
  title,
  icon,
  onClose,
  children,
  wide
}: {
  title: string
  icon: React.ReactNode
  onClose: () => void
  children: React.ReactNode
  wide?: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input:not([readonly]),textarea,button.primary')?.focus()
  }, [])
  return (
    <div className="f-git-sub-backdrop">
      <div ref={ref} className={`f-git-sub ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="f-git-sub-head">
          {icon}
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={14} aria-hidden="true" />
          </button>
        </header>
        <div className="f-git-sub-body">{children}</div>
      </div>
    </div>
  )
}
