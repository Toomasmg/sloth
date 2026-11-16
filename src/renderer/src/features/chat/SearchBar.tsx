import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { MagnifyingGlass, X } from '@phosphor-icons/react'
import { CHAT_LIMITS, type ChatConvRef, type ChatMessage } from '../../../../shared/chat'
import { IconButton, Input } from '../../ui'
import { matchParts, snippet } from './message-ops'
import { errText, searchMessages } from './store'
import { dayLabel, timeLabel } from './view-utils'

const DEBOUNCE_MS = 300
const MIN_LETTERS = 2

interface Props {
  conv: ChatConvRef
  onJump(id: string): void
  onClose(): void
}

export function SearchBar({ conv, onJump, onClose }: Props): React.JSX.Element {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<ChatMessage[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  const seq = useRef(0)
  const listId = useId()
  const term = q.trim()

  const run = (value: string): void => {
    const n = ++seq.current
    setBusy(true)
    setErr(undefined)
    searchMessages(conv, value)
      .then((r) => n === seq.current && setResults(r))
      .catch((e: unknown) => n === seq.current && setErr(errText(e)))
      .finally(() => n === seq.current && setBusy(false))
  }

  useEffect(() => {
    if (term.length < MIN_LETTERS) {
      seq.current++
      setResults(null)
      setBusy(false)
      return
    }
    const t = setTimeout(() => run(term), DEBOUNCE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term])

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter' && term.length >= MIN_LETTERS) {
      e.preventDefault()
      run(term)
    }
  }

  const now = Date.now()
  return (
    <section className="f-chat-search" aria-label="Buscar en la conversación" onKeyDown={onKey}>
      <div className="f-chat-search-row">
        <Input
          autoFocus
          size="sm"
          type="search"
          value={q}
          maxLength={CHAT_LIMITS.searchQuery}
          placeholder="Buscar en esta conversación"
          aria-label="Buscar en esta conversación"
          aria-controls={listId}
          prefix={<MagnifyingGlass size={14} />}
          onChange={(e) => setQ(e.target.value)}
        />
        <IconButton label="Cerrar búsqueda" shortcut="Esc" size="sm" icon={<X size={14} />} onClick={onClose} />
      </div>
      <div id={listId} className="f-chat-results" role="region" aria-label="Resultados" aria-live="polite">
        {err && (
          <p className="f-chat-err" role="alert">
            {err}
          </p>
        )}
        {!err && term.length > 0 && term.length < MIN_LETTERS && <p className="hint">Escribí al menos {MIN_LETTERS} letras.</p>}
        {!err && busy && <p className="hint">Buscando…</p>}
        {!err && !busy && results && results.length === 0 && <p className="hint">No hay mensajes con «{term}».</p>}
        {!err && results && results.length > 0 && (
          <ul className="f-chat-hits">
            {results.map((m) => (
              <li key={m.id}>
                <button type="button" className="f-chat-hit" onClick={() => onJump(m.id)}>
                  <span className="f-chat-hit-head">
                    <strong>{m.author.login}</strong>
                    <span className="hint">
                      {dayLabel(m.createdAt, now)}, {timeLabel(m.createdAt)}
                    </span>
                  </span>
                  <span className="f-chat-hit-text">
                    {matchParts(snippet(m.body, term), term).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
