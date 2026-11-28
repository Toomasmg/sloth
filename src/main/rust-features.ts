/**
 * Lo que en la cáscara de Tauri atiende Rust. La cáscara lista en SLOTH_RUST_FEATURES las funciones que no se registran
 * acá (el router de Rust contesta sus canales antes de reenviar). Rust además es el dueño del
 * estado: este proceso trabaja con una copia que Rust le empuja (`rust.*`) y le pide las escrituras por el puente.
 * En Electron no hay lista ni puente y todo sigue igual.
 */
export interface PuenteRust {
  nativo(op: string, ...args: unknown[]): Promise<unknown>
  /** Eventos que manda Rust a este proceso (la copia del estado, la sesión del chat para «celular»...). */
  alEvento?(nombre: string, fn: (...args: unknown[]) => void): void
}

export function funcionesEnRust(env: string | undefined): ReadonlySet<string> {
  return new Set((env ?? '').split(',').map((s) => s.trim()).filter(Boolean))
}

const lista = funcionesEnRust(process.env.SLOTH_RUST_FEATURES)

export const atiendeRust = (nombre: string): boolean => lista.has(nombre)

const puente = (): PuenteRust | undefined => (globalThis as { slothPuente?: PuenteRust }).slothPuente

/** En la cáscara de Tauri Rust es el dueño de sloth-state.json, de la Configuración y de las terminales. */
export function rustEsDueno(): boolean {
  return puente()?.alEvento !== undefined
}

/** Canales del núcleo que con Rust como dueño atiende Rust: acá no se registran. */
export const CANALES_DEL_NUCLEO_EN_RUST: ReadonlySet<string> = new Set([
  'state:get',
  'permission:pending',
  'daemon:info',
  'daemon:shutdown',
  'accounts:add',
  'accounts:setShareSetup',
  'accounts:remove',
  'accounts:statuses',
  'workspaces:add',
  'workspaces:remove',
  'workspaces:update',
  'workspaces:reveal',
  'ui:openPanes',
  'dialog:pickFolder',
  'pty:start',
  'pty:write',
  'pty:resize',
  'pty:kill',
  'clipboard:read',
  'clipboard:write',
  'pty:cuentaOcupada',
  'pty:running',
  'pty:resumeOnce'
])

export function alEventoDeRust(nombre: string, fn: (...args: unknown[]) => void): void {
  puente()?.alEvento?.(nombre, fn)
}

function nativo(op: string, args: unknown[]): Promise<unknown> {
  const p = puente()
  if (!p) return Promise.reject(new Error('Sin núcleo de Rust.'))
  return p.nativo(op, ...args)
}

/** Un pedido nativo a Rust (`rust.<función>`, p. ej. `rust.chat`). */
export const pedirARust = (op: string, ...args: unknown[]): Promise<unknown> => nativo(op, args)

/** Pide algo al núcleo de Rust: alta y baja de espacios, terminales, agentes, cierre. */
export const pedirAlNucleo = <T = unknown>(op: string, ...args: unknown[]): Promise<T> => nativo('rust.nucleo', [op, ...args]) as Promise<T>

export const pedirAlStore = (op: string, ...args: unknown[]): Promise<unknown> => nativo('rust.store', [op, ...args])

export const pedirAjustes = (patch: unknown): Promise<unknown> => nativo('rust.ajustes', [patch])
