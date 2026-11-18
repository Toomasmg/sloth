import { useUi } from '../host'
import type { PerfilVista } from '../../../../shared/perfiles'
import { useFotoPerfil } from './store'
import { iniciales } from './view'

export function Avatar({ perfil, size = 22 }: { perfil: PerfilVista; size?: number }): React.JSX.Element {
  const ui = useUi()
  const foto = useFotoPerfil(ui, perfil.id, perfil.tieneFoto)
  return (
    <span className="f-perfil-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {foto ? <img src={foto} alt="" draggable={false} /> : iniciales(perfil.nombre)}
    </span>
  )
}
