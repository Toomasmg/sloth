import { memo, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { PtyChunk } from '../../shared/types'
import { api, onPtyData, onPtyExit } from './api'
import { subscribeSettings, termOptions } from './features/settings/store'
import { usePaneVisible } from './visibility'

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
  // Terminal y ajuste vivos (para cuando el panel vuelve a verse).
  const live = useRef<{ term: Terminal; fit: FitAddon } | null>(null)
  // Panel en pestaña (oculto): no dibuja, no mide y no parpadea el cursor.
  const shown = usePaneVisible(id)

  useEffect(() => {
    const el = host.current
    if (!el) return
    let disposed = false
    // Fuente, tamaño, cursor y tema salen de la Configuración (features/settings).
    const opts = termOptions()
    const term = new Terminal({
      ...opts,
      cursorBlink: opts.cursorBlink && document.visibilityState === 'visible',
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    try {
      fit.fit()
    } catch {
      /* el panel todavía no tiene tamaño */
    }
    live.current = { term, fit }
    // xterm mide la letra al abrir: si la webfont todavía no llegó, se vuelve a medir cuando carga.
    if (!document.fonts.check(`${opts.fontSize}px "JetBrains Mono Variable"`)) {
      void document.fonts.load(`${opts.fontSize}px "JetBrains Mono Variable"`).then(
        () => {
          if (disposed) return
          // Cambiar la fuente (aunque sea el mismo nombre) hace que xterm vuelva a medir.
          term.options.fontFamily = `${opts.fontFamily}, monospace`
          term.options.fontFamily = opts.fontFamily
          if (el.offsetParent !== null) {
            try {
              fit.fit()
            } catch {
              /* sin tamaño todavía */
            }
          }
        },
        () => undefined
      )
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
      term.options.cursorBlink = termOptions().cursorBlink && document.visibilityState === 'visible' && shownRef.current
    }
    document.addEventListener('visibilitychange', onVis)

    // Cambios de Configuración en vivo: se actualizan las opciones (sin recrear la terminal) y se reajusta.
    let last = opts
    const offSettings = subscribeSettings(() => {
      const o = termOptions()
      if (o.fontFamily !== last.fontFamily) term.options.fontFamily = o.fontFamily
      if (o.fontSize !== last.fontSize) term.options.fontSize = o.fontSize
      if (o.lineHeight !== last.lineHeight) term.options.lineHeight = o.lineHeight
      if (o.cursorStyle !== last.cursorStyle) term.options.cursorStyle = o.cursorStyle
      if (o.theme !== last.theme) term.options.theme = o.theme
      if (o.minimumContrastRatio !== last.minimumContrastRatio) term.options.minimumContrastRatio = o.minimumContrastRatio
      if (o.cursorBlink !== last.cursorBlink) onVis()
      if (o.scrollback !== last.scrollback) term.options.scrollback = o.scrollback
      const metrics = o.fontFamily !== last.fontFamily || o.fontSize !== last.fontSize || o.lineHeight !== last.lineHeight
      last = o
      if (!metrics || disposed || el.offsetParent === null || el.clientWidth === 0) return
      try {
        fit.fit()
      } catch {
        /* sin tamaño todavía */
      }
    })

    return () => {
      disposed = true
      live.current = null
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      offSettings()
      el.removeEventListener('contextmenu', onContext)
      offData()
      offExit()
      term.dispose()
    }
  }, [id, generation])

  // Cambia la visibilidad: oculta, sin parpadeo; visible otra vez, ajusta y repinta lo que hubo mientras tanto.
  const shownRef = useRef(shown)
  shownRef.current = shown
  useEffect(() => {
    const l = live.current
    if (!l) return
    l.term.options.cursorBlink = termOptions().cursorBlink && shown && document.visibilityState === 'visible'
    if (!shown || host.current?.offsetParent == null) return
    try {
      l.fit.fit()
    } catch {
      /* sin tamaño todavía */
    }
    l.term.refresh(0, l.term.rows - 1)
  }, [shown])

  return <div className="terminal-host" ref={host} />
})
