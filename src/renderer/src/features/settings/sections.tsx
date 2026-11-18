import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useUi } from '../host'
import { TeamIcon, UpdateIcon } from '../../icons/SlothIcons'
import { LogoMark } from '../../Logo'
import type { ChatCheck, ChatCheckEstado, ChatConfigView, ChatSnapshot } from '../../../../shared/chat'
import { esHostSupabase } from '../../../../shared/chat-text'
import { openReport } from '../report/bus'
import { request as requestExportImport } from '../export-import/bus'
import { openHelp } from '../help/bus'
import { openJoinInvite } from '../chat/store'
import { runFeatureCommand } from '../palette'
import { setPhase } from '../updater/phase'
import { useUpdateDot } from '../updater/useUpdateStatus'
import { useSettings } from './store'
import { UPDATE_CHANNELS, type UpdateChannel } from '../../../../shared/settings-model'
import { errText, Group, useSave, SectionHint } from './ui'
import { Button, EmptyState, InlineAlert, Input, Tag } from '../../ui'
import { ChatClaudeGroup } from './ChatClaude'
import { Ajustes as TicketsAjustes } from '../tickets/Ajustes'
import { setBoardOpen, useSnapshot } from '../tickets/model'
import { openDialog, useTemplates, usesTicket } from '../templates/store'
import { colorHex } from '../templates/catalog'
import { shortPath } from '../../format'
import { goAfterClose, ToggleLikeButton } from './sections/comunes'
export { GeneralSection } from './sections/General'
export { AccountsSection } from './sections/Accounts'
export { AppearanceSection } from './sections/Appearance'
export { TerminalSection } from './sections/Terminal'
export { ShortcutsSection } from './sections/Shortcuts'
export { NotificationsSection } from './sections/Notifications'
/* ---------- Equipo y chat ---------- */

const CHECK_ICONO: Record<ChatCheckEstado, string> = { ok: '✔', fallo: '✖', aviso: '!', 'sin-datos': '?' }
const CHECK_ETIQUETA: Record<ChatCheckEstado, string> = { ok: 'Bien', fallo: 'Falló', aviso: 'Atención', 'sin-datos': 'Sin datos' }

function resumenChecks(checks: ChatCheck[]): string {
  const n = (e: ChatCheckEstado): number => checks.filter((c) => c.estado === e).length
  const fallos = checks.filter((c) => c.estado === 'fallo').map((c) => c.titulo)
  const partes = [`${n('ok')} bien`, `${n('aviso')} con atención`, `${fallos.length} falló${fallos.length ? `: ${fallos.join(', ')}` : ''}`]
  return `Revisión: ${partes.join(', ')}.`
}

