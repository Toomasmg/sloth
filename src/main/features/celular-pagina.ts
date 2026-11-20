import { SELLO_JS } from './celular-sello-web'

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
    <button type="button" class="completa" id="completa" aria-label="Pantalla completa" title="Pantalla completa" hidden><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"></path></svg></button>
  </header>
  <div class="pista" id="pista-ios" role="note" hidden>
    <span>Para verlo sin la barra del navegador: tocá Compartir y «Agregar a inicio», y abrilo desde ese ícono.</span>
    <button type="button" id="pista-ok">Entendido</button>
  </div>
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
    <p class="term-nota" id="term-nota" hidden>La terminal de cada sesión no se abre desde «Desde cualquier red». Escaneá el QR del Wi-Fi de casa (en Sloth, panel Celular, el de arriba) con el celu conectado a ese Wi-Fi.</p>
    <ul class="lista" id="lista"></ul>
    <p class="hoy" id="hoy">Hoy: sin datos</p>
  </section>
</main>
<section class="term" id="term" role="dialog" aria-modal="true" aria-labelledby="term-nombre" hidden>
  <header class="term-top">
    <button type="button" class="term-volver" id="term-volver" aria-label="Volver a las sesiones"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg></button>
    <span class="term-nombre" id="term-nombre"></span>
    <button type="button" class="term-ajustar" id="term-ajustar" aria-pressed="false">Ajustar al celu</button>
  </header>
  <div class="term-aviso" id="term-aviso" role="status" hidden></div>
  <div class="term-pantalla" id="term-pantalla"></div>
  <div class="term-teclas" role="group" aria-label="Teclas">
    <button type="button" data-tecla="esc">Esc</button>
    <button type="button" data-tecla="tab">Tab</button>
    <button type="button" data-tecla="arriba" aria-label="Flecha arriba">↑</button>
    <button type="button" data-tecla="abajo" aria-label="Flecha abajo">↓</button>
    <button type="button" data-tecla="izq" aria-label="Flecha izquierda">←</button>
    <button type="button" data-tecla="der" aria-label="Flecha derecha">→</button>
    <button type="button" data-tecla="ctrlc" aria-label="Control C">Ctrl C</button>
    <button type="button" data-tecla="enter" aria-label="Enter">⏎</button>
  </div>
  <form class="term-escribir" id="term-form" autocomplete="off">
    <textarea id="term-texto" rows="1" placeholder="Escribile a la terminal…" aria-label="Texto para la terminal" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
    <button type="submit" id="term-enviar">Enviar</button>
  </form>
