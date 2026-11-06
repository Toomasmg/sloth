import { useEffect, useRef, useState } from 'react'
import { CheckCircle, FileArrowDown, FileArrowUp, FolderSimple, Notebook, SkipForward, UserPlus, X } from '@phosphor-icons/react'
import type { FeatureUi } from '../host'
import { useUi } from '../host'
import { onRequest, request } from './bus'
import './export-import.css'

interface PlanAccount {
  label: string
  action: 'crear' | 'existe'
}
interface PlanWorkspace {
  name: string
  folder: string
  cuenta: string
  branch?: string
  action: 'agregar' | 'saltear'
  reason?: string
}
interface ImportPlan {
  version: string
  cuentas: PlanAccount[]
  espacios: PlanWorkspace[]
  plantillas: { nuevas: string[]; existentes: string[]; salteadas: { name: string; reason: string }[] }
}
interface Preview {
  token: string
  file: string
  plan: ImportPlan
}
interface ImportResult {
  cuentas: number
  espacios: number
  plantillas: number
  errores: string[]
}
interface ConfirmResult {
  cuentas: number
  espacios: number
  errores: string[]
  plantillas: Record<string, unknown>[]
}

type View =
  | { kind: 'preview'; preview: Preview }
  | { kind: 'imported'; result: ImportResult }
  | { kind: 'exported'; file: string; cuentas: number; espacios: number }

const errText = (e: unknown): string =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const n = (k: number, uno: string, varios: string): string => `${k} ${k === 1 ? uno : varios}`

