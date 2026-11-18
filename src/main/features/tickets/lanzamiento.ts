export interface Lanzamiento {
  file: string
  args: string[]
  /** true: los argumentos ya son la línea de comandos entera y Node no tiene que volver a entrecomillarlos. */
  verbatim: boolean
}

// cmd lee estos caracteres como sintaxis aun entre comillas: una ruta así no se ejecuta.
const RUTA_CMD_RARA = /[%"&^!<>|\r\n]/
const RUTA_ABSOLUTA_WIN = /^(?:[A-Za-z]:\\|\\\\[^\\])/
// Lo único que llevan los argumentos de `codex exec` de Sloth (opciones, nombres validados, JSON de herramientas). Sin espacios ni nada que cmd lea como sintaxis.
const ARG_CMD_SEGURO = /^[A-Za-z0-9_.=\-[\],"]+$/

/**
 * Cómo lanzar `exe args` sin shell. Un `.cmd` o `.bat` de npm en Windows solo corre por cmd.exe: la línea se
 * arma acá, con argumentos fijos y la ruta entre comillas (las de afuera las quita `/s`), igual que en
 * `agentes.ts` y `codex-limites.ts`. Las comillas de un argumento se escapan con `\\"` para que el
 * programa las reciba tal cual (el JSON de `enabled_tools`). Con una ruta o un argumento que cmd podría leer
 * como sintaxis, no se lanza: tira un Error con el motivo.
 */
export function lanzamientoDe(exe: string, args: readonly string[], plataforma: NodeJS.Platform): Lanzamiento {
  if (plataforma !== 'win32' || !/\.(cmd|bat)$/i.test(exe)) return { file: exe, args: [...args], verbatim: false }
  if (RUTA_CMD_RARA.test(exe) || !RUTA_ABSOLUTA_WIN.test(exe)) throw new Error('La ruta de Codex tiene caracteres que cmd.exe no acepta. Instalalo en una carpeta sin símbolos raros en el nombre.')
  if (args.some((a) => !ARG_CMD_SEGURO.test(a))) throw new Error('No se lanza Codex por cmd.exe: un argumento trae caracteres que cmd.exe leería como comandos.')
  const linea = args.map((a) => a.replace(/"/g, '\\"')).join(' ')
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `""${exe}"${linea ? ` ${linea}` : ''}"`], verbatim: true }
}
