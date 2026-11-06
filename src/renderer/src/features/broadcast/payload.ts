/**
 * Arma lo que se escribe en la terminal para mandarle un prompt a Claude Code.
 * Sin imports a propósito: se prueba con Node directo.
 *
 * - Una línea: el texto tal cual y después Enter (`\r`).
 * - Varias líneas: pegado entre corchetes (bracketed paste, `ESC[200~ … ESC[201~`), igual que hace
 *   xterm al pegar con Ctrl+V; así Claude Code toma los saltos como parte del prompt y no como Enter.
 *   Los saltos van como `\r` (como los manda xterm al pegar). Después, Enter aparte.
 * Se sacan los caracteres de control (incluido ESC): un texto con `ESC[201~` adentro cortaría el pegado.
 */
export const MAX_PROMPT = 20_000

export function cleanPrompt(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f\x9b]/g, '')
    .replace(/\s+$/, '')
    .replace(/^\n+/, '')
}

export interface Payload {
  /** Lo que se escribe primero. */
  body: string
  /** Lo que se escribe después de una pausa corta (Enter). */
  submit: string
  multiline: boolean
}

export function buildPayload(text: string): Payload | null {
  const t = cleanPrompt(text)
  if (!t.trim()) return null
  if (t.length > MAX_PROMPT) throw new Error(`El prompt es demasiado largo (máximo ${MAX_PROMPT} caracteres).`)
  const multiline = t.includes('\n')
  const body = multiline ? `\x1b[200~${t.replace(/\n/g, '\r')}\x1b[201~` : t
  return { body, submit: '\r', multiline }
}
