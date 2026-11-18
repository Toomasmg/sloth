export interface DatosHook {
  url: string
  token: string
}

/**
 * Entorno de la terminal de un espacio. URL y token del canal de hooks solo van si el agente los usa:
 * con Claude hooks y statusline; con Codex solo el aviso de turno y solo si la cuenta lo activó. El token
 * es por espacio; con Claude ya está en el entorno de sus herramientas, y con Codex lo ve lo que corra Codex.
 */
export function entornoDeTerminal(
  base: Record<string, string>,
  capacidades: { hooks: boolean; avisoTurno: boolean },
  avisoActivo: boolean,
  ws: string,
  hook: () => DatosHook
): Record<string, string> {
  if (!capacidades.hooks && !(capacidades.avisoTurno && avisoActivo)) return { ...base, SLOTH_WS: ws }
  const { url, token } = hook()
  return { ...base, SLOTH_WS: ws, SLOTH_HOOK_URL: url, SLOTH_TOKEN: token }
}
