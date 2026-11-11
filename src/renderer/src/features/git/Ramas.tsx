import { useState } from 'react'
import { useUi } from '../host'
import { BranchIcon } from '../../icons/SlothIcons'
import { ArrowDownGlyph, ArrowUpGlyph, CheckGlyph, SpinGlyph } from './glyphs'
import { errText, plural, type BranchesRes, type GitShared, type StashRes, type StatusRes, type SyncRes } from './util'

interface Props {
  g: GitShared
  st: StatusRes
  sync: SyncRes | null
  stash: StashRes | null
  branches: BranchesRes | null
  onGoCambios: () => void
}

/** Pestaña Ramas: subir/traer, cambiar (con stash si hay cambios), locales, remotas y rama nueva. */
export function Ramas({ g, st, sync, stash, branches, onGoCambios }: Props): React.JSX.Element {
  const ui = useUi()
  const cur = st.branch ?? 'HEAD separado'
  const curName = st.branch ?? null
  const nFiles = st.files.length
  const [ask, setAsk] = useState<{ name: string; remote: boolean } | null>(null)
  const [askErr, setAskErr] = useState('')
  const [busy, setBusy] = useState('')
  const [newName, setNewName] = useState('')
  const [base, setBase] = useState(curName ?? '')
  const [brErr, setBrErr] = useState('')

  const ahead = sync?.ahead ?? 0
  const behind = sync?.behind ?? 0
  const upstream = sync?.upstream ?? null
  const locals = branches?.local ?? []
  const others = locals.filter((b) => !b.current)
  const remotes = branches?.remote ?? []
  const syncTxt = `${plural(ahead, 'commit por subir', 'commits por subir')} · ${behind} por bajar`

  /** Corre una acción: marca ocupado; el error va al banner del panel. */
  const act = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key)
    try {
      await fn()
    } catch (e) {
      g.fail(errText(e))
    } finally {
      setBusy('')
    }
  }

  const doSwitch = async (name: string, remote: boolean): Promise<void> => {
    await ui.invoke('feat:git:switch', g.wsId, name, remote)
    g.say(`Cambiaste a ${name}`)
    await g.reload()
  }

  const goBranch = (name: string, remote: boolean): void => {
    if (name === curName) return
    if (nFiles > 0) {
      setAskErr('')
      return setAsk({ name, remote })
    }
    void act(`go:${name}`, () => doSwitch(name, remote))
  }

  /** Guarda los cambios en el stash de Sloth y cambia. Si el cambio falla, los cambios quedan en el stash. */
  const stashAndSwitch = async (): Promise<void> => {
    if (!ask) return
    const { name, remote } = ask
    setBusy('stash')
    setAskErr('')
    try {
      await ui.invoke('feat:git:stashPush', g.wsId)
    } catch (e) {
      setAskErr(errText(e))
      setBusy('')
      return
    }
    try {
      setAsk(null)
      await doSwitch(name, remote)
      g.say(`Cambios guardados en el stash · cambiaste a ${name}`)
    } catch (e) {
      setAsk(null)
      g.fail(`${errText(e)} Tus cambios quedaron guardados en el stash: restauralos desde acá.`)
      await g.reload()
    } finally {
      setBusy('')
    }
  }

  const restore = (): void =>
    void act('restore', async () => {
      await ui.invoke('feat:git:stashRestore', g.wsId)
      g.say('Cambios restaurados desde el stash')
      await g.reload()
    })

  const pull = (): void =>
    void act('pull', async () => {
      const out = await ui.invoke<string>('feat:git:pull', g.wsId)
      g.say(/already up to date|Ya está/i.test(out ?? '') ? `Ya estás al día con origin/${curName}` : `Traído de origin/${curName}`)
      await g.reload()
    })

  const push = (): void =>
    void act('push', async () => {
      if (!curName) return
      await ui.invoke('feat:git:push', g.wsId, curName)
      g.say(`Subido a origin/${curName}`)
      await g.reload()
    })

  const createBranch = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const name = newName.trim().replace(/\s+/g, '-')
    if (!name) return setBrErr('Ponele un nombre a la rama nueva.')
    if (!/^[\w./-]+$/.test(name)) return setBrErr('Usá letras sin acento, números, guiones, puntos o barras.')
    if (locals.some((b) => b.name === name)) return setBrErr(`Ya existe una rama llamada «${name}».`)
    if (!base) return setBrErr('Elegí desde qué rama crearla.')
    setBrErr('')
    setBusy('new')
    try {
      await ui.invoke('feat:git:createBranch', g.wsId, name, base)
      setNewName('')
      g.say(`Rama nueva «${name}» desde ${base} · ahora estás en ella`)
      await g.reload()
    } catch (err) {
      setBrErr(errText(err))
    } finally {
      setBusy('')
    }
  }

  const bsy = busy !== ''

  return (
    <div className="g-branches">
      {g.prs.map((p) => (
        <div key={p.url} role="status" className="g-banner ok">
          <CheckGlyph />
          <div className="g-banner-body">
            <div className="g-banner-t">PR #{p.number} abierto hacia {p.to}</div>
            <div className="g-banner-s">
              {p.from} → {p.to} · esperando revisión
            </div>
          </div>
          <button type="button" className="g-btn-plain" onClick={() => void ui.invoke('feat:git:openUrl', p.url).catch((e) => g.fail(errText(e)))}>
            Ver PR
          </button>
        </div>
      ))}

      {ask && (
        <div role="status" className="g-banner warn">
          <div className="g-banner-body">
            <div className="g-banner-t">
              Tenés {plural(nFiles, 'archivo sin confirmar', 'archivos sin confirmar')}.
            </div>
            <div className="g-banner-s">Confirmalos o guardalos antes de cambiar a «{ask.name}».</div>
            {askErr && (
              <div role="alert" className="form-error">
                {askErr}
              </div>
            )}
            <div className="g-banner-actions">
              <button type="button" className="g-btn-solid" onClick={() => void stashAndSwitch()} disabled={bsy}>
                {busy === 'stash' ? <SpinGlyph /> : null}
                Guardar aparte (stash) y cambiar
              </button>
              <button type="button" className="g-btn-plain" onClick={onGoCambios} disabled={bsy}>
                Ir a Cambios
              </button>
              <button type="button" className="g-btn-ghost" onClick={() => setAsk(null)} disabled={bsy}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {stash && (
        <div className="g-card">
          <div className="g-card-body">
            <div className="g-card-t">Cambios guardados aparte (stash)</div>
            <div className="g-card-s">
              {plural(stash.files, 'archivo', 'archivos')} de {stash.branch}
            </div>
          </div>
          <button type="button" className="g-btn-plain" onClick={restore} disabled={bsy}>
            {busy === 'restore' ? <SpinGlyph /> : null}
            Restaurar
          </button>
        </div>
      )}

      <section aria-labelledby="g-rm-cur" className="g-section">
        <h2 id="g-rm-cur" className="g-section-t">
          Rama actual
        </h2>
        <div className="g-current">
          <span className="g-current-ico" aria-hidden="true">
            <BranchIcon size={18} strokeWidth={1.8} />
          </span>
          <div className="g-current-body">
            <div className="g-current-name">
              <span className="mono">{cur}</span>
              <span className="g-pill">Actual</span>
            </div>
            <div className="g-card-s">
              {upstream ? `Sigue a ${upstream} · ${syncTxt}` : `Todavía no está en origin · ${plural(ahead, 'commit por subir', 'commits por subir')}`}
            </div>
          </div>
          <div className="g-current-actions">
            <button type="button" className="g-btn-plain" onClick={push} disabled={bsy || !curName}>
              {busy === 'push' ? <SpinGlyph /> : <ArrowUpGlyph />}
              Subir
            </button>
            <button type="button" className="g-btn-plain" onClick={pull} disabled={bsy || !curName}>
              {busy === 'pull' ? <SpinGlyph /> : <ArrowDownGlyph />}
              Traer
            </button>
          </div>
        </div>
      </section>

      {others.length > 0 && (
        <section aria-labelledby="g-rm-loc" className="g-section">
          <h2 id="g-rm-loc" className="g-section-t">
            Otras ramas locales
          </h2>
          <div className="g-table">
            {others.map((b) => (
              <div key={b.name} className="g-trow">
                <div className="g-trow-body">
                  <div className="g-trow-name mono">{b.name}</div>
                  <div className="g-trow-sub">{b.subject}</div>
                </div>
                <span className="g-trow-meta">{b.upstream ? `sigue a ${b.upstream}` : 'sin remoto'}</span>
                <button type="button" className="g-btn-plain" onClick={() => goBranch(b.name, false)} aria-label={`Cambiar a ${b.name}`} disabled={bsy}>
                  Cambiar
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="g-rm-rem" className="g-section">
        <h2 id="g-rm-rem" className="g-section-t">
          Remotas en origin
        </h2>
        <div className="g-table">
          {remotes.length === 0 && <div className="g-sec-hint">No hay ramas remotas conocidas. Usá «Subir» para publicar la actual.</div>}
          {remotes.map((r) => {
            const isCur = r.name === curName
            return (
              <div key={r.name} className="g-trow">
                <div className="g-trow-body">
                  <div className="g-trow-name mono">origin/{r.name}</div>
                  <div className="g-trow-sub">{r.subject}</div>
                </div>
                <span className="g-trow-meta">{isCur ? 'es la actual' : r.hasLocal ? 'con copia local' : 'solo en remoto'}</span>
                <button
                  type="button"
                  className="g-btn-plain"
                  onClick={() => goBranch(r.name, true)}
                  aria-label={`Cambiar a origin/${r.name}`}
                  disabled={bsy || isCur}
                >
                  Cambiar
                </button>
              </div>
            )
          })}
        </div>
      </section>

      <form className="g-newbranch" onSubmit={(e) => void createBranch(e)}>
        <div className="g-newbranch-t">Nueva rama desde…</div>
        <div className="g-newbranch-row">
          <label className="g-field">
            <span>Nombre</span>
            <input className="mono" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Ej.: fix/tabla-vacia" autoComplete="off" spellCheck={false} />
          </label>
          <label className="g-field">
            <span>Desde</span>
            <select value={base} onChange={(e) => setBase(e.target.value)}>
              {locals.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {brErr && (
          <div role="alert" className="form-error">
            {brErr}
          </div>
        )}
        <div className="g-newbranch-actions">
          <button type="submit" className="g-btn-solid" disabled={bsy || locals.length === 0}>
            {busy === 'new' ? <SpinGlyph /> : null}
            Crear y cambiar
          </button>
        </div>
      </form>
    </div>
  )
}
