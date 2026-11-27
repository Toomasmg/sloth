/**
 * Envoltorio de la statusline de cada cuenta. Claude Code le pasa a la statusline un JSON con
 * `rate_limits` (el % real de los límites de 5 h y semanal); es el único lugar donde llega. El
 * envoltorio guarda ese dato en la carpeta de la cuenta y después corre la statusline de siempre
 * con la misma entrada, así lo que ves abajo de Claude no cambia.
 *
 * En Windows, Claude corre la statusline con Git Bash si está instalado y, si no, con PowerShell. Por
 * eso el comando es solo `node "<script>" <original en base64>`, que se escribe igual en los dos, y es
 * el script el que vuelve a correr la statusline original en el mismo shell que la lanzó.
 */

export const STATUSLINE_MARKER = 'sloth-statusline'

/** Archivo que deja el envoltorio en la carpeta de cada cuenta. Lo lee la función «celular». */
export const LIMITES_ARCHIVO = 'sloth-limites.json'

/**
 * Lee la entrada una vez. Si lo lanzó Sloth (SLOTH_WS) y sabe de qué cuenta es (CLAUDE_CONFIG_DIR),
 * guarda los límites. Después corre la statusline original con esa misma entrada y devuelve su
 * salida y su código. Git Bash deja MSYSTEM y EXEPATH (su carpeta bin): con eso se elige su bash y no
 * el de WSL que vive en System32. Sin MSYSTEM en Windows, el shell de Claude fue PowerShell.
 */
export const STATUSLINE_SCRIPT = `// ${STATUSLINE_MARKER}: generado por Sloth, no editar.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const E = process.env;
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  guardar();
  correr();
});
function guardar() {
  const dir = E.CLAUDE_CONFIG_DIR;
  if (!dir || !E.SLOTH_WS) return;
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
}
function shell(cmd) {
  if (E.MSYSTEM || process.platform !== 'win32') {
    const bash = E.EXEPATH && fs.existsSync(path.join(E.EXEPATH, 'bash.exe')) ? path.join(E.EXEPATH, 'bash.exe') : E.SHELL || (process.platform === 'win32' ? 'bash' : '/bin/sh');
    return [bash, ['-c', cmd]];
  }
  return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd]];
}
function correr() {
  let cmd = '';
  try { cmd = Buffer.from(process.argv[2] || '', 'base64url').toString('utf8'); } catch {}
  if (!cmd) return process.exit(0);
  const [file, args] = shell(cmd);
  const hijo = spawn(file, args, { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
  hijo.on('error', () => process.exit(0));
  hijo.on('exit', (code) => process.exit(code ?? 0));
  hijo.stdin.on('error', () => {});
  hijo.stdin.end(raw);
  // Claude corta la statusline que tarda si llega otra: que no quede el hijo colgado.
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { hijo.kill(); process.exit(0); });
}
`

export interface StatusLine {
  type: string
  command: string
  [k: string]: unknown
}

const esStatusLine = (v: unknown): v is StatusLine =>
  !!v && typeof v === 'object' && (v as StatusLine).type === 'command' && typeof (v as StatusLine).command === 'string'

/** Lo que envolvió una versión anterior: `node "<script>" <original en base64url>` o `<sloth-hook> statusline <original>`. */
const ENVUELTA = /^(?:node "[^"]*sloth-statusline\.cjs"|\S*sloth-hook\S* statusline)(?: (\S+))?$/

/**
 * Envuelve la statusline de la cuenta. Sin statusline, solo captura y no imprime nada. Si hay algo que no es una
 * statusline de comando, no se toca. Con `helper` (el ejecutable en Rust) el envoltorio no necesita Node: una que
 * había envuelto la versión con Node se vuelve a envolver con el ejecutable, conservando la original.
 */
export function envolverStatusline(actual: unknown, script: string, helper?: string | null): unknown {
  const capturar = helper ? `${helper} statusline` : `node "${script.replace(/\\/g, '/')}"`
  if (actual === undefined || actual === null) return { type: 'command', command: capturar }
  if (!esStatusLine(actual)) return actual
  const envuelta = ENVUELTA.exec(actual.command)
  if (envuelta) {
    if (!helper || actual.command.startsWith(capturar)) return actual
    return { ...actual, command: envuelta[1] ? `${capturar} ${envuelta[1]}` : capturar }
  }
  if (actual.command.includes(STATUSLINE_MARKER)) return actual
  // base64url: sin comillas, espacios ni signos que Git Bash o PowerShell interpreten.
  return { ...actual, command: `${capturar} ${Buffer.from(actual.command, 'utf8').toString('base64url')}` }
}
