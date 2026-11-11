import { useEffect, useRef, useState } from 'react'
import { api } from './api'

export interface FolderDropOptions {
  /** Hay al menos una cuenta: sin cuentas no se crea un espacio. */
  canCreate: boolean
  /** Se soltó una carpeta válida (ruta absoluta y nombre base). */
  onFolder(path: string, name: string): void
  onError(message: string): void
}

const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')
const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? ''
const inModal = (t: EventTarget | null): boolean => t instanceof Element && t.closest('[aria-modal="true"]') !== null
/** Sobre una terminal, soltar pega las rutas ahí (TerminalView): no se crea un espacio. */
const inTerminal = (t: EventTarget | null): boolean => t instanceof Element && t.closest('.terminal-host') !== null

/**
 * Soltar una carpeta sobre la ventana para crear un espacio. Sobre una terminal no: ahí se pegan las rutas. Devuelve si hay que mostrar el overlay.
 * Solo reacciona a archivos del sistema (`types` incluye 'Files'). Los drops dentro de un modal no
 * se interceptan (solo se evita que Electron navegue al archivo). La validación real la hace main.
 */
export function useFolderDrop(opts: FolderDropOptions): boolean {
  const [active, setActive] = useState(false)
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    let depth = 0
    const onEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth++
      setActive(!inModal(e.target) && !inTerminal(e.target))
    }
    const onOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setActive(false)
    }
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setActive(false)
      if (inModal(e.target) || inTerminal(e.target)) return
      const o = optsRef.current
      const file = e.dataTransfer?.files?.[0]
      if (!file) {
        o.onError('No llegó ninguna carpeta. Soltala de nuevo desde el Explorador.')
        return
      }
      if (!o.canCreate) {
        o.onError('Agregá una cuenta de Claude antes de crear un espacio.')
        return
      }
      let path = ''
      try {
        path = api.pathForFile(file)
      } catch {
        path = ''
      }
      if (!path) {
        o.onError('No pude leer la ruta de lo que soltaste. Probá de nuevo con la carpeta.')
        return
      }
      const name = baseName(path)
      // Heurística: un nombre con extensión y tipo MIME es un archivo. Main igual valida que sea carpeta.
      if (file.type !== '' && /\.[^.\\/]+$/.test(name)) {
        o.onError('Para crear un espacio soltá una carpeta. Para pasarle un archivo a Claude, soltalo sobre la terminal del espacio.')
        return
      }
      o.onFolder(path, name)
    }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return active
}
