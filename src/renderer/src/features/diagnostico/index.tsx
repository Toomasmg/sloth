import { useEffect } from 'react'
import { api } from '../../api'
import { ReportIcon } from '../../icons/SlothIcons'
import { toast } from '../../ui'
import { useUi, type Command, type FeatureUi } from '../host'
import { onCopiarDiagnostico, pedirCopiarDiagnostico } from './bus'
import { payloadDeEvento, payloadDeRazon, type ErrorPayload } from './payload'

type Invoke = (canal: string, ...args: unknown[]) => Promise<unknown>

export async function copiarDiagnostico(invoke: Invoke): Promise<void> {
  try {
    const texto = await invoke('feat:diagnostico:texto')
    if (typeof texto !== 'string') throw new Error('respuesta inesperada')
    await api.clipboardWrite(texto)
    toast({ tone: 'success', message: 'Diagnóstico copiado. No se envió a ningún lado: pegalo donde lo necesites.' })
  } catch (e) {
    toast({ tone: 'danger', message: `No pude armar el diagnóstico: ${e instanceof Error ? e.message : String(e)}` })
  }
}

function Global(): null {
  const ui = useUi()
  useEffect(() => {
    const invoke: Invoke = (canal, ...args) => ui.invoke(canal, ...args)
    const reportar = (p: ErrorPayload): void => {
      // Si falla el canal de errores no hay a dónde avisar.
      invoke('feat:diagnostico:errorRenderer', { mensaje: p.mensaje, stack: p.stack }).catch(() => {})
    }
    const onError = (e: ErrorEvent): void => reportar(payloadDeEvento(e.message, e.error))
    const onRechazo = (e: PromiseRejectionEvent): void => reportar(payloadDeRazon(e.reason))
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRechazo)
    const soltar = onCopiarDiagnostico(() => void copiarDiagnostico(invoke))

    let vivo = true
    invoke('feat:diagnostico:crashPrevio')
      .then((previo) => {
        if (!vivo || previo !== true) return
        toast({
          tone: 'warning',
          message: 'Sloth se cerró inesperadamente la última vez.',
          duration: 0,
          actionLabel: 'Copiar diagnóstico',
          onAction: () => void copiarDiagnostico(invoke)
        })
      })
      .catch(() => {
        // Es un aviso de cortesía: sin el dato no hay nada útil que mostrar.
      })
    return () => {
      vivo = false
      soltar()
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRechazo)
    }
  }, [ui])
  return null
}

const commands = (): Command[] => [
  {
    id: 'diagnostico:copiar',
    title: 'Copiar diagnóstico',
    subtitle: 'Versiones, funciones activas y últimos errores, sin datos sensibles',
    group: 'Sloth',
    keywords: 'diagnostico diagnóstico errores log soporte bug ayuda',
    icon: <ReportIcon size={16} />,
    run: pedirCopiarDiagnostico
  }
]

const ui: FeatureUi = { name: 'diagnostico', Global, commands }

export default ui
