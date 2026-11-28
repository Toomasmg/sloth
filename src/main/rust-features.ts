/**
 * Funciones del lado main que en la cáscara de Tauri atiende Rust. La cáscara las lista en SLOTH_RUST_FEATURES:
 * acá no se registran (el router de Rust contesta sus canales antes de reenviar), y lo que Rust necesita de este proceso
 * (la carpeta del perfil activo y los eventos de hook de Claude) se le avisa por el puente nativo. En Electron no hay lista.
 */
export interface PuenteRust {
  nativo(op: string, ...args: unknown[]): Promise<unknown>
}

export function funcionesEnRust(env: string | undefined): ReadonlySet<string> {
  return new Set((env ?? '').split(',').map((s) => s.trim()).filter(Boolean))
}

const lista = funcionesEnRust(process.env.SLOTH_RUST_FEATURES)

export const atiendeRust = (nombre: string): boolean => lista.has(nombre)

const puente = (): PuenteRust | undefined => (globalThis as { slothPuente?: PuenteRust }).slothPuente

export function hayFuncionesEnRust(): boolean {
  return lista.size > 0 && puente() !== undefined
}

export function anunciarPerfil(carpeta: string, falla: (e: unknown) => void): void {
  puente()?.nativo('rust.perfil', carpeta).catch(falla)
}

/** El evento de hook llega a las funciones que pasaron a Rust (la de git refresca el contador al terminar un turno). */
export function reenviarHook(evento: string, ws: string | undefined, falla: (e: unknown) => void): void {
  puente()?.nativo('rust.hook', evento, ws ?? null).catch(falla)
}
