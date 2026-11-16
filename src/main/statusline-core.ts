/**
 * Envoltorio de la statusline de cada cuenta. Claude Code le pasa a la statusline un JSON con
 * `rate_limits` (el % real de los límites de 5 h y semanal); es el único lugar donde llega. El
 * envoltorio guarda ese dato en la carpeta de la cuenta y después corre la statusline de siempre
 * con la misma entrada, así lo que ves abajo de Claude no cambia.
 */

export const STATUSLINE_MARKER = 'sloth-statusline'

/** Archivo que deja el envoltorio en la carpeta de cada cuenta. Lo lee la función «celular». */
export const LIMITES_ARCHIVO = 'sloth-limites.json'

/**
 * Script que corre node con la entrada de la statusline. Solo escribe si lo lanzó Sloth (SLOTH_WS) y
 * sabe de qué cuenta es (CLAUDE_CONFIG_DIR). No imprime nada y siempre sale con código 0: la
 * statusline del usuario la corre el shell aparte.
 */
export const STATUSLINE_SCRIPT = `// ${STATUSLINE_MARKER}: generado por Sloth, no editar.
const fs = require('node:fs');
const path = require('node:path');
const E = process.env;
const dir = E.CLAUDE_CONFIG_DIR;
if (!dir || !E.SLOTH_WS) process.exit(0);
setTimeout(() => process.exit(0), 3000).unref();
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { if (raw.length < 262144) raw += c; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  try {
    const r = JSON.parse(raw).rate_limits;
    if (!r || typeof r !== 'object') return;
    const pick = (w) => (w && typeof w.used_percentage === 'number' ? { pct: w.used_percentage, resetsAt: w.resets_at ?? null } : null);
    const out = { fiveHour: pick(r.five_hour), sevenDay: pick(r.seven_day), at: Date.now() };
    if (!out.fiveHour && !out.sevenDay) return;
    const file = path.join(dir, '${LIMITES_ARCHIVO}');
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, file);
  } catch {}
});
`

export interface StatusLine {
  type: string
  command: string
  [k: string]: unknown
}

const esStatusLine = (v: unknown): v is StatusLine =>
  !!v && typeof v === 'object' && (v as StatusLine).type === 'command' && typeof (v as StatusLine).command === 'string'

/**
 * Envuelve la statusline de la cuenta. La statusline de siempre corre en el mismo shell que la lanzó
 * Claude, tal cual (en una subshell propia), con la misma entrada: `$(cat)` la lee una vez y se la
 * pasa a los dos. Si ya está envuelta, la deja igual. Sin statusline, solo captura y no imprime nada.
 * Si hay algo que no es una statusline de comando, no se toca.
 */
export function envolverStatusline(actual: unknown, script: string): unknown {
  const capturar = `node "${script.replace(/\\/g, '/')}"`
  if (actual === undefined || actual === null) return { type: 'command', command: capturar }
  if (!esStatusLine(actual)) return actual
  if (actual.command.includes(STATUSLINE_MARKER)) return actual
  const command = `j=$(cat); printf '%s' "$j" | ${capturar} >/dev/null 2>&1; printf '%s' "$j" | (\n${actual.command}\n)`
  return { ...actual, command }
}
