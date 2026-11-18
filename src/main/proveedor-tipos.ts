import type { Capacidades, ProveedorId } from '../shared/proveedores'

export interface Proveedor {
  id: ProveedorId
  envConfigDir: string
  /** Carpeta de la cuenta dentro de accounts/<id>/. */
  subcarpetaCuenta: string
  /** Archivo del que se lee el email público del login. */
  archivoMeta: string
  /** Relativa al configDir. */
  carpetaHistorial: string
  capacidades: Capacidades
  /** Cómo se instala el agente, para el aviso cuando no está en el PATH. */
  comoInstalar: string
  /** Variables del entorno heredado que no deben llegar a la terminal (la clave viene en mayúsculas). */
  quitarDelEntorno(claveMayus: string): boolean
  envCuenta(configDir: string): Record<string, string>
  resolverExe(env?: NodeJS.ProcessEnv): string | undefined
  argvInteractivo(o: { continuar?: boolean; prompt?: string }): string[]
  /** Lo que corre la terminal de login de la cuenta. */
  argvLogin(): string[]
  /** Sin abrir credenciales: solo lo que el agente deja a la vista (datos públicos o la existencia de un archivo). */
  estadoLogin(configDir: string): { loggedIn: boolean; email?: string }
  /** Deja la carpeta de la cuenta lista antes del primer arranque; nunca pisa lo que ya hay. */
  prepararCarpeta(configDir: string): void
  hayConversacionPrevia(configDir: string, cwd: string): boolean
}
