const SERVIDOR_RE = /^[A-Za-z0-9_-]+$/

export const servidorDePrefijo = (prefijo: string): string => prefijo.replace(/^mcp__/, '').replace(/__$/, '')

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// Con --tools '' las herramientas de Claude Code no entran, pero los MCP que la cuenta ya permite sí: un ticket
// podría hacer que la consulta use uno que no es el del conector.
export function mcpAjenos(settings: unknown, claudeJson: unknown, prefijoConector: string): string[] {
  const servidores = new Set<string>()
  const allow = esObjeto(settings) && esObjeto(settings.permissions) ? settings.permissions.allow : undefined
  if (Array.isArray(allow)) {
    for (const regla of allow) {
      const m = typeof regla === 'string' ? /^mcp__(.+?)(?:__.*)?$/.exec(regla) : null
      if (m) servidores.add(m[1])
    }
  }
  if (esObjeto(claudeJson) && esObjeto(claudeJson.mcpServers)) {
    for (const nombre of Object.keys(claudeJson.mcpServers)) servidores.add(nombre.replace(/[^A-Za-z0-9_-]/g, '_'))
  }
  servidores.delete(servidorDePrefijo(prefijoConector))
  return [...servidores].filter((s) => SERVIDOR_RE.test(s)).sort().map((s) => `mcp__${s}`)
}
