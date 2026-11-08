import { useRef, useState, type DragEvent } from 'react'
import { DoneIcon, FolderIcon, KeyboardIcon, PermissionIcon, TeamIcon, TemplatesIcon, ThemeIcon, ExportIcon } from '../../icons/SlothIcons'
import type { UiCtx } from '../host'
import { errText, type Conflicto, type ImportChoices, type ImportPreview, type ImportResult, type PlanSpace } from './types'

const LINE = 'inset 0 -1px 0 var(--line)'

const plural = (k: number, uno: string, varios: string): string => `${k} ${k === 1 ? uno : varios}`

const defaultChoices = (): ImportChoices => ({
  grupos: { espacios: true, plantillas: true, apariencia: true, equipo: true, permisos: true },
  espacios: {}
})

/** Pestaña «Importar»: elegir (o soltar) el archivo, contraseña si está cifrado, resumen con conflictos y rutas, y resultado. */
export function ImportTab({ ui, onClose }: { ui: UiCtx; onClose: () => void }): React.JSX.Element {
  const [pre, setPre] = useState<ImportPreview | null>(null)
  const [stage, setStage] = useState<'inicio' | 'pw' | 'plan' | 'importando' | 'listo'>('inicio')
  const [choices, setChoices] = useState<ImportChoices>(defaultChoices)
  const [pwIn, setPwIn] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [over, setOver] = useState(false)
  const busy = useRef(false)

  const apply = (p: ImportPreview | null): void => {
    if (!p) return
    setPre(p)
    setErr(null)
    setPwIn('')
    if (p.needsPassword) setStage('pw')
    else {
      setChoices(defaultChoices())
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
      setChoices(defaultChoices())
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

  const confirm = (): void => {
    if (!pre?.plan) return
    const p = pre.plan
    const tplAll = p.plantillas.nuevas.length + p.plantillas.existentes.length + p.plantillas.salteadas.length
    const any =
      (p.espacios.length > 0 && choices.grupos.espacios) ||
      (tplAll > 0 && choices.grupos.plantillas) ||
      (p.apariencia && choices.grupos.apariencia) ||
      (!!p.equipo && choices.grupos.equipo) ||
      (p.reglas > 0 && choices.grupos.permisos)
    if (!any) {
      setErr('Marcá al menos un grupo para importar.')
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
        if (r.ajustes.apariencia || r.ajustes.accountColors) {
          try {
            await ui.invoke('feat:settings:set', { ...(r.ajustes.apariencia ?? {}), ...(r.ajustes.accountColors ? { accountColors: r.ajustes.accountColors } : {}) })
          } catch (e) {
            errores.push(`Ajustes: ${errText(e)}`)
          }
        }
        await ui.reload()
        setResult({ ...r, plantillas: r.plantillas.slice(0, plantillas), errores })
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
          <ExportIcon size={22} />
        </span>
        <div className="f-ei-drop-title">Soltá acá un archivo .sloth</div>
        <div className="f-ei-muted">Si no lo tenés a mano, elegilo desde tu PC.</div>
        <button type="button" className="btn primary" onClick={chooseFile} disabled={busy.current}>
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
    if (result.permisos) parts.push(plural(result.permisos, 'regla de permisos', 'reglas de permisos'))
    if (result.cuentas) parts.push(plural(result.cuentas, 'cuenta', 'cuentas'))
    const doneMsg = parts.length
      ? `Se importaron ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`}.`
      : 'No se importó nada.'
    return (
      <div className="f-ei-done" role="region" aria-label="Resultado de la importación">
        <div className="f-ei-done-head">
          <span className="f-ei-done-ico">
            <DoneIcon size={18} />
          </span>
          <div>
            <div className="f-ei-done-title">Configuración importada</div>
            <div role="status" className="f-ei-muted f-ei-done-msg">
              {doneMsg}
            </div>
          </div>
        </div>
        {result.cuentas > 0 && <p className="f-ei-muted">Las cuentas nuevas quedan sin sesión: iniciá sesión en cada una desde Configuración › Cuentas.</p>}
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
        <div className="f-ei-foot">
          <button type="button" className="btn ghost" onClick={cancel}>
            Importar otro archivo
          </button>
          <span className="f-ei-grow" />
          <button type="button" className="btn primary" onClick={onClose} autoFocus>
            Listo
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
          <PermissionIcon size={22} />
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
            <button type="button" className="btn ghost" onClick={cancel}>
              Cancelar
            </button>
            <span className="f-ei-grow" />
            <button type="submit" className="btn primary" disabled={!pwIn}>
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

  return (
    <div className="f-ei-tab">
      <div className="f-ei-fileRow">
        <span className="f-ei-drop-ico small">
          <ExportIcon size={16} />
        </span>
        <div className="f-ei-grow">
          <div className="mono f-ei-fname">{pre.file.split(/[\\/]/).pop()}</div>
          {plan.version !== '?' && <div className="f-ei-muted">Exportado con la v{plan.version}</div>}
        </div>
        <button type="button" className="btn" onClick={cancel} disabled={importing}>
          Elegir otro archivo
        </button>
      </div>

      {issues.length > 0 && (
        <div role="status" className="f-ei-warn">
          Hay {issues.join(' y ')}. Revisalos antes de importar.
        </div>
      )}
      {issues.length === 0 && (
        <div role="status" className="f-ei-okbox">
          Todo listo para importar: no hay conflictos ni rutas que falten.
        </div>
      )}

      <section className="f-ei-sec" aria-labelledby="im-qt">
        <h3 id="im-qt">Qué trae el archivo</h3>
        <div className="f-ei-card">
          {/* Espacios */}
          <div style={{ boxShadow: LINE }}>
            {hasSpaces ? (
              <>
                <label className="f-ei-row">
                  <input type="checkbox" checked={choices.grupos.espacios} onChange={() => setChoices((c) => ({ ...c, grupos: { ...c.grupos, espacios: !c.grupos.espacios } }))} disabled={importing} />
                  <span className="f-ei-grow">
                    <span className="f-ei-name">
                      <FolderIcon size={14} /> Espacios
                    </span>
                    <span className="f-ei-desc">Nombre, ruta, color y cuenta asignada. Los archivos del proyecto no vienen en el archivo.</span>
                  </span>
                  <span className="f-ei-size">
                    {spaces.filter((s) => statusOf(s) === 'ok' || statusOf(s) === 'conflicto').length} de {spaces.length} para importar
                  </span>
                </label>
                {spaces.map((s) => {
                  const st = statusOf(s)
                  const c = choices.espacios[String(s.index)]?.conflicto ?? 'saltear'
                  return (
                    <div key={s.index} className={`f-ei-sub${st === 'saltear' || st === 'ya' ? ' muted' : ''}`}>
                      <div className="f-ei-sub-head">
                        <span className="f-ei-dot" style={{ background: 'var(--fg-muted)' }} aria-hidden="true" />
                        <span className="f-ei-name">{s.nombre}</span>
                        <span className="f-ei-chip">{s.cuenta}</span>
                        <span className={`f-ei-badge ${st}`}>{badgeText(st)}</span>
                      </div>
                      <div className="f-ei-path mono" title={s.ruta}>
                        {s.ruta}
                      </div>
                      {st === 'faltante' && (
                        <div className="f-ei-fix">
                          <span className="f-ei-warnText">La ruta no existe en esta PC.</span>
                          <button type="button" className="btn sm warn" onClick={() => pickFolder(s.index)} disabled={importing}>
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
            icon={<TemplatesIcon size={14} />}
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
            present={plan.apariencia}
            on={choices.grupos.apariencia}
            onToggle={() => setChoices((c) => ({ ...c, grupos: { ...c.grupos, apariencia: !c.grupos.apariencia } }))}
            disabled={importing}
            icon={<ThemeIcon size={14} />}
            name="Apariencia"
            desc="Tema, densidad y tamaño del texto que trae el archivo."
            sum="Del archivo"
          />

          <Group
            present={!!plan.equipo}
            on={choices.grupos.equipo}
            onToggle={() => setChoices((c) => ({ ...c, grupos: { ...c.grupos, equipo: !c.grupos.equipo } }))}
            disabled={importing}
            icon={<TeamIcon size={14} />}
            name="Equipo y chat"
            desc={`Solo la URL del proyecto de Supabase (${plan.equipo ?? ''}). No cambia tu sesión ni tu key: cargala en Equipo.`}
            sum="Solo la URL"
          />

          <Group
            present={plan.reglas > 0}
            on={choices.grupos.permisos}
            onToggle={() => setChoices((c) => ({ ...c, grupos: { ...c.grupos, permisos: !c.grupos.permisos } }))}
            disabled={importing}
            icon={<PermissionIcon size={14} />}
            name="Reglas de permisos"
            desc="Los «Aprobar siempre» de cada espacio, en su .claude/settings.local.json."
            sum={plural(plan.reglas, 'regla', 'reglas')}
          />

          {/* Atajos: el archivo no trae cambios de atajos */}
          <div className="f-ei-row muted">
            <span className="f-ei-grow">
              <KeyboardIcon size={14} /> Atajos
            </span>
            <span className="f-ei-size">No trae este grupo</span>
          </div>
        </div>
      </section>

      {err && (
        <p role="alert" className="f-ei-err">
          {err}
        </p>
      )}
      <div className="f-ei-foot">
        <span className="f-ei-grow" />
        <button type="button" className="btn ghost" onClick={cancel} disabled={importing}>
          Cancelar
        </button>
        <button type="button" className="btn primary" onClick={confirm} disabled={importing} aria-busy={importing}>
          {importing ? 'Importando…' : 'Importar'}
        </button>
      </div>
    </div>
  )
}

function badgeText(st: PlanSpace['status']): string {
  switch (st) {
    case 'ok':
      return 'Nuevo'
    case 'conflicto':
      return 'Conflicto'
    case 'faltante':
      return 'Falta carpeta'
    case 'ya':
      return 'Ya está'
    default:
      return 'Se saltea'
  }
}

function Group(props: {
  present: boolean
  on: boolean
  onToggle: () => void
  disabled: boolean
  icon: React.ReactNode
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
          <span className="f-ei-name">
            {props.icon} {props.name}
          </span>
          <span className="f-ei-desc">{props.desc}</span>
        </span>
        <span className="f-ei-size">{props.sum}</span>
      </label>
    </div>
  )
}
