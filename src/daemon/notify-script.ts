/** Marca que identifica el script de aviso de turno que escribe Sloth. */
export const NOTIFY_SCRIPT_MARCA = 'sloth-notify'

/**
 * Script que Codex corre al terminar un turno (`notify` del config.toml de la cuenta). Codex le pasa un
 * JSON como último argumento: es un dato externo, solo se mira `type` y nada de su texto sale de acá.
 * Solo hace algo si lo lanzó Sloth (variables de entorno presentes) y el destino es la propia máquina.
 * No lee stdin, no ejecuta nada de lo que recibe y siempre sale con código 0.
 */
export const NOTIFY_SCRIPT = `// ${NOTIFY_SCRIPT_MARCA}: generado por Sloth, no editar.
const http = require('node:http');
const E = process.env;
const url = E.SLOTH_HOOK_URL, token = E.SLOTH_TOKEN, ws = E.SLOTH_WS;
if (!url || !token || !ws) process.exit(0);
setTimeout(() => process.exit(0), 2500).unref();
const arg = process.argv[process.argv.length - 1];
if (typeof arg !== 'string' || arg.length > 262144) process.exit(0);
let j;
try { j = JSON.parse(arg); } catch { process.exit(0); }
if (!j || typeof j !== 'object' || j.type !== 'agent-turn-complete') process.exit(0);
let u;
try { u = new URL(url); } catch { process.exit(0); }
if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) process.exit(0);
const req = http.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sloth-token': token }, timeout: 2000 }, (res) => { res.resume(); res.on('end', () => process.exit(0)); });
req.on('error', () => process.exit(0));
req.on('timeout', () => { req.destroy(); process.exit(0); });
req.end(JSON.stringify({ ws, event: 'Stop' }));
`
