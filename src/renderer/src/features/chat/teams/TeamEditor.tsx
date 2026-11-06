import { useEffect, useId, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Camera, Check, Users } from '@phosphor-icons/react'
import { CHAT_LIMITS, type ChatTeam, type ChatTeamInput } from '../../../../../shared/chat'
import { useUi } from '../../host'
import { cleanError } from '../../../format'
import {
  canvasToPhotoBase64,
  checkPhotoFile,
  cropGeometry,
  drawCrop,
  PHOTO_ACCEPT_ATTR,
  PHOTO_SIDE,
  ZOOM_MAX,
  ZOOM_MIN
} from './photo-crop'
import { canManage, TeamModal } from './shared'

type PhotoMode = 'keep' | 'none' | 'remove' | 'new'
const STEP = 4
const codepoints = (s: string): number => [...s].length

/** Crear (sin `team`) o editar (con `team`, solo owner/admin) nombre, descripción y foto (con recorte). */
export function TeamEditor({
  team,
  onClose,
  onSaved
}: {
  team?: ChatTeam
  onClose(): void
  onSaved(team: ChatTeam): void
}): React.JSX.Element {
  const ui = useUi()
  const titleId = useId()
  const nameId = useId()
  const descId = useId()
  const countId = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  const editing = Boolean(team)
  const canEdit = !team || canManage(team.role)
  const hasTeamPhoto = Boolean(team?.photo)

  const [name, setName] = useState(team?.name ?? '')
  const [description, setDescription] = useState(team?.description ?? '')
  const [photoMode, setPhotoMode] = useState<PhotoMode>(hasTeamPhoto ? 'keep' : 'none')
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null)
  const [zoom, setZoom] = useState(ZOOM_MIN)
  const [ox, setOx] = useState(0)
  const [oy, setOy] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Si falló la foto después de crear el equipo, el equipo ya existe: no se vuelve a crear.
  const [created, setCreated] = useState(false)

  const nameLen = codepoints(name.trim())
  const descLen = codepoints(description.trim())
  const nameOk = nameLen >= 1 && nameLen <= CHAT_LIMITS.teamName
  const descOk = descLen <= CHAT_LIMITS.teamDescription

  // Dibuja el recorte cada vez que cambia la imagen o el encuadre.
  useEffect(() => {
    const c = canvasRef.current
    if (!c || !bitmap) return
    drawCrop(c, bitmap, bitmap.width, bitmap.height, zoom, ox, oy)
  }, [bitmap, zoom, ox, oy])

  // Libera el bitmap al desmontar.
  useEffect(() => () => bitmap?.close(), [bitmap])

  const pickFile = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = '' // permite volver a elegir el mismo archivo
    if (!file) return
    const bad = checkPhotoFile(file)
    if (bad) {
      setErr(bad)
      return
    }
    setErr(null)
    try {
      // El bitmap anterior se cierra en el cleanup del efecto de arriba.
      setBitmap(await createImageBitmap(file))
      setZoom(ZOOM_MIN)
      setOx(0)
      setOy(0)
      setPhotoMode('new')
    } catch {
      setErr('No se pudo leer la imagen. Probá con otra.')
    }
  }

  const changeZoom = (z: number): void => {
    if (!bitmap) return
    const g = cropGeometry(bitmap.width, bitmap.height, PHOTO_SIDE, z, ox, oy)
    setZoom(z)
    setOx(g.ox)
    setOy(g.oy)
  }

  const moveBy = (dx: number, dy: number): void => {
    if (!bitmap) return
    const g = cropGeometry(bitmap.width, bitmap.height, PHOTO_SIDE, zoom, ox + dx, oy + dy)
    setOx(g.ox)
    setOy(g.oy)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!bitmap || busy) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, ox, oy }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const d = drag.current
    if (!d || !bitmap) return
    // El canvas puede verse más chico que 256 px: se convierte el movimiento a px del canvas.
    const k = PHOTO_SIDE / e.currentTarget.getBoundingClientRect().width
    const g = cropGeometry(bitmap.width, bitmap.height, PHOTO_SIDE, zoom, d.ox + (e.clientX - d.x) * k, d.oy + (e.clientY - d.y) * k)
    setOx(g.ox)
    setOy(g.oy)
  }
  const endDrag = (): void => {
    drag.current = null
  }

  const onCropKey = (e: React.KeyboardEvent<HTMLCanvasElement>): void => {
    const step = e.shiftKey ? STEP * 4 : STEP
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step]
    }
    const m = moves[e.key]
    if (!m) return
    e.preventDefault()
    moveBy(m[0], m[1])
  }

  const removePhoto = (): void => {
    setErr(null)
    setBitmap(null)
    setPhotoMode('remove')
  }

  const undoPhoto = (): void => {
    setErr(null)
    setBitmap(null)
    setPhotoMode(hasTeamPhoto ? 'keep' : 'none')
  }

  const save = async (): Promise<void> => {
    if (!canEdit || busy || created || !nameOk || !descOk) return
    setErr(null)
    setBusy(true)
    try {
      // Foto: en create solo se manda si hay una nueva; en update, null la quita y omitir la deja como está.
      let photoBase64: string | null | undefined
      if (photoMode === 'new') {
        if (!canvasRef.current) throw new Error('No se pudo preparar la foto.')
        photoBase64 = (await canvasToPhotoBase64(canvasRef.current)).base64
      } else if (photoMode === 'remove' && editing) {
        photoBase64 = null
      }
      const base = { name: name.trim(), description: description.trim() }
      if (!team) {
        const input: ChatTeamInput = photoBase64 ? { ...base, photoBase64 } : base
        const saved = await ui.invoke<ChatTeam>('feat:chat:createTeam', input)
        onSaved(saved)
      } else {
        const patch: Partial<ChatTeamInput> = photoBase64 === undefined ? base : { ...base, photoBase64 }
        const saved = await ui.invoke<ChatTeam>('feat:chat:updateTeam', team.id, patch)
        onSaved(saved)
      }
    } catch (e) {
      const msg = cleanError(e)
      if (!team && msg.startsWith('El equipo se creó')) setCreated(true)
      setErr(msg)
    } finally {
      setBusy(false)
    }
  }

  const showCurrent = photoMode === 'keep' && hasTeamPhoto
  const showCrop = photoMode === 'new' && bitmap !== null
  const locked = !canEdit || busy || created

  return (
    <TeamModal titleId={titleId} title={editing ? `Editar ${team?.name ?? 'equipo'}` : 'Nuevo equipo'} icon={<Users size={18} weight="duotone" />} busy={busy} onClose={onClose}>
      <form
        className="f-chat-team-form"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {!canEdit && <p className="field-help">Solo el owner o un admin puede editar el equipo.</p>}

        <div className="field">
          <label htmlFor={nameId}>Nombre</label>
          <input
            id={nameId}
            value={name}
            maxLength={CHAT_LIMITS.teamName}
            onChange={(e) => setName(e.target.value)}
            disabled={locked}
            autoFocus={!editing}
            autoComplete="off"
            aria-describedby={`${nameId}-count`}
            placeholder="Ej: Plataforma"
          />
          <span id={`${nameId}-count`} className="f-chat-team-count">
            {nameLen}/{CHAT_LIMITS.teamName}
          </span>
        </div>

        <div className="field">
          <label htmlFor={descId}>Descripción (opcional)</label>
          <textarea
            id={descId}
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={locked}
            aria-describedby={countId}
          />
          <span id={countId} className={`f-chat-team-count${descOk ? '' : ' over'}`}>
            {descLen}/{CHAT_LIMITS.teamDescription}
          </span>
        </div>

        <section className="f-chat-team-photo-block" aria-labelledby={`${titleId}-photo`}>
          <h3 id={`${titleId}-photo`}>Foto</h3>

          {showCurrent && team?.photo && (
            <img className="f-chat-team-photo" src={team.photo} alt={`Foto actual de ${team.name}`} width={96} height={96} />
          )}
          {photoMode === 'none' && (
            <p className="f-chat-team-photo-empty" aria-hidden="true">
              <Users size={28} />
            </p>
          )}
          {photoMode === 'remove' && <p className="field-help">La foto se quita al guardar.</p>}
          {showCrop && (
            <div className="f-chat-team-crop-wrap">
              <canvas
                ref={canvasRef}
                className="f-chat-team-crop"
                width={PHOTO_SIDE}
                height={PHOTO_SIDE}
                role="application"
                tabIndex={0}
                aria-label="Recorte de la foto. Arrastrala, o usá las flechas para moverla (Shift acelera)."
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={onCropKey}
              />
              <div className="field">
                <label htmlFor={`${titleId}-zoom`}>Zoom</label>
                <input
                  id={`${titleId}-zoom`}
                  type="range"
                  min={ZOOM_MIN}
                  max={ZOOM_MAX}
                  step={0.05}
                  value={zoom}
                  disabled={locked}
                  onChange={(e) => changeZoom(Number(e.target.value))}
                />
              </div>
            </div>
          )}

          <div className="f-chat-team-actions">
            {canEdit && (
              <button type="button" className="btn sm" onClick={() => fileRef.current?.click()} disabled={locked}>
                <Camera size={14} aria-hidden="true" />
                {photoMode === 'new' ? 'Cambiar imagen' : 'Elegir foto'}
              </button>
            )}
            {canEdit && editing && (photoMode === 'keep' || photoMode === 'new') && (
              <button type="button" className="btn sm ghost" onClick={removePhoto} disabled={locked}>
                Quitar foto
              </button>
            )}
            {canEdit && (photoMode === 'remove' || photoMode === 'new') && (
              <button type="button" className="btn sm ghost" onClick={undoPhoto} disabled={locked}>
                {photoMode === 'new' ? 'Descartar recorte' : 'Deshacer'}
              </button>
            )}
          </div>
          <input ref={fileRef} type="file" accept={PHOTO_ACCEPT_ATTR} hidden onChange={(e) => void pickFile(e)} aria-label="Elegir imagen de la foto del equipo" />
          <p className="field-help">PNG, JPG o WebP de hasta 10 MB. Se recorta cuadrada y se guarda en 256 × 256.</p>
        </section>

        {err && (
          <p className="form-error" role="alert">
            {err}
          </p>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {created ? 'Cerrar' : 'Cancelar'}
          </button>
          {!created && (
            <button type="submit" className="btn primary" disabled={locked || !nameOk || !descOk}>
              {busy ? (
                'Guardando…'
              ) : (
                <>
                  <Check size={14} aria-hidden="true" /> {editing ? 'Guardar' : 'Crear equipo'}
                </>
              )}
            </button>
          )}
        </div>
      </form>
    </TeamModal>
  )
}