function Modal({ title, icon, onClose, children, actions }: {
  title: string
  icon: React.ReactNode
  onClose: () => void
  children: React.ReactNode
  actions: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        className="modal f-export-import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="f-ei-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          {icon}
          <h2 id="f-ei-title">{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        {children}
        <footer className="modal-actions">{actions}</footer>
      </div>
    </div>
  )
}

function PreviewView({ preview, onDone, onClose }: { preview: Preview; onDone: (r: ImportResult) => void; onClose: () => void }): React.JSX.Element {
  const ui = useUi()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { plan } = preview
  const newAcc = plan.cuentas.filter((c) => c.action === 'crear')
  const oldAcc = plan.cuentas.filter((c) => c.action === 'existe')
  const add = plan.espacios.filter((w) => w.action === 'agregar')
  const skip = plan.espacios.filter((w) => w.action === 'saltear')
  const tplNew = plan.plantillas.nuevas
  const nothing = !newAcc.length && !add.length && !tplNew.length

  const cancel = (): void => {
    void ui.invoke('feat:export-import:cancel', preview.token).catch(() => {})
    onClose()
  }
  const confirm = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const r = await ui.invoke<ConfirmResult>('feat:export-import:confirm', preview.token)
      // Las plantillas las guarda su propia función (valida y las mantiene en memoria).
      let saved = 0
      const errores = [...r.errores]
      for (const t of r.plantillas) {
        try {
          await ui.invoke('feat:templates:save', t)
          saved++
        } catch (e) {
          errores.push(`Plantilla «${String(t.name)}»: ${errText(e)}`)
        }
      }
      await ui.reload()
      onDone({ cuentas: r.cuentas, espacios: r.espacios, plantillas: saved, errores })
    } catch (e) {
      setErr(errText(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Importar configuración"
      icon={<FileArrowUp size={18} weight="duotone" aria-hidden="true" className="f-ei-head-icon" />}
      onClose={cancel}
      actions={
        <>
          <button type="button" className="btn ghost" onClick={cancel}>
            Cancelar
          </button>
          <button type="button" className="btn primary" onClick={() => void confirm()} disabled={busy || nothing} autoFocus={!nothing}>
            {busy ? 'Importando…' : 'Importar'}
          </button>
        </>
      }
    >
      <p className="f-ei-file mono" title={preview.file}>
        {preview.file}
        {plan.version !== '?' && <span className="f-ei-ver"> · exportado con v{plan.version}</span>}
      </p>

      <section className="f-ei-sec" aria-labelledby="f-ei-acc">
        <h3 id="f-ei-acc">
          <UserPlus size={14} aria-hidden="true" /> Cuentas
        </h3>
        {newAcc.length ? (
          <>
            <ul className="f-ei-list">
              {newAcc.map((c) => (
                <li key={c.label}>
                  <span className="f-ei-badge add">Nueva</span>
                  <span className="f-ei-name">{c.label}</span>
                </li>
              ))}
            </ul>
            <p className="f-ei-help">Quedan sin sesión: iniciá sesión en cada una desde el sidebar.</p>
          </>
        ) : (
          <p className="f-ei-help">No hay cuentas nuevas.</p>
        )}
        {oldAcc.length > 0 && <p className="f-ei-help">Ya existen acá y se reutilizan: {oldAcc.map((c) => c.label).join(', ')}.</p>}
      </section>

      <section className="f-ei-sec" aria-labelledby="f-ei-ws">
        <h3 id="f-ei-ws">
          <FolderSimple size={14} aria-hidden="true" /> Espacios
        </h3>
        {plan.espacios.length === 0 && <p className="f-ei-help">El archivo no trae espacios.</p>}
        <ul className="f-ei-list">
          {add.map((w, i) => (
            <li key={`a${i}`}>
              <span className="f-ei-badge add">Se agrega</span>
              <span className="f-ei-name">{w.name}</span>
              <span className="f-ei-meta mono" title={w.folder}>
                {w.cuenta} · {w.branch ? `${w.branch} · ` : ''}
                {w.folder}
              </span>
            </li>
          ))}
          {skip.map((w, i) => (
            <li key={`s${i}`} className="skip">
              <span className="f-ei-badge skip">
                <SkipForward size={10} weight="fill" aria-hidden="true" /> Se saltea
              </span>
              <span className="f-ei-name">{w.name}</span>
              <span className="f-ei-meta">{w.reason}</span>
            </li>
          ))}
        </ul>
      </section>

      {(tplNew.length > 0 || plan.plantillas.existentes.length > 0 || plan.plantillas.salteadas.length > 0) && (
        <section className="f-ei-sec" aria-labelledby="f-ei-tpl">
          <h3 id="f-ei-tpl">
            <Notebook size={14} aria-hidden="true" /> Plantillas
          </h3>
          {tplNew.length > 0 && <p className="f-ei-help">Se agregan: {tplNew.join(', ')}.</p>}
          {plan.plantillas.existentes.length > 0 && (
            <p className="f-ei-help">Ya tenés con ese nombre (se conservan las tuyas): {plan.plantillas.existentes.join(', ')}.</p>
          )}
          {plan.plantillas.salteadas.length > 0 && (
            <p className="f-ei-help">
              Se saltean: {plan.plantillas.salteadas.map((t) => `${t.name} (${t.reason})`).join(', ')}.
            </p>
          )}
        </section>
      )}

      {nothing && <p className="f-ei-help">No hay nada nuevo para importar.</p>}
      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}
    </Modal>
  )
}

function Global(): React.JSX.Element | null {
  const ui = useUi()
  const [view, setView] = useState<View | null>(null)
  const busy = useRef(false)

  useEffect(
    () =>
      onRequest(async (r) => {
        if (busy.current) return
        busy.current = true
        try {
          if (r.kind === 'export') {
            const res = await ui.invoke<{ file: string; cuentas: number; espacios: number } | null>('feat:export-import:export')
            if (res) setView({ kind: 'exported', ...res })
          } else {
            const p = await ui.invoke<Preview | null>('feat:export-import:import')
            if (p) setView({ kind: 'preview', preview: p })
          }
        } catch (e) {
          ui.notifyError(errText(e))
        } finally {
          busy.current = false
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const close = (): void => setView(null)
  if (!view) return null
  if (view.kind === 'preview') return <PreviewView preview={view.preview} onClose={close} onDone={(result) => setView({ kind: 'imported', result })} />

  const ok = <CheckCircle size={18} weight="fill" aria-hidden="true" className="f-ei-ok-icon" />
  const closeBtn = (
    <button type="button" className="btn primary" onClick={close} autoFocus>
      Listo
    </button>
  )
  if (view.kind === 'exported') {
    return (
      <Modal title="Configuración exportada" icon={ok} onClose={close} actions={closeBtn}>
        <p className="f-ei-help">
          Se guardaron {n(view.cuentas, 'cuenta', 'cuentas')} y {n(view.espacios, 'espacio', 'espacios')} en:
        </p>
        <p className="f-ei-file mono">{view.file}</p>
        <p className="f-ei-help">El archivo no incluye sesiones, credenciales ni conversaciones. En la otra PC: paleta → «Importar configuración».</p>
      </Modal>
    )
  }
  const r = view.result
  return (
    <Modal title="Configuración importada" icon={ok} onClose={close} actions={closeBtn}>
      <p className="f-ei-help" role="status">
        Se agregaron {n(r.cuentas, 'cuenta', 'cuentas')}, {n(r.espacios, 'espacio', 'espacios')} y {n(r.plantillas, 'plantilla', 'plantillas')}.
      </p>
      {r.cuentas > 0 && <p className="f-ei-help">Las cuentas nuevas quedan sin sesión: iniciá sesión desde el sidebar.</p>}
      {r.errores.length > 0 && (
        <ul className="f-ei-list f-ei-errors" role="alert">
          {r.errores.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

const ui: FeatureUi = {
  name: 'export-import',
  Global,
  commands: () => [
    {
      id: 'export-import:export',
      title: 'Exportar configuración',
      subtitle: 'Cuentas, espacios y plantillas a un JSON (sin sesiones)',
      group: 'Sloth',
      keywords: 'export backup respaldo otra pc json',
      run: () => request({ kind: 'export' })
    },
    {
      id: 'export-import:import',
      title: 'Importar configuración',
      subtitle: 'Desde un JSON exportado en otra PC',
      group: 'Sloth',
      keywords: 'import restaurar otra pc json',
      run: () => request({ kind: 'import' })
    }
  ]
}

export default ui
