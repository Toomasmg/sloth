import { useEffect, useState } from 'react'
import { useUi } from '../host'
import { CommitIcon, PullRequestIcon } from '../../icons/SlothIcons'
import { CheckGlyph, SpinGlyph } from './glyphs'
import { DiffView } from './DiffView'
import { KIND, TITLE_MAX, errText, plural, splitPath, suggestMessage, type FileChange, type GitShared, type StatusRes, type SyncRes } from './util'

interface Props {
  g: GitShared
  st: StatusRes
  sync: SyncRes | null
  onOpenPr: () => void
}

/** Pestaña Cambios: preparar/sacar, diff, descarte y commit. */
export function Cambios({ g, st, sync, onOpenPr }: Props): React.JSX.Element {
  const ui = useUi()
  const files = st.files
  const staged = files.filter((f) => f.staged)
  const unstaged = files.filter((f) => !f.staged)
  const prot = st.protected
  const branch = st.branch ?? null

  const [selPath, setSelPath] = useState<string | null>(null)
  const sel: FileChange | null = files.find((f) => f.path === selPath) ?? files[0] ?? null
  const [view, setView] = useState<'uni' | 'split'>('uni')
  const [discarding, setDiscarding] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [commitErr, setCommitErr] = useState('')
  const [genNote, setGenNote] = useState(false)
  const [diffErr, setDiffErr] = useState('')

  useEffect(() => {
    setDiscarding(false)
    setTyped('')
    setDiffErr('')
  }, [sel?.path])

  const titleLine = msg.split('\n')[0] ?? ''
  const titleLen = [...titleLine].length
  const titleLong = titleLen > TITLE_MAX

  /** Corre una acción: marca ocupado y pasa el error al banner del panel. */
  const act = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key)
    try {
      await fn()
    } catch (e) {
      g.fail(errText(e))
    } finally {
      setBusy('')
    }
  }

  const toggle = (f: FileChange): void =>
    void act(`f:${f.path}`, async () => {
      await ui.invoke(f.staged ? 'feat:git:unstage' : 'feat:git:stage', g.wsId, f.path)
      await g.reload()
    })

  const bulk = (stage: boolean): void =>
    void act('all', async () => {
      await ui.invoke(stage ? 'feat:git:stageAll' : 'feat:git:unstageAll', g.wsId)
      await g.reload()
    })

  const discard = (): void => {
    if (!sel) return
    const name = splitPath(sel.path).name
    void act('discard', async () => {
      await ui.invoke('feat:git:discard', g.wsId, sel.path, sel.code === '??' ? typed : undefined)
      setDiscarding(false)
      g.say(`Cambios descartados en ${name}`)
      await g.reload()
    })
  }

  const doCommit = async (openPr: boolean): Promise<void> => {
    setCommitErr('')
    if (staged.length === 0) return setCommitErr('No hay archivos preparados. Marcá al menos uno con su casilla para confirmarlo.')
    if (!msg.trim()) return setCommitErr('Falta el mensaje del commit. Escribilo o tocá «Que lo escriba Claude».')
    if (prot) return setCommitErr(`No se commitea directo en ${branch ?? 'HEAD separado'}. Creá una rama nueva desde Ramas.`)
    setBusy('commit')
    try {
      const sha = await ui.invoke<string>('feat:git:commit', g.wsId, msg.trim())
      setMsg('')
      setGenNote(false)
      g.say(`Commit ${sha} creado`)
      await g.reload()
      if (openPr) onOpenPr()
    } catch (e) {
      setCommitErr(errText(e))
    } finally {
      setBusy('')
    }
  }

  const genMsg = (): void => {
    setCommitErr('')
    if (staged.length === 0) return setCommitErr('Preparà al menos un archivo para que Claude escriba el mensaje.')
    const s = suggestMessage(staged)
    setMsg(s.body ? `${s.title}\n\n${s.body}` : s.title)
    setGenNote(true)
    g.say('Sugerencia lista: revisala antes de confirmar')
  }

  const pushNow = (): void =>
    void act('push', async () => {
      if (!branch) return
      await ui.invoke('feat:git:push', g.wsId, branch)
      g.say(`Subido a origin/${branch}`)
      await g.reload()
    })

  // ----- Sin cambios -----
  if (files.length === 0) {
    const ahead = sync?.ahead ?? 0
    return (
      <div className="g-empty">
        <span className="g-empty-ico" aria-hidden="true">
          <CheckGlyph size={20} />
        </span>
        <div className="g-empty-t">No hay cambios sin confirmar</div>
        <div className="g-empty-h">
          {ahead > 0 ? 'Tu último commit todavía no está en origin.' : `Todo lo que hiciste ya está en origin/${branch ?? 'la rama'}.`}
        </div>
        {ahead > 0 && branch && (
          <button type="button" className="g-btn-solid" onClick={pushNow} disabled={busy !== ''}>
            {busy === 'push' ? <SpinGlyph /> : null}
            Subir {plural(ahead, 'commit', 'commits')} a origin
          </button>
        )}
      </div>
    )
  }

  const askName = sel ? splitPath(sel.path).name : ''
  const untracked = sel?.code === '??'

  return (
    <div className="g-changes">
      <div className="g-lists">
        <section aria-label="Archivos preparados">
          <div className="g-sec-h">
            <span className="g-sec-t">Preparados · {staged.length}</span>
            <span className="g-spacer" />
            <button type="button" className="g-link" onClick={() => bulk(false)} disabled={staged.length === 0 || busy !== ''}>
              Sacar todo
            </button>
          </div>
          {staged.length === 0 && <div className="g-sec-hint">Nada preparado todavía. Marcá un archivo para confirmarlo.</div>}
          <ul className="g-list" aria-label="Lista de preparados">
            {staged.map((f) => (
              <FileRow key={f.path} f={f} selected={sel?.path === f.path} onSelect={() => setSelPath(f.path)} onToggle={() => toggle(f)} disabled={busy !== ''} />
            ))}
          </ul>
        </section>

        <section aria-label="Archivos sin preparar">
          <div className="g-sec-h">
            <span className="g-sec-t">Sin preparar · {unstaged.length}</span>
            <span className="g-spacer" />
            <button type="button" className="g-link" onClick={() => bulk(true)} disabled={unstaged.length === 0 || busy !== ''}>
              Preparar todo
            </button>
          </div>
          {unstaged.length === 0 && <div className="g-sec-hint">Todo está preparado.</div>}
          <ul className="g-list" aria-label="Lista de sin preparar">
            {unstaged.map((f) => (
              <FileRow key={f.path} f={f} selected={sel?.path === f.path} onSelect={() => setSelPath(f.path)} onToggle={() => toggle(f)} disabled={busy !== ''} />
            ))}
          </ul>
        </section>
      </div>

      {sel && (
        <div className="g-diffbox">
          <div className="g-diffbar">
            <span className="g-diffname mono">
              <span className="g-dir">{splitPath(sel.path).dir}</span>
              {askName}
            </span>
            <span className="g-stat mono">
              <span className="f-git-plus">+{sel.add ?? 0}</span> <span className="f-git-minus">−{sel.del ?? 0}</span>
            </span>
            <span className="g-spacer" />
            <div className="g-seg" role="group" aria-label="Forma del diff">
              <button type="button" aria-pressed={view === 'uni'} onClick={() => setView('uni')}>
                Unificado
              </button>
              <button type="button" aria-pressed={view === 'split'} onClick={() => setView('split')}>
                Lado a lado
              </button>
            </div>
            <button type="button" className="g-danger-link" onClick={() => setDiscarding(true)} disabled={busy !== ''}>
              Descartar cambios de este archivo
            </button>
          </div>

          {discarding && (
            <div className="g-confirm" role="alertdialog" aria-label="Confirmar descarte">
              {untracked ? (
                <>
                  <div className="g-confirm-t">
                    Se va a borrar <span className="mono">{askName}</span>, que todavía no está en git. Se pierde y no se puede deshacer. Escribí su nombre para confirmar.
                  </div>
                  <input
                    className="g-confirm-in mono"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    aria-label={`Escribí ${askName} para confirmar`}
                    placeholder={askName}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </>
              ) : (
                <span className="g-confirm-t">¿Descartar los cambios de {askName}? Se pierden y no se puede deshacer.</span>
              )}
              <button type="button" className="g-btn-ghost" onClick={() => setDiscarding(false)}>
                Cancelar
              </button>
              <button
                type="button"
                className="g-btn-danger"
                onClick={discard}
                disabled={busy !== '' || (untracked && typed !== askName)}
              >
                {untracked ? 'Borrar archivo' : 'Sí, descartar'}
              </button>
            </div>
          )}

          <div className="g-diffscroll">
            <DiffView key={sel.path} wsId={g.wsId} path={sel.path} view={view} onError={setDiffErr} />
          </div>
          {diffErr && <p className="form-error g-inline-err">{diffErr}</p>}
        </div>
      )}

      <form
        className="g-commit"
        onSubmit={(e) => {
          e.preventDefault()
          void doCommit(false)
        }}
      >
        <div className="g-commit-h">
          <label htmlFor="g-commit-msg">Mensaje del commit</label>
          <span className="g-spacer" />
          <span className={`g-count mono ${titleLong ? 'long' : ''}`}>
            Título {titleLen}/{TITLE_MAX}
          </span>
        </div>
        <textarea
          id="g-commit-msg"
          className="g-textarea"
          rows={3}
          value={msg}
          onChange={(e) => {
            setMsg(e.target.value)
            setCommitErr('')
            setGenNote(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void doCommit(false)
            }
          }}
          aria-describedby="g-commit-hints"
          placeholder="Qué cambiaste y por qué (Ctrl+Enter confirma)"
          maxLength={10000}
        />
        <div id="g-commit-hints" className="g-hints">
          {titleLong && <div className="g-warn-txt">El título pasa de {TITLE_MAX} caracteres. Acortalo: en el historial se corta.</div>}
          {genNote && <div className="hint">Sugerencia armada a partir de los archivos y sus cambios. Es editable: revisala antes de confirmar.</div>}
          {commitErr && (
            <div role="alert" className="form-error">
              {commitErr}
            </div>
          )}
        </div>
        <div className="g-commit-actions">
          <button type="button" className="g-btn-ghost" onClick={genMsg} disabled={busy !== ''}>
            Que lo escriba Claude
          </button>
          <span className="g-spacer" />
          <button type="button" className="g-btn-plain" onClick={() => void doCommit(true)} disabled={busy !== ''}>
            <PullRequestIcon size={13} /> Confirmar y abrir PR
          </button>
          <button type="submit" className="g-btn-solid" disabled={busy !== ''}>
            {busy === 'commit' ? <SpinGlyph /> : <CommitIcon size={13} />}
            Confirmar {plural(staged.length, 'archivo', 'archivos')}
          </button>
        </div>
      </form>
    </div>
  )
}

