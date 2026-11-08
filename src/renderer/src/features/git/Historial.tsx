import { useEffect, useMemo, useState } from 'react'
import { useUi } from '../host'
import { SearchIcon } from '../../icons/SlothIcons'
import { errText, norm, plural, relTime, splitPath, type CommitFile, type GitShared, type LogEntry } from './util'

/** Pestaña Historial: commits de la rama actual, con archivos al expandir y búsqueda sin tildes. */
export function Historial({ g, rev }: { g: GitShared; rev: number }): React.JSX.Element {
  const ui = useUi()
  const [log, setLog] = useState<LogEntry[] | null>(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [files, setFiles] = useState<Record<string, CommitFile[] | 'error'>>({})

  useEffect(() => {
    let alive = true
    ui.invoke<LogEntry[]>('feat:git:log', g.wsId)
      .then((l) => {
        if (!alive) return
        setLog(l)
        setErr('')
        setFiles({})
      })
      .catch((e) => alive && setErr(errText(e)))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g.wsId, rev])

  const toggle = (c: LogEntry): void => {
    if (open === c.hash) return setOpen(null)
    setOpen(c.hash)
    if (files[c.hash]) return
    ui.invoke<CommitFile[]>('feat:git:commitFiles', g.wsId, c.hash)
      .then((list) => setFiles((m) => ({ ...m, [c.hash]: list })))
      .catch(() => setFiles((m) => ({ ...m, [c.hash]: 'error' })))
  }

  const all = log ?? []
  const nq = norm(q.trim())
  const shown = useMemo(() => (nq ? all.filter((c) => norm(c.title).includes(nq)) : all), [all, nq])
  const pending = all.filter((c) => !c.pushed).length
  const info =
    (nq ? `${shown.length} de ${all.length}` : String(all.length)) +
    (all.length === 1 ? ' commit' : ' commits') +
    (pending ? ` · ${pending} sin subir` : '')

  return (
    <div className="g-hist">
      <div className="g-hist-top">
        <label className="g-search">
          <SearchIcon size={14} aria-hidden="true" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar en el historial" aria-label="Buscar commits por mensaje" />
        </label>
        <span className="g-info">{log ? info : ''}</span>
      </div>

      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}
      {log && all.length === 0 && <div className="g-sec-hint center">Todavía no hay commits en esta rama.</div>}
      {log && all.length > 0 && shown.length === 0 && <div className="g-sec-hint center">Ningún commit tiene «{q.trim()}».</div>}

      <ul className="g-commits" aria-label="Commits de la rama actual">
        {shown.map((c) => {
          const isOpen = open === c.hash
          const list = files[c.hash]
          return (
            <li key={c.hash}>
              <button type="button" className="g-commit-row" onClick={() => toggle(c)} aria-expanded={isOpen}>
                <span className="g-hash mono">{c.short}</span>
                <span className="g-commit-txt">
                  <span className="g-commit-title">{c.title}</span>
                  <span className="g-commit-meta">
                    {c.author} · {relTime(c.date)}
                  </span>
                </span>
                {!c.pushed && <span className="g-badge-warn">sin subir</span>}
                <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={`g-chev ${isOpen ? 'up' : ''}`}>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              {isOpen && (
                <div className="g-commit-files">
                  {list === undefined && <div className="hint">Cargando archivos…</div>}
                  {list === 'error' && <div className="form-error">No se pudieron leer los archivos de este commit.</div>}
                  {Array.isArray(list) && list.length === 0 && <div className="hint">Este commit no cambia archivos.</div>}
                  {Array.isArray(list) &&
                    list.map((f) => {
                      const { dir, name } = splitPath(f.path)
                      return (
                        <div key={f.path} className="g-cfile mono">
                          <span className="g-path">
                            <span className="g-dir">{dir}</span>
                            {name}
                          </span>
                          <span className="g-stat">
                            {f.binary ? (
                              <span className="hint">bin</span>
                            ) : (
                              <>
                                <span className="f-git-plus">+{f.add ?? 0}</span> <span className="f-git-minus">−{f.del ?? 0}</span>
                              </>
                            )}
                          </span>
                        </div>
                      )
                    })}
                  {Array.isArray(list) && list.length > 0 && <div className="hint">{plural(list.length, 'archivo', 'archivos')}</div>}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
