import { powerMonitor } from 'electron'
import { execFile } from 'node:child_process'
import { availableParallelism, totalmem } from 'node:os'
import { join } from 'node:path'
import type { Feature, FeatureContext } from './context'
import { currentSettings, onSettingsChanged } from './settings'
import { entornoJob, leerSalidaJob, limitesDe, nombreJob, perfilVigente, sinLimites, type EstadoRendimiento, type PedidoJob } from '../../shared/rendimiento-core'
import { scriptCodificado } from '../rendimiento-script'

/**
 * Función «rendimiento»: pone un tope de RAM y de núcleos a las terminales (y a todo lo que corre en
 * ellas) con un Job Object de Windows, y cambia de perfil al enchufar o desenchufar la notebook.
 * Con daemon, el daemon entra al Job y sus terminales nuevas lo heredan solas. Sin daemon, Sloth no
 * entra (la interfaz quedaría limitada): se suman sus terminales y se vuelve a aplicar al abrir una.
 */
const soportado = process.platform === 'win32'
const nucleosTotales = availableParallelism()
const ramTotalMB = Math.floor(totalmem() / 1024 / 1024)

let ctxRef: FeatureContext | null = null
let estado: EstadoRendimiento = {
  soportado,
  enBateria: false,
  ramTotalMB,
  nucleosTotales,
  aplicado: null,
  error: null,
  aplicando: false
}
let cola: Promise<void> = Promise.resolve()
let ultimaClave = ''
let porTerminal: ReturnType<typeof setTimeout> | null = null
let porAjuste: ReturnType<typeof setTimeout> | null = null
const terminalesVistas = new Set<string>()

const powershell = (): string => join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

function publicar(cambios: Partial<EstadoRendimiento>): void {
  estado = { ...estado, ...cambios }
  ctxRef?.emit('estado', estado)
}

function correrScript(pedido: PedidoJob): Promise<{ procesos: number; vistos: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      powershell(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', scriptCodificado()],
      { env: { ...process.env, ...entornoJob(pedido) }, windowsHide: true, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().split(/\r?\n/)[0] || 'El script de rendimiento falló.'))
        try {
          resolve(leerSalidaJob(stdout))
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      }
    )
  })
}

/** Aplica el perfil vigente. De a una pasada por vez: si ya quedó aplicado lo mismo, no hace nada. */
function aplicar(forzar = false): Promise<void> {
  // El catch deja la cola andando aunque una pasada falle antes de llegar al script (backend caído).
  cola = cola.then(() => pasada(forzar)).catch((e: unknown) => ctxRef?.log('[rendimiento]', e))
  return cola
}

async function pasada(forzar: boolean): Promise<void> {
  const ctx = ctxRef
  if (!ctx || !soportado) return
  const b = ctx.terminal() ?? (await ctx.backend())
  const info = b.info()
  const daemon = info.mode === 'daemon' && typeof info.pid === 'number'
  const dueno = daemon ? (info.pid as number) : process.pid
  const limites = limitesDe(perfilVigente(currentSettings().rendimiento, estado.enBateria), ramTotalMB, nucleosTotales)
  const clave = JSON.stringify([dueno, limites])
  // Sin límites y sin nada aplicado: no hace falta crear un Job vacío (ni siquiera al forzar).
  if (estado.aplicado === null && sinLimites(limites, nucleosTotales)) return
  if (!forzar && clave === ultimaClave) return
  publicar({ aplicando: true })
  try {
    const r = await correrScript({
      nombre: nombreJob(dueno),
      raiz: dueno,
      incluirRaiz: daemon,
      excluir: daemon ? '' : process.execPath,
      limites,
      dueno
    })
    ultimaClave = clave
    publicar({ aplicando: false, error: null, aplicado: { ...limites, procesos: r.procesos, en: Date.now() } })
    ctx.log(`[rendimiento] ${limites.ramMB ? `${limites.ramMB} MB` : 'RAM sin límite'}, ${limites.nucleos}/${nucleosTotales} núcleos, ${r.procesos}/${r.vistos} procesos`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    publicar({ aplicando: false, error: msg })
    ctx.log('[rendimiento] no se pudo aplicar:', msg)
  }
}

const feature: Feature = {
  name: 'rendimiento',
  register(ctx) {
    ctxRef = ctx
    if (!soportado) {
      ctx.handle('estado', () => estado)
      return
    }
    estado = { ...estado, enBateria: powerMonitor.isOnBatteryPower() }
    const alCambiarEnergia = (): void => {
      const enBateria = powerMonitor.isOnBatteryPower()
      if (enBateria === estado.enBateria) return
      publicar({ enBateria })
      void aplicar()
    }
    powerMonitor.on('on-ac', alCambiarEnergia)
    powerMonitor.on('on-battery', alCambiarEnergia)
    // Al arrastrar los controles llegan muchos cambios seguidos: se aplica cuando el valor queda quieto.
    let ultimoAjuste = JSON.stringify(currentSettings().rendimiento)
    onSettingsChanged((s) => {
      const ahora = JSON.stringify(s.rendimiento)
      if (ahora === ultimoAjuste) return
      ultimoAjuste = ahora
      if (porAjuste) clearTimeout(porAjuste)
      porAjuste = setTimeout(() => void aplicar(), 700)
    })

    void ctx.backend().then((b) => {
      // Daemon relanzado: es otro proceso y necesita su propio Job.
      b.on('reconnect', () => void aplicar())
      return aplicar()
    })
    // Sin daemon las terminales nuevas no heredan el Job: se suman cuando abren (una vez por terminal).
    ctx.onPtyData((id) => {
      if (terminalesVistas.has(id) || ctx.terminal()?.info().mode !== 'inprocess') return
      terminalesVistas.add(id)
      if (porTerminal) clearTimeout(porTerminal)
      porTerminal = setTimeout(() => void aplicar(true), 1500)
    })
    ctx.onPtyExit((id) => terminalesVistas.delete(id))

    ctx.handle('estado', () => estado)
    ctx.handle('reaplicar', async () => {
      await aplicar(true)
      return estado
    })
  },
  dispose() {
    if (porTerminal) clearTimeout(porTerminal)
    if (porAjuste) clearTimeout(porAjuste)
  }
}

export default feature
