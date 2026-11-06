import { memo, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { PtyChunk } from '../../shared/types'
import { api, onPtyData, onPtyExit } from './api'

interface Props {
  id: string
  /** Cambia para forzar un reinicio de la terminal. */
  generation: number
  onError: (message: string) => void
}

/** Memo: los cambios de estado de agentes o permisos en App no re-renderizan las terminales. */
export const TerminalView = memo(function TerminalView({ id, generation, onError }: Props): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  // onError por ref: la terminal solo se recrea si cambian id o generation.
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    const el = host.current
    if (!el) return
    let disposed = false
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: document.visibilityState === 'visible',
      cursorStyle: 'bar',
      scrollback: 3000,
      allowProposedApi: true,
      theme: {
        background: '#12141a',
        foreground: '#e3ebf0',
        cursor: '#9feaf9',
        cursorAccent: '#12141a',
        selectionBackground: '#2c4a52',
        black: '#2f3444',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#9feaf9',
        white: '#cbd5e1',
        brightBlack: '#6b7385',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#f8fafc'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    try {
      fit.fit()
    } catch {
      /* el panel todavía no tiene tamaño */
    }

    // Lo que llega antes de recibir el buffer se encola, y se descarta lo ya incluido en el buffer.
    let upTo = -1
    const queued: PtyChunk[] = []
    const offData = onPtyData(id, (chunk) => {
      if (upTo < 0) queued.push(chunk)
      else if (chunk.seq > upTo) term.write(chunk.data)
    })
    const offExit = onPtyExit(id, (code) => {
      term.write(`\r\n\x1b[90m[proceso terminado, código ${code}. Usá «Reiniciar» para abrir otra terminal]\x1b[0m\r\n`)
    })

    api
      .ptyStart(id, term.cols, term.rows)
      .then((res) => {
        if (disposed) return
        for (const c of res.chunks) term.write(c.data)
        upTo = res.upTo
        for (const c of queued) if (c.seq > upTo) term.write(c.data)
        queued.length = 0
        api.ptyResize(id, term.cols, term.rows)
        term.focus()
      })
      .catch((e: Error) => {
        upTo = Number.MAX_SAFE_INTEGER
        const msg = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
        term.write(`\x1b[31m${msg}\x1b[0m\r\n`)
        onErrorRef.current(msg)
      })

    term.onData((d) => api.ptyWrite(id, d))
    term.onResize(({ cols, rows }) => api.ptyResize(id, cols, rows))

    // Ctrl+Shift+C / Ctrl+Shift+V copian y pegan; Ctrl+C sigue siendo interrumpir.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown' || !ev.ctrlKey || !ev.shiftKey) return true
      if (ev.code === 'KeyC') {
        const sel = term.getSelection()
        if (sel) api.clipboardWrite(sel)
        return false
      }
      if (ev.code === 'KeyV') {
        void api.clipboardRead().then((t) => t && term.paste(t))
        return false
      }
      return true
    })
    // Clic derecho: copia si hay selección, si no pega (como Windows Terminal).
    const onContext = (ev: MouseEvent): void => {
      ev.preventDefault()
      const sel = term.getSelection()
      if (sel) {
        api.clipboardWrite(sel)
        term.clearSelection()
      } else void api.clipboardRead().then((t) => t && term.paste(t))
    }
    el.addEventListener('contextmenu', onContext)

    // Fit agrupado en un frame y nunca con el panel oculto (display:none mide 0 y rompería cols/rows).
    let raf = 0
    const ro = new ResizeObserver(() => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (disposed || el.offsetParent === null || el.clientWidth === 0 || el.clientHeight === 0) return
        try {
          fit.fit()
        } catch {
          /* sin tamaño todavía */
        }
      })
    })
    ro.observe(el)

    // Sin parpadeo de cursor (timer por terminal) mientras la ventana no se ve.
    const onVis = (): void => {
      term.options.cursorBlink = document.visibilityState === 'visible'
    }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      el.removeEventListener('contextmenu', onContext)
      offData()
      offExit()
      term.dispose()
    }
  }, [id, generation])

  return <div className="terminal-host" ref={host} />
})
