/**
 * Nombres de los servidores MCP que tiene la cuenta en su `config.toml` (`[mcp_servers.<nombre>]`).
 * Solo texto: quien llama lee el archivo de la carpeta de la cuenta (nunca auth.json) y no lo escribe.
 * Módulo puro (lo corre `node --test` con type stripping).
 */
import type { ServidorMcp } from '../../../shared/tickets'
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

/** El nombre del servidor de `mcp__<nombre>__`. Los de claude.ai no están en el config.toml de ninguna cuenta de Codex. */
export function servidorDePrefijo(prefijo: string): string | undefined {
  const m = /^mcp__(.+)__$/.exec(prefijo)
  if (!m || m[1].startsWith('claude_ai_') || !nombreServidorValido(m[1])) return undefined
  return m[1]
}

/** Codex no dice si un servidor anda: quedan en `otro` («sin saber») y solo los de nombre válido, que son los que Sloth puede nombrar en un prefijo. */
export function servidoresRevisados(nombres: readonly string[]): ServidorMcp[] {
  return nombres.filter(nombreServidorValido).map((nombre) => ({ nombre, prefijo: `mcp__${nombre}__`, estado: 'otro' }))
}

/** `runClaude` lanza sin shell: en Windows un `.cmd` de npm no se puede abrir así. */
export const lanzableSinShell = (exe: string, plataforma: NodeJS.Platform): boolean => !(plataforma === 'win32' && /\.(cmd|bat)$/i.test(exe))
