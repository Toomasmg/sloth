import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../../../api'
import { useUi } from '../../host'
import { MoreIcon } from '../../../icons/SlothIcons'
import { fmtTok, totalTok, usageTitle } from '../../../format'
import { loginPaneId, type Account, type AgenteDisponible } from '../../../../../shared/types'
import { capacidadesDe, motivoSinCapacidad, nombreProveedor, proveedorIdDe } from '../../../../../shared/proveedores'
import { TITULO_LIMITES, filasLimites, formularioCuenta, textoSinLimites } from '../agente-form'
import type { LecturaLimitesCodex } from '../../../../../shared/celular'
import { resolveAccountColor, updateSettings, useSettings } from '../store'
import { ACCOUNT_PALETTE, PLAN_SUGGESTIONS } from '../../../../../shared/settings-model'
import { Group, useSave, SectionHint } from '../ui'
import { Button, IconButton, Input, Select, Tag } from '../../../ui'
/* ---------- Cuentas ---------- */

const ACC_COLORS = ACCOUNT_PALETTE

export function AccountsSection({ onClose, adding, setAdding }: { onClose(): void; adding: boolean; setAdding(v: boolean | ((v: boolean) => boolean)): void }): React.JSX.Element {
  const ui = useUi()
  const p = useSettings()
  const save = useSave()
  const [name, setName] = useState('')
  const [plan, setPlan] = useState('Pro')
  const [nameErr, setNameErr] = useState(false)
  const [proveedor, setProveedor] = useState('claude')
  const [agentes, setAgentes] = useState<AgenteDisponible[]>([])
  const [confirm, setConfirm] = useState<string | null>(null)
  /** Fila con el menú «más» abierto (usar mi setup, quitar). */
  const [menu, setMenu] = useState<string | null>(null)

  /** «Usar mi setup de ~/.claude» de una cuenta: guarda y recarga la lista. */
  const toggleShare = (acc: Account): void => {
    save(async () => {
      await api.setShareSetup(acc.id, acc.shareSetup === false)
      await ui.reload()
    })
  }

  /** «Leer límites de uso (experimental)» de una cuenta de Codex: guarda y recarga la lista. */
  const toggleLimites = (acc: Account): void => {
    save(async () => {
      await api.setLimitesExperimentales(acc.id, acc.limitesExperimentales !== true)
      await ui.reload()
    })
  }

  /** «Avisar cuando termina» de una cuenta de Codex: si no se puede activar (ya hay un notify propio, falta node) la pantalla muestra el motivo. */
  const toggleAviso = (acc: Account): void => {
    save(async () => {
      await api.setAvisoDeTurno(acc.id, acc.avisoDeTurno !== true)
      await ui.reload()
    })
  }

  const conLectura = ui.accounts.filter((a) => capacidadesDe(a)?.limitesExperimental === true && a.limitesExperimentales === true).map((a) => a.id)
  const claveLectura = conLectura.join(',')
  /** Sin la clave: todavía leyendo. Cada cuenta entra apenas llega su lectura, sin esperar a las demás. */
  const [limites, setLimites] = useState<Record<string, LecturaLimitesCodex>>({})
  useEffect(() => {
    const ids = claveLectura ? claveLectura.split(',') : []
    setLimites((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => ids.includes(id))))
    let vivo = true
    for (const id of ids) {
      api.limitesCodex(id).then(
        (r) => vivo && setLimites((prev) => ({ ...prev, [id]: r })),
        () => vivo && setLimites((prev) => ({ ...prev, [id]: { tipo: 'sin-dato' } }))
      )
    }
    return () => {
      vivo = false
    }
  }, [claveLectura])

  useEffect(() => {
    if (!adding) return
    api.agentes().then(setAgentes, () => setAgentes([]))
  }, [adding])

  const form = formularioCuenta(proveedor, agentes, ui.accounts)
  const agenteElegido = form.opciones.find((o) => o.id !== 'claude' && o.id === proveedor)?.id

  const addAccount = (e: FormEvent): void => {
    e.preventDefault()
    const n = name.trim()
    if (form.bloqueo) return
    if (!n) {
      setNameErr(true)
      return
    }
    setNameErr(false)
    save(async () => {
      const acc: Account = await api.addAccount(n, agenteElegido)
      if (!agenteElegido && plan.trim()) await updateSettings({ accountPlans: { [acc.id]: plan.trim() } })
      await ui.reload()
      setAdding(false)
      setName('')
      setProveedor('claude')
      onClose()
      ui.openPane(loginPaneId(acc.id))
    })
  }

  const remove = (id: string): void => {
    save(async () => {
      await api.removeAccount(id)
      setConfirm(null)
      await ui.reload()
      ui.closePane(loginPaneId(id))
    })
  }

  return (
    <>
      {adding && (
        <form className="f-set-card f-set-form f-set-form-add" onSubmit={addAccount} noValidate>
          <div className="f-set-form-title">{form.titulo}</div>
          {form.mostrarSelector && (
            <label className="f-set-stack">
              <span className="f-set-label">Agente</span>
              <Select value={proveedor} onChange={(e) => setProveedor(e.target.value)}>
                {form.opciones.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.nombre}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <div className="f-set-form-row">
            <label className="f-set-stack grow2">
              <span className="f-set-label">Nombre para reconocerla</span>
              <Input value={name} placeholder="Ej.: Trabajo de Ana" onChange={(e) => setName(e.target.value)} aria-invalid={nameErr} />
            </label>
            {form.mostrarPlan && (
              <label className="f-set-stack grow1">
                <span className="f-set-label">Plan</span>
                <Select value={plan} onChange={(e) => setPlan(e.target.value)}>
                  {PLAN_SUGGESTIONS.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </Select>
              </label>
            )}
          </div>
          {form.aviso && <p className="f-set-hint">{form.aviso}</p>}
          {form.avisoVersion && (
            <p role="alert" className="form-error">
              {form.avisoVersion}
            </p>
          )}
          {form.bloqueo && (
            <p role="alert" className="form-error">
              {form.bloqueo}
            </p>
          )}
          {nameErr && (
            <p role="alert" className="form-error">
              Poné un nombre para la cuenta.
            </p>
          )}
          <div className="f-set-actions">
            <span className="f-set-hint grow">Después vas a iniciar sesión en el navegador. Sloth no guarda contraseñas.</span>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancelar
            </Button>
            <Button variant="primary" size="sm" type="submit" disabled={!!form.bloqueo}>
              Agregar
            </Button>
          </div>
        </form>
      )}

      <datalist id="f-set-plan-list">
        {PLAN_SUGGESTIONS.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
      <Group id="g-cuentas" title={`Tus cuentas · ${ui.accounts.length}`}>
        {ui.accounts.length === 0 && <p className="f-set-row f-set-hint">Todavía no agregaste cuentas.</p>}
        {ui.accounts.map((a, i) => {
          const st = ui.statuses[a.id]
          const logged = !!st?.loggedIn
          const color = resolveAccountColor(a.id, i, p)
          const custom = p.settings.accountColors[a.id]
          const spaces = ui.workspaces.filter((w) => w.accountId === a.id).length
          const busy = confirm === a.id
          const conUso = capacidadesDe(a)?.uso === true
          // Sin la capacidad el escáner devuelve ceros: mostrarlos sería un dato falso.
          const u = conUso ? ui.usage[a.id] : undefined
          const motivoSetup = capacidadesDe(a)?.setupCompartido === true ? undefined : motivoSinCapacidad(a, 'setupCompartido')
          const conLimites = capacidadesDe(a)?.limitesExperimental === true
          // Claude avisa por sus hooks siempre; solo el agente que avisa por notify tiene este switch.
          const conAviso = capacidadesDe(a)?.avisoTurno === true && capacidadesDe(a)?.hooks !== true
          const leyendoLimites = conLimites && a.limitesExperimentales === true
          const lecturaL = limites[a.id]
          const filasL = leyendoLimites ? filasLimites(lecturaL?.tipo === 'datos' ? lecturaL.limites : null) : []
          return (
            <div key={a.id} className="f-set-acc" style={{ '--acc': color } as React.CSSProperties}>
              <div className="f-set-row">
                <span className="f-set-avatar" aria-hidden="true">
                  {a.label.slice(0, 1).toUpperCase()}
                </span>
                <div className="f-set-row-text">
                  <span className="f-set-row-title">
                    {a.label}
                    {a.proveedor !== undefined && proveedorIdDe(a) !== 'claude' && (
                      <>
                        {' '}
                        <Tag>{nombreProveedor(a)}</Tag>
                      </>
                    )}
                  </span>
                  <span className="f-set-hint">
                    {spaces === 1 ? '1 espacio' : `${spaces} espacios`}
                    {logged && st?.email ? ` · ${st.email}` : ''}
                  </span>
                  {u && (
                    <dl className="sl-usage" title={usageTitle(u)}>
                      <div>
                        <dt>5 h</dt>
                        <dd>{fmtTok(totalTok(u.last5h))}</dd>
                      </div>
                      <div>
                        <dt>Hoy</dt>
                        <dd>{fmtTok(totalTok(u.today))}</dd>
                      </div>
                      <div>
                        <dt>7 días</dt>
                        <dd>{fmtTok(totalTok(u.last7d))}</dd>
                      </div>
                    </dl>
                  )}
                  {leyendoLimites && filasL.length > 0 && (
                    <dl className="sl-usage" title={TITULO_LIMITES}>
                      {filasL.map((f) => (
                        <div key={f.nombre}>
                          <dt>{f.nombre}</dt>
                          <dd>{f.valor}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {leyendoLimites && filasL.length === 0 && <span className="f-set-hint">{textoSinLimites(lecturaL)}</span>}
                </div>
                {conUso && (
                  <PlanField key={`${a.id}-${p.settings.accountPlans[a.id] ?? ''}`} label={a.label} value={p.settings.accountPlans[a.id] ?? ''} onCommit={(plan) => save({ accountPlans: { [a.id]: plan || null } })} />
                )}
                <span className={`f-set-state ${logged ? 'ok' : 'warn'}`}>
                  <span className="f-set-dot" aria-hidden="true" />
                  {logged ? 'Sesión iniciada' : 'Hay que iniciar sesión'}
                </span>
                <div className="f-set-row-ctl">
                  {busy ? (
                    <>
                      <Button size="sm" onClick={() => setConfirm(null)}>
                        Cancelar
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => remove(a.id)}>
                        Sí, quitar
                      </Button>
                    </>
                  ) : (
                    <>
                      {logged ? (
                        <Button size="sm" aria-label={`Abrir terminal de ${a.label}`} onClick={() => {
                            onClose()
                            ui.openPane(loginPaneId(a.id))
                          }}
                        >
                          Terminal
                        </Button>
                      ) : (
                        <Button variant="primary" size="sm" onClick={() => {
                            onClose()
                            ui.openPane(loginPaneId(a.id))
                          }}
                        >
                          Iniciar sesión
                        </Button>
                      )}
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-haspopup="menu"
                        aria-expanded={menu === a.id}
                        label={`Más acciones de ${a.label}`}
                        icon={<MoreIcon size={15} aria-hidden="true" />}
                        onClick={() => setMenu(menu === a.id ? null : a.id)}
                      />
                    </>
                  )}
                </div>
              </div>
              {menu === a.id && !busy && (
                <div className="f-set-acc-menu" role="menu" aria-label={`Acciones de ${a.label}`}>
                  <label className="switch" role="menuitem" title={motivoSetup ?? 'Enlaza tus skills, agents, hooks, plugins, settings y MCP de ~/.claude'}>
                    <span className="switch-text">
                      Usar mi setup de <span className="mono">~/.claude</span>
                    </span>
                    <input type="checkbox" role="switch" checked={!motivoSetup && a.shareSetup !== false} disabled={!!motivoSetup} onChange={() => toggleShare(a)} />
                    <span className="switch-track" aria-hidden="true" />
                  </label>
                  {motivoSetup && <span className="f-set-hint">{motivoSetup}</span>}
                  {conLimites && (
                    <>
                      <label className="switch" role="menuitem" title="Sloth abre Codex un momento para preguntarle cuánto usaste. Solo lo hace si esa cuenta no tiene una terminal abierta.">
                        <span className="switch-text">
                          Leer límites de uso <Tag>Experimental</Tag>
                        </span>
                        <input type="checkbox" role="switch" checked={a.limitesExperimentales === true} onChange={() => toggleLimites(a)} />
                        <span className="switch-track" aria-hidden="true" />
                      </label>
                      <span className="f-set-hint">Sloth abre Codex un momento para preguntarle cuánto usaste de cada ventana. Riesgo: al leer, Codex puede renovar el inicio de sesión de la cuenta, y si tenés su terminal abierta esa terminal se quedaría sin sesión; por eso Sloth no lee mientras haya una terminal abierta de esa cuenta y muestra «Sin dato». Con el celu abierto lo repite cada 5 minutos. Puede fallar si Codex cambia; con una API key no aplica.</span>
                    </>
                  )}
                  {conAviso && (
                    <>
                      <label className="switch" role="menuitem" title="Agrega una línea «notify» al config.toml de esta cuenta de Codex.">
                        <span className="switch-text">
                          Avisar cuando termina <Tag>Experimental</Tag>
                        </span>
                        <input type="checkbox" role="switch" checked={a.avisoDeTurno === true} onChange={() => toggleAviso(a)} />
                        <span className="switch-track" aria-hidden="true" />
                      </label>
                      <span className="f-set-hint">Agrega una línea «notify» al config.toml de la cuenta, nunca pisa una tuya y se saca al apagarlo. Si Codex no la ejecuta, no pasa nada: solo no llega el aviso. El cambio vale para las terminales que abras desde ahora; las que ya están abiertas siguen como estaban hasta que las reabras.</span>
                    </>
                  )}
                  <Button variant="danger" size="sm" role="menuitem" onClick={() => {
                      setMenu(null)
                      setConfirm(a.id)
                    }}
                  >
                    Quitar cuenta
                  </Button>
                </div>
              )}
              <AccountSwatches acc={a} index={i} custom={custom} onPick={(hex) => save({ accountColors: { [a.id]: hex } })} onAuto={() => save({ accountColors: { [a.id]: null } })} />
            </div>
          )
        })}
      </Group>
      <SectionHint>Sloth nunca lee tus contraseñas ni tus tokens. Para pasar un espacio a otra cuenta usá «Mover a otra cuenta» en el menú del espacio.</SectionHint>
    </>
  )
}

/** Plan escrito a mano: etiqueta opcional, con sugerencias. Se guarda al salir del campo o al Enter. */
function PlanField({ label, value, onCommit }: { label: string; value: string; onCommit(plan: string): void }): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const commit = (): void => {
    const t = draft.trim()
    if (t !== value) onCommit(t)
  }
  return (
    <label className="f-set-plan">
      <span className="sr-only">Plan de {label}</span>
      <input
        className="f-set-input f-set-plan-input"
        list="f-set-plan-list"
        value={draft}
        maxLength={20}
        placeholder="Plan"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
      />
    </label>
  )
}

function AccountSwatches({
  acc,
  index,
  custom,
  onPick,
  onAuto
}: {
  acc: Account
  index: number
  custom: string | undefined
  onPick(hex: string): void
  onAuto(): void
}): React.JSX.Element {
  const gid = `f-set-sw-${acc.id}`
  return (
    <div className="f-set-swatches" role="radiogroup" aria-labelledby={gid}>
      <span id={gid} className="f-set-hint">
        Color
      </span>
      <button type="button" role="radio" aria-checked={!custom} aria-label="Automático" title="Automático" className={`f-set-sw ${!custom ? 'on' : ''}`} onClick={onAuto}>
        <span style={{ background: resolveAccountColor(acc.id, index) }} />
        <span className="sr-only">Automático</span>
      </button>
      {ACC_COLORS.map((c) => (
        <button key={c.hex} type="button" role="radio" aria-checked={custom === c.hex} aria-label={c.name} title={c.name} className={`f-set-sw ${custom === c.hex ? 'on' : ''}`} onClick={() => onPick(c.hex)}>
          <span style={{ background: c.hex }} />
        </button>
      ))}
    </div>
  )
}
