import { useEffect, useId, useState, type FormEvent } from 'react'
import { SignIn, SignOut } from '@phosphor-icons/react'
import type { ChatConfigView } from '../../../../shared/chat'
import { useUi } from '../host'
import { baseName, hostOf } from './view-utils'
import { errText, useChatAttach, useChatSnapshot } from './store'

const DOC_URL = 'https://github.com/Toomasmg/sloth/blob/main/docs/chat-supabase.md'

type Msg = { tone: 'ok' | 'err'; text: string }

/**
 * Chat del equipo dentro de Configuración → Equipo y datos: URL y clave anon de Supabase, de dónde sale
 * la config activa, la oferta de un .sloth/team.json (solo se usa si el usuario la acepta) y la sesión.
 */
export function ChatSettings(): React.JSX.Element {
  const ui = useUi()
  useChatAttach(ui)
  const snap = useChatSnapshot()
  const [cfg, setCfg] = useState<ChatConfigView>()
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg>()
  const urlId = useId()
  const keyId = useId()

  const load = (): Promise<void> =>
    ui
      .invoke<ChatConfigView>('feat:chat:getConfig')
      .then((c) => {
        setCfg(c)
        // Prellena la URL con la activa (la clave nunca vuelve completa: solo una vista recortada).
        setUrl((u) => (u ? u : (c.active?.supabaseUrl ?? '')))
      })
      .catch((e: unknown) => setMsg({ tone: 'err', text: errText(e) }))

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Ejecuta una acción de config o sesión y muestra el resultado. */
  const act = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    setBusy(true)
    setMsg(undefined)
    try {
      await fn()
      if (ok) setMsg({ tone: 'ok', text: ok })
      await load()
    } catch (e) {
      setMsg({ tone: 'err', text: errText(e) })
    } finally {
      setBusy(false)
    }
  }

  const save = (e: FormEvent): void => {
    e.preventDefault()
    const supabaseUrl = url.trim()
    const anonKey = key.trim()
    if (!/^https:\/\//.test(supabaseUrl)) return setMsg({ tone: 'err', text: 'La URL tiene que empezar con https://.' })
    if (!anonKey) return setMsg({ tone: 'err', text: 'Falta la clave anon.' })
    void act(async () => {
      await ui.invoke('feat:chat:setConfig', { supabaseUrl, anonKey })
      setKey('')
    }, 'Guardado.')
  }

  const remove = (): void => {
    void act(() => ui.invoke('feat:chat:setConfig', null), 'Configuración borrada.')
  }

  const accept = (): void => {
    const repo = cfg?.offered?.repo
    if (!repo) return
    void act(() => ui.invoke('feat:chat:acceptTeamConfig', repo), 'Usando la configuración del repo.')
  }

  const auth = snap?.auth
  const offered = cfg?.offered
  const active = cfg?.active

  return (
    <section className="f-chat-settings" aria-labelledby="f-chat-cfg-h">
      <h3 id="f-chat-cfg-h" className="f-chat-cfg-title">
        Chat del equipo
      </h3>
      <p className="hint">Cada equipo usa su propio proyecto de Supabase. Pegá acá la URL y la clave pública (anon).</p>

      {offered && (
        <div className="f-chat-offer" role="group" aria-label="Configuración propuesta por el repo">
          <p>
            El repo <strong title={offered.repo}>{baseName(offered.repo)}</strong> propone usar el chat en{' '}
            <strong>{hostOf(offered.supabaseUrl)}</strong>. ¿Usarlo?
          </p>
          <button type="button" className="btn primary sm" onClick={accept} disabled={busy}>
            Usar
          </button>
        </div>
      )}

      <form className="f-chat-cfg-form" onSubmit={save}>
        <div className="field">
          <label htmlFor={urlId}>URL del proyecto</label>
          <input
            id={urlId}
            type="url"
            value={url}
            placeholder="https://xxxx.supabase.co"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={keyId}>Clave anon (pública)</label>
          <input
            id={keyId}
            type="text"
            value={key}
            placeholder={active ? `Actual: ${active.keyPreview}` : 'eyJ… o sb_publishable_…'}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setKey(e.target.value)}
          />
          <span className="hint">Nunca pegues la service_role: Sloth la rechaza.</span>
        </div>
        <div className="f-chat-cfg-actions">
          <button type="submit" className="btn primary sm" disabled={busy || !url.trim() || !key.trim()}>
            Guardar
          </button>
          <button
            type="button"
            className="btn sm ghost"
            onClick={remove}
            disabled={busy || active?.source !== 'settings'}
          >
            Borrar
          </button>
        </div>
      </form>

      {msg && (
        <p className={msg.tone === 'err' ? 'f-chat-err' : 'hint f-chat-ok'} role={msg.tone === 'err' ? 'alert' : 'status'}>
          {msg.text}
        </p>
      )}

      <p className="hint">
        {active ? (
          <>
            Origen: {active.source === 'settings' ? 'Configuración de Sloth' : `.sloth/team.json de ${baseName(active.repo ?? '')}`}
            {' · '}
            <span className="mono">{hostOf(active.supabaseUrl)}</span>
            {' · '}
            <span className="mono">{active.keyPreview}</span>
          </>
        ) : (
          'Sin configuración activa.'
        )}
      </p>

      <div className="f-chat-session">
        {auth?.status === 'signedIn' && (
          <>
            <span>
              Sesión: <strong>@{auth.me.login}</strong>
            </span>
            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => void act(() => ui.invoke('feat:chat:signOut'))}>
              <SignOut size={14} aria-hidden="true" />
              Cerrar sesión
            </button>
          </>
        )}
        {auth?.status === 'signedOut' && (
          <>
            <span className="hint">Sin sesión.</span>
            <button type="button" className="btn sm" disabled={busy} onClick={() => void act(() => ui.invoke('feat:chat:signIn'))}>
              <SignIn size={14} aria-hidden="true" />
              Iniciar sesión con GitHub
            </button>
          </>
        )}
        {auth?.status === 'signingIn' && (
          <>
            <span className="hint" role="status">
              Esperando el navegador…
            </span>
            <button type="button" className="btn sm ghost" onClick={() => void act(() => ui.invoke('feat:chat:cancelSignIn'))}>
              Cancelar
            </button>
          </>
        )}
        {auth?.status === 'error' && <span className="f-chat-err">{auth.message}</span>}
      </div>

      <p className="hint">
        <a href={DOC_URL} target="_blank" rel="noopener noreferrer">
          Cómo crear el Supabase del equipo
        </a>
      </p>
    </section>
  )
}
