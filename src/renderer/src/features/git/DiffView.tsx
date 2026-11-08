import { useEffect, useMemo, useState } from 'react'
import { useUi } from '../host'
import { WarnGlyph } from './glyphs'
import { errText, fmtSize, lineClass, pairRows, type DiffLine, type DiffRes } from './util'

const PAGE = 2000

/** Diff del archivo seleccionado: unificado o lado a lado, con paginado para archivos largos. */
export function DiffView({
  wsId,
  path,
  view,
  onError
}: {
  wsId: string
  path: string
  view: 'uni' | 'split'
  onError: (m: string) => void
}): React.JSX.Element {
  const ui = useUi()
  const [limit, setLimit] = useState(PAGE)
  const [res, setRes] = useState<DiffRes | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLimit(PAGE)
    setRes(null)
  }, [path])

  useEffect(() => {
    let alive = true
    setLoading(true)
    ui.invoke<DiffRes>('feat:git:diff', wsId, path, limit)
      .then((r) => alive && setRes(r))
      .catch((e) => alive && onError(errText(e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, path, limit])

  const rows = useMemo(() => (res && res.kind === 'text' && view === 'split' ? pairRows(res.lines) : []), [res, view])

  if (!res) return <div className="f-git-diff-msg">{loading ? 'Cargando diff…' : ''}</div>
  if (res.kind === 'binary')
    return (
      <div className="f-git-diff-msg">
        <WarnGlyph size={14} /> Archivo binario{res.size ? ` (${fmtSize(res.size)})` : ''}: no se muestra el diff.
      </div>
    )
  if (res.kind === 'huge')
    return (
      <div className="f-git-diff-msg">
        <WarnGlyph size={14} /> Archivo enorme ({fmtSize(res.size)}): no se muestra el diff. Abrilo con tu editor.
      </div>
    )
  if (res.kind === 'empty') return <div className="f-git-diff-msg">Sin diferencias de contenido (archivo vacío o solo cambió el modo).</div>
  if (res.kind === 'missing') return <div className="f-git-diff-msg">El archivo ya no existe.</div>

  const more = res.truncated && (
    <div className="f-git-more">
      <span className="hint">Mostrando {res.lines.length} líneas.</span>
      <button className="btn sm" onClick={() => setLimit((n) => n + PAGE)} disabled={loading}>
        {loading ? 'Cargando…' : `Ver ${PAGE} más`}
      </button>
    </div>
  )

  if (view === 'split') {
    return (
      <div className="f-git-diff f-git-split" role="region" aria-label={`Diff de ${path}`} tabIndex={0}>
        {rows.map((r, i) =>
          r.span ? (
            <div key={i} className={`f-git-l f-git-l-${lineClass(r.span.t)} f-git-l-span`}>
              <span className="f-git-txt">{r.span.s || ' '}</span>
            </div>
          ) : (
            <div key={i} className="f-git-pair">
              <Half line={r.l ?? null} side="l" />
              <Half line={r.r ?? null} side="r" />
            </div>
          )
        )}
        {more}
      </div>
    )
  }

  return (
    <div className="f-git-diff" role="region" aria-label={`Diff de ${path}`} tabIndex={0}>
      {res.lines.map((l, i) => (
        <div key={i} className={`f-git-l f-git-l-${lineClass(l.t)}`}>
          <span className="f-git-ln">{l.o ?? ''}</span>
          <span className="f-git-ln">{l.n ?? ''}</span>
          <span className="f-git-sign" aria-hidden="true">
            {l.t === '+' || l.t === '-' ? l.t : ''}
          </span>
          <span className="f-git-txt">{l.s || ' '}</span>
        </div>
      ))}
      {more}
    </div>
  )
}

function Half({ line, side }: { line: DiffLine | null; side: 'l' | 'r' }): React.JSX.Element {
  const num = line ? (side === 'l' ? line.o : line.n) : undefined
  const cls = line ? lineClass(line.t) : 'empty'
  return (
    <div className={`f-git-half f-git-half-${cls}`}>
      <span className="f-git-ln">{num ?? ''}</span>
      <span className="f-git-sign" aria-hidden="true">
        {line && (line.t === '+' || line.t === '-') ? line.t : ''}
      </span>
      <span className="f-git-txt">{line ? line.s || ' ' : ''}</span>
    </div>
  )
}
