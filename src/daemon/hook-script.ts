/** Marca que identifica nuestros hooks dentro del settings.json de cada cuenta. */
export const HOOK_MARKER = 'sloth-hook'
/** Marcador de versiones anteriores (AntiRea): sus entradas también se limpian al instalar. */
export const LEGACY_HOOK_MARKERS = ['antirea-hook'] as const

/**
 * Script que corre Claude en cada hook. Solo hace algo si lo lanzó Sloth (variables de entorno
 * presentes): usar esa cuenta fuera de la app no hace nada. Siempre sale con código 0.
 * - Eventos normales: POST fire-and-forget a SLOTH_HOOK_URL (o ANTIREA_HOOK_URL) (nunca bloquea más de ~2,5 s).
 * - PermissionRequest: POST a <origin>/permission y espera la decisión de la UI (hasta 125 s). Si hay
 *   decisión la imprime como hookSpecificOutput; si no, no imprime nada y Claude pregunta en la terminal.
 */
export const HOOK_SCRIPT = `// ${HOOK_MARKER}: generado por Sloth, no editar.
const http = require('node:http');
const E = process.env;
const url = E.SLOTH_HOOK_URL || E.ANTIREA_HOOK_URL, token = E.SLOTH_TOKEN || E.ANTIREA_TOKEN, ws = E.SLOTH_WS || E.ANTIREA_WS;
if (!url || !token || !ws) process.exit(0);
const event = process.argv[2];
const isPerm = event === 'PermissionRequest';
let finished = false;
const done = (out) => {
  if (finished) return;
  finished = true;
  if (out) process.stdout.write(out, () => process.exit(0));
  else process.exit(0);
};
setTimeout(() => done(), isPerm ? 126000 : 2500).unref();
const LIMIT = isPerm ? 4194304 : 65536;
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { if (raw.length < LIMIT) raw += c; });
process.stdin.on('error', () => done());
process.stdin.on('end', () => {
  let j = {};
  try { j = JSON.parse(raw); } catch {}
  let target = url, body, timeout = 1500;
  if (isPerm) {
    try { target = new URL(url).origin + '/permission'; } catch { return done(); }
    let input = j.tool_input && typeof j.tool_input === 'object' ? j.tool_input : {};
    let suggestions = Array.isArray(j.permission_suggestions) ? j.permission_suggestions : undefined;
    body = JSON.stringify({ ws, tool: String(j.tool_name || ''), input, suggestions });
    if (body.length > 250000) {
      const s = JSON.stringify(input);
      input = { _truncated: true, preview: s.slice(0, 4000) };
      body = JSON.stringify({ ws, tool: String(j.tool_name || ''), input, suggestions: undefined });
    }
    timeout = 125000;
  } else {
    body = JSON.stringify({ ws, event, tool: j.tool_name, message: j.message, notificationType: j.notification_type });
  }
  const req = http.request(target, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sloth-token': token }, timeout }, (res) => {
    if (!isPerm) { res.resume(); res.on('end', () => done()); return; }
    let r = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { if (r.length < 1048576) r += c; });
    res.on('end', () => {
      try {
        const d = JSON.parse(r).decision;
        if (res.statusCode === 200 && d && typeof d === 'object' && !Array.isArray(d)) {
          return done(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } }));
        }
      } catch {}
      done();
    });
    res.on('error', () => done());
  });
  req.on('error', () => done());
  req.on('timeout', () => { req.destroy(); done(); });
  req.end(body);
});
`
