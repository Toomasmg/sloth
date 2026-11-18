import { useEffect, useState } from 'react'
import { useUi } from '../../host'
import { useSettings } from '../store'
import { Group, Row, Slider, ToggleRow, useSave } from '../ui'
import { Button, InlineAlert } from '../../../ui'
import { RAM_MB, type PerfilRendimiento, type RendimientoSettings } from '../../../../../shared/settings-model'
import type { EstadoRendimiento } from '../../../../../shared/rendimiento-core'

const GB = 1024
const fmtGB = (mb: number): string => `${Math.round((mb / GB) * 10) / 10} GB`

/**
 * RAM y núcleos de un perfil. Los dos controles van de lo mínimo a «todo»: llevarlos al tope es sin
 * límite (se guarda 0), así no hay un interruptor aparte para prenderlo.
 */
function Perfil({ id, perfil, estado, onChange }: { id: string; perfil: PerfilRendimiento; estado: EstadoRendimiento; onChange(p: PerfilRendimiento): void }): React.JSX.Element {
  const maxGB = Math.max(RAM_MB.min / GB, Math.floor(estado.ramTotalMB / GB))
  const ramGB = perfil.ramMB > 0 ? Math.min(maxGB, Math.round(perfil.ramMB / GB)) : maxGB
  const nucleos = perfil.nucleos > 0 ? Math.min(perfil.nucleos, estado.nucleosTotales) : estado.nucleosTotales
  return (
    <>
      <Row title="RAM máxima" hint="Entre todas las terminales y lo que corre en ellas (Claude, npm, tests)." htmlFor={`${id}-ram`}>
        <Slider
          id={`${id}-ram`}
          label="RAM máxima"
          wide
          value={ramGB}
          min={RAM_MB.min / GB}
          max={maxGB}
          format={(v) => (v >= maxGB ? 'Sin límite' : `${v} GB`)}
          onChange={(v) => onChange({ ...perfil, ramMB: v >= maxGB ? 0 : v * GB })}
        />
      </Row>
      <Row title="Núcleos" hint="Cuántos procesadores lógicos pueden usar. Menos núcleos: más fresca y más batería, pero más lenta." htmlFor={`${id}-cpu`}>
        <Slider
          id={`${id}-cpu`}
          label="Núcleos"
          wide
          value={nucleos}
          min={1}
          max={estado.nucleosTotales}
          format={(v) => (v >= estado.nucleosTotales ? `Todos (${v})` : `${v} de ${estado.nucleosTotales}`)}
          onChange={(v) => onChange({ ...perfil, nucleos: v >= estado.nucleosTotales ? 0 : v })}
        />
      </Row>
    </>
  )
}

function resumen(e: EstadoRendimiento): string {
  if (e.aplicando) return 'Aplicando…'
  const a = e.aplicado
  if (!a) return 'Sin límites: las terminales usan toda la PC.'
  const ram = a.ramMB ? `hasta ${fmtGB(a.ramMB)}` : 'RAM sin límite'
  const cpu = a.nucleos >= e.nucleosTotales ? 'todos los núcleos' : `${a.nucleos} de ${e.nucleosTotales} núcleos`
  return `${ram} · ${cpu} · ${a.procesos} ${a.procesos === 1 ? 'proceso' : 'procesos'}`
}

export function RendimientoSection(): React.JSX.Element {
  const ui = useUi()
  const r = useSettings().settings.rendimiento
  const save = useSave()
  const [estado, setEstado] = useState<EstadoRendimiento | null>(null)
  useEffect(() => {
    let vivo = true
    ui.invoke<EstadoRendimiento>('feat:rendimiento:estado').then(
      (e) => vivo && setEstado(e),
      () => vivo && setEstado(null)
    )
    const off = ui.on('feat:rendimiento:estado', (e: EstadoRendimiento) => setEstado(e))
    return () => {
      vivo = false
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // La interfaz manda el bloque entero: main valida y fusiona igual.
  const guardar = (cambio: Partial<RendimientoSettings>): void => save({ rendimiento: { ...r, ...cambio } })

  if (!estado) return <Group id="g-rend">{null}</Group>
  if (!estado.soportado) return <InlineAlert>Los límites de rendimiento solo funcionan en Windows.</InlineAlert>
  return (
    <>
      <Group id="g-rend-ahora" title="Ahora">
        <Row title={estado.enBateria ? 'Con batería' : 'Enchufada'} hint={resumen(estado)}>
          <Button size="sm" disabled={estado.aplicando} onClick={() => save(() => ui.invoke('feat:rendimiento:reaplicar'))}>
            Volver a aplicar
          </Button>
        </Row>
        {estado.error && <InlineAlert tone="danger">No se pudieron aplicar los límites: {estado.error}</InlineAlert>}
      </Group>
      <Group id="g-rend-enchufada" title={r.bateriaDistinta ? 'Enchufada' : 'Límites'}>
        <Perfil id="f-rend-ac" perfil={r.enchufada} estado={estado} onChange={(enchufada) => guardar({ enchufada })} />
      </Group>
      <Group id="g-rend-bateria" title="Con batería">
        <ToggleRow
          title="Otro límite con batería"
          hint="Al desenchufar la notebook cambia solo a estos valores, y vuelve a los de arriba al enchufarla."
          checked={r.bateriaDistinta}
          onChange={(bateriaDistinta) => guardar({ bateriaDistinta })}
        />
        {r.bateriaDistinta && <Perfil id="f-rend-bat" perfil={r.bateria} estado={estado} onChange={(bateria) => guardar({ bateria })} />}
      </Group>
      <InlineAlert tone="warning">
        Si las terminales llegan al tope de RAM, el programa que pide más memoria falla y se puede cerrar (por ejemplo, Claude a mitad de
        una tarea). Dejá margen. La ventana de Sloth no entra en el límite.
      </InlineAlert>
    </>
  )
}
