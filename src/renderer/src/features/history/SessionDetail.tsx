import { useEffect, useRef, useState } from 'react'
import { useUi } from '../host'
import { cleanError } from '../../format'
import { EyeIcon, HideIcon, PencilIcon, TerminalIcon } from '../../icons/SlothIcons'
import { PaneMenu, type PaneMenuItem } from '../../layout/PaneMenu'
import { dayLabel, durLabel, fmtTime, plainSummary, plural, spaceColor, STATUS_LABEL } from './model'
import type { DetailItem, OpenResult, PrefsReply, SessionInfo, SessionRow } from './types'

/** Detalle de una sesión: cabecera, acciones, última respuesta, conversación y archivos tocados. */
export function SessionDetail({
  row,
  isPinned,
  isHidden,
  status,
  onPrefs,
  onResumed,
  onDeleted,
  onNotice,
  say
}: {
  row: SessionRow
  isPinned: boolean
  isHidden: boolean
  status: 'perm' | 'ok' | 'int'
  onPrefs: (p: PrefsReply) => void
  /** Se llama cuando la conversación ya se está retomando (la página se cierra). */
  onResumed: () => void
  /** La conversación fue a la Papelera: la página la saca de la lista. */
  onDeleted: (p: PrefsReply) => void
  onNotice: (m: string | null) => void
  say: (m: string) => void
}): React.JSX.Element {
  const ui = useUi()
  const inv = useRef(ui.invoke)
  inv.current = ui.invoke
  const [info, setInfo] = useState<SessionInfo | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<Record<number, boolean>>({})
  const [askHide, setAskHide] = useState(false)
  const [askDel, setAskDel] = useState(false)
  const [deleting, setDeleting] = useState(false)
  /** Nombre del espacio con terminal abierta: hay que confirmar antes de retomar ahí. */
  const [wsConfirm, setWsConfirm] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    inv
      .current<SessionInfo>('feat:history:detail', row.accountId, row.sessionId)
      .then((i) => {
        if (alive) setInfo(i)
      })
      .catch((e) => {
        if (alive) setErr(cleanError(e))
      })
    return () => {
      alive = false
    }
  }, [row.accountId, row.sessionId])

  const resume = async (confirmRestart = false): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const r = await inv.current<OpenResult>('feat:history:open', {
        accountId: row.accountId,
        sessionId: row.sessionId,
        cwd: row.cwd,
        confirmRestart
      })
      if (r.needsConfirm) {
        setWsConfirm(r.wsName ?? 'ese espacio')
        return
      }
      setWsConfirm(null)
      if (r.manualCommand) {
        onNotice(`«${r.wsName}» no arranca Claude solo. Para retomar esta conversación corré en su terminal: ${r.manualCommand}`)
        return
      }
      onResumed()
    } catch (e) {
      setErr(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  const togglePin = async (): Promise<void> => {
    try {
      onPrefs(await inv.current<PrefsReply>('feat:history:pin', row.key, !isPinned))
      say(isPinned ? 'Quitada de fijadas' : 'Fijada arriba')
    } catch (e) {
      setErr(cleanError(e))
    }
  }

  const setHidden = async (on: boolean): Promise<void> => {
    try {
      onPrefs(await inv.current<PrefsReply>('feat:history:hide', row.key, on))
      setAskHide(false)
      say(on ? 'Quitada de la lista. La conversación de Claude no se tocó.' : 'Vuelve a aparecer en la lista')
    } catch (e) {
      setErr(cleanError(e))
    }
  }

  const removeConv = async (): Promise<void> => {
    setDeleting(true)
    setErr(null)
    try {
      const p = await inv.current<PrefsReply>('feat:history:delete', row.accountId, row.sessionId)
      setAskDel(false)
      onDeleted(p)
    } catch (e) {
      setErr(cleanError(e))
    } finally {
      setDeleting(false)
    }
  }

  const menuItems: PaneMenuItem[] = [
    isHidden
      ? { id: 'show', label: 'Volver a mostrar', icon: <EyeIcon size={15} />, onSelect: () => void setHidden(false) }
      : {
          id: 'hide',
          label: 'Quitar de la lista',
          hint: 'La conversación no se toca',
          icon: <HideIcon size={15} />,
          onSelect: () => setAskHide(true)
        }
  ]

  const copy = (): void => {
    if (!info) return
    window.sloth
      .clipboardWrite(plainSummary(info))
      .then(() => say('Resumen copiado'))
      .catch(() => say('No se pudo copiar el resumen'))
  }

  const exportMd = async (): Promise<void> => {
    setErr(null)
    try {
      const r = await inv.current<{ file: string } | null>('feat:history:export', row.accountId, row.sessionId)
      if (r) say(`Exportado como ${r.file}`)
    } catch (e) {
      setErr(cleanError(e))
    }
  }

  const files = info?.files ?? row.files
  const adds = files.reduce((a, f) => a + f.add, 0)
  const dels = files.reduce((a, f) => a + f.del, 0)
  const msgCount = info ? info.messages : row.messages

  return (
    <div className="hd">
      <div className="hd-top">
        <div className="hd-crumb">
          <span className="hist-dot" style={{ background: spaceColor(row.spaceKey) }} aria-hidden="true" />
          {row.spaceName} · {row.accountLabel}
        </div>
        <h2 className="hd-title">{row.title}</h2>
        <div className="hd-meta">
          <span>
            {dayLabel(row.start)}, {fmtTime(row.start)}
          </span>
          <span>{durLabel(row.start, row.end)}</span>
          <span>{plural(msgCount, 'mensaje', 'mensajes')}</span>
          <span>{plural(files.length, 'archivo', 'archivos')}</span>
          <span className={`chip ${status === 'perm' ? 'chip-perm' : status === 'ok' ? 'chip-done' : 'chip-idle'}`}>{STATUS_LABEL[status]}</span>
          {isHidden && <span className="chip chip-idle">Oculta en Sloth</span>}
        </div>
        <div className="hd-path">
          {row.cwd}
          {row.branch ? ` · ${row.branch}` : ''}
        </div>
      </div>

      <div className="hd-actions">
        <button type="button" className="btn primary" onClick={() => void resume(false)} disabled={busy}>
          {busy ? 'Abriendo…' : 'Retomar esta sesión'}
        </button>
        <button type="button" className="btn" aria-pressed={isPinned} onClick={() => void togglePin()}>
          {isPinned ? 'Quitar de fijadas' : 'Fijar'}
        </button>
        <button type="button" className="btn" onClick={copy} disabled={!info}>
          Copiar resumen
        </button>
        <button type="button" className="btn" onClick={() => void exportMd()} disabled={!info}>
          Exportar como Markdown
        </button>
        <span className="hist-grow" />
        <button type="button" className="btn ghost hd-del" onClick={() => setAskDel(true)} disabled={deleting}>
          Borrar
        </button>
        <PaneMenu label="Más acciones de la conversación" items={menuItems} />
      </div>

      {askDel && (
        <div className="hd-box danger" role="group" aria-label="Confirmar borrado">
          <span className="hd-box-text">
            ¿Borrar «{row.title}»? Va a la Papelera de Windows; podés recuperarla desde ahí.
          </span>
          <button type="button" className="btn ghost" onClick={() => setAskDel(false)} disabled={deleting}>
            Cancelar
          </button>
          <button type="button" className="btn danger" onClick={() => void removeConv()} disabled={deleting} autoFocus>
            {deleting ? 'Borrando…' : 'Sí, borrar'}
          </button>
        </div>
      )}

      {wsConfirm && (
        <div className="hd-box" role="group" aria-label="Confirmar retomar">
          <span className="hd-box-text">«{wsConfirm}» tiene la terminal abierta: se cierra y Claude retoma esta conversación ahí.</span>
          <button type="button" className="btn ghost" onClick={() => setWsConfirm(null)}>
            Cancelar
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void resume(true)} autoFocus>
            Retomar ahí
          </button>
        </div>
      )}

      {askHide && (
        <div className="hd-box danger" role="group" aria-label="Confirmar quitar de la lista">
          <span className="hd-box-text">
            ¿Quitar «{row.title}» de la lista de Sloth? La conversación de Claude no se borra: sigue en tu carpeta de Claude. Podés volver a
            mostrarla desde el historial.
          </span>
          <button type="button" className="btn ghost" onClick={() => setAskHide(false)}>
            Cancelar
          </button>
          <button type="button" className="btn danger" onClick={() => void setHidden(true)} autoFocus>
            Quitar de la lista
          </button>
        </div>
      )}

      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}

      <section className="hd-sec" aria-label="Resumen">
        <h3>Resumen</h3>
        {info ? (
          <p className="hd-summary">{info.lastAnswer || 'Esta sesión no tiene respuestas de texto de Claude.'}</p>
        ) : (
          <p className="hint">Cargando la conversación…</p>
        )}
      </section>

      {info && (
        <section className="hd-sec hd-conv" aria-label="Conversación">
          <h3>
            Conversación · {plural(info.messages, 'mensaje', 'mensajes')}
          </h3>
          {info.items.map((it, i) => (
            <Item key={i} it={it} open={!!open[i]} onToggle={() => setOpen((o) => ({ ...o, [i]: !o[i] }))} />
          ))}
          {info.items.length === 0 && <p className="hint">No hay mensajes para mostrar.</p>}
        </section>
      )}

      <section className="hd-sec" aria-label="Archivos tocados">
        <h3>
          Archivos tocados{files.length ? ` · ${files.length} · +${adds} −${dels}` : ''}
        </h3>
        {files.length > 0 ? (
          <div className="hd-files">
            {files.map((f) => (
              <div key={f.path} className="hd-file">
                <span className="hd-file-p">{f.path}</span>
                <span className="hd-add">+{f.add}</span>
                <span className={`hd-del ${f.del ? '' : 'zero'}`}>−{f.del}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="hint">Esta sesión no tocó archivos.</p>
        )}
      </section>
    </div>
  )
}

function Item({ it, open, onToggle }: { it: DetailItem; open: boolean; onToggle: () => void }): React.JSX.Element {
  if (it.k === 'msg') {
    const user = it.role === 'user'
    return (
      <div className="hd-msg">
        <span className={`hd-av ${user ? 'user' : 'claude'}`} aria-hidden="true">
          {user ? 'V' : 'C'}
        </span>
        <div className="hd-msg-body">
          <div className="hd-who">{user ? 'Vos' : 'Claude'}</div>
          <p className="hd-text">{it.text}</p>
        </div>
      </div>
    )
  }
  const Icon = it.kind === 'read' ? EyeIcon : it.kind === 'edit' ? PencilIcon : TerminalIcon
  const metaCls = it.err ? 'err' : it.kind === 'run' ? 'ok' : ''
  return (
    <div className="hd-tool">
      <button type="button" className="hd-tool-btn" aria-expanded={open} onClick={onToggle}>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`hd-chev ${open ? 'on' : ''}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
        <Icon size={14} strokeWidth={1.8} className="hd-ico" />
        <span className="hd-tool-title">{it.title}</span>
        {it.meta && <span className={`hd-tool-meta ${metaCls}`}>{it.meta}</span>}
      </button>
      {open && (
        <div className={`hd-tool-body ${it.kind === 'run' ? 'is-run' : ''}`}>
          {it.cmd && <div className="hd-cmd">$ {it.cmd}</div>}
          {it.kind !== 'run' && it.lines.map((l, i) => <div key={i}>{l}</div>)}
          {it.kind === 'run' &&
            it.lines.map((l, i) => (
              <div key={i} className={/FAIL|Error|Expected/.test(l) ? 'err' : /PASS|passed|OK/.test(l) ? 'ok' : ''}>
                {l}
              </div>
            ))}
          {it.kind === 'run' && it.lines.length === 0 && <div className="hint">Sin salida.</div>}
        </div>
      )}
    </div>
  )
}