function FileRow({
  f,
  selected,
  onSelect,
  onToggle,
  disabled
}: {
  f: FileChange
  selected: boolean
  onSelect: () => void
  onToggle: () => void
  disabled: boolean
}): React.JSX.Element {
  const k = KIND[f.code]
  const { dir, name } = splitPath(f.path)
  return (
    <li className={`g-row ${selected ? 'sel' : ''}`}>
      <input
        type="checkbox"
        className="g-check"
        checked={Boolean(f.staged)}
        onChange={onToggle}
        disabled={disabled}
        aria-label={f.staged ? `Sacar de preparados ${f.path}` : `Preparar ${f.path}`}
      />
      <button type="button" className="g-rowbtn" onClick={onSelect} aria-current={selected ? 'true' : undefined} title={f.orig ? `${f.orig} → ${f.path}` : f.path}>
        <span className={`g-kind g-kind-${k.cls}`} aria-hidden="true">
          {k.letter}
        </span>
        <span className="sr-only">{k.label}</span>
        <span className="g-path mono">
          <span className="g-dir">{dir}</span>
          {name}
        </span>
        <span className="g-stat mono">
          {f.binary ? (
            <span className="hint">bin</span>
          ) : f.huge ? (
            <span className="hint">enorme</span>
          ) : (
            <>
              <span className="f-git-plus">+{f.add ?? 0}</span> <span className="f-git-minus">−{f.del ?? 0}</span>
            </>
          )}
        </span>
      </button>
    </li>
  )
}
