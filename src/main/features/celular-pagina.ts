/**
 * La página del celu: HTML, CSS y JS sin dependencias, servidos por la PC. Acostado es el visor
 * (tablero de auto: dos relojes a los costados y lo urgente en el medio); parado, la lista completa.
 * Todo lo que viene de la PC se pone con textContent: los nombres de los espacios son datos del usuario.
 */

export const PAGINA_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#08090B">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Sloth">
<title>Sloth</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icono.png">
<link rel="icon" href="/icono.png">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;family=JetBrains+Mono:wght@500;600;700&amp;display=swap">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<main class="app" id="app">
  <header class="top">
    <span class="marca">Sloth</span>
    <div class="cuentas" role="group" aria-label="Cuenta" id="cuentas"></div>
    <span class="conexion" id="conexion" role="status"><span class="punto"></span><span id="conexion-texto">Conectando…</span></span>
  </header>
  <div class="relojes">
    <section class="reloj" id="g5" aria-label="Límite de 5 horas"></section>
    <section class="reloj" id="g7" aria-label="Límite semanal"></section>
  </div>
  <section class="centro">
    <div class="contadores">
      <div class="contador c-espera"><span class="num" id="n-espera">0</span><span class="etq">Te necesita</span></div>
      <div class="contador c-listo"><span class="num" id="n-listo">0</span><span class="etq">Terminaron</span></div>
      <div class="contador c-trabaja"><span class="num" id="n-trabaja">0</span><span class="etq">Trabajando</span></div>
    </div>
    <div class="pedido" id="pedido" hidden></div>
    <div class="calma" id="calma"><span class="calma-t">Nada te espera</span><span class="calma-s" id="calma-s">Ningún permiso pendiente.</span></div>
    <h2 class="titulo-lista">Sesiones <span id="resumen"></span></h2>
    <ul class="lista" id="lista"></ul>
    <p class="hoy" id="hoy">Hoy: sin datos</p>
  </section>
</main>
<section class="aviso-pantalla" id="sin-token" hidden>
  <h1>Este celu no está conectado</h1>
  <p id="sin-token-texto">Abrí Sloth en la PC, entrá a «Celular» y escaneá el QR.</p>
