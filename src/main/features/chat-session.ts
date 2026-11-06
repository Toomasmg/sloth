/**
 * Sesión del chat: adaptador de almacenamiento para supabase-js. Todo vive en memoria y se persiste
 * en `userData/features/chat-session.bin` cifrado con safeStorage. Si el cifrado del SO no está
 * disponible, NO se persiste nada (la sesión dura lo que la app). Nunca se loguean valores.
 *
 * Sin Electron a propósito: safeStorage entra por inyección (`CryptoLike`), así se prueba con Node.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Lo que usamos de `safeStorage` de Electron. */
export interface CryptoLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(enc: Buffer): string
}

/** Forma que pide supabase-js para `auth.storage` (síncrona). */
export interface SessionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface SessionStore {
  readonly storage: SessionStorage
  /** Cuántas entradas hay (0 = sin sesión guardada). */
  size(): number
  /** Si la sesión se guarda entre reinicios (hay cifrado disponible). */
  readonly persistent: boolean
  /** Olvida la sesión en memoria y borra el archivo. */
  clear(): void
}

const MAX_FILE_BYTES = 256 * 1024

export function createSessionStore(opts: { file: string; crypto: CryptoLike; log: (msg: string) => void }): SessionStore {
  const map = new Map<string, string>()
  const persistent = (() => {
    try {
      return opts.crypto.isEncryptionAvailable()
    } catch {
      return false
    }
  })()
  if (!persistent) opts.log('chat: el cifrado del sistema no está disponible; la sesión de chat no se guarda entre reinicios.')

  const removeFile = (): void => {
    try {
      rmSync(opts.file, { force: true })
    } catch {
      /* nada que borrar */
    }
  }

  const persist = (): void => {
    if (!persistent) return
    if (map.size === 0) return removeFile()
    try {
      mkdirSync(dirname(opts.file), { recursive: true })
      const enc = opts.crypto.encryptString(JSON.stringify(Object.fromEntries(map)))
      const tmp = `${opts.file}.${process.pid}.tmp`
      writeFileSync(tmp, enc)
      renameSync(tmp, opts.file)
    } catch {
      opts.log('chat: no se pudo guardar la sesión de chat.')
    }
  }

  // Carga: solo si hay cifrado. Si el archivo no se puede leer o descifrar, se descarta.
  if (persistent && existsSync(opts.file)) {
    try {
      const buf = readFileSync(opts.file)
      if (buf.length > MAX_FILE_BYTES) throw new Error('demasiado grande')
      const data = JSON.parse(opts.crypto.decryptString(buf)) as unknown
      if (data && typeof data === 'object' && !Array.isArray(data))
        for (const [k, v] of Object.entries(data)) if (typeof v === 'string') map.set(k, v)
    } catch {
      opts.log('chat: la sesión guardada no se pudo leer; hay que volver a iniciar sesión.')
      map.clear()
      removeFile()
    }
  }

  const storage: SessionStorage = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
      persist()
    },
    removeItem: (key) => {
      map.delete(key)
      persist()
    }
  }

  return {
    storage,
    size: () => map.size,
    persistent,
    clear: () => {
      map.clear()
      removeFile()
    }
  }
}
