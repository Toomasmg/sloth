import { useEffect, useRef } from 'react'
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

export function TerminalView({ id, generation, onError }: Props): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    let disposed = false
    const term = new Terminal({
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: {
        background: '#0b0d11',
        foreground: '#d6dae3',
        cursor: '#7aa2ff',
        selectionBackground: '#2a3550'
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
        onError(msg)
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

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* sin tamaño todavía */
      }
    })
    ro.observe(el)

    return () => {
      disposed = true
      ro.disconnect()
      el.removeEventListener('contextmenu', onContext)
      offData()
      offExit()
      term.dispose()
    }
  }, [id, generation, onError])

  return <div className="terminal-host" ref={host} />
}
