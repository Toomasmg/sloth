import type { Page } from '@playwright/test'

export interface Scroll {
  ms: number
  frames: number
  frameMean: number
  frameP95: number
  lafCount: number
  lafTotalMs: number
}

export interface Fila {
  caso: string
  n: number
  nodosItem: number
  nodosTotal: number
  primerRenderMs: number
  scroll: Scroll
  mutacionesPorSeg: number
  rerenderMs?: number
  /** Del aviso que le llega a la UI hasta la primera tarjeta pintada: deja afuera lo que tarda el banco en mandar el dato. */
  desdeAvisoMs?: number
}

const r1 = (n: number): number => Math.round(n * 10) / 10

export function armar(page: Page, selector: string): Promise<void> {
  return page.evaluate((sel) => {
    const w = window as unknown as { __listo: Promise<number> }
    w.__listo = new Promise<number>((resolve) => {
      const t0 = performance.now()
      ;(window as unknown as { __t0: number }).__t0 = t0
      const fin = (): void => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)))
      }
      if (document.querySelector(sel)) return fin()
      const mo = new MutationObserver(() => {
        if (!document.querySelector(sel)) return
        mo.disconnect()
        fin()
      })
      mo.observe(document.body, { childList: true, subtree: true })
    })
  }, selector)
}

export async function cobrar(page: Page): Promise<number> {
  const ms = await page.evaluate(() => (window as unknown as { __listo: Promise<number> }).__listo)
  return r1(ms)
}

export async function contar(page: Page, scroller: string, item: string): Promise<{ item: number; total: number }> {
  return page.evaluate(
    ([sc, it]) => {
      const el = document.querySelector(sc)
      return { item: document.querySelectorAll(it).length, total: el ? el.querySelectorAll('*').length : 0 }
    },
    [scroller, item]
  )
}

export async function scrollear(page: Page, scroller: string): Promise<Scroll> {
  const s = await page.evaluate(
    (sel) =>
      new Promise<Scroll>((resolve) => {
        const el = document.querySelector<HTMLElement>(sel)
        if (!el) return resolve({ ms: 0, frames: 0, frameMean: 0, frameP95: 0, lafCount: 0, lafTotalMs: 0 })
        const laf: number[] = []
        let po: PerformanceObserver | null = null
        try {
          po = new PerformanceObserver((l) => l.getEntries().forEach((e) => laf.push(e.duration)))
          po.observe({ type: 'long-animation-frame', buffered: false })
        } catch {
          po = null
        }
        el.scrollTop = 0
        const dts: number[] = []
        let last = performance.now()
        const t0 = last
        const paso = (): void => {
          const now = performance.now()
          dts.push(now - last)
          last = now
          const max = el.scrollHeight - el.clientHeight
          if (el.scrollTop >= max - 1) {
            po?.disconnect()
            const orden = [...dts].sort((a, b) => a - b)
            const media = dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length)
            resolve({
              ms: now - t0,
              frames: dts.length,
              frameMean: media,
              frameP95: orden[Math.min(orden.length - 1, Math.floor(orden.length * 0.95))] ?? 0,
              lafCount: laf.length,
              lafTotalMs: laf.reduce((a, b) => a + b, 0)
            })
            return
          }
          el.scrollTop = Math.min(max, el.scrollTop + 800)
          requestAnimationFrame(paso)
        }
        requestAnimationFrame(paso)
      }),
    scroller
  )
  return { ...s, ms: r1(s.ms), frameMean: r1(s.frameMean), frameP95: r1(s.frameP95), lafTotalMs: r1(s.lafTotalMs) }
}

export async function mutacionesEnReposo(page: Page, ms: number): Promise<number> {
  const n = await page.evaluate(
    (dur) =>
      new Promise<number>((resolve) => {
        let c = 0
        const mo = new MutationObserver((l) => {
          c += l.length
        })
        mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
        setTimeout(() => {
          mo.disconnect()
          resolve(c)
        }, dur)
      }),
    ms
  )
  return r1((n * 1000) / ms)
}