export function TeamSection({ onClose }: { onClose(): void }): React.JSX.Element {
  const ui = useUi()
  const [snap, setSnap] = useState<ChatSnapshot | null>(null)
  const [cfg, setCfg] = useState<ChatConfigView | null>(null)
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [tried, setTried] = useState(false)
  const [testRes, setTestRes] = useState<{ ok: boolean; text: string } | null>(null)
  const [checks, setChecks] = useState<ChatCheck[] | null>(null)
  const [checksFailed, setChecksFailed] = useState(false)

  /** Consulta real a Supabase con la configuración guardada (feat:chat:test) más la revisión de solo lectura (feat:chat:validate). */
  const runTest = (): void => {
    setTesting(true)
    setTestRes(null)
    setChecks(null)
    setChecksFailed(false)
    const revision = ui.invoke<ChatCheck[]>('feat:chat:validate').then(setChecks, () => setChecksFailed(true))
    const prueba = ui.invoke<{ ok: boolean; message: string }>('feat:chat:test').then(
      (r) => setTestRes({ ok: r.ok, text: r.message }),
      (e) => setTestRes({ ok: false, text: errText(e) })
    )
    void Promise.all([prueba, revision]).finally(() => {
      setTesting(false)
      void reloadState()
    })
  }

  const loadCfg = useCallback(
    () =>
      ui.invoke<ChatConfigView>('feat:chat:getConfig').then(
        (c) => {
          setCfg(c)
          setUrl((u) => u || c.active?.supabaseUrl || '')
        },
        (e) => setMsg({ ok: false, text: errText(e) })
      ),
    [ui]
  )
  const reloadState = useCallback(() => ui.invoke<ChatSnapshot>('feat:chat:state').then(setSnap, () => undefined), [ui])

  useEffect(() => {
    void loadCfg()
    void reloadState()
    return ui.on('feat:chat:snapshot', (s: ChatSnapshot) => setSnap(s))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const act = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
      if (ok) setMsg({ ok: true, text: ok })
      await loadCfg()
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    } finally {
      setBusy(false)
    }
  }

  const saveCfg = (e: FormEvent): void => {
    e.preventDefault()
    const supabaseUrl = url.trim()
    const anonKey = key.trim()
    setTried(true)
    if (!supabaseUrl) return setMsg({ ok: false, text: 'Falta la URL del proyecto.' })
    if (!/^https:\/\//.test(supabaseUrl)) return setMsg({ ok: false, text: 'La URL tiene que empezar con https://.' })
    if (!anonKey) return setMsg({ ok: false, text: 'Falta la clave publicable.' })
    void act(async () => {
      await ui.invoke('feat:chat:setConfig', { supabaseUrl, anonKey })
      setKey('')
    }, 'Guardado.')
  }

  const auth = snap?.auth
  const conn = snap?.connection
  const host = (() => {
    try {
      return cfg?.active ? new URL(cfg.active.supabaseUrl).host : ''
    } catch {
      return ''
    }
  })()
  let title = 'Cargando…'
  let sub = ''
  let tone: 'ok' | 'warn' | 'err' | 'info' = 'info'
  if (snap && auth) {
    if (auth.status === 'unconfigured') {
      title = 'Sin configurar'
      sub = 'Pegá la URL y la clave del proyecto de Supabase para usar el chat.'
      tone = 'warn'
    } else if (auth.status === 'error') {
      title = 'Hay un problema con la conexión'
      sub = auth.message
      tone = 'err'
    } else if (auth.status === 'signedOut') {
      title = 'Falta iniciar sesión con GitHub'
      sub = 'Sin sesión no se puede usar el chat.'
      tone = 'warn'
    } else if (auth.status === 'signingIn') {
      title = 'Esperando GitHub…'
      sub = 'Terminá el inicio de sesión en el navegador.'
      tone = 'info'
    } else {
      const who = `sesión de ${auth.me.login}`
      sub = host ? `${host} · ${who}` : who
      if (conn === 'live') {
        title = 'Conectado al chat del equipo'
        tone = 'ok'
      } else if (conn === 'connecting') {
        title = 'Conectando…'
        tone = 'info'
      } else if (conn === 'retrying') {
        title = 'Reintentando la conexión…'
        tone = 'warn'
      } else {
        title = 'Sin conexión en vivo'
        tone = 'warn'
      }
    }
  }
  // Tokens del tema (oscuro y claro): cada par fondo/texto cumple contraste sobre la tarjeta.
  const toneColor = {
    ok: ['var(--done-soft)', 'var(--ok-fg)'],
    warn: ['var(--waiting-soft)', 'var(--warn-fg)'],
    err: ['var(--danger-soft)', 'var(--danger-fg)'],
    info: ['var(--info-soft)', 'var(--info)']
  }[tone]
  const signedIn = auth?.status === 'signedIn'
  const signingIn = auth?.status === 'signingIn'
  const offered = cfg?.offered
  const repoName = offered?.repo.split(/[\\/]/).filter(Boolean).pop() ?? ''

  const gh = (fn: string, ok?: string): void => {
    void act(() => ui.invoke(fn), ok)
  }

  return (
    <>
      <div className="f-set-card f-set-status">
        <span className="f-set-status-ico" style={{ background: toneColor[0], color: toneColor[1] }} aria-hidden="true">
          <TeamIcon size={18} />
        </span>
        <div className="grow">
          <div className="f-set-row-title">{title}</div>
          <div className="f-set-hint">{sub}</div>
        </div>
        <Button size="sm" disabled={testing} aria-busy={testing} onClick={runTest}>
          {testing ? 'Probando…' : 'Probar conexión'}
        </Button>
      </div>
      {testRes && (
        <p className={testRes.ok ? 'f-set-ok' : 'form-error'} role={testRes.ok ? 'status' : 'alert'}>
          {testRes.text}
        </p>
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {checksFailed ? 'No se pudo revisar el servidor.' : checks ? resumenChecks(checks) : ''}
      </div>
      {(checks || checksFailed) && (
        <div>
          {checksFailed && <p className="form-error">No se pudo revisar el servidor.</p>}
          {checks && (
            <ul className="f-set-checks" aria-label="Chequeos del servidor">
              {checks.map((c) => (
                <li key={c.id} className={`f-set-check ${c.estado}`}>
                  <span className="f-set-check-ico" aria-hidden="true">
                    {CHECK_ICONO[c.estado]}
                  </span>
                  <div>
                    <div>
                      <span className="sr-only">{CHECK_ETIQUETA[c.estado]}: </span>
                      {c.titulo}
                    </div>
                    <div className="f-set-hint">{c.detalle}</div>
                    {c.accion && <div className="f-set-hint">{c.accion}</div>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {offered && (
        <div className="f-set-card f-set-offer" role="group" aria-label="Configuración propuesta por el repo">
          <p>
            El repo <strong title={repoName}>{repoName}</strong> propone usar el chat en <strong>{new URL(offered.supabaseUrl).host}</strong>. ¿Usarlo?
          </p>
          {!esHostSupabase(new URL(offered.supabaseUrl).host) && (
            <InlineAlert tone="warning">Ese servidor no es de Supabase (supabase.co). Quien lo maneja ve todo lo que se escribe en el chat. Usalo solo si sabés de quién es.</InlineAlert>
          )}
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void act(() => ui.invoke('feat:chat:acceptTeamConfig', offered.repo), 'Usando la configuración del repo.')}>
            Usar
          </Button>
        </div>
      )}

      {!signedIn && (
        <div className="f-set-card f-set-row">
          <div className="f-set-row-text">
            <span className="f-set-row-title">¿Te mandaron una invitación?</span>
            <span className="f-set-hint">Pegala y Sloth configura el servidor, te pide iniciar sesión y te suma al equipo.</span>
          </div>
          <div className="f-set-row-ctl">
            <Button variant={auth?.status === 'unconfigured' ? 'primary' : 'secondary'} size="sm" onClick={() => openJoinInvite()}>
              Unirme con una invitación
            </Button>
          </div>
        </div>
      )}

      <form className="f-set-card f-set-form" onSubmit={saveCfg} noValidate>
        <label className="f-set-stack">
          <span className="f-set-hint">URL del proyecto de Supabase</span>
          <Input mono type="url" value={url} placeholder="https://xxxx.supabase.co" autoComplete="off" spellCheck={false} aria-invalid={tried && !url.trim()} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="f-set-stack">
          <span className="f-set-hint">Clave publicable (la que empieza con sb_publishable)</span>
          <span className="f-set-inline">
            <input
              className="f-set-input mono"
              type={showKey ? 'text' : 'password'}
              value={key}
              placeholder={cfg?.active ? `Actual: ${cfg.active.keyPreview}` : 'sb_publishable_…'}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={tried && !key.trim() && !cfg?.active}
              onChange={(e) => setKey(e.target.value)}
            />
            <Button size="sm" aria-pressed={showKey} onClick={() => setShowKey((v) => !v)}>
              {showKey ? 'Ocultar' : 'Mostrar'}
            </Button>
          </span>
        </label>
        <p className="f-set-note warn">Nunca pegues acá la clave service_role: Sloth la rechaza porque daría acceso total a la base.</p>
        <div className="f-set-actions">
          {cfg?.active?.source === 'settings' && !confirmDel && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDel(true)}>
              Borrar configuración
            </Button>
          )}
          {confirmDel && (
            <span className="f-set-confirm" role="alertdialog" aria-labelledby="f-set-del-t">
              <span id="f-set-del-t">¿Borrar la configuración del chat? Hay que volver a cargar la URL y la clave.</span>
              <Button variant="ghost" size="sm" data-autofocus onClick={() => setConfirmDel(false)}>
                Cancelar
              </Button>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => {
                  setConfirmDel(false)
                  void act(() => ui.invoke('feat:chat:setConfig', null), 'Configuración borrada.')
                }}
              >
                Sí, borrar
              </Button>
            </span>
          )}
          <Button variant="primary" size="sm" type="submit" disabled={busy}>
            Guardar
          </Button>
        </div>
      </form>

      <div className="f-set-card f-set-row">
        <div className="f-set-row-text">
          <span className="f-set-row-title">Sesión de GitHub</span>
          <span className="f-set-hint">{signedIn ? `Conectado como ${auth.me.login}` : auth?.status === 'signingIn' ? (auth.aviso ?? 'Esperando la respuesta del navegador') : 'No conectado · necesario para el chat'}</span>
        </div>
        <div className="f-set-row-ctl">
          {signingIn && (
            <Button variant="ghost" size="sm" onClick={() => gh('feat:chat:cancelSignIn')}>
              Cancelar
            </Button>
          )}
          {signedIn ? (
            <Button size="sm" disabled={busy} onClick={() => gh('feat:chat:signOut', 'Sesión de GitHub cerrada.')}>
              Cerrar sesión
            </Button>
          ) : (
            <Button variant="primary" size="sm" disabled={busy || signingIn || auth?.status === 'unconfigured'} onClick={() => gh('feat:chat:signIn')}>
              Conectar con GitHub
            </Button>
          )}
        </div>
      </div>

      {msg && (
        <p className={msg.ok ? 'f-set-ok' : 'form-error'} role={msg.ok ? 'status' : 'alert'}>
          {msg.text}
        </p>
      )}

      <ChatClaudeGroup />

      <Group id="g-tc" title="Plantillas del equipo">
        <ToggleLikeButton
          title="Importar o actualizar las plantillas del equipo"
          hint="Las trae del archivo .sloth/team.json del repo de tus espacios."
          onClick={goAfterClose(onClose, () => runFeatureCommand('team-config:import', ui))}
        />
        <ToggleLikeButton
          title="Exportar mi configuración como la del equipo"
          hint="Genera team.json en el repo con tus plantillas (sin cuentas ni rutas)."
          onClick={goAfterClose(onClose, () => runFeatureCommand('team-config:export', ui))}
        />
      </Group>
    </>
  )
}

/* ---------- Actualizaciones ---------- */

interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  error?: string
  upToDate?: boolean
  enabled: boolean
  current: string
}

export function UpdatesSection(): React.JSX.Element {
  const ui = useUi()
  const p = useSettings()
  const save = useSave()
  const [st, setSt] = useState<UpdateStatus | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** «Más tarde» dejó una versión pendiente: mismo dato que el punto del engranaje. */
  const pendiente = useUpdateDot()

  useEffect(() => {
    ui.invoke<UpdateStatus>('feat:updater:status').then(setSt, () => undefined)
    return ui.on('feat:updater:status', (s: UpdateStatus) => setSt(s))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const check = (): void => {
    setBusy(true)
    setMsg(null)
    ui.invoke<UpdateStatus>('feat:updater:check').then(
      (s) => {
        setSt(s)
        setMsg(s.state === 'available' ? `Hay una versión nueva: ${s.version ?? ''}.` : s.upToDate ? 'Tenés la última versión.' : null)
      },
      (e) => setMsg(errText(e))
    ).finally(() => setBusy(false))
  }

  const busyNow = st?.state === 'checking' || st?.state === 'downloading'
  const title = !st
    ? 'Cargando…'
    : !st.enabled
      ? 'Las actualizaciones están apagadas en desarrollo'
      : st.state === 'checking'
        ? 'Buscando una versión nueva…'
        : st.state === 'available'
          ? `Hay una versión nueva: ${st.version ?? ''}`
          : st.state === 'downloading'
            ? `Descargando ${st.version ?? ''} · ${st.percent ?? 0}%`
            : st.state === 'ready'
              ? `Versión ${st.version ?? ''} lista para instalar`
              : st.state === 'error'
                ? (st.error ?? 'No se pudo buscar actualizaciones')
                : 'Sloth está al día'

  return (
    <>
      <div className="f-set-card f-set-status">
        <span className="f-set-status-ico lg" style={{ background: 'var(--done-soft)', color: 'var(--ok-fg)' }} aria-hidden="true">
          <UpdateIcon size={18} />
        </span>
        <div className="grow">
          <div className="f-set-row-title">{title}</div>
          <div className="f-set-hint">Versión instalada: {st?.current ?? '…'}</div>
        </div>
        {st?.state === 'ready' ? (
          <Button variant="primary" size="sm" onClick={() => void ui.invoke('feat:updater:install')}>
            Reiniciar e instalar
          </Button>
        ) : (
          <Button variant="primary" size="sm" disabled={busy || busyNow || st?.enabled === false} onClick={check}>
            Buscar ahora
          </Button>
        )}
      </div>
      {msg && (
        <p role="status" className="f-set-ok">
          {msg}
        </p>
      )}
      {pendiente && st?.version && (
        <div role="status" className="f-set-card f-set-status">
          <div className="grow">
            <div className="f-set-row-title">Dejaste para después la versión {st.version}</div>
            <div className="f-set-hint">No te vuelve a avisar hasta mañana. Podés verla cuando quieras.</div>
          </div>
          <Button size="sm" onClick={() => setPhase('notes')}>
            Ver novedades
          </Button>
        </div>
      )}
      <Group id="g-canal" label="Canal de actualizaciones">
        {UPDATE_CHANNELS.map((c: UpdateChannel) => {
          const on = p.settings.updateChannel === c
          const hint = c === 'estable' ? 'Recomendado. Recibís las versiones probadas.' : 'Recibís las novedades antes, pueden tener errores.'
          return (
            <button key={c} type="button" role="radio" aria-checked={on} className="f-set-row f-set-toggle" onClick={() => save({ updateChannel: c })}>
              <span className={`f-set-radio ${on ? 'on' : ''}`} aria-hidden="true" />
              <span className="f-set-row-text">
                <span className="f-set-row-title">{c === 'estable' ? 'Estable' : 'Beta'}</span>
                <span className="f-set-hint">{hint}</span>
              </span>
            </button>
          )
        })}
      </Group>
    </>
  )
}

/* ---------- Copia de seguridad ---------- */

export function BackupSection({ onClose }: { onClose(): void }): React.JSX.Element {
  return (
    <>
      <Group id="g-bk" title="Exportar e importar">
        <ToggleLikeButton
          title="Exportar configuración…"
          hint="Un archivo .sloth con espacios, plantillas, apariencia, atajos y reglas de permisos. Sirve para pasarla a otra PC o guardarla."
          onClick={goAfterClose(onClose, () => requestExportImport({ kind: 'export' }))}
        />
        <ToggleLikeButton
          title="Importar configuración…"
          hint="Desde un archivo .sloth de otra PC. Antes te muestra qué va a agregar, y las reglas de permisos una por una."
          onClick={goAfterClose(onClose, () => requestExportImport({ kind: 'import' }))}
        />
      </Group>
      <SectionHint>
        Se lleva: espacios, plantillas, apariencia, atajos y reglas de permisos. Las sesiones de Claude nunca se exportan: en la otra PC vas a iniciar sesión de nuevo, y las credenciales de las cuentas tampoco viajan.
      </SectionHint>
    </>
  )
}

/* ---------- Acerca de ---------- */

export function AboutSection({ onClose }: { onClose(): void }): React.JSX.Element {
  const ui = useUi()
  const [version, setVersion] = useState<string>('…')
  useEffect(() => {
    ui.invoke<{ current: string }>('feat:updater:status').then((s) => setVersion(s.current), () => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Las otras ventanas se abren después de cerrar la Configuración, para que tomen el foco.
  const go = (fn: () => void) => goAfterClose(onClose, fn)
  return (
    <>
      <div className="f-set-card f-set-about">
        <LogoMark size={110} />
        <div className="f-set-about-name">Sloth {version}</div>
        <div className="f-set-hint">Varias cuentas de Claude, sin apuro.</div>
        <div className="f-set-actions center">
          <a className="btn sm" href="https://github.com/Toomasmg/sloth" target="_blank" rel="noreferrer">
            Repositorio
          </a>
          <a className="btn sm" href="https://github.com/Toomasmg/sloth/blob/main/PRIVACY.md" target="_blank" rel="noreferrer">
            Privacidad
          </a>
          <Button size="sm" onClick={go(() => openReport())}>
            Reportar un problema
          </Button>
        </div>
        <div className="f-set-hint">Sin telemetría. Sloth busca actualizaciones en GitHub por su cuenta; el resto (chat, celu, ntfy) sale solo si lo activás.</div>
      </div>
      <Group id="g-mas" title="Más">
        <ToggleLikeButton title="Novedades" hint="Qué cambió en la última versión de Sloth." onClick={go(() => openHelp('whatsnew'))} />
        <ToggleLikeButton title="Buscar actualizaciones" hint="Mira si hay una versión nueva y la baja sola." onClick={go(() => runFeatureCommand('updater:check', ui))} />
      </Group>
    </>
  )
}

/* ---------- Plantillas ---------- */

export function TemplatesSection(): React.JSX.Element {
  const ui = useUi()
  const { list, defaultId, loaded } = useTemplates()
  const accLabel = (id: string): string => (id === 'sugerida' ? 'Cuenta sugerida' : (ui.accounts.find((a) => a.id === id)?.label ?? 'cuenta borrada'))
  if (loaded && list.length === 0)
    return (
      <EmptyState
        title="Todavía no hay plantillas"
        description="Una plantilla arma el espacio por vos: carpeta, cuenta, rama y primer mensaje. Creá una o guardá un espacio como plantilla desde su panel."
        action={
          <Button variant="primary" onClick={() => openDialog({ kind: 'manage' })}>
            Nueva plantilla
          </Button>
        }
      />
    )
  return (
    <>
      <div className="f-set-actions">
        <Button variant="primary" size="sm" onClick={() => openDialog({ kind: 'manage' })}>
          Nueva plantilla
        </Button>
      </div>
      <Group id="g-plantillas" label="Tus plantillas">
        {list.map((t) => (
          <div key={t.id} className="f-set-row">
            <span className="f-set-swatch" style={{ background: colorHex(t.color) }} aria-hidden="true" />
            <div className="f-set-row-text">
              <span className="f-set-row-title">
                {t.name}
                {t.id === defaultId && <Tag>Predeterminada</Tag>}
                {t.team && <Tag>Del equipo</Tag>}
              </span>
              <span className="f-set-hint">
                {accLabel(t.accountId)}
                {usesTicket(t) ? ' · pide ticket' : ''}
                {t.useWorktree ? ` · rama ${t.useWorktree.branchPattern}` : t.repoPath ? ` · ${shortPath(t.repoPath)}` : ''}
              </span>
            </div>
            <div className="f-set-row-ctl">
              <Button size="sm" onClick={() => openDialog({ kind: 'manage', id: t.id })} aria-label={`Editar plantilla ${t.name}`}>
                Editar
              </Button>
            </div>
          </div>
        ))}
      </Group>
    </>
  )
}

/* ---------- Tickets ---------- */

export function TicketsSection({ onClose }: { onClose(): void }): React.JSX.Element {
  const snap = useSnapshot()
  if (!snap) return <SectionHint>Cargando…</SectionHint>
  return (
    <>
      <TicketsAjustes snap={snap} />
      <SectionHint>
        Los tickets se leen, no se cambian solos.{' '}
        <button type="button" className="f-set-link" onClick={() => {
            onClose()
            setBoardOpen(true)
          }}>
          Ir a Tickets
        </button>
      </SectionHint>
    </>
  )
}
