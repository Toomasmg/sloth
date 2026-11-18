import { useMemo } from 'react'
import { qrComoCaminoSvg, qrDeTexto } from '../../../../shared/qr'
import { InlineAlert } from '../../ui'

export function Qr({ texto }: { texto: string }): React.JSX.Element {
  const dibujo = useMemo(() => {
    try {
      return qrComoCaminoSvg(qrDeTexto(texto))
    } catch {
      return null
    }
  }, [texto])
  if (!dibujo) return <InlineAlert tone="warning">No se pudo dibujar el código. Copiá el enlace.</InlineAlert>
  const { path, lado } = dibujo
  return (
    <svg className="f-cel-qr" viewBox={`0 0 ${lado} ${lado}`} role="img" aria-label="Código QR para abrir Sloth en el celu" shapeRendering="crispEdges">
      <rect width={lado} height={lado} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}
