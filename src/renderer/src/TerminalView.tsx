import { memo, useCallback, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { PtyChunk } from '../../shared/types'
import { joinPaths } from '../../shared/paste-paths'
import { api, onPtyData, onPtyExit } from './api'
import { subscribeSettings, termOptions } from './features/settings/store'
import { usePaneVisible } from './visibility'
import { PANES_FIT_EVENT } from './layout/store'
import { MicDictado } from './features/dictado/MicDictado'

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
    // Claude Code dibuja su propio cursor en la caja de texto. El cursor real lo vuelve a mostrar ConPTY
    // en cada cuadro, a veces a mitad del redibujo, y salta por la pantalla. Mientras Claude está abierto
    // (?2031h al arrancar, ?2031l al salir) se ignora el «mostrar cursor» (?25h); en la shell vuelve a verse.
    // Claude no usa la pantalla alternativa y vim, nvim o nano sí (algunos también activan 2031): ahí el
    // cursor se deja tal cual.
    let claudeUi = false
    const inNormalBuffer = (): boolean => term.buffer.active.type === 'normal'
    const ALT_SCREEN = [47, 1047, 1049]
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.includes(2031) && !claudeUi && inNormalBuffer()) {
        claudeUi = true
        term.write('\x1b[?25l')
      }
      return claudeUi && inNormalBuffer() && params.length === 1 && params[0] === 25
    })
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (params.includes(2031) && claudeUi && inNormalBuffer()) {
        claudeUi = false
        term.write('\x1b[?25h')
      }
      // Volviendo de un editor abierto desde Claude: el cursor que mostró el editor se vuelve a ocultar.
      if (claudeUi && params.some((p) => typeof p === 'number' && ALT_SCREEN.includes(p))) term.write('\x1b[?25l')
      return false
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
    // Pruebas de Playwright: leen el buffer y el estado del cursor desde acá (e2e/terminal.ts).
    if (navigator.webdriver) (el as HTMLDivElement & { __xterm?: Terminal }).__xterm = term
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

    // Pegar: texto, rutas de archivos copiados (un .zip, una carpeta) o una imagen, que main guarda
    // como PNG y pega su ruta para que Claude Code la adjunte.
    const pasteClipboard = (): void => {
      void api.clipboardRead().then((t) => t && term.paste(t))
    }
    // Copia la selección y la limpia; si falla, la selección queda a la vista.
    const copySelection = (): void => {
      const sel = term.getSelection()
      if (!sel) return
      api
        .clipboardWrite(sel)
        .then(() => term.clearSelection())
        .catch(() => undefined)
    }
    // Ctrl+V y Ctrl+Shift+V pegan. Ctrl+C copia si hay algo seleccionado y si no interrumpe (^C), como
    // Windows Terminal; Ctrl+Shift+C siempre copia. En la pantalla alternativa (vim, nano) Ctrl+V solo
    // llega como ^V: allá es bloque visual o «literal siguiente».
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown' || !ev.ctrlKey || ev.altKey || ev.metaKey) return true
      if (ev.code === 'KeyV' && (ev.shiftKey || inNormalBuffer())) {
        // Sin preventDefault el navegador también dispararía su «paste» (solo texto) y pegaría dos veces.
        ev.preventDefault()
        pasteClipboard()
        return false
      }
      if (ev.code === 'KeyC' && (ev.shiftKey || term.hasSelection())) {
        ev.preventDefault()
        copySelection()
        return false
      }
      return true
    })
    // Soltar archivos o carpetas sobre la terminal pega sus rutas (las fotos y los .zip incluidos).
    const onDragOver = (ev: DragEvent): void => {
      if (!Array.from(ev.dataTransfer?.types ?? []).includes('Files')) return
      ev.preventDefault()
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
      el.classList.add('drop-on')
    }
    const onDragLeave = (ev: DragEvent): void => {
      if (!el.contains(ev.relatedTarget as Node | null)) el.classList.remove('drop-on')
    }
    const onDropFiles = (ev: DragEvent): void => {
      el.classList.remove('drop-on')
      const files = Array.from(ev.dataTransfer?.files ?? [])
      if (!files.length) return
      ev.preventDefault()
      const paths = files.map((f) => {
        try {
          return api.pathForFile(f)
        } catch {
          return ''
        }
      })
      const text = joinPaths(paths)
      if (!text) {
        onErrorRef.current('No pude leer la ruta de lo que soltaste. Probá de nuevo desde el Explorador.')
        return
      }
      term.paste(text)
      term.focus()
    }
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('drop', onDropFiles)
    // Clic derecho: copia si hay selección, si no pega (como Windows Terminal).
    const onContext = (ev: MouseEvent): void => {
      ev.preventDefault()
      if (term.hasSelection()) copySelection()
      else pasteClipboard()
    }
    el.addEventListener('contextmenu', onContext)

    // El dictado de Windows (Win+H) escribe en el textarea oculto de xterm y Chromium corre en horizontal
    // lo que lo contiene para mostrarlo: la terminal quedaba cortada a la izquierda. Nada acá se desplaza
    // de costado, así que se vuelve a 0 (el scroll vertical de xterm no se toca).
    const onScroll = (ev: Event): void => {
      const t = ev.target
      if (t instanceof HTMLElement && t.scrollLeft !== 0) t.scrollLeft = 0
    }
    el.addEventListener('scroll', onScroll, true)

    // Fit agrupado en un frame y nunca con el panel oculto (display:none mide 0 y rompería cols/rows).
    let raf = 0
    const ro = new ResizeObserver(() => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        // Durante el arrastre de la barra lateral no se ajusta: el fit llega al soltar (PANES_FIT_EVENT).
        if (document.body.classList.contains('is-resizing-side')) return
        if (disposed || el.offsetParent === null || el.clientWidth === 0 || el.clientHeight === 0) return
        try {
          fit.fit()
        } catch {
          /* sin tamaño todavía */
        }
      })
    })
    ro.observe(el)
    const onPanesFit = (): void => {
      if (disposed || el.offsetParent === null || el.clientWidth === 0 || el.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        /* sin tamaño todavía */
      }
    }
    window.addEventListener(PANES_FIT_EVENT, onPanesFit)

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
      window.removeEventListener(PANES_FIT_EVENT, onPanesFit)
      document.removeEventListener('visibilitychange', onVis)
      offSettings()
      el.removeEventListener('contextmenu', onContext)
      el.removeEventListener('scroll', onScroll, true)
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('dragleave', onDragLeave)
      el.removeEventListener('drop', onDropFiles)
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

  // Lo dictado se pega como si se escribiera (sin Enter); el espacio separa una frase de la siguiente.
  const pegarDictado = useCallback((texto: string): void => {
    const l = live.current
    if (!l) return
    l.term.paste(`${texto} `)
    l.term.focus()
  }, [])

  return (
    <>
      <div className="terminal-host" ref={host} />
      <MicDictado paneId={id} onTexto={pegarDictado} />
    </>
  )
})
