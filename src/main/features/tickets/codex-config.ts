/**
 * Nombres de los servidores MCP que tiene la cuenta en su `config.toml` (`[mcp_servers.<nombre>]`).
 * Solo texto: quien llama lee el archivo de la carpeta de la cuenta (nunca auth.json) y no lo escribe.
 * Módulo puro (lo corre `node --test` con type stripping).
 */
import { analizar } from '../../toml-escaner'

const MAX_TOML = 1024 * 1024
const MAX_SERVIDORES = 100
const NOMBRE_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Solo estos nombres se pasan a `-c`: otro texto en una clave de TOML podría cambiar qué se configura. */
export const nombreServidorValido = (n: string): boolean => NOMBRE_RE.test(n)

/** undefined si el TOML no se puede leer entero: con duda no se afirma qué servidores hay. */
export function servidoresDeConfigToml(toml: string): string[] | undefined {
  if (toml.length > MAX_TOML) return undefined
  const a = analizar(toml)
  if (!a.ok) return undefined
  const nombres = new Set<string>()
  for (const s of a.sentencias) {
    if (s.tipo === 'tablaArray') continue
    const ruta = s.tipo === 'clave' ? [...s.tabla, ...s.ruta] : s.ruta
    if (ruta[0] === 'mcp_servers' && ruta.length > 1 && nombres.size < MAX_SERVIDORES) nombres.add(ruta[1])
  }
  return [...nombres]
}

/** Los que no se pueden desactivar con `-c` por su nombre: se le avisa a la persona. */
export const servidoresIgnorados = (servidores: readonly string[]): string[] => servidores.filter((n) => !nombreServidorValido(n))
