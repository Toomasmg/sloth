import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ArrowBendUpLeft, PaperPlaneRight, PencilSimple, X } from '@phosphor-icons/react'
import { CHAT_LIMITS, type ChatConvRef, type ChatMessage, type ChatProfile } from '../../../../shared/chat'
import { applyMention, mentionQueryAt } from '../../../../shared/chat-text'
import { Button, IconButton } from '../../ui'
import { firstWords } from './alerts'
import { composerKey, lastEditable, type ComposerMode } from './message-ops'
import { ConfirmInline } from './teams/shared'
import { editMessage, errText, getDraft, mentionCandidates, pingTyping, removeMessage, sendMessage, setDraft } from './store'

const MAX_SUGGESTIONS = 6

export interface ComposerHandle {
  startReply(m: ChatMessage): void
  startEdit(m: ChatMessage): void
  focus(): void
}

interface Props {
  conv: ChatConvRef
  meId?: string
  list: readonly ChatMessage[]
  /** El servidor tiene la 0004: sin eso no hay editar ni responder. */
  extras: boolean
  onSent(): void
  /** Esc sin nada que cancelar: el foco sale de la caja. */
  onEscape(): void
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ conv, meId, list, extras, onSent, onEscape }, ref) {
  const [text, setText] = useState(() => getDraft(conv))
  const [mode, setMode] = useState<ComposerMode>({ kind: 'new' })
  const [err, setErr] = useState<string>()
  const [caret, setCaret] = useState(0)
  const [people, setPeople] = useState<ChatProfile[]>([])
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<number>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const saved = useRef('')
  const caretToEnd = useRef(false)
  const peopleLoaded = useRef(false)
  const taId = useId()
  const countId = useId()
  const listId = useId()
  const over = text.length > CHAT_LIMITS.body
  const near = text.length > CHAT_LIMITS.body - 300

  const query = mentionQueryAt(text, caret)
  const matches = query
    ? people.filter((p) => p.login.toLowerCase().includes(query.query.toLowerCase())).slice(0, MAX_SUGGESTIONS)
    : []
  const listOpen = !!query && matches.length > 0 && dismissed !== query.start
  const activeAt = Math.min(active, Math.max(0, matches.length - 1))
  const optId = (i: number): string => `${listId}-${i}`

  useEffect(() => {
    if (!query || peopleLoaded.current) return
    peopleLoaded.current = true
    mentionCandidates(conv)
      .then(setPeople)
      .catch(() => {
        peopleLoaded.current = false
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query !== undefined])

  useEffect(() => {
    if (!caretToEnd.current) return
    caretToEnd.current = false
    const ta = taRef.current
    if (!ta) return
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
  }, [mode, text])

  const startReply = (m: ChatMessage): void => {
    setMode({
      kind: 'reply',
      to: { id: m.id, authorLogin: m.author.login, excerpt: firstWords(m.body, CHAT_LIMITS.replyExcerpt), deleted: false }
    })
    setConfirmDelete(false)
    taRef.current?.focus()
  }

  const startEdit = (m: ChatMessage): void => {
    if (mode.kind !== 'edit') saved.current = text
    setMode({ kind: 'edit', id: m.id, original: m.body })
    setText(m.body)
    setConfirmDelete(false)
    setErr(undefined)
    caretToEnd.current = true
  }

  useImperativeHandle(ref, () => ({ startReply, startEdit, focus: () => taRef.current?.focus() }))

  const cancelMode = (): void => {
    if (mode.kind === 'edit') {
      setText(saved.current)
      setDraft(conv, saved.current)
    }
    setMode({ kind: 'new' })
    setConfirmDelete(false)
    setErr(undefined)
    taRef.current?.focus()
  }

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    const body = text.trim()
    if (over) return
    if (mode.kind === 'edit') {
      if (!body) {
        setConfirmDelete(true)
        return
      }
      if (body === mode.original) return cancelMode()
      try {
        await editMessage(conv, mode.id, body)
        cancelMode()
      } catch (ex) {
        setErr(errText(ex))
      }
      return
    }
    if (!body) return
    const replyTo = mode.kind === 'reply' ? mode.to : undefined
    setText('')
    setDraft(conv, '')
    setMode({ kind: 'new' })
    setErr(undefined)
    onSent()
    try {
      await sendMessage(conv, body, replyTo)
    } catch (ex) {
      setErr(errText(ex))
    }
  }

  const removeEdited = async (): Promise<void> => {
    if (mode.kind !== 'edit') return
    const target = list.find((m) => m.id === mode.id)
    setConfirmDelete(false)
    try {
      if (target) await removeMessage(target)
      cancelMode()
    } catch (ex) {
      setErr(errText(ex))
    }
  }

  const pick = (p: ChatProfile): void => {
    if (!query) return
    const ta = taRef.current
    const to = ta?.selectionStart ?? caret
    const next = applyMention(text, query.start, to, p.login)
    setText(next.text)
    setDraft(conv, next.text)
    setCaret(next.caret)
    requestAnimationFrame(() => {
      ta?.focus()
      ta?.setSelectionRange(next.caret, next.caret)
    })
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    const composing = e.nativeEvent.isComposing
    if (listOpen && !composing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        setActive((activeAt + d + matches.length) % matches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(matches[activeAt])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (query) setDismissed(query.start)
        return
      }
    }
    const act = composerKey(e.key, { shift: e.shiftKey, composing }, text, mode)
    if (act === 'send') {
      e.preventDefault()
      void submit()
    } else if (act === 'editLast') {
      const last = meId ? lastEditable(list, meId) : undefined
      if (extras && last) {
        e.preventDefault()
        startEdit(last)
      }
    } else if (act === 'cancel') {
      e.preventDefault()
      cancelMode()
    } else if (e.key === 'Escape' && !composing) {
      e.preventDefault()
      onEscape()
    }
  }

  const editing = mode.kind === 'edit'

  return (
    <form className="f-chat-composer" onSubmit={(e) => void submit(e)}>
      {err && (
        <p className="f-chat-err" role="alert">
          {err}
        </p>
      )}
      {mode.kind !== 'new' && (
        <div className="f-chat-mode">
          {editing ? <PencilSimple size={14} aria-hidden="true" /> : <ArrowBendUpLeft size={14} aria-hidden="true" />}
          <span className="f-chat-mode-text">
            {mode.kind === 'reply' ? (
              <>
                Respondiendo a <strong>@{mode.to.authorLogin}</strong>: {mode.to.excerpt}
              </>
            ) : (
              'Editando mensaje'
            )}
          </span>
          <IconButton label={editing ? 'Cancelar edición' : 'Cancelar respuesta'} shortcut="Esc" size="sm" icon={<X size={12} />} onClick={cancelMode} />
        </div>
      )}
      {confirmDelete && (
        <ConfirmInline
          id={`${taId}-del`}
          message="El mensaje quedó vacío. ¿Eliminarlo? Lo deja de ver todo el equipo."
          confirmLabel="Eliminar"
          onConfirm={() => void removeEdited()}
          onCancel={() => {
            setConfirmDelete(false)
            taRef.current?.focus()
          }}
        />
      )}
      <div className="f-chat-field">
        {listOpen && (
          <ul className="f-chat-suggest" role="listbox" id={listId} aria-label="Personas para mencionar">
            {matches.map((p, i) => (
              <li
                key={p.id}
                id={optId(i)}
                role="option"
                aria-selected={i === activeAt}
                className="f-chat-suggest-opt"
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(p)
                }}
              >
                <strong>@{p.login}</strong>
                {p.name && <span className="hint">{p.name}</span>}
              </li>
            ))}
          </ul>
        )}
        <label className="sr-only" htmlFor={taId}>
          Escribí un mensaje
        </label>
        <textarea
          id={taId}
          ref={taRef}
          data-chat-composer=""
          rows={2}
          value={text}
          placeholder="Escribí un mensaje. Enter envía, Shift+Enter salta de línea."
          aria-describedby={countId}
          aria-invalid={over || undefined}
          aria-autocomplete="list"
          aria-controls={listOpen ? listId : undefined}
          aria-activedescendant={listOpen ? optId(activeAt) : undefined}
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart)
            setActive(0)
            setDismissed(undefined)
            if (!editing) {
              setDraft(conv, e.target.value)
              if (e.target.value) pingTyping(conv)
            }
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKey}
        />
      </div>
      <div className="f-chat-composer-foot">
        <span id={countId} className={over ? 'f-chat-count over' : 'f-chat-count'}>
          {over ? `Pasaste el límite: ${text.length}/${CHAT_LIMITS.body}` : near ? `${text.length}/${CHAT_LIMITS.body}` : ''}
        </span>
        <Button type="submit" look="classic" size="sm" variant="primary" disabled={(!text.trim() && !editing) || over}>
          <PaperPlaneRight size={14} aria-hidden="true" />
          {editing ? 'Guardar' : 'Enviar'}
        </Button>
      </div>
    </form>
  )
})
