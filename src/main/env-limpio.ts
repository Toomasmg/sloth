/**
 * Entorno limpio para cada terminal: se quitan las variables que harían que el agente use otra
 * cuenta (API keys) o crea que corre anidado dentro de otra sesión suya, y las propias de Sloth.
 */
export function entornoLimpio(origen: NodeJS.ProcessEnv, quitarDelAgente: (claveMayus: string) => boolean): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(origen)) {
    if (v === undefined) continue
    const key = k.toUpperCase()
    if (quitarDelAgente(key) || key.startsWith('ELECTRON_') || key.startsWith('ANTIREA_') || key.startsWith('SLOTH_')) continue
    env[k] = v
  }
  env.TERM_PROGRAM = 'Sloth'
  return env
}
