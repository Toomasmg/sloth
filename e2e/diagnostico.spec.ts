import { test, expect } from './sloth'

const enTauri = process.env.SLOTH_E2E_RUNTIME === 'tauri'

test('el diagnóstico trae versiones, funciones activas y los errores de la interfaz', async ({ sloth: { page } }) => {
  const invocar = (canal: string, ...args: unknown[]): Promise<unknown> =>
    page.evaluate(([c, a]) => window.sloth.feat.invoke(c, ...a), [canal, args] as [string, unknown[]])

  // Una carpeta de datos nueva no tiene sesión anterior: no hay cierre inesperado que avisar.
  expect(await invocar('feat:diagnostico:crashPrevio')).toBe(false)
  await invocar('feat:diagnostico:errorRenderer', { mensaje: 'roto en e2e', stack: 'at prueba' })

  const texto = (await invocar('feat:diagnostico:texto')) as string
  expect(texto.startsWith('Diagnóstico de Sloth\n')).toBe(true)
  expect(texto).toMatch(enTauri ? /\nSloth \S+ · WebView2 \d/ : /\nSloth \S+ · Electron \d\S* · Node \d/)
  if (enTauri) expect(texto).not.toContain('Electron')
  const funciones = texto.match(/^Funciones activas: (.*)$/m)?.[1].split(', ') ?? []
  expect(funciones).toEqual(expect.arrayContaining(['diagnostico', 'settings', 'git', 'tickets']))
  expect(new Set(funciones).size).toBe(funciones.length)
  expect(texto).toContain('renderer: roto en e2e')
  expect(texto).not.toContain('La sesión anterior terminó de forma inesperada.')
})
