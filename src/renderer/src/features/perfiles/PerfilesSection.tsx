import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Modal } from '../../Modal'
import { cleanError } from '../../format'
import { Button, InlineAlert, Input, Select } from '../../ui'
import { useUi } from '../host'
import { Group, Row } from '../settings/ui'
import { MAX_NOMBRE_PERFIL, type EntradaActividad, type PerfilVista } from '../../../../shared/perfiles'
import { Avatar } from './Avatar'
import { CambiarDialog } from './CambiarDialog'
import { refrescarPerfiles, usePerfiles } from './store'
import { agruparActividadPorDia, textoActividad } from './view'

interface RespuestaGithub {
  login: string
  nombreAplicado: boolean
  aviso?: string
}

function validarNombre(n: string): string | null {
  const t = n.trim()
  if (!t) return 'Escribí un nombre para el perfil.'
  if ([...t].length > MAX_NOMBRE_PERFIL) return `El nombre puede tener hasta ${MAX_NOMBRE_PERFIL} letras.`
  return null
}

function Actividad({ perfilId }: { perfilId: string }): React.JSX.Element {
  const ui = useUi()
  const [items, setItems] = useState<EntradaActividad[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    setItems(null)
    setError(null)
    ui.invoke<EntradaActividad[]>('feat:perfiles:actividad', perfilId, 50)
      .then((r) => vivo && setItems(Array.isArray(r) ? r : []))
      .catch((e) => vivo && setError(cleanError(e)))
    return () => {
      vivo = false
    }
  }, [ui, perfilId])

  if (error) return <InlineAlert tone="danger">{error}</InlineAlert>
  if (!items) return <p className="f-perfil-vacio">Cargando…</p>
  if (items.length === 0) return <p className="f-perfil-vacio">Todavía no hay actividad.</p>
  const grupos = agruparActividadPorDia(items, Date.now())
  return (
    <div className="f-perfil-actividad">
      {grupos.map((g) => (
        <section key={g.dia} aria-label={g.dia}>
          <h3 className="f-perfil-dia">{g.dia}</h3>
          <ul>
            {g.items.map((e, i) => (
              <li key={`${e.t}-${i}`}>
                <span className="f-perfil-hora">{new Date(e.t).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</span>
                <span>{textoActividad(e)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function FilaPerfil({
  perfil,
  unico,
  onCambiar,
  onBorrar
}: {
  perfil: PerfilVista
  unico: boolean
  onCambiar: () => void
  onBorrar: () => void
}): React.JSX.Element {
  const ui = useUi()
  const [editando, setEditando] = useState(false)
  const [nombre, setNombre] = useState(perfil.nombre)
  const [error, setError] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [trabajando, setTrabajando] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const botonRenombrar = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (editando) inputRef.current?.select()
  }, [editando])

  const cerrarEdicion = (): void => {
    setEditando(false)
    setError(null)
    setNombre(perfil.nombre)
    requestAnimationFrame(() => botonRenombrar.current?.focus())
  }

  const guardar = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const v = validarNombre(nombre)
    if (v) return setError(v)
    setTrabajando(true)
    try {
      await ui.invoke('feat:perfiles:renombrar', perfil.id, nombre.trim())
      await refrescarPerfiles(ui)
      setEditando(false)
      setError(null)
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setTrabajando(false)
    }
  }

  const traer = async (): Promise<void> => {
    setTrabajando(true)
    setError(null)
    setAviso(null)
    try {
      const r = await ui.invoke<RespuestaGithub>('feat:perfiles:traerDeGithub', perfil.id, {})
      await refrescarPerfiles(ui)
      setAviso(r.aviso ?? (r.nombreAplicado ? `Listo: traje tu nombre y tu foto de GitHub (${r.login}).` : `Listo: traje tu foto de GitHub (${r.login}). El nombre quedó como estaba.`))
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setTrabajando(false)
    }
  }

  return (
    <li className="f-perfil-fila">
      <Avatar perfil={perfil} size={32} />
      <div className="f-perfil-fila-main">
        {editando ? (
          <form className="f-perfil-form" onSubmit={(e) => void guardar(e)} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), cerrarEdicion())}>
            <Input ref={inputRef} size="sm" aria-label={`Nombre nuevo para ${perfil.nombre}`} value={nombre} onChange={(e) => setNombre(e.target.value)} error={error ?? undefined} autoFocus />
            <Button type="submit" size="sm" variant="primary" loading={trabajando}>
              Guardar
            </Button>
            <Button size="sm" variant="ghost" onClick={cerrarEdicion}>
              Cancelar
            </Button>
          </form>
        ) : (
          <>
            <span className="f-perfil-nombre">
              {perfil.nombre}
              {perfil.activo && <span className="f-perfil-activo">Activo</span>}
            </span>
            {perfil.ghLogin && <span className="f-set-hint">GitHub: {perfil.ghLogin}</span>}
          </>
        )}
        {!editando && error && (
          <p role="alert" className="f-perfil-error">
            {error}
          </p>
        )}
        {aviso && (
          <p role="status" className="f-set-hint">
            {aviso}
          </p>
        )}
      </div>
      {!editando && (
        <div className="f-perfil-acciones">
          {!perfil.activo && (
            <Button size="sm" variant="secondary" onClick={onCambiar}>
              Cambiar a este
            </Button>
          )}
          <Button ref={botonRenombrar} size="sm" variant="ghost" aria-label={`Renombrar ${perfil.nombre}`} onClick={() => setEditando(true)}>
            Renombrar
          </Button>
          <Button size="sm" variant="ghost" loading={trabajando} aria-label={`Traer nombre y foto de GitHub para ${perfil.nombre}`} onClick={() => void traer()}>
            Traer de GitHub
          </Button>
          <Button size="sm" variant="ghost" disabled={perfil.activo || unico} aria-label={`Borrar ${perfil.nombre}`} title={perfil.activo ? 'No se puede borrar el perfil activo' : undefined} onClick={onBorrar}>
            Borrar
          </Button>
        </div>
      )}
    </li>
  )
}

function BorrarDialog({ perfil, onClose }: { perfil: PerfilVista; onClose: () => void }): React.JSX.Element {
  const ui = useUi()
  const [trabajando, setTrabajando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const borrar = async (): Promise<void> => {
    setTrabajando(true)
    setError(null)
    try {
      await ui.invoke('feat:perfiles:borrar', perfil.id)
      await refrescarPerfiles(ui)
      onClose()
    } catch (e) {
      setError(cleanError(e))
      setTrabajando(false)
    }
  }
  return (
    <Modal
      title={`Borrar «${perfil.nombre}»`}
      size="sm"
      onClose={onClose}
      locked={trabajando}
      footer={
        <>
          <Button variant="ghost" autoFocus onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="danger" loading={trabajando} onClick={() => void borrar()}>
            Borrar perfil
          </Button>
        </>
      }
    >
      <p className="f-perfil-texto">Se guarda en Respaldos, no se pierde nada. Si más adelante lo querés de vuelta, podés recuperarlo desde esa carpeta.</p>
      {error && (
        <p role="alert" className="f-perfil-error">
          {error}
        </p>
      )}
    </Modal>
  )
}

export function PerfilesSection(): React.JSX.Element {
  const ui = useUi()
  const payload = usePerfiles(ui)
  const [nuevo, setNuevo] = useState('')
  const [errorNuevo, setErrorNuevo] = useState<string | null>(null)
  const [creando, setCreando] = useState(false)
  const [aCambiar, setACambiar] = useState<string | null>(null)
  const [aBorrar, setABorrar] = useState<string | null>(null)
  const [actividadDe, setActividadDe] = useState<string | null>(null)
  const [cerrando, setCerrando] = useState(false)
  const [errorAjenas, setErrorAjenas] = useState<string | null>(null)

  if (!payload) return <p className="f-perfil-vacio">Cargando…</p>

  const perfilActividad = payload.perfiles.some((p) => p.id === actividadDe) ? (actividadDe as string) : payload.activo
  const destino = payload.perfiles.find((p) => p.id === aCambiar)
  const borrando = payload.perfiles.find((p) => p.id === aBorrar)

  const crear = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const v = validarNombre(nuevo)
    if (v) return setErrorNuevo(v)
    setCreando(true)
    setErrorNuevo(null)
    try {
      await ui.invoke('feat:perfiles:crear', nuevo.trim())
      await refrescarPerfiles(ui)
      setNuevo('')
    } catch (err) {
      setErrorNuevo(cleanError(err))
    } finally {
      setCreando(false)
    }
  }

  const cerrarAjenas = async (): Promise<void> => {
    setCerrando(true)
    setErrorAjenas(null)
    try {
      await ui.invoke('feat:perfiles:cerrarAjenas')
      await refrescarPerfiles(ui)
    } catch (err) {
      setErrorAjenas(cleanError(err))
    } finally {
      setCerrando(false)
    }
  }

  return (
    <>
      {payload.modoRaiz && <InlineAlert tone="warning">Los perfiles no se pudieron preparar; Sloth usa tus datos de siempre.</InlineAlert>}

      <Group id="g-perfiles" title="Tus perfiles">
        <ul className="f-perfil-lista">
          {payload.perfiles.map((p) => (
            <FilaPerfil key={p.id} perfil={p} unico={payload.perfiles.length <= 1} onCambiar={() => setACambiar(p.id)} onBorrar={() => setABorrar(p.id)} />
          ))}
        </ul>
        <form className="f-perfil-crear" onSubmit={(e) => void crear(e)}>
          <Input size="sm" aria-label="Nombre del perfil nuevo" placeholder="Nombre del perfil nuevo" value={nuevo} onChange={(e) => setNuevo(e.target.value)} error={errorNuevo ?? undefined} maxLength={MAX_NOMBRE_PERFIL * 2} />
          <Button type="submit" size="sm" variant="primary" loading={creando}>
            Crear perfil
          </Button>
        </form>
      </Group>

      {payload.ajenas.cantidad > 0 && (
        <Group id="g-perfiles-ajenas" title="Terminales de otros perfiles en segundo plano">
          <Row
            title={payload.ajenas.cantidad === 1 ? '1 terminal sigue abierta' : `${payload.ajenas.cantidad} terminales siguen abiertas`}
            hint="Quedaron abiertas cuando cambiaste de perfil. Podés cerrarlas si ya no las necesitás."
          >
            <Button size="sm" variant="secondary" loading={cerrando} onClick={() => void cerrarAjenas()}>
              Cerrarlas
            </Button>
          </Row>
          {errorAjenas && (
            <p role="alert" className="f-perfil-error">
              {errorAjenas}
            </p>
          )}
        </Group>
      )}

      <Group id="g-perfiles-act" title="Actividad">
        <div className="f-perfil-act-head">
          <Select
            size="sm"
            aria-label="Ver la actividad de"
            value={perfilActividad}
            onChange={(e) => setActividadDe(e.target.value)}
            options={payload.perfiles.map((p) => ({ value: p.id, label: p.nombre }))}
          />
        </div>
        <Actividad perfilId={perfilActividad} />
      </Group>

      {destino && <CambiarDialog payload={payload} destino={destino} onClose={() => setACambiar(null)} />}
      {borrando && <BorrarDialog perfil={borrando} onClose={() => setABorrar(null)} />}
    </>
  )
}