</section>
<script src="/app.js"></script>
</body>
</html>
`

export const PAGINA_CSS = `:root {
  --fondo: #08090B; --panel: #14171B; --borde: #23272E; --pista: #1E2228;
  --texto: #E8EAED; --fuerte: #F1F3F4; --suave: #9AA0A6;
  --celeste: #7CC4FF; --ambar: #FFB547; --rojo: #FF6B5B;
  --espera: #FFB067; --listo: #5BE3A6; --trabaja: #8CC2FF; --quieto: #B0B5BA;
  --ui: Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, 'Cascadia Mono', Menlo, monospace;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { background: var(--fondo); color: var(--texto); font: 14px/1.4 var(--ui); -webkit-text-size-adjust: 100%; }
button { font: inherit; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--trabaja); outline-offset: 2px; }
[hidden] { display: none !important; }
.app {
  min-height: 100%;
  display: grid; gap: 14px;
  padding: max(14px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(18px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "top" "relojes" "centro";
  align-content: start;
}
.top { grid-area: top; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.marca { font-size: 19px; font-weight: 700; letter-spacing: -0.01em; margin-right: auto; }
.cuentas { order: 3; flex: 1 1 100%; display: flex; gap: 4px; padding: 3px; background: var(--panel); border: 1px solid var(--borde); border-radius: 12px; overflow-x: auto; }
.cuentas button { flex: 1 0 auto; min-height: 44px; padding: 0 14px; border: 0; border-radius: 9px; background: transparent; color: var(--suave); font-size: 14px; font-weight: 500; white-space: nowrap; }
.cuentas button[aria-pressed="true"] { background: #2A2F37; color: var(--fuerte); font-weight: 600; }
.conexion { display: inline-flex; align-items: center; gap: 7px; padding: 6px 11px; border-radius: 999px; background: var(--panel); border: 1px solid var(--borde); font-size: 12px; color: #B0B5BA; }
.conexion .punto { width: 8px; height: 8px; border-radius: 50%; background: var(--suave); }
.conexion.ok .punto { background: var(--listo); }
.conexion.mal { color: var(--espera); border-color: rgba(255,176,103,0.45); }
.conexion.mal .punto { background: var(--rojo); }
.relojes { grid-area: relojes; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.reloj { display: flex; flex-direction: column; align-items: center; gap: 2px; background: var(--panel); border: 1px solid var(--borde); border-radius: 20px; padding: 10px 6px 12px; min-width: 0; }
.reloj svg { width: 100%; max-width: 170px; height: auto; display: block; }
.reloj .pie { font-size: 12px; color: var(--suave); text-align: center; min-height: 1.4em; }
.aguja { transform-origin: 100px 100px; transition: transform 600ms cubic-bezier(.3,1.4,.5,1); }
.valor { transition: stroke-dasharray 600ms ease; }
.centro { grid-area: centro; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.contadores { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.contador { border-radius: 14px; padding: 10px 8px; display: flex; flex-direction: column; align-items: center; gap: 2px; border: 1px solid; }
.contador .num { font: 700 30px/1.1 var(--mono); }
.contador .etq { font-size: 11px; font-weight: 600; }
.c-espera { background: rgba(255,159,67,0.14); border-color: rgba(255,176,103,0.4); color: var(--espera); }
.c-listo { background: rgba(61,220,151,0.12); border-color: rgba(91,227,166,0.3); color: var(--listo); }
.c-trabaja { background: rgba(90,169,255,0.12); border-color: rgba(140,194,255,0.3); color: var(--trabaja); }
.c-espera.hay .num { animation: alerta 1.4s ease-in-out infinite; }
@keyframes alerta { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
.pedido { border-radius: 16px; padding: 12px 14px; background: var(--panel); border: 1px solid rgba(255,176,103,0.45); display: flex; flex-direction: column; gap: 10px; }
.pedido .p-nombre { font-size: 15px; font-weight: 600; color: var(--fuerte); overflow-wrap: anywhere; }
.pedido .p-texto { font-size: 13px; color: var(--suave); overflow-wrap: anywhere; }
.pedido .p-botones { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.pedido button { min-height: 44px; border-radius: 12px; font-size: 15px; font-weight: 600; }
.b-rechazar { border: 1px solid #3A3F47; background: transparent; color: var(--texto); }
.b-aprobar { border: 0; background: var(--espera); color: #1A1206; font-weight: 700; }
.pedido button:disabled { opacity: 0.55; cursor: default; }
.pedido .p-nota { font-size: 12px; color: var(--suave); }
.pedido .p-error { font-size: 12px; color: var(--rojo); }
.calma { border-radius: 16px; padding: 12px 14px; background: var(--panel); border: 1px solid var(--borde); display: flex; flex-direction: column; gap: 2px; }
.calma-t { font-size: 15px; font-weight: 600; color: var(--listo); }
.calma-s { font-size: 12px; color: var(--suave); }
.titulo-lista { margin: 4px 0 0; font-size: 16px; font-weight: 700; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.titulo-lista span { font-size: 12px; font-weight: 400; color: var(--suave); }
.lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.lista li { background: var(--panel); border: 1px solid var(--borde); border-radius: 16px; padding: 11px 14px; display: flex; align-items: center; gap: 12px; min-width: 0; }
.lista .punto { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.lista .s-texto { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.lista .s-nombre { font-size: 15px; font-weight: 600; color: var(--fuerte); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lista .s-detalle { font-size: 12px; color: var(--suave); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lista .s-lado { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex: none; }
.lista .s-estado { font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 999px; }
.lista .s-hace { font: 500 11px var(--mono); color: var(--suave); }
.hoy { margin: 0; font-size: 12px; color: var(--suave); text-align: center; font-variant-numeric: tabular-nums; }
.vacio { color: var(--suave); font-size: 13px; padding: 4px 2px; }

@media (orientation: landscape) and (max-height: 600px) {
  .app {
    height: 100%; gap: 16px;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.55fr) minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-areas: "g5 top g7" "g5 centro g7";
    align-content: stretch; align-items: center;
    background: radial-gradient(ellipse at 50% 120%, #15181D 0%, var(--fondo) 70%);
  }
  .relojes { display: contents; }
  #g5 { grid-area: g5; }
  #g7 { grid-area: g7; }
  .reloj { background: none; border: 0; padding: 0; }
  .reloj svg { max-width: 260px; }
  .app { gap: 8px 16px; padding-top: max(10px, env(safe-area-inset-top)); padding-bottom: max(10px, env(safe-area-inset-bottom)); }
  .marca { display: none; }
  .top { flex-wrap: nowrap; align-self: start; min-width: 0; }
  .cuentas { order: 0; flex: 0 1 auto; min-width: 0; scrollbar-width: none; }
  .cuentas::-webkit-scrollbar { display: none; }
  .cuentas button { padding: 0 12px; font-size: 13px; }
  .conexion { margin-left: auto; padding: 4px 8px; font-size: 11px; white-space: nowrap; flex: none; }
  .centro { align-self: stretch; gap: 8px; overflow: hidden; }
  .contador { padding: 6px 8px; }
  .contador .num { font-size: 26px; }
  .pedido { padding: 10px 12px; gap: 8px; }
  .calma { padding: 10px 12px; }
  .titulo-lista { display: none; }
  .lista { gap: 2px; }
  .lista li { background: none; border: 0; padding: 0; min-height: 26px; gap: 8px; }
  .lista li.del-pedido { display: none; }
  .lista li:nth-child(n+4) { display: none; }
  .lista .punto { width: 8px; height: 8px; }
  .lista .s-detalle { display: none; }
  .lista .s-nombre { font-size: 13px; font-weight: 400; color: var(--texto); }
  .lista .s-lado { flex-direction: row; align-items: center; gap: 8px; }
  .lista .s-estado { background: none !important; padding: 0; }
  .lista .s-hace { width: 48px; text-align: right; }
  .lista { flex: 0 1 auto; min-height: 0; overflow: hidden; }
  .hoy { flex: none; }
  .hoy { margin-top: auto; }
}
.aviso-pantalla { position: fixed; inset: 0; display: flex; flex-direction: column; justify-content: center; gap: 8px; padding: 24px max(24px, env(safe-area-inset-right)) 24px max(24px, env(safe-area-inset-left)); background: var(--fondo); text-align: center; }
.aviso-pantalla h1 { margin: 0; font-size: 20px; }
.aviso-pantalla p { margin: 0 auto; max-width: 36ch; color: var(--suave); }
@media (prefers-reduced-motion: reduce) {
  .aguja, .valor { transition: none; }
  .c-espera.hay .num { animation: none; }
}
`

export const PAGINA_JS = `(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var CADA_MS = 1500;
  var ARCO = 335.1, CIRC = 502.7;
  var ESTADOS = {
    waiting: { t: 'Te necesita', c: '#FFB067', f: 'rgba(255,159,67,0.16)' },
    done: { t: 'Terminó', c: '#5BE3A6', f: 'rgba(61,220,151,0.14)' },
    working: { t: 'Trabajando', c: '#8CC2FF', f: 'rgba(90,169,255,0.16)' },
    idle: { t: 'Listo', c: '#B0B5BA', f: 'rgba(154,160,166,0.14)' },
    sleeping: { t: 'Dormido', c: '#9AA0A6', f: 'rgba(154,160,166,0.10)' },
    exited: { t: 'Cerrado', c: '#9AA0A6', f: 'rgba(154,160,166,0.10)' }
  };
  var $ = function (id) { return document.getElementById(id); };
  var guardar = function (k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } };
  var leer = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };

  var token = new URLSearchParams(location.search).get('t');
  if (token) guardar('sloth-token', token); else token = leer('sloth-token');
  var cuentaElegida = leer('sloth-cuenta');
  var ultimo = null, desfase = 0, ultimoOk = 0, timer = null, enviando = false, errorPedido = '';

  function el(tag, clase, texto) {
    var n = document.createElement(tag);
    if (clase) n.className = clase;
    if (texto !== undefined) n.textContent = texto;
    return n;
  }
  function svg(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  var ahoraPc = function () { return Date.now() + desfase; };
  function hace(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 45) return 'recién';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' h';
    return Math.floor(h / 24) + ' d';
  }
  function reinicio(ms) {
    if (ms === null) return 'Sin hora de reinicio';
    var falta = ms - ahoraPc();
    if (falta <= 0) return 'Reiniciando…';
    var min = Math.round(falta / 60000);
    if (min < 60) return 'Reinicia en ' + min + ' min';
    if (falta < 24 * 3600000) return 'Reinicia en ' + Math.floor(min / 60) + ' h ' + (min % 60) + ' min';
    var d = new Date(ms);
    var dia = d.toLocaleDateString('es-AR', { weekday: 'short' }).replace('.', '');
    var hora = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
    return 'Reinicia el ' + dia + ' ' + hora;
  }
  function tokens(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' M';
    if (n >= 1e3) return Math.round(n / 1e3) + ' k';
    return String(n);
  }

  function armarReloj(cont, etiqueta) {
    var s = svg('svg', { viewBox: '0 0 200 175', role: 'img' });
    s.appendChild(svg('circle', { cx: 100, cy: 100, r: 94, fill: 'none', stroke: '#FF6B5B', 'stroke-width': 4, 'stroke-dasharray': '0 334.6 59.1 1000', transform: 'rotate(150 100 100)', opacity: 0.8 }));
    s.appendChild(svg('circle', { cx: 100, cy: 100, r: 80, fill: 'none', stroke: '#1E2228', 'stroke-width': 14, 'stroke-linecap': 'round', 'stroke-dasharray': ARCO + ' ' + CIRC, transform: 'rotate(150 100 100)' }));
    var valor = svg('circle', { cx: 100, cy: 100, r: 80, fill: 'none', stroke: '#7CC4FF', 'stroke-width': 14, 'stroke-linecap': 'round', 'stroke-dasharray': '0 ' + CIRC, transform: 'rotate(150 100 100)', 'class': 'valor' });
    s.appendChild(valor);
    var g = svg('g', { 'stroke-linecap': 'round' });
    for (var i = 0; i <= 10; i++) {
      var mayor = i % 2 === 0;
      g.appendChild(svg('line', { x1: mayor ? 150 : 156, y1: 100, x2: 163, y2: 100, stroke: mayor ? '#5A606A' : '#3A3F47', 'stroke-width': mayor ? 2.5 : 2, transform: 'rotate(' + (150 + i * 24) + ' 100 100)' }));
    }
    s.appendChild(g);
    var tag = svg('text', { x: 100, y: 72, 'text-anchor': 'middle', fill: '#9AA0A6', 'font-size': 12, 'font-weight': 600, 'letter-spacing': 2, 'font-family': 'Inter, sans-serif' });
    tag.textContent = etiqueta;
    s.appendChild(tag);
    var aguja = svg('line', { x1: 100, y1: 100, x2: 158, y2: 100, stroke: '#F1F3F4', 'stroke-width': 4, 'stroke-linecap': 'round', 'class': 'aguja' });
    s.appendChild(aguja);
    s.appendChild(svg('circle', { cx: 100, cy: 100, r: 9, fill: '#F1F3F4' }));
    s.appendChild(svg('circle', { cx: 100, cy: 100, r: 3.5, fill: '#08090B' }));
    var pct = svg('text', { x: 100, y: 156, 'text-anchor': 'middle', fill: '#F1F3F4', 'font-size': 34, 'font-weight': 700, 'font-family': 'JetBrains Mono, monospace' });
    s.appendChild(pct);
    var pie = el('span', 'pie');
    cont.appendChild(s);
    cont.appendChild(pie);
    return { s: s, valor: valor, aguja: aguja, pct: pct, pie: pie, etiqueta: etiqueta };
  }
  var relojes = { g5: armarReloj($('g5'), '5 HORAS'), g7: armarReloj($('g7'), 'SEMANA') };

  function pintarReloj(r, v, nombreLargo) {
    if (!v) {
      r.valor.setAttribute('stroke-dasharray', '0 ' + CIRC);
      r.valor.setAttribute('opacity', '0');
      r.aguja.style.transform = 'rotate(150deg)';
      r.aguja.setAttribute('opacity', '0.35');
      r.pct.textContent = '—';
      r.pie.textContent = 'Sin datos todavía';
      r.s.setAttribute('aria-label', nombreLargo + ': sin datos todavía. Aparece cuando Claude responda en esta cuenta.');
      return;
    }
    var f = Math.max(0, Math.min(1, v.pct / 100));
    var color = f >= 0.85 ? '#FF6B5B' : f >= 0.6 ? '#FFB547' : '#7CC4FF';
    r.valor.setAttribute('stroke', color);
    r.valor.setAttribute('opacity', '1');
    r.valor.setAttribute('stroke-dasharray', (ARCO * f).toFixed(1) + ' ' + CIRC);
    r.aguja.style.transform = 'rotate(' + (150 + 240 * f).toFixed(1) + 'deg)';
    r.aguja.setAttribute('opacity', '1');
    r.pct.textContent = Math.round(v.pct) + '%';
    var texto = reinicio(v.reiniciaEn);
    r.pie.textContent = texto;
    r.s.setAttribute('aria-label', nombreLargo + ': ' + Math.round(v.pct) + ' % usado. ' + texto);
  }

  function pintarCuentas(e) {
    var cont = $('cuentas');
    if (!e.cuentas.some(function (c) { return c.id === cuentaElegida; })) {
      var conDatos = e.cuentas.filter(function (c) { return c.cincoHoras || c.semana; })[0];
      cuentaElegida = (conDatos || e.cuentas[0] || { id: null }).id;
    }
    cont.textContent = '';
    cont.hidden = e.cuentas.length < 2;
    e.cuentas.forEach(function (c) {
      var b = el('button', '', c.nombre);
      b.type = 'button';
      b.setAttribute('aria-pressed', c.id === cuentaElegida ? 'true' : 'false');
      b.addEventListener('click', function () { cuentaElegida = c.id; guardar('sloth-cuenta', c.id); pintar(); });
      cont.appendChild(b);
    });
    var actual = e.cuentas.filter(function (c) { return c.id === cuentaElegida; })[0];
    pintarReloj(relojes.g5, actual && actual.cincoHoras, 'Límite de 5 horas');
    pintarReloj(relojes.g7, actual && actual.semana, 'Límite semanal');
    $('hoy').textContent = actual && actual.hoy ? 'Hoy: ' + tokens(actual.hoy.tokens) + ' tokens · ' + actual.hoy.mensajes + ' mensajes' : 'Hoy: sin datos';
  }

  function decidir(id, decision) {
    if (enviando) return;
    enviando = true;
    errorPedido = '';
    pintar();
    fetch('/api/permiso', { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-sloth-token': token }, body: JSON.stringify({ id: id, decision: decision }) })
      .then(function (r) {
        if (r.ok) return null;
        return r.json().then(function (j) { return j && j.error ? j.error : 'No se pudo responder.'; }, function () { return 'No se pudo responder.'; });
      })
      .then(function (err) { errorPedido = err || ''; }, function () { errorPedido = 'Sin conexión con la PC. Probá de nuevo.'; })
      .then(function () { enviando = false; consultar(); });
  }

  function pintarPedido(e) {
    var p = e.pedidos[0];
    var caja = $('pedido');
    $('calma').hidden = !!p;
    caja.hidden = !p;
    if (!p) {
      var ultimaListo = e.sesiones.filter(function (s) { return s.estado === 'done'; })[0];
      $('calma-s').textContent = ultimaListo ? ultimaListo.nombre + ' terminó hace ' + hace(ahoraPc() - ultimaListo.desde) : 'Ningún permiso pendiente.';
      return;
    }
    caja.textContent = '';
    var cab = el('div');
    cab.appendChild(el('div', 'p-nombre', p.sesion + (e.pedidos.length > 1 ? '  ·  1 de ' + e.pedidos.length : '')));
    cab.appendChild(el('div', 'p-texto', 'Pide permiso: ' + p.texto + ' · hace ' + hace(ahoraPc() - p.desde)));
    caja.appendChild(cab);
    if (e.aprobar) {
      var botones = el('div', 'p-botones');
      var no = el('button', 'b-rechazar', 'Rechazar');
      var si = el('button', 'b-aprobar', enviando ? 'Enviando…' : 'Aprobar');
      no.type = si.type = 'button';
      no.disabled = si.disabled = enviando;
      no.addEventListener('click', function () { decidir(p.id, 'deny'); });
      si.addEventListener('click', function () { decidir(p.id, 'allow'); });
      botones.appendChild(no);
      botones.appendChild(si);
      caja.appendChild(botones);
    } else {
      caja.appendChild(el('div', 'p-nota', 'Respondelo en la PC. Para hacerlo desde acá, prendé «Aprobar desde el celu» en Sloth.'));
    }
    if (errorPedido) caja.appendChild(el('div', 'p-error', errorPedido));
  }

  function pintarLista(e) {
    var lista = $('lista');
    lista.textContent = '';
    var conPedido = e.pedidos[0] ? e.pedidos[0].sesionId : null;
    var nombres = {};
    e.cuentas.forEach(function (c) { nombres[c.id] = c.nombre; });
    if (!e.sesiones.length) lista.appendChild(el('li', 'vacio', 'No hay espacios abiertos en la PC.'));
    // La del pedido va al final: acostado se oculta y no le quita lugar a las otras tres.
    var orden = e.sesiones.filter(function (s) { return s.id !== conPedido; }).concat(e.sesiones.filter(function (s) { return s.id === conPedido; }));
    orden.forEach(function (s) {
      var st = ESTADOS[s.estado] || ESTADOS.idle;
      var li = el('li', s.id === conPedido ? 'del-pedido' : '');
      var punto = el('span', 'punto');
      punto.style.background = st.c;
      var texto = el('div', 's-texto');
      texto.appendChild(el('span', 's-nombre', s.nombre));
      var cuenta = nombres[s.cuentaId] || '';
      texto.appendChild(el('span', 's-detalle', cuenta + (s.detalle ? ' · ' + s.detalle : '')));
      var lado = el('div', 's-lado');
      var chip = el('span', 's-estado', st.t);
      chip.style.color = st.c;
      chip.style.background = st.f;
      lado.appendChild(chip);
      lado.appendChild(el('span', 's-hace', hace(ahoraPc() - s.desde)));
      li.appendChild(punto);
      li.appendChild(texto);
      li.appendChild(lado);
      lista.appendChild(li);
    });
    var n = function (k) { return e.sesiones.filter(function (s) { return s.estado === k; }).length; };
    $('n-espera').textContent = n('waiting');
    $('n-espera').parentNode.classList.toggle('hay', n('waiting') > 0);
    $('n-listo').textContent = n('done');
    $('n-trabaja').textContent = n('working');
    $('resumen').textContent = e.sesiones.length ? e.sesiones.length + (e.sesiones.length === 1 ? ' abierta' : ' abiertas') : '';
  }

  function pintarConexion() {
    var c = $('conexion');
    var t = $('conexion-texto');
    var lejos = Date.now() - ultimoOk;
    c.classList.toggle('ok', !!ultimoOk && lejos < 6000);
    c.classList.toggle('mal', !ultimoOk || lejos >= 6000);
    if (!ultimoOk) t.textContent = 'Buscando la PC…';
    else if (lejos < 6000) t.textContent = 'PC conectada';
    else t.textContent = 'Sin conexión con la PC · hace ' + hace(lejos);
  }

  function pintar() {
    pintarConexion();
    if (!ultimo) return;
    pintarCuentas(ultimo);
    pintarPedido(ultimo);
    pintarLista(ultimo);
  }

  function sinToken(texto) {
    $('app').hidden = true;
    $('sin-token').hidden = false;
    if (texto) $('sin-token-texto').textContent = texto;
  }

  function consultar() {
    clearTimeout(timer);
    if (!token) return sinToken();
    fetch('/api/estado', { cache: 'no-store', headers: { 'x-sloth-token': token } })
      .then(function (r) {
        if (r.status === 401) {
          guardar('sloth-token', null);
          token = null;
          sinToken('Este celu ya no está autorizado (se regeneró el código en Sloth). Escaneá el QR de nuevo.');
          return null;
        }
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (e) {
        if (!e) return;
        ultimo = e;
        desfase = e.ahora - Date.now();
        ultimoOk = Date.now();
        pintar();
      }, function () { pintarConexion(); })
      .then(function () { if (token && !document.hidden) timer = setTimeout(consultar, CADA_MS); });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) clearTimeout(timer);
    else consultar();
  });
  consultar();
})();
`

export function manifiesto(): string {
  return JSON.stringify({
    name: 'Sloth',
    short_name: 'Sloth',
    description: 'Cómo van tus sesiones de Claude, desde el celu.',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    orientation: 'any',
    background_color: '#08090B',
    theme_color: '#08090B',
    icons: [{ src: '/icono.png', sizes: '256x256', type: 'image/png', purpose: 'any' }]
  })
}
