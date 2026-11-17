/** Cómo se le pasa a cada shell el comando inicial de Claude. Puro: se prueba con Node. */

/** Familia de sintaxis de la shell: cambia cómo se pasa el comando inicial. */
export type ShellFamily = 'ps' | 'cmd' | 'posix'

// Argumentos que no necesitan comillas en ninguna de las shells.
const PLAIN = /^[A-Za-z0-9_\-./:=\\]+$/
// PowerShell cierra un string de comilla simple también con las tipográficas (‘ ’ ‚ ‛): se duplican todas.
export const psArg = (s: string): string => (PLAIN.test(s) ? s : `'${s.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`)
export const posixArg = (s: string): string => (PLAIN.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
// cmd no tiene escape confiable: se quitan las comillas y los caracteres especiales del prompt.
export const cmdArg = (s: string): string => (PLAIN.test(s) ? s : `"${s.replace(/["&|<>^%!()]/g, '')}"`)

/**
 * argv de Claude con un prompt inicial. El prompt puede venir de un team.json o de un archivo importado:
 * va después de «--» para que uno que empiece con guion (--permission-mode=…, --settings=…) no se lea como opción.
 */
export const claudeWithPrompt = (prompt: string): string[] => ['claude', '--', prompt.replace(/[\r\n]+/g, ' ')]

/** Argumentos de la shell: solo la shell, o la shell corriendo el comando de Claude y quedándose abierta. */
export function shellArgs(family: ShellFamily, claude?: string[]): string[] {
  if (!claude?.length) return family === 'ps' ? ['-NoLogo'] : family === 'posix' ? ['--login', '-i'] : []
  switch (family) {
    case 'ps':
      return ['-NoLogo', '-NoExit', '-Command', claude.map(psArg).join(' ')]
    case 'cmd':
      return ['/k', claude.map(cmdArg).join(' ')]
    case 'posix':
      return ['--login', '-i', '-c', `${claude.map(posixArg).join(' ')}; exec bash --login -i`]
  }
}
