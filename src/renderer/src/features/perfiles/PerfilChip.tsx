import { useState } from 'react'
import { CaretDown, Check, UsersThree } from '@phosphor-icons/react'
import { Menu, type MenuItem } from '../../ui'
import { useUi } from '../host'
import { openSettings } from '../settings/bus'
import { Avatar } from './Avatar'
import { CambiarDialog } from './CambiarDialog'
import { usePerfiles } from './store'
import { mostrarChip } from './view'

/** Chip de la barra de título: solo aparece con dos o más perfiles. */
export function PerfilChip(): React.JSX.Element | null {
  const ui = useUi()
  const payload = usePerfiles(ui)
  const [destinoId, setDestinoId] = useState<string | null>(null)
  if (!payload || !mostrarChip(payload)) return null
  const activo = payload.perfiles.find((p) => p.id === payload.activo) ?? payload.perfiles[0]
  const destino = payload.perfiles.find((p) => p.id === destinoId)

  const items: MenuItem[] = [
    ...payload.perfiles.map(
      (p): MenuItem => ({
        id: p.id,
        label: p.nombre,
        icon: p.id === payload.activo ? <Check size={14} aria-hidden="true" /> : undefined,
        hint: p.id === payload.activo ? 'Activo' : undefined,
        onSelect: () => {
          if (p.id !== payload.activo) setDestinoId(p.id)
        }
      })
    ),
    { type: 'separator' },
    { id: 'administrar', label: 'Administrar perfiles…', icon: <UsersThree size={14} aria-hidden="true" />, onSelect: () => openSettings('perfiles') }
  ]

  return (
    <>
      <Menu
        aria-label="Perfiles"
        align="end"
        items={items}
        trigger={(p) => (
          <button {...p} className="tb-chip f-perfil-chip" aria-label={`Perfil: ${activo.nombre}. Cambiar de perfil`} title="Cambiar de perfil">
            <Avatar perfil={activo} size={16} />
            <span className="f-perfil-chip-nombre">{activo.nombre}</span>
            <CaretDown size={10} aria-hidden="true" />
          </button>
        )}
      />
      {destino && <CambiarDialog payload={payload} destino={destino} onClose={() => setDestinoId(null)} />}
    </>
  )
}
