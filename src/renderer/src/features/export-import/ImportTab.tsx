import { useRef, useState, type DragEvent } from 'react'
import type { UiCtx } from '../host'
import { Ico, P } from './ico'
import {
  errText,
  type AddRulesResult,
  type Conflicto,
  type ImportChoices,
  type ImportPlan,
  type ImportPreview,
  type ImportResult,
  type PlanPermiso,
  type PlanRule,
  type PlanSpace
} from './types'

const LINE = 'inset 0 -1px 0 var(--line)'

const plural = (k: number, uno: string, varios: string): string => `${k} ${k === 1 ? uno : varios}`

const defaultChoices = (): ImportChoices => ({
  grupos: { espacios: true, plantillas: true, apariencia: true, atajos: true, equipo: true },
  espacios: {}
})

/** Resultado final: lo que devolvió main más cuántas reglas de permisos se agregaron y se omitieron. */
type Listo = ImportResult & { reglas: { agregadas: number; omitidas: number } }

const KIND_LABEL: Record<string, string> = { cmd: 'Comando', net: 'Dominio', edit: 'Edición', other: 'Herramienta' }

/** Pestaña «Importar»: elegir (o soltar) el archivo, contraseña si está cifrado, resumen con conflictos y rutas, reglas de permisos una por una, y resultado. */
export function ImportTab({ ui, onClose }: { ui: UiCtx; onClose: () => void }): React.JSX.Element {
  const [pre, setPre] = useState<ImportPreview | null>(null)
  const [stage, setStage] = useState<'inicio' | 'pw' | 'plan' | 'importando' | 'listo'>('inicio')
  const [choices, setChoices] = useState<ImportChoices>(defaultChoices)
  /** Reglas de permisos tildadas (por id de la regla). Todas arrancan destildadas. */
  const [rulesOn, setRulesOn] = useState<Record<string, boolean>>({})
  const [pwIn, setPwIn] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<Listo | null>(null)
  const [over, setOver] = useState(false)
  const busy = useRef(false)

  const fresh = (): void => {
    setChoices(defaultChoices())
    setRulesOn({})
  }

  const apply = (p: ImportPreview | null): void => {
    if (!p) return
    setPre(p)
    setErr(null)
    setPwIn('')
    if (p.needsPassword) setStage('pw')
    else {
      fresh()
      setStage('plan')
    }
  }

  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (busy.current) return
    busy.current = true
    try {
      await fn()
    } catch (e) {
      setErr(errText(e))
    } finally {
      busy.current = false
    }
  }

  const chooseFile = (): void =>
    void run(async () => {
      const p = await ui.invoke<ImportPreview | null>('feat:export-import:import')
      apply(p)
    })

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setOver(false)
    const f = e.dataTransfer.files?.[0]
    if (!f) return
    void run(async () => {
      const text = await f.text()
      apply(await ui.invoke<ImportPreview>('feat:export-import:importText', f.name, text))
    })
  }

  const cancel = (): void => {
    if (pre) void ui.invoke('feat:export-import:cancel', pre.token).catch(() => {})
    setPre(null)
    setStage('inicio')
    setErr(null)
    setResult(null)
  }

  const unlock = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!pre) return
    void run(async () => {
      const r = await ui.invoke<{ token: string; file: string; plan: NonNullable<ImportPreview['plan']> }>('feat:export-import:unlock', pre.token, pwIn)
      setPwIn('')
      setPre({ ...pre, needsPassword: false, plan: r.plan })
      fresh()
      setStage('plan')
    })
  }

  const pickFolder = (index: number): void =>
    void run(async () => {
      const dir = await ui.invoke<string | null>('feat:export-import:pickFolder')
      if (!dir) return
      setChoices((c) => ({ ...c, espacios: { ...c.espacios, [String(index)]: { ...c.espacios[String(index)], carpeta: dir } } }))
    })

  const setConflict = (index: number, conflicto: Conflicto): void =>
    setChoices((c) => ({ ...c, espacios: { ...c.espacios, [String(index)]: { ...c.espacios[String(index)], conflicto } } }))

  const plan = pre?.plan
  /** Un espacio con carpeta que faltaba, ya elegida, pasa a «ok». */
  const statusOf = (s: PlanSpace): PlanSpace['status'] => (s.status === 'faltante' && choices.espacios[String(s.index)]?.carpeta ? 'ok' : s.status)

  /** Por qué una regla no se puede tildar (null = se puede). Misma lógica que usa confirm. */
  const reasonOf = (p: PlanPermiso, r: PlanRule): string | null => {
    if (!r.valida) return r.motivo ?? 'no es una regla válida'
    if (p.espacioIndex < 0) return 'su espacio no está en el archivo'
    if (!choices.grupos.espacios) return 'marcá Espacios para asignarla'
    const s = plan?.espacios.find((x) => x.index === p.espacioIndex)
    if (!s) return 'su espacio no está en el archivo'
    const st = statusOf(s)
    if (st === 'saltear' || st === 'faltante') return 'su espacio no se importa'
    if (st === 'conflicto' && (choices.espacios[String(s.index)]?.conflicto ?? 'saltear') === 'saltear') return 'su espacio se saltea'
    return null
  }

  const toggleRule = (id: string): void => setRulesOn((m) => ({ ...m, [id]: !m[id] }))

  /** Reglas tildadas que se pueden agregar (ya filtradas por el motivo de arriba). */
  const ticked: { p: PlanPermiso; r: PlanRule }[] = plan
    ? plan.permisos.flatMap((p) => p.reglas.filter((r) => rulesOn[r.id] && !reasonOf(p, r)).map((r) => ({ p, r })))
    : []

  const confirm = (): void => {
    if (!pre?.plan) return
    const p = pre.plan
    const tplAll = p.plantillas.nuevas.length + p.plantillas.existentes.length + p.plantillas.salteadas.length
    const any =
      (p.espacios.length > 0 && choices.grupos.espacios) ||
      (tplAll > 0 && choices.grupos.plantillas) ||
      (p.apariencia && choices.grupos.apariencia) ||
      (p.atajos > 0 && choices.grupos.atajos) ||
      (!!p.equipo && choices.grupos.equipo) ||
      ticked.length > 0
    if (!any) {
      setErr('Marcá al menos algo para importar.')
      return
    }
    setStage('importando')
    setErr(null)
    void run(async () => {
      try {
        const r = await ui.invoke<ImportResult>('feat:export-import:confirm', pre.token, choices)
        const errores = [...r.errores]
        let plantillas = 0
        for (const t of r.plantillas) {
          try {
            await ui.invoke('feat:templates:save', t)
            plantillas++
          } catch (e) {
            errores.push(`Plantilla «${String(t.name)}»: ${errText(e)}`)
          }
        }
        const ajustes = { ...(r.ajustes.apariencia ?? {}), ...(r.ajustes.accountColors ? { accountColors: r.ajustes.accountColors } : {}), ...(r.ajustes.accountPlans ? { accountPlans: r.ajustes.accountPlans } : {}), ...(r.ajustes.atajos ? { shortcuts: r.ajustes.atajos } : {}) }
        if (Object.keys(ajustes).length) {
          try {
            await ui.invoke('feat:settings:set', ajustes)
          } catch (e) {
            errores.push(`Ajustes: ${errText(e)}`)
          }
        }
        // Reglas: solo las tildadas, en el espacio que quedó (creado o ya existente). Main las valida de nuevo.
        let agregadas = 0
        const enviar = ticked.flatMap(({ p: g, r: rule }) => {
          const wsId = r.espaciosWs[String(g.espacioIndex)]
          return wsId && rule.draft ? [{ workspaceId: wsId, ...rule.draft }] : []
        })
        if (enviar.length) {
          try {
            const a = await ui.invoke<AddRulesResult>('feat:permissions:addRules', { reglas: enviar })
            agregadas = a.agregadas
          } catch (e) {
            errores.push(`Reglas de permisos: ${errText(e)}`)
          }
        }
        await ui.reload()
        setResult({
          ...r,
          plantillas: r.plantillas.slice(0, plantillas),
          errores,
          reglas: { agregadas, omitidas: p.reglas - agregadas }
        })
        setStage('listo')
      } catch (e) {
        setErr(errText(e))
        setStage('plan')
      }
    })
  }

  // ---- Inicio: elegir o soltar ----
  if (stage === 'inicio') {
    return (
      <div
        className={`f-ei-drop${over ? ' over' : ''}`}
        role="region"
        aria-label="Zona para soltar el archivo"
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <span className="f-ei-drop-ico">
          <Ico d={P.upload} size={22} />
        </span>
        <div className="f-ei-drop-title">Soltá acá un archivo .sloth</div>
        <div className="f-ei-muted">Si no lo tenés a mano, elegilo desde tu PC.</div>
        <button type="button" className="f-ei-btn primary" onClick={chooseFile} disabled={busy.current}>
          Elegir archivo…
        </button>
        {err && (
          <p role="alert" className="f-ei-err">
            {err}
          </p>
        )}
      </div>
    )
  }

  // ---- Listo ----
  if (stage === 'listo' && result) {
    const parts: string[] = []
    if (result.espacios) parts.push(plural(result.espacios, 'espacio', 'espacios'))
    if (result.plantillas.length) parts.push(plural(result.plantillas.length, 'plantilla', 'plantillas'))
    if (result.ajustes.apariencia) parts.push('tu apariencia')
    if (result.ajustes.atajos) parts.push('tus atajos')
    if (result.reglas.agregadas) parts.push(plural(result.reglas.agregadas, 'regla de permisos', 'reglas de permisos'))
    if (result.cuentas) parts.push(plural(result.cuentas, 'cuenta', 'cuentas'))
    const doneMsg = parts.length
      ? `Se importaron ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`}.`
      : 'No se importó nada.'
    const reglasMsg = plan && plan.reglas > 0 ? `Reglas de permisos: ${result.reglas.agregadas} agregadas, ${result.reglas.omitidas} omitidas.` : ''
    return (
      <div className="f-ei-done" role="region" aria-label="Resultado de la importación">
        <div className="f-ei-done-head">
          <span className="f-ei-done-ico">
            <Ico d={P.check} size={18} sw={2.2} />
          </span>
          <div>
            <div className="f-ei-done-title">Configuración importada</div>
            <div role="status" className="f-ei-muted f-ei-done-msg">
              {doneMsg}
            </div>
            {reglasMsg && <div className="f-ei-muted f-ei-done-msg">{reglasMsg}</div>}
          </div>
        </div>
        {result.cuentas > 0 && <p className="f-ei-muted f-ei-done-note">Las cuentas nuevas quedan sin sesión: iniciá sesión en cada una desde Configuración › Cuentas.</p>}
        {result.saltados.length > 0 && (
          <div className="f-ei-warn">
            <strong>Se saltearon:</strong>
            <ul>
              {result.saltados.map((s, i) => (
                <li key={i}>
                  {s.nombre}: {s.motivo}
                </li>
              ))}
            </ul>
          </div>
        )}
        {result.notas.map((n, i) => (
          <p key={i} className="f-ei-muted">
            {n}
          </p>
        ))}
        {result.errores.length > 0 && (
          <ul role="alert" className="f-ei-errors">
            {result.errores.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
        <div className="f-ei-foot f-ei-foot-done">
          <button type="button" className="f-ei-btn primary" onClick={onClose} autoFocus>
            Ir a los espacios
          </button>
          <button type="button" className="f-ei-btn secondary" onClick={cancel}>
            Importar otro archivo
          </button>
        </div>
      </div>
    )
  }

  // ---- Contraseña ----
  if (stage === 'pw' && pre) {
    return (
      <div className="f-ei-drop">
        <span className="f-ei-drop-ico">
          <Ico d={P.lock} size={22} />
        </span>
        <div className="f-ei-drop-title">Archivo protegido con contraseña</div>
        <div className="f-ei-muted mono">{pre.file}</div>
        <form onSubmit={unlock} className="f-ei-pwform">
          <label className="field">
            <span>Contraseña del archivo</span>
            <input
              type="password"
              autoComplete="off"
              autoFocus
              value={pwIn}
              onChange={(e) => {
                setPwIn(e.target.value)
                setErr(null)
              }}
              aria-invalid={!!err}
              aria-describedby="imp-pw-e"
            />
          </label>
          {err && (
            <span id="imp-pw-e" role="alert" className="f-ei-err">
              {err}
            </span>
          )}
          <div className="f-ei-foot">
            <button type="button" className="f-ei-btn ghost" onClick={cancel}>
              Cancelar
            </button>
            <span className="f-ei-grow" />
            <button type="submit" className="f-ei-btn primary sm" disabled={!pwIn}>
              Abrir
            </button>
          </div>
        </form>
      </div>
    )
  }

  // ---- Resumen (plan) ----
  if (!pre || !plan) return <p className="f-ei-help">Leyendo el archivo…</p>
  const importing = stage === 'importando'
  const spaces = plan.espacios
  const hasSpaces = spaces.length > 0
  const conflicts = spaces.filter((s) => statusOf(s) === 'conflicto').length
  const missing = spaces.filter((s) => statusOf(s) === 'faltante').length
  const issues: string[] = []
  if (choices.grupos.espacios && conflicts) issues.push(conflicts === 1 ? '1 conflicto' : `${conflicts} conflictos`)
  if (choices.grupos.espacios && missing) issues.push(missing === 1 ? '1 ruta que no existe en esta PC' : `${missing} rutas que no existen en esta PC`)
  const tplN = plan.plantillas.nuevas.length + plan.plantillas.existentes.length + plan.plantillas.salteadas.length
  const rulesHave = plan.permisos.some((p) => p.reglas.length > 0)

  return (
    <div className="f-ei-tab">
      <div className="f-ei-fileRow">
        <span className="f-ei-file-ico" aria-hidden="true">
          <Ico d={P.doc} size={18} />
        </span>
        <div className="f-ei-grow">
          <div className="mono f-ei-fname">{pre.file.split(/[\\/]/).pop()}</div>
          {plan.version !== '?' && <div className="f-ei-muted">Exportado con la v{plan.version}</div>}
        </div>
        <button type="button" className="f-ei-btn secondary" onClick={cancel} disabled={importing}>
          Elegir otro archivo
        </button>
      </div>

      {issues.length > 0 && (
        <div role="status" className="f-ei-warn">
          <Ico d={P.warn} size={16} sw={1.9} />
          <span>Hay {issues.join(' y ')}. Revisalos antes de importar.</span>
        </div>
      )}
      {issues.length === 0 && (
        <div role="status" className="f-ei-okbox">
          <Ico d={P.check} size={16} sw={2.2} />
          <span>Todo listo para importar: no hay conflictos ni rutas que falten.</span>
        </div>
      )}

      <section className="f-ei-sec" aria-labelledby="im-qt">
        <h2 id="im-qt" className="f-ei-h">
          Qué trae el archivo
        </h2>
        <div className="f-ei-card">
          {/* Espacios */}
          <div style={{ boxShadow: LINE }}>
            {hasSpaces ? (
              <>
                <label className="f-ei-row">
                  <input type="checkbox" checked={choices.grupos.espacios} onChange={() => setChoices((c) => ({ ...c, grupos: { ...c.grupos, espacios: !c.grupos.espacios } }))} disabled={importing} />
                  <span className="f-ei-grow">
                    <span className="f-ei-name">Espacios</span>
                    <span className="f-ei-desc">Nombre, ruta, colores y cuenta asignada, más el plan de cada cuenta. Los archivos del proyecto no vienen en el archivo.</span>
                  </span>
                  <span className="f-ei-size">
                    {spaces.filter((s) => statusOf(s) === 'ok' || statusOf(s) === 'conflicto').length} de {spaces.length} para importar
                  </span>
                </label>
                {spaces.map((s) => {
                  const st = statusOf(s)
                  const c = choices.espacios[String(s.index)]?.conflicto ?? 'saltear'
                  const badge = badgeOf(st, c)
                  const dim = st === 'saltear' || st === 'ya' || (st === 'conflicto' && c === 'saltear')
                  return (
                    <div key={s.index} className={`f-ei-sub${dim ? ' muted' : ''}`}>
                      <div className="f-ei-sub-head">
                        <span className="f-ei-dot" style={{ background: s.color ?? 'var(--fg-muted)' }} aria-hidden="true" />
                        <span className="f-ei-name">{s.nombre}</span>
                        <span className="f-ei-chip">{s.cuenta}</span>
                        <span className={`f-ei-badge ${badge.tone}`}>{badge.label}</span>
                      </div>
                      <div className="f-ei-path mono" title={s.ruta}>
                        {s.ruta}
                      </div>
                      {st === 'faltante' && (
                        <div className="f-ei-fix">
                          <span className="f-ei-warnText">La ruta no existe en esta PC.</span>
                          <button type="button" className="f-ei-btn warn sm" onClick={() => pickFolder(s.index)} disabled={importing}>
                            Elegir otra carpeta
                          </button>
                        </div>
                      )}
                      {st === 'ya' && <div className="f-ei-muted f-ei-fix">Ya está en Sloth.</div>}
                      {st === 'saltear' && s.motivo && <div className="f-ei-muted f-ei-fix">{s.motivo}</div>}
                      {choices.espacios[String(s.index)]?.carpeta && s.status === 'faltante' && (
                        <div className="f-ei-okText f-ei-fix">Carpeta lista en esta PC</div>
                      )}
                      {st === 'conflicto' && (
                        <div className="f-ei-fix f-ei-conflict">
                          <span className="f-ei-grow">Ya tenés un espacio «{s.existente ?? s.nombre}». ¿Qué hacemos?</span>
                          <select
                            aria-label={`Qué hacer con el espacio ${s.nombre}`}
                            value={c}
                            onChange={(e) => setConflict(s.index, e.target.value as Conflicto)}
                            disabled={importing}
                          >
                            <option value="reemplazar">Reemplazar</option>
                            <option value="dos">Mantener los dos</option>
                            <option value="saltear">Saltear</option>
                          </select>
                        </div>
                      )}
                    </div>
                  )
                })}
              </>
            ) : (
              <div className="f-ei-row muted">
                <span className="f-ei-grow">Espacios</span>
                <span className="f-ei-size">No trae este grupo</span>
              </div>
            )}
          </div>

          {/* Plantillas */}
          <Group
            present={tplN > 0}
            on={choices.grupos.plantillas}
            onToggle={() => setChoices((c) => ({ ...c, grupos: { ...c.grupos, plantillas: !c.grupos.plantillas } }))}
            disabled={importing}
            name="Plantillas"
            desc={
              [
                plan.plantillas.nuevas.length ? `Se agregan: ${plan.plantillas.nuevas.join(', ')}.` : '',
                plan.plantillas.existentes.length ? `Ya tenés con ese nombre (se conservan las tuyas): ${plan.plantillas.existentes.join(', ')}.` : '',
                plan.plantillas.salteadas.length ? `Se saltean: ${plan.plantillas.salteadas.map((t) => `${t.name} (${t.reason})`).join(', ')}.` : ''
              ]
                .filter(Boolean)
                .join(' ')
            }
            sum={plural(tplN, 'plantilla', 'plantillas')}
          />

          <Group
            present={plan.atajos > 0}
            on={choices.grupos.atajos}
            onToggle={() => setChoices((c) => ({ ...c, grupos: { ...c.grupos, atajos: !c.grupos.atajos } }))}
            disabled={importing}
            name="Atajos"
            desc="Los atajos que cambió el archivo. Reemplazan los tuyos solo en esas acciones."
            sum={plural(plan.atajos, 'cambiado', 'cambiados')}
          />

          <Group
            present={plan.apariencia}
            on={choices.grupos.apariencia}
            onToggle={() => setChoices((c) => ({ ...c, grupos: { ...c.grupos, apariencia: !c.grupos.apariencia } }))}
            disabled={importing}
            name="Apariencia"
            desc="Tema, color de acento, densidad y tamaño del texto."
            sum={resumenApariencia(plan.aparienciaValores)}
          />

          <Group
            present={!!plan.equipo}
            on={choices.grupos.equipo}
            onToggle={() => setChoices((c) => ({ ...c, grupos: { ...c.grupos, equipo: !c.grupos.equipo } }))}
            disabled={importing}
            name="Equipo y chat"
            desc={`Solo la URL del proyecto de Supabase (${plan.equipo ?? ''}). No cambia tu sesión ni tu key: cargala en Equipo.`}
            sum="Solo la URL"
          />

          {/* Reglas de permisos: una por una, todas destildadas. */}
          {rulesHave ? (
            <div style={{ boxShadow: LINE }}>
              <div className="f-ei-row">
                <span className="f-ei-grow">
                  <span className="f-ei-name">Reglas de permisos</span>
                  <span className="f-ei-desc">
                    Las «Permitir siempre» de Sloth. Vienen destildadas: tildá solo las que quieras agregar. Nunca se escriben en la configuración de Claude.
                  </span>
                </span>
                <span className="f-ei-size">
                  {ticked.length} de {plan.reglasValidas} marcadas
                </span>
              </div>
              {plan.permisos.map((p) =>
                p.reglas.length ? (
                  <div key={p.reglas[0].id} className="f-ei-sub">
                    <div className="f-ei-sub-head">
                      <span className="f-ei-name">{p.espacio}</span>
                      <span className="f-ei-chip">Espacio</span>
                    </div>
                    <div className="f-ei-path mono" title={p.ruta}>
                      {p.ruta}
                    </div>
                    {p.reglas.map((r) => {
                      const off = reasonOf(p, r)
                      return (
                        <label key={r.id} className={`f-ei-row sub${off ? ' f-ei-disabled' : ''}`}>
                          <input
                            type="checkbox"
                            checked={!off && !!rulesOn[r.id]}
                            disabled={!!off || importing}
                            onChange={() => toggleRule(r.id)}
                            aria-label={`Agregar la regla ${r.texto} del espacio ${p.espacio}`}
                          />
                          <span className="f-ei-chip">{r.valida && r.draft ? KIND_LABEL[r.draft.kind] : 'No válida'}</span>
                          <span className="f-ei-grow mono f-ei-rule-text" title={r.texto}>
                            {r.texto}
                          </span>
                          {off && <span className="f-ei-muted f-ei-fix">{off}</span>}
                        </label>
                      )
                    })}
                  </div>
                ) : null
              )}
            </div>
          ) : (
            <div className="f-ei-row muted" style={{ boxShadow: LINE }}>
              <span className="f-ei-grow">Reglas de permisos</span>
              <span className="f-ei-size">No trae este grupo</span>
            </div>
          )}
        </div>
      </section>

      {err && (
        <p role="alert" className="f-ei-err">
          {err}
        </p>
      )}
      <div className="f-ei-foot">
        <span className="f-ei-grow" />
        <button type="button" className="f-ei-btn ghost" onClick={cancel} disabled={importing}>
          Cancelar
        </button>
        <button type="button" className="f-ei-btn primary" onClick={confirm} disabled={importing} aria-busy={importing}>
          {importing ? 'Importando…' : 'Importar'}
        </button>
      </div>
    </div>
  )
}

/** Chip de cada espacio (como el artboard): en un conflicto, lo que va a pasar según la elección. */
function badgeOf(st: PlanSpace['status'], c: Conflicto): { label: string; tone: 'ok' | 'info' | 'warn' | 'muted' } {
  switch (st) {
    case 'ok':
    case 'faltante':
      return { label: 'Nuevo', tone: 'ok' }
    case 'conflicto':
      if (c === 'reemplazar') return { label: 'Reemplaza al actual', tone: 'info' }
      if (c === 'dos') return { label: 'Se agrega como copia', tone: 'info' }
      return { label: 'Se saltea', tone: 'warn' }
    case 'ya':
      return { label: 'Ya está', tone: 'muted' }
    default:
      return { label: 'Se saltea', tone: 'warn' }
  }
}

const THEME_NAMES: Record<string, string> = { oscuro: 'Oscuro', noche: 'Más oscuro', claro: 'Claro', sistema: 'Según Windows' }
const ACCENT_NAMES: Record<string, string> = { cielo: 'Cielo', hoja: 'Hoja', lila: 'Lila', ambar: 'Ámbar' }

/** Resumen de Apariencia como el artboard: «Más oscuro · Lila · Compacta · 14 px» (con «Modo liviano» si está). */
function resumenApariencia(v: ImportPlan['aparienciaValores']): string {
  if (!v) return 'Sin valores'
  const partes = [
    v.theme ? (THEME_NAMES[v.theme] ?? v.theme) : null,
    v.accent ? (ACCENT_NAMES[v.accent] ?? v.accent) : null,
    v.density ? (v.density === 'cómoda' ? 'Cómoda' : 'Compacta') : null,
    typeof v.uiFontSize === 'number' ? `${v.uiFontSize} px` : null,
    v.lightMode ? 'Modo liviano' : null
  ]
  return partes.filter(Boolean).join(' · ') || 'Sin valores'
}

function Group(props: {
  present: boolean
  on: boolean
  onToggle: () => void
  disabled: boolean
  name: string
  desc: string
  sum: string
}): React.JSX.Element {
  if (!props.present) {
    return (
      <div className="f-ei-row muted" style={{ boxShadow: LINE }}>
        <span className="f-ei-grow">{props.name}</span>
        <span className="f-ei-size">No trae este grupo</span>
      </div>
    )
  }
  return (
    <div style={{ boxShadow: LINE }}>
      <label className="f-ei-row">
        <input type="checkbox" checked={props.on} onChange={props.onToggle} disabled={props.disabled} />
        <span className="f-ei-grow">
          <span className="f-ei-name">{props.name}</span>
          <span className="f-ei-desc">{props.desc}</span>
        </span>
        <span className="f-ei-size">{props.sum}</span>
      </label>
    </div>
  )
}