</section>
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
  grid-template-areas: "top" "pista" "relojes" "centro";
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
    grid-template-rows: auto auto minmax(0, 1fr);
    grid-template-areas: "g5 top g7" "g5 pista g7" "g5 centro g7";
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
.completa { flex: none; width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center; border-radius: 12px; border: 1px solid var(--borde); background: var(--panel); color: var(--texto); }
.pista { grid-area: pista; display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 12px; border-radius: 12px; background: rgba(90,169,255,0.12); border: 1px solid rgba(140,194,255,0.3); font-size: 12px; color: var(--texto); }
.pista span { flex: 1; min-width: 0; }
.pista button { flex: none; min-height: 44px; padding: 0 12px; border: 0; border-radius: 9px; background: #2A2F37; color: var(--fuerte); font-weight: 600; }
.aviso-pantalla { position: fixed; inset: 0; display: flex; flex-direction: column; justify-content: center; gap: 8px; padding: 24px max(24px, env(safe-area-inset-right)) 24px max(24px, env(safe-area-inset-left)); background: var(--fondo); text-align: center; }
.aviso-pantalla h1 { margin: 0; font-size: 20px; }
.aviso-pantalla p { margin: 0 auto; max-width: 36ch; color: var(--suave); }
.lista .s-term { flex: none; min-height: 44px; padding: 0 12px; display: inline-flex; align-items: center; gap: 6px; border-radius: 12px; border: 1px solid rgba(140,194,255,0.35); background: rgba(90,169,255,0.12); color: var(--trabaja); font-size: 13px; font-weight: 600; }
.lista .s-term .s-term-ico { font: 700 13px var(--mono); }
.lista .s-term:disabled { opacity: 0.5; cursor: default; }
.term-nota { margin: 0; padding: 10px 12px; border-radius: 12px; background: var(--panel); border: 1px solid var(--borde); font-size: 12px; color: var(--suave); }
.term { position: fixed; inset: 0; z-index: 10; display: flex; flex-direction: column; background: var(--fondo); padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
.term-top { flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--borde); }
.term-volver { flex: none; width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 12px; background: transparent; color: var(--texto); }
.term-nombre { flex: 1; min-width: 0; font-size: 15px; font-weight: 600; color: var(--fuerte); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.term-ajustar { flex: none; min-height: 44px; padding: 0 12px; border: 1px solid var(--borde); border-radius: 12px; background: var(--panel); color: var(--texto); font-size: 13px; font-weight: 600; }
.term-ajustar[aria-pressed="true"] { background: #2A2F37; color: var(--fuerte); }
.term-aviso { flex: none; padding: 8px 14px; font-size: 13px; color: var(--espera); background: rgba(255,159,67,0.10); border-bottom: 1px solid rgba(255,176,103,0.3); }
.term-pantalla { flex: 1; min-height: 0; overflow: auto; padding: 6px 4px; background: #0B0D10; -webkit-overflow-scrolling: touch; }
.term-pantalla .xterm { padding: 0; }
.term-teclas { flex: none; display: flex; gap: 4px; padding: 6px 8px; overflow-x: auto; border-top: 1px solid var(--borde); scrollbar-width: none; }
.term-teclas::-webkit-scrollbar { display: none; }
.term-teclas button { flex: 1 0 auto; min-width: 38px; min-height: 44px; padding: 0 6px; border: 1px solid var(--borde); border-radius: 10px; background: var(--panel); color: var(--texto); font: 600 13px var(--mono); }
.term-escribir { flex: none; display: flex; gap: 8px; padding: 6px 8px 8px; }
.term-escribir textarea { flex: 1; min-width: 0; min-height: 44px; max-height: 120px; resize: none; padding: 11px 12px; border: 1px solid var(--borde); border-radius: 12px; background: var(--panel); color: var(--texto); font: 16px/1.3 var(--mono); }
.term-escribir textarea:focus-visible { outline: 2px solid var(--trabaja); outline-offset: 1px; }
.term-escribir button { flex: none; min-height: 44px; padding: 0 16px; border: 0; border-radius: 12px; background: var(--trabaja); color: #08111C; font-weight: 700; }
.term button:disabled, .term textarea:disabled { opacity: 0.5; cursor: default; }
@media (prefers-reduced-motion: reduce) {
  .aguja, .valor { transition: none; }
  .c-espera.hay .num { animation: none; }
}
`

export const PAGINA_JS = SELLO_JS + '\n' + `(function () {
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
  var MAX_RESPUESTA = 262144;
  var HORA_CORRIDA = 'Revisá la hora del celu: está corrida respecto de la PC.';
  var $ = function (id) { return document.getElementById(id); };
  var guardar = function (k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } };
  var leer = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  // La versión remota define window.slothFetch: se busca en cada pedido, no al cargar. En el Wi-Fi
  // los pedidos van sellados con la clave del QR (window.slothSello).
  // Derivar la clave y precalcular el MAC cuesta: se hace una vez por clave, no en cada pedido.
  var cacheClaves = { t: null, c: null };
  var clavesDe = function (t) {
    if (cacheClaves.t !== t || !cacheClaves.c) cacheClaves = { t: t, c: window.slothSello.abrirClave(t) };
    return cacheClaves.c;
  };
  var sellado = function (ruta, objeto, senal) {
    return new Promise(function (resolve, reject) {
      var claves = clavesDe(token);
      if (!claves) { resolve({ ok: false, status: 401 }); return; }
      var s = window.slothSello.sellarPedido(claves, ruta, objeto);
      var opciones = { method: 'POST', cache: 'no-store', headers: { 'content-type': 'text/plain' }, body: s.sobre };
      if (senal) opciones.signal = senal;
      fetch(ruta, opciones)
        .then(function (r) {
          if (r.status !== 200 && r.status !== 400 && r.status !== 403 && r.status !== 404 && r.status !== 409) return { ok: false, status: r.status };
          return r.text().then(function (texto) {
            if (texto.length > MAX_RESPUESTA) throw new Error('grande');
            var plano = window.slothSello.abrirRespuesta(claves, s.iv, texto);
            if (plano === null) throw new Error('sello');
            return { ok: r.ok, status: r.status, json: function () { return Promise.resolve(JSON.parse(plano)); } };
          });
        })
        .then(resolve, reject);
    });
  };
  var pedirApi = function (ruta, objeto, senal) {
    if (window.slothFetch) return window.slothFetch(ruta, objeto ? { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(objeto) } : { cache: 'no-store' });
    return sellado(ruta, objeto || {}, senal);
  };

  var viejo = leer('sloth-token');
  var enlace = new URLSearchParams(location.hash.slice(1)).get('k');
  var enlaceMalo = false;
  if (enlace) {
    if (window.slothSello.abrirClave(enlace)) guardar('sloth-clave', enlace);
    else enlaceMalo = true;
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* sin historial */ }
  }
  var token = viejo === 'remoto' ? viejo : (enlaceMalo ? null : enlace || leer('sloth-clave'));
  if (viejo && viejo !== 'remoto') guardar('sloth-token', null);
  var cuentaElegida = leer('sloth-cuenta');
  var ultimo = null, desfase = 0, ultimoOk = 0, timer = null, enviando = false, errorPedido = '', avisoHora = false;

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

  function textoError(error) {
    if (error === 'reloj') return HORA_CORRIDA;
    if (error === 'repetido') return 'No se pudo responder. Probá de nuevo.';
    return error;
  }

  function decidir(id, decision) {
    if (enviando) return;
    enviando = true;
    errorPedido = '';
    pintar();
    pedirApi('/api/permiso', { id: id, decision: decision })
      .then(function (r) {
        if (r.ok) return null;
        return r.json().then(function (j) { return j && j.error ? textoError(j.error) : 'No se pudo responder.'; }, function () { return 'No se pudo responder.'; });
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
      var enWifi = e.terminal && !window.slothFetch;
      var soloWifi = !!window.slothFetch && !!e.terminalEnWifi;
      if ((enWifi || soloWifi) && s.estado !== 'exited') {
        var bt = el('button', 's-term');
        bt.appendChild(el('span', 's-term-ico', '>_'));
        bt.appendChild(el('span', '', 'Terminal'));
        bt.type = 'button';
        if (soloWifi) {
          bt.disabled = true;
          bt.setAttribute('aria-label', 'Terminal de ' + s.nombre + ': escaneá el QR del Wi-Fi de casa para abrirla');
          bt.setAttribute('aria-describedby', 'term-nota');
        } else {
          bt.setAttribute('aria-label', 'Abrir la terminal de ' + s.nombre);
          bt.addEventListener('click', function () { abrirTerminal(s.id, s.nombre); });
        }
        li.appendChild(bt);
      }
      lista.appendChild(li);
    });
    var n = function (k) { return e.sesiones.filter(function (s) { return s.estado === k; }).length; };
    $('n-espera').textContent = n('waiting');
    $('n-espera').parentNode.classList.toggle('hay', n('waiting') > 0);
    $('n-listo').textContent = n('done');
    $('n-trabaja').textContent = n('working');
    $('term-nota').hidden = !(window.slothFetch && e.terminalEnWifi);
    $('resumen').textContent = e.sesiones.length ? e.sesiones.length + (e.sesiones.length === 1 ? ' abierta' : ' abiertas') : '';
  }

  function pintarConexion() {
    var c = $('conexion');
    var t = $('conexion-texto');
    var lejos = Date.now() - ultimoOk;
    c.classList.toggle('ok', !avisoHora && !!ultimoOk && lejos < 6000);
    c.classList.toggle('mal', avisoHora || !ultimoOk || lejos >= 6000);
    if (avisoHora) t.textContent = HORA_CORRIDA;
    else if (!ultimoOk) t.textContent = 'Buscando la PC…';
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
    if (!token) return sinToken(enlaceMalo ? 'El QR no se leyó bien. Escaneá el QR de nuevo en Sloth.' : viejo ? 'Hay que volver a emparejar este celu: escaneá el QR de nuevo en Sloth.' : undefined);
    pedirApi('/api/estado')
      .then(function (r) {
        if (r.status === 401) {
          guardar('sloth-token', null);
          guardar('sloth-clave', null);
          token = null;
          sinToken('Este celu ya no está autorizado (se regeneró el código en Sloth). Escaneá el QR de nuevo.');
          return null;
        }
        if (r.status === 409) {
          return r.json().then(function (j) {
            avisoHora = !!j && j.error === 'reloj';
            throw new Error('http 409');
          });
        }
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (e) {
        if (!e) return;
        avisoHora = false;
        ultimo = e;
        desfase = e.ahora - Date.now();
        ultimoOk = Date.now();
        pintar();
      }, function () { pintarConexion(); })
      .then(function () { if (token && !document.hidden) timer = setTimeout(consultar, CADA_MS); });
  }

  // Sin la barra del navegador. Una página http no se puede instalar como app en Android, pero sí
  // puede pedir pantalla completa con un toque; el iPhone no deja, y la única salida es el ícono de inicio.
  var enApp = window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone === true;
  var raiz = document.documentElement;
  var pedir = raiz.requestFullscreen ? function () { return raiz.requestFullscreen({ navigationUI: 'hide' }); } : raiz.webkitRequestFullscreen ? function () { raiz.webkitRequestFullscreen(); return Promise.resolve(); } : null;
  var enCompleta = function () { return !!(document.fullscreenElement || document.webkitFullscreenElement); };
  if (pedir && !enApp) {
    var boton = $('completa');
    var entrar = function () {
      if (enCompleta()) return;
      try { var r = pedir(); if (r && r.catch) r.catch(function () { /* el navegador no quiso */ }); } catch (e) { /* idem */ }
    };
    var actualizar = function () { boton.hidden = enCompleta(); };
    boton.addEventListener('click', entrar);
    document.addEventListener('pointerup', entrar);
    document.addEventListener('fullscreenchange', actualizar);
    document.addEventListener('webkitfullscreenchange', actualizar);
    actualizar();
  } else if (!enApp && /iP(hone|od)/.test(navigator.userAgent) && !leer('sloth-pista-ios')) {
    $('pista-ios').hidden = false;
    $('pista-ok').addEventListener('click', function () { $('pista-ios').hidden = true; guardar('sloth-pista-ios', '1'); });
  }


  // Terminal, con dos lazos. «Mirar» deja un pedido abierto en la PC (hasta 20 s) que contesta apenas hay salida
  // nueva; «escribir» manda lo que se teclea en pedidos aparte, de a uno y en orden, y la PC contesta ya.
  // Todo sellado por el mismo canal que el estado. xterm se carga recién al abrirla (pesa ~500 kB).
  var TECLAS = { esc: '\\x1b', tab: '\\t', arriba: '\\x1b[A', abajo: '\\x1b[B', der: '\\x1b[C', izq: '\\x1b[D', ctrlc: '\\x03', enter: '\\r' };
  var TERM_MAX = 1500, TERM_ESPERA = 20000, TERM_MARGEN = 8000, TERM_ESCRIBIR_MAX = 10000;
  var term = null, termId = null, termDesde = -1, termCola = [], termTam = null, termTamPend = null;
  var termAjustado = false, termCerrada = false, xtermCargando = null, conHistoria = false;
  var termMas = false, termParada = false, termTipo = '', termIguales = 0;
  var termGen = 0, termCtl = null, termMirando = false, termFallas = 0, termPausa = 0, termMirarTimer = null, termWatchdog = null;
  var termEscribiendo = false, termEscFallas = 0, termEscTok = 0, termEscTimer = null, termEscCtl = null, termEscWatchdog = null, termN = 0;
  var TERM_PESO = 3000, TERM_IGUALES = 3;
  // La PC recuerda 10 min los números de escritura que hizo: pasado bastante menos que eso lo que no se confirmó se descarta, nunca se reenvía.
  var TERM_ESCRITURA_MAX_MS = 120000;
  var termNota = '';
  // Identifica a esta página ante la PC: con el número de cada escritura, un reintento no se escribe dos veces.
  var TERM_SESION = (function () {
    var abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', r = '', b = null;
    try { b = new Uint8Array(16); window.crypto.getRandomValues(b); } catch (e) { b = null; }
    for (var i = 0; i < 16; i++) r += abc.charAt((b ? b[i] : Math.floor(Math.random() * 62)) % 62);
    return r;
  })();

  function cargarXterm() {
    if (window.Terminal) return Promise.resolve();
    if (xtermCargando) return xtermCargando;
    xtermCargando = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '/xterm.css';
      document.head.appendChild(css);
      var js = document.createElement('script');
      js.src = '/xterm.js';
      js.onload = function () { resolve(); };
      js.onerror = function () { xtermCargando = null; reject(new Error('xterm')); };
      document.head.appendChild(js);
    });
    return xtermCargando;
  }

  function avisoTerm(texto) {
    $('term-aviso').hidden = !texto;
    $('term-aviso').textContent = texto || '';
  }

  // La celda se mide en lo que dibujó xterm (redondea a píxeles de la pantalla); a ojo, el texto se corta.
  function celda() {
    var pantalla = $('term-pantalla').querySelector('.xterm-screen');
    if (!pantalla || !term.cols) return null;
    return { w: pantalla.offsetWidth / term.cols, h: pantalla.offsetHeight / term.rows };
  }
  // Lo que queda para las columnas: el padding y la barra de scroll de xterm.
  var anchoUtil = function () { return $('term-pantalla').clientWidth - 8 - 14; };

  // Con el tamaño de la PC la letra se achica hasta que entren las columnas; si ni así, se desliza de costado.
  function encajar() {
    if (!term || !termTam) return;
    if (term.cols !== termTam.cols || term.rows !== termTam.rows) term.resize(termTam.cols, termTam.rows);
    var px = term.options.fontSize;
    for (var i = 0; i < 3; i++) {
      var c = celda();
      if (!c || !c.w) return;
      var nuevo = Math.max(7, Math.min(15, Math.floor(px * anchoUtil() / (c.w * termTam.cols) * 10) / 10));
      if (Math.abs(nuevo - px) < 0.1) return;
      term.options.fontSize = px = nuevo;
    }
  }

  function tamDelCelu() {
    var c = celda();
    var px = term.options.fontSize;
    var w = c && c.w ? c.w * 13 / px : 7.8, h = c && c.h ? c.h * 13 / px : 16;
    return { cols: Math.max(20, Math.min(500, Math.floor(anchoUtil() / w))), rows: Math.max(5, Math.min(200, Math.floor(($('term-pantalla').clientHeight - 12) / h))) };
  }

  // Cuánto ocupa lo que se escribe dentro del JSON del pedido (bytes UTF-8 ya escapados): la PC no acepta
  // sobres de más de 8192 y un ESC pegado pesa 6, una letra con tilde 2.
  function unidades(t, i) {
    var c = t.charCodeAt(i), d = t.charCodeAt(i + 1);
    return c >= 0xd800 && c < 0xdc00 && d >= 0xdc00 && d < 0xe000 ? 2 : 1;
  }
  function pesoCar(t, i, u) {
    var c = t.charCodeAt(i);
    if (u === 2) return 4;
    if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) return 2;
    if (c < 32) return 6;
    if (c < 128) return 1;
    if (c < 2048) return 2;
    if (c >= 0xd800 && c < 0xe000) return 6;
    return 3;
  }

  function encolar(texto, aparte) {
    if (termCerrada || !texto) return;
    var i = 0;
    while (i < texto.length) {
      var ult = termCola[termCola.length - 1];
      var junta = !aparte && !!ult && !ult.aparte && !ult.n;
      var p = junta ? ult.p : 0, largo = junta ? ult.t.length : 0, ini = i;
      while (i < texto.length) {
        var u = unidades(texto, i), w = pesoCar(texto, i, u);
        if (p + w > TERM_PESO || largo + (i - ini) + u > TERM_MAX) break;
        p += w;
        i += u;
      }
      if (i === ini) { termCola.push({ t: '', p: 0, aparte: false }); continue; }
      if (junta) { ult.t += texto.slice(ini, i); ult.p = p; }
      else termCola.push({ t: texto.slice(ini, i), p: p, aparte: !!aparte });
    }
    enviarEscritura();
  }

  var retardoTerm = function (fallas) { return fallas ? Math.min(4000, 250 * Math.pow(2, fallas - 1)) : 0; };
  var botonesTerm = function () { $('term-enviar').disabled = $('term-ajustar').disabled = termCerrada || termParada; };

  // Lo que llegue de un pedido de mirar anterior a esto ya no vale: se compara termGen.
  function soltarMirar() {
    termGen++;
    clearTimeout(termMirarTimer);
    clearTimeout(termWatchdog);
    if (termCtl) { try { termCtl.abort(); } catch (e) { /* ya estaba cortado */ } termCtl = null; }
    termMirando = false;
  }

  function soltarEscribir() {
    termEscTok++;
    clearTimeout(termEscTimer);
    termEscTimer = null;
    clearTimeout(termEscWatchdog);
    if (termEscCtl) { try { termEscCtl.abort(); } catch (e) { /* ya estaba cortado */ } termEscCtl = null; }
    termEscribiendo = false;
  }

  function aplicarTam(j) {
    var cambio = !termTam || termTam.cols !== j.cols || termTam.rows !== j.rows;
    if (cambio) { termTam = { cols: j.cols, rows: j.rows }; encajar(); }
    return cambio;
  }

  function aplicarEstado(j) {
    termAjustado = j.ajustado;
    $('term-ajustar').setAttribute('aria-pressed', termAjustado ? 'true' : 'false');
    $('term-ajustar').textContent = termAjustado ? 'Tamaño de la PC' : 'Ajustar al celu';
    termCerrada = !j.viva;
    avisoTerm(termCerrada ? 'La terminal está cerrada en la PC. Abrila ahí para seguir desde acá.' : termNota);
    botonesTerm();
  }

  var tipoDeError = function (err) {
    var m = err && err.message;
    return m === 'grande' || m === 'sello' ? m : m === 'http 429' ? 'ocupada' : 'red';
  };

  function rechazoDeLaPc(j) {
    termCerrada = true;
    termCola = [];
    termTamPend = null;
    avisoTerm(j && j.error === 'reloj' ? HORA_CORRIDA : (j && j.error) || 'La PC no dejó abrir la terminal.');
    botonesTerm();
  }

  function falloMirar(tipo) {
    termMas = false;
    termFallas++;
    termPausa = retardoTerm(termFallas);
    if (tipo === 'red' || tipo === 'ocupada') {
      termTipo = '';
      termIguales = 0;
      if (termFallas >= 2) avisoTerm(tipo === 'ocupada' ? 'La PC está ocupada. Reintentando…' : 'Sin conexión con la PC. Reintentando…');
      return;
    }
    // La PC sí contestó: lo que se mira no cambia nada allá, se pide de nuevo desde el mismo punto.
    termIguales = tipo === termTipo ? termIguales + 1 : 1;
    termTipo = tipo;
    var motivo = tipo === 'grande' ? 'La respuesta de la PC era demasiado grande para el celu.' : 'No pude leer la respuesta de la PC.';
    if (termIguales >= TERM_IGUALES) {
      termParada = true;
      termCola = [];
      termTamPend = null;
      avisoTerm(motivo + ' Volvé a las sesiones y abrí la terminal de nuevo.');
    } else avisoTerm(motivo + ' Reintentando…');
  }

  function programarMirar() {
    if (termParada) return;
    if (termPausa > 0) termMirarTimer = setTimeout(mirar, termPausa);
    else mirar();
  }

  function mirar() {
    clearTimeout(termMirarTimer);
    if (!termId || !term || termMirando || termParada || document.hidden) return;
    var id = termId, gen = termGen;
    var espera = termDesde < 0 || termMas ? 0 : TERM_ESPERA;
    var ctl = window.AbortController ? new AbortController() : null;
    var t0 = Date.now();
    termCtl = ctl;
    termMirando = true;
    termWatchdog = setTimeout(function () {
      if (gen !== termGen) return;
      soltarMirar();
      falloMirar('red');
      programarMirar();
    }, espera + TERM_MARGEN);
    pedirApi('/api/terminal', { id: id, desde: termDesde, espera: espera, sesion: TERM_SESION }, ctl ? ctl.signal : null)
      .then(function (r) {
        if (gen !== termGen) return null;
        if (r.status === 401) { cerrarTerminal(false); consultar(); return null; }
        if (!r.json) throw new Error('http ' + r.status);
        return r.json().then(function (j) { return { r: r, j: j }; });
      })
      .then(function (x) {
        if (!x || gen !== termGen) return;
        termFallas = 0;
        termTipo = '';
        termIguales = 0;
        termPausa = 0;
        if (!x.r.ok) {
          rechazoDeLaPc(x.j);
          termPausa = 2000;
          return;
        }
        var j = x.j;
        // Primero el tamaño: lo que llega se dibujó para ese ancho.
        var cambio = aplicarTam(j);
        if (j.reinicio) term.reset();
        if (j.datos) term.write(j.datos, cambio || j.reinicio ? function () { term.scrollToBottom(); } : undefined);
        termDesde = j.hasta;
        termMas = !!j.mas;
        aplicarEstado(j);
        // Una respuesta vacía casi enseguida (la PC soltó la espera) no puede volverse un lazo apretado.
        if (termCerrada) termPausa = 2000;
        else if (espera > 0 && !j.datos && !j.reinicio && !j.mas && !cambio && Date.now() - t0 < 400) termPausa = 500;
      }, function (err) {
        if (gen !== termGen) return;
        falloMirar(tipoDeError(err));
      })
      .then(function () {
        if (gen !== termGen) return;
        clearTimeout(termWatchdog);
        termCtl = null;
        termMirando = false;
        botonesTerm();
        programarMirar();
      });
  }

  function quitarEscrito(item) {
    if (termTamPend === item) termTamPend = null;
    else if (termCola[0] === item) termCola.shift();
  }

  function programarEscritura() {
    if (!termEscFallas) enviarEscritura();
    else termEscTimer = setTimeout(function () { termEscTimer = null; enviarEscritura(); }, retardoTerm(termEscFallas));
  }

  function falloEscribir(tipo) {
    termEscFallas++;
    if (termEscFallas >= 2) avisoTerm(tipo === 'ocupada' ? 'La PC está ocupada. Reintentando…' : 'Sin conexión con la PC. Reintentando…');
  }

  // Un pedido por vez y en orden. Mientras no haya respuesta el item sigue en la cola con su número: si la
  // red falla se reenvía igual y la PC, que ya lo hizo, no lo repite.
  function enviarEscritura() {
    // Con un reintento esperando su backoff, teclear más no lo adelanta.
    if (termEscTimer || !termId || !term || termEscribiendo || termParada || termCerrada || document.hidden) return;
    // Lo que ya salió con número y no se confirmó va primero: la PC descarta un número menor que el último que hizo,
    // así que si un «Ajustar» se numerara antes, las teclas pendientes se perderían sin aviso.
    var sinConfirmar = termCola[0] && termCola[0].n ? termCola[0] : termTamPend && termTamPend.n ? termTamPend : null;
    var item = sinConfirmar || termTamPend || termCola[0];
    if (!item) return;
    if (!item.n) {
      item.n = ++termN;
      item.env = Date.now();
    } else if (Date.now() - item.env > TERM_ESCRITURA_MAX_MS) {
      quitarEscrito(item);
      termEscFallas = 0;
      if (item.t) termNota = 'No sé si llegó lo último que escribiste desde el celu. Revisá la terminal.';
      avisoTerm(termNota);
      enviarEscritura();
      return;
    }
    var pedido = { id: termId, desde: termDesde, soloEscribir: true, sesion: TERM_SESION, n: item.n };
    if (item.tam) pedido.tam = item.tam;
    else pedido.escribir = item.t;
    var tok = ++termEscTok;
    var ctl = window.AbortController ? new AbortController() : null;
    termEscCtl = ctl;
    termEscribiendo = true;
    termEscWatchdog = setTimeout(function () {
      if (tok !== termEscTok) return;
      soltarEscribir();
      falloEscribir('red');
      programarEscritura();
    }, TERM_ESCRIBIR_MAX);
    pedirApi('/api/terminal', pedido, ctl ? ctl.signal : null)
      .then(function (r) {
        if (tok !== termEscTok) return null;
        if (r.status === 401) { cerrarTerminal(false); consultar(); return null; }
        if (!r.json) throw new Error('http ' + r.status);
        return r.json().then(function (j) { return { r: r, j: j }; });
      })
      .then(function (x) {
        if (!x || tok !== termEscTok) return;
        termEscFallas = 0;
        if (!x.r.ok) { rechazoDeLaPc(x.j); return; }
        termNota = '';
        quitarEscrito(item);
        aplicarTam(x.j);
        aplicarEstado(x.j);
      }, function (err) {
        if (tok !== termEscTok) return;
        if (err && (err.message === 'grande' || err.message === 'sello')) {
          // La PC sí contestó (y ya escribió lo que iba): no se reenvía, o se escribiría dos veces.
          quitarEscrito(item);
          avisoTerm('No pude leer la respuesta de la PC: puede que lo último que escribiste no haya llegado.');
        } else falloEscribir(tipoDeError(err));
      })
      .then(function () {
        if (tok !== termEscTok) return;
        clearTimeout(termEscWatchdog);
        termEscCtl = null;
        termEscribiendo = false;
        programarEscritura();
      });
  }

  function reanudarTerm() {
    if (!termId || !term) return;
    soltarMirar();
    clearTimeout(termEscTimer);
    termEscTimer = null;
    mirar();
    enviarEscritura();
  }

  function abrirTerminal(id, nombre) {
    soltarMirar();
    soltarEscribir();
    termId = id;
    termDesde = -1;
    termCola = [];
    termTamPend = null;
    termTam = null;
    termCerrada = false;
    termFallas = 0;
    termEscFallas = 0;
    termPausa = 0;
    termMas = false;
    termParada = false;
    termTipo = '';
    termIguales = 0;
    termNota = '';
    $('term-nombre').textContent = nombre;
    $('term').hidden = false;
    $('term-enviar').disabled = $('term-ajustar').disabled = false;
    avisoTerm('Abriendo la terminal…');
    if (!conHistoria) {
      conHistoria = true;
      window.addEventListener('popstate', function () { if (termId) cerrarTerminal(true); });
    }
    try { history.pushState({ terminal: id }, ''); } catch (e) { /* sin historial */ }
    cargarXterm().then(function () {
      if (termId !== id) return;
      if (!term) {
        term = new window.Terminal({
          fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Mono", Menlo, monospace',
          fontSize: 12, scrollback: 5000, cursorBlink: true,
          theme: { background: '#0B0D10', foreground: '#E8EAED', cursor: '#8CC2FF', selectionBackground: '#2A3A4F' }
        });
        term.open($('term-pantalla'));
        term.onData(function (d) { encolar(d, false); });
        window.addEventListener('resize', encajar);
      } else term.reset();
      mirar();
      enviarEscritura();
    }, function () { avisoTerm('No se pudo cargar la terminal. Revisá la conexión con la PC.'); });
  }

  function cerrarTerminal(desdeHistoria) {
    if (!termId) return;
    var id = termId;
    if (termAjustado) pedirApi('/api/terminal', { id: id, desde: termDesde, tam: 'pc', soloEscribir: true, sesion: TERM_SESION, n: ++termN }).then(null, function () { /* la PC lo devuelve sola al rato */ });
    termId = null;
    termAjustado = false;
    termCola = [];
    termTamPend = null;
    soltarMirar();
    soltarEscribir();
    $('term').hidden = true;
    if (!desdeHistoria) { try { history.back(); } catch (e) { /* sin historial */ } }
  }

  $('term-volver').addEventListener('click', function () { cerrarTerminal(false); });
  $('term-ajustar').addEventListener('click', function () {
    if (!termId || !term) return;
    termTamPend = { tam: termAjustado ? 'pc' : tamDelCelu(), n: 0 };
    enviarEscritura();
  });
  if (document.querySelectorAll) {
    [].forEach.call(document.querySelectorAll('[data-tecla]'), function (b) {
      b.addEventListener('click', function () { encolar(TECLAS[b.getAttribute('data-tecla')], true); });
    });
  }
  $('term-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var t = $('term-texto');
    if (!t.value) { encolar('\\r', true); return; }
    // El Enter va en otro pedido: pegado al texto, Claude lo toma como parte de lo pegado y no lo manda.
    encolar(t.value.replace(/\\r?\\n/g, '\\r'), true);
    encolar('\\r', true);
    t.value = '';
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { clearTimeout(timer); soltarMirar(); clearTimeout(termEscTimer); termEscTimer = null; }
    else { consultar(); reanudarTerm(); }
  });
  window.addEventListener('online', reanudarTerm);
  window.addEventListener('pageshow', reanudarTerm);
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
