// Los subcomandos de Claude Code (update, purge, mcp…) se reconocen aunque vengan después de `--`.
const BARE_COMMAND = /^[a-z][a-z-]*$/

/** Por qué un primer mensaje no se puede pasar a `claude`, o undefined si está bien. */
export function initialPromptProblem(prompt: string): string | undefined {
  const t = prompt.trim()
  if (t.startsWith('-')) return 'El primer mensaje no puede empezar con «-»: Claude Code lo tomaría como una opción.'
  if (BARE_COMMAND.test(t))
    return 'El primer mensaje no puede ser una sola palabra en minúsculas: Claude Code la tomaría como un subcomando (p. ej. «update»). Escribí una frase o un /comando.'
  return undefined
}
