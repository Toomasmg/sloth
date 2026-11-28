(function () {
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
  // La clave del QR solo sirve para pedir entrar: este celu genera la suya y la PC la acepta cuando alguien toca «Dejar entrar».
  var remota = viejo === 'remoto' || !!window.slothFetch;
  if (enlace) {
    if (window.slothSello.abrirClave(enlace)) guardar(remota ? 'sloth-clave' : 'sloth-qr', enlace);
    else enlaceMalo = true;
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* sin historial */ }
  }
  var qr = remota || enlaceMalo ? null : leer('sloth-qr');
  var token = viejo === 'remoto' ? viejo : (enlaceMalo ? null : (remota && enlace) || leer('sloth-clave'));
  if (viejo && viejo !== 'remoto') guardar('sloth-token', null);
  var cuentaElegida = leer('sloth-cuenta');
  var ultimo = null, desfase = 0, ultimoOk = 0, timer = null, avisoHora = false;

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
  var haceTexto = function (ms) { var h = hace(ms); return h === 'recién' ? h : 'hace ' + h; };
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
    // Abajo del porcentaje: la aguja barre de 150° a 390° y nunca baja de y=130, así no tacha el rótulo.
    var tag = svg('text', { x: 100, y: 172, 'text-anchor': 'middle', fill: '#9AA0A6', 'font-size': 11, 'font-weight': 600, 'letter-spacing': 2, 'font-family': 'Inter, sans-serif' });
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

  var colorDe = function (f) { return f >= 0.85 ? '#FF6B5B' : f >= 0.6 ? '#FFB547' : '#7CC4FF'; };
  function pintarReloj(r, v, nombreLargo, quien) {
    var antes = quien ? quien + ' · ' : '';
    if (!v) {
      r.valor.setAttribute('stroke-dasharray', '0 ' + CIRC);
      r.valor.setAttribute('opacity', '0');
      r.aguja.style.transform = 'rotate(150deg)';
      r.aguja.setAttribute('opacity', '0.35');
      r.pct.textContent = '—';
      r.pie.textContent = antes + 'Sin datos todavía';
      r.s.setAttribute('aria-label', nombreLargo + ': sin datos todavía. Aparece cuando Claude responda en esta cuenta.');
      return;
    }
    var f = Math.max(0, Math.min(1, v.pct / 100));
    var color = colorDe(f);
    r.valor.setAttribute('stroke', color);
    r.valor.setAttribute('opacity', '1');
    r.valor.setAttribute('stroke-dasharray', (ARCO * f).toFixed(1) + ' ' + CIRC);
    r.aguja.style.transform = 'rotate(' + (150 + 240 * f).toFixed(1) + 'deg)';
    r.aguja.setAttribute('opacity', '1');
    r.pct.textContent = Math.round(v.pct) + '%';
    var texto = reinicio(v.reiniciaEn);
    r.pie.textContent = antes + texto;
    r.s.setAttribute('aria-label', nombreLargo + ': ' + Math.round(v.pct) + ' % usado. ' + texto);
  }

  var TODAS = 'todas';
  var FILTROS = { waiting: 'Te necesita', done: 'Terminaron', working: 'Trabajando' };
  var filtroEstado = null;
  var nombreCuenta = function (e, id) { var c = e.cuentas.filter(function (x) { return x.id === id; })[0]; return c ? c.nombre : ''; };
  var cuentasEnVista = function (e) { return cuentaElegida === TODAS ? e.cuentas : e.cuentas.filter(function (c) { return c.id === cuentaElegida; }); };
  // Con una cuenta (o ninguna con datos) no hay selector: se ven todas las sesiones, aunque alguna sea de una cuenta que no vino.
  var deLaCuenta = function (e) { return cuentaElegida === TODAS || e.cuentas.length < 2 ? e.sesiones : e.sesiones.filter(function (s) { return s.cuentaId === cuentaElegida; }); };
  var pctDe = function (v) { return v ? v.pct : -1; };

  function pintarCuentas(e) {
    var cont = $('cuentas');
    var varias = e.cuentas.length > 1;
    var existe = e.cuentas.some(function (c) { return c.id === cuentaElegida; });
    if (cuentaElegida === TODAS ? !varias : !existe) cuentaElegida = varias ? TODAS : (e.cuentas[0] || { id: null }).id;
    cont.textContent = '';
    cont.hidden = !varias;
    [{ id: TODAS, nombre: 'Todas' }].concat(e.cuentas).forEach(function (c) {
      var b = el('button', '', c.nombre);
      b.type = 'button';
      b.setAttribute('aria-pressed', c.id === cuentaElegida ? 'true' : 'false');
      b.addEventListener('click', function () { cuentaElegida = c.id; guardar('sloth-cuenta', c.id); pintar(); });
      cont.appendChild(b);
    });
    var enVista = cuentasEnVista(e);
    // Acostado entran dos relojes: con «Todas», los de la cuenta más cerca del límite de 5 h.
    var actual = enVista.slice().sort(function (a, b) { return pctDe(b.cincoHoras) - pctDe(a.cincoHoras); })[0];
    var quien = cuentaElegida === TODAS && actual ? actual.nombre : '';
    pintarReloj(relojes.g5, actual && actual.cincoHoras, 'Límite de 5 horas' + (quien ? ' de ' + quien : ''), quien);
    pintarReloj(relojes.g7, actual && actual.semana, 'Límite semanal' + (quien ? ' de ' + quien : ''), quien);
    var hoy = enVista.filter(function (c) { return c.hoy; });
    var tk = 0, msj = 0;
    hoy.forEach(function (c) { tk += c.hoy.tokens; msj += c.hoy.mensajes; });
    $('hoy').textContent = !hoy.length ? 'Hoy: sin datos' : !tk && !msj ? 'Hoy: sin uso todavía' : 'Hoy: ' + tokens(tk) + ' tokens · ' + msj + (msj === 1 ? ' mensaje' : ' mensajes');
    deslizar();
  }

  // Si las cuentas no entran, el borde derecho se desvanece: hay más deslizando.
  function deslizar() {
    var c = $('cuentas');
    c.classList.toggle('desliza', c.scrollWidth > c.clientWidth + 1 && c.scrollLeft + c.clientWidth < c.scrollWidth - 1);
  }
  $('cuentas').addEventListener('scroll', deslizar);

  function ventanaCompacta(nombre, v) {
    var cel = el('div', 'lim-v');
    cel.appendChild(el('span', 'lim-n', nombre));
    var barra = el('span', 'barra');
    var relleno = el('i');
    if (v) {
      var f = Math.max(0, Math.min(1, v.pct / 100));
      relleno.style.width = (f * 100).toFixed(1) + '%';
      relleno.style.background = colorDe(f);
    }
    barra.appendChild(relleno);
    cel.appendChild(barra);
    cel.appendChild(el('span', 'lim-pct', v ? Math.round(v.pct) + ' %' : '—'));
    return cel;
  }

  // Parado, los límites van en una franja (una fila por cuenta) para que lo urgente quede arriba sin bajar.
  function pintarLimites(e) {
    var cont = $('limites');
    cont.textContent = '';
    var lista = cuentasEnVista(e);
    cont.hidden = !lista.length;
    var varias = lista.length > 1;
    var cuando = function (nombre, v) {
      if (!v) return nombre + ' sin datos';
      var r = reinicio(v.reiniciaEn);
      return nombre + ' ' + r.charAt(0).toLowerCase() + r.slice(1);
    };
    var pct = function (v) { return v ? Math.round(v.pct) + ' % usado' : 'sin datos'; };
    lista.forEach(function (c) {
      var fila = el('div', varias ? 'lim con-cuenta' : 'lim');
      if (varias) fila.appendChild(el('span', 'lim-cuenta', c.nombre));
      fila.appendChild(ventanaCompacta('5 h', c.cincoHoras));
      fila.appendChild(ventanaCompacta('Semana', c.semana));
      var pie = !c.cincoHoras && !c.semana ? 'Sin datos todavía: aparecen cuando Claude responda en esta cuenta.' : cuando('5 h', c.cincoHoras) + ' · ' + cuando('Semana', c.semana);
      if (!varias) fila.appendChild(el('span', 'lim-pie', pie));
      fila.setAttribute('role', 'img');
      fila.setAttribute('aria-label', c.nombre + '. Límite de 5 horas: ' + pct(c.cincoHoras) + '. Semanal: ' + pct(c.semana) + '. ' + pie);
      cont.appendChild(fila);
    });
  }

  function botonTerminal(e, s) {
    var enWifi = e.terminal && !window.slothFetch;
    var soloWifi = !!window.slothFetch && !!e.terminalEnWifi;
    if (!(enWifi || soloWifi) || s.estado === 'exited') return null;
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
    return bt;
  }

  function textoError(error) {
    if (error === 'reloj') return HORA_CORRIDA;
    if (error === 'repetido') return 'No se pudo responder. Probá de nuevo.';
    return error;
  }

  // Cada pedido con su tarjeta y sus botones: se puede responder cualquiera, no solo el primero.
  var enviandoId = null, errores = {}, expandidos = {}, confirmar = { id: null, hasta: 0 }, respondidos = [], vistos = {}, firmaPedidos = '';
  var CONFIRMAR_MS = 5000, LARGO_MAX = 300, LINEAS_MAX = 6;
  var confirmando = function (p) { return confirmar.id === p.id && Date.now() < confirmar.hasta; };
  var esLargo = function (p) { return p.texto.length > LARGO_MAX || p.texto.split(String.fromCharCode(10)).length > LINEAS_MAX; };

  function anunciar(texto) {
    var a = $('aviso-nuevo');
    a.textContent = '';
    setTimeout(function () { a.textContent = texto; }, 50);
  }

  function decidir(p, decision) {
    if (enviandoId) return;
    enviandoId = p.id;
    delete errores[p.id];
    pintar();
    pedirApi('/api/permiso', { id: p.id, decision: decision })
      .then(function (r) {
        if (r.ok) return null;
        return r.json().then(function (j) { return j && j.error ? textoError(j.error) : 'No se pudo responder.'; }, function () { return 'No se pudo responder.'; });
      })
      .then(function (err) {
        if (err) { errores[p.id] = err; return; }
        respondidos.unshift({ aprobado: decision === 'allow', sesion: p.sesion, texto: p.texto, hora: Date.now() });
        respondidos = respondidos.slice(0, 3);
        anunciar((decision === 'allow' ? 'Aprobado: ' : 'Rechazado: ') + p.sesion);
      }, function () { errores[p.id] = 'Sin conexión con la PC. Probá de nuevo.'; })
      .then(function () { enviandoId = null; confirmar.id = null; consultar(); });
  }

  function tarjetaPedido(e, p, i) {
    var li = el('li', 'pedido' + (p.destructivo ? ' destructivo' : ''));
    var cab = el('div', 'p-cab');
    var ses = e.sesiones.filter(function (s) { return s.id === p.sesionId; })[0];
    var cuenta = e.cuentas.length > 1 && ses ? '  ·  ' + nombreCuenta(e, ses.cuentaId) : '';
    cab.appendChild(el('span', 'p-nombre', p.sesion + cuenta));
    cab.appendChild(el('span', 'p-hace', hace(ahoraPc() - p.desde)));
    li.appendChild(cab);
    li.appendChild(el('span', 'p-titulo', (p.titulo || 'Claude pide permiso') + (e.pedidos.length > 1 ? '  ·  ' + (i + 1) + ' de ' + e.pedidos.length : '')));
    if (p.destructivo) li.appendChild(el('span', 'p-marca', 'Destructivo: ' + p.destructivo));
    var largo = esLargo(p), abierto = !!expandidos[p.id];
    li.appendChild(el('pre', 'p-cmd' + (largo && !abierto ? ' corto' : ''), p.texto));
    if (largo) {
      var ver = el('button', 'p-ver', abierto ? 'Ver menos' : 'Ver todo (' + p.texto.length + ' caracteres)');
      ver.type = 'button';
      ver.setAttribute('aria-expanded', abierto ? 'true' : 'false');
      ver.addEventListener('click', function () { expandidos[p.id] = !abierto; pintar(); });
      li.appendChild(ver);
    }
    if (e.aprobar) {
      var botones = el('div', 'p-botones');
      var no = el('button', 'b-rechazar', 'Rechazar');
      var dos = confirmando(p);
      var si = el('button', p.destructivo ? 'b-aprobar-peligro' : 'b-aprobar', enviandoId === p.id ? 'Enviando…' : dos ? 'Tocá de nuevo para aprobar' : 'Aprobar');
      no.type = si.type = 'button';
      no.disabled = !!enviandoId;
      // Lo que no se vio entero no se aprueba: primero «Ver todo».
      si.disabled = !!enviandoId || (largo && !abierto) || !!p.cortado;
      no.addEventListener('click', function () { decidir(p, 'deny'); });
      si.addEventListener('click', function () {
        if (p.destructivo && !confirmando(p)) {
          confirmar = { id: p.id, hasta: Date.now() + CONFIRMAR_MS };
          pintar();
          setTimeout(pintar, CONFIRMAR_MS + 50);
          return;
        }
        decidir(p, 'allow');
      });
      botones.appendChild(no);
      botones.appendChild(si);
      li.appendChild(botones);
      if (p.cortado) li.appendChild(el('span', 'p-nota', 'Es demasiado largo para verlo entero en el celu: para aprobarlo, respondelo en la PC.'));
      else if (largo && !abierto) li.appendChild(el('span', 'p-nota', 'Para aprobar, mirá el pedido entero con «Ver todo».'));
      else if (dos) li.appendChild(el('span', 'p-nota', 'Es destructivo: tocá «Aprobar» otra vez en 5 s para confirmarlo.'));
    } else if (i === 0) {
      li.appendChild(el('span', 'p-nota', 'Respondelo en la PC. Para hacerlo desde acá, prendé «Aprobar desde el celu» en Sloth.'));
    }
    if (errores[p.id]) li.appendChild(el('span', 'p-error', errores[p.id]));
    return li;
  }

  function pintarPedidos(e) {
    var nuevos = e.pedidos.filter(function (p) { return !vistos[p.id]; });
    e.pedidos.forEach(function (p) { vistos[p.id] = true; });
    if (nuevos.length) anunciar(nuevos.length === 1 ? 'Pedido de permiso en ' + nuevos[0].sesion + ': ' + (nuevos[0].titulo || nuevos[0].texto) + (nuevos[0].destructivo ? '. Destructivo.' : '.') : nuevos.length + ' pedidos de permiso nuevos.');
    // Se rearma solo si cambió algo: rearmar cada 1,5 s le saca el foco al botón que se está por tocar.
    var firma = JSON.stringify([e.aprobar, e.cuentas.length, enviandoId, confirmar.id && confirmando({ id: confirmar.id }) ? confirmar.id : null, expandidos, errores, e.pedidos.map(function (p) { return [p.id, p.texto, p.destructivo, hace(ahoraPc() - p.desde)]; })]);
    if (firma !== firmaPedidos) {
      firmaPedidos = firma;
      var cont = $('pedidos');
      cont.textContent = '';
      e.pedidos.forEach(function (p, i) { cont.appendChild(tarjetaPedido(e, p, i)); });
    }
    var lista = $('respondidos');
    lista.textContent = '';
    respondidos.filter(function (r) { return Date.now() - r.hora < 15 * 60000; }).forEach(function (r) {
      var hora = new Date(r.hora).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
      var li = el('li', r.aprobado ? 'r-si' : 'r-no', (r.aprobado ? '✓ Aprobaste' : '✕ Rechazaste') + ' a las ' + hora + ' · ' + r.sesion + ' · ' + r.texto);
      lista.appendChild(li);
    });
  }

  // «Te necesita» sin pedido de permiso: Claude preguntó algo o espera que sigas. Va arriba, con el mensaje entero.
  function pintarEsperan(e) {
    var cont = $('esperan');
    cont.textContent = '';
    var conPedido = {};
    e.pedidos.forEach(function (p) { conPedido[p.sesionId] = true; });
    var esperan = e.sesiones.filter(function (s) { return s.estado === 'waiting' && !conPedido[s.id]; });
    var nuevas = esperan.filter(function (s) { return !vistos[s.id + ':' + s.desde]; });
    esperan.forEach(function (s) { vistos[s.id + ':' + s.desde] = true; });
    if (nuevas.length) anunciar(nuevas.map(function (s) { return s.nombre + ' te necesita'; }).join('. ') + '.');
    esperan.forEach(function (s) {
      var li = el('li');
      var cab = el('div', 'e-cab');
      cab.appendChild(el('span', 'e-nombre', s.nombre));
      cab.appendChild(el('span', 'e-hace', hace(ahoraPc() - s.desde)));
      li.appendChild(cab);
      if (e.cuentas.length > 1) li.appendChild(el('span', 'e-cuenta', nombreCuenta(e, s.cuentaId)));
      li.appendChild(el('span', 'e-msj', s.detalle || 'Claude espera tu respuesta.'));
      li.appendChild(botonTerminal(e, s) || el('span', 'e-nota', 'Respondé en la PC.'));
      cont.appendChild(li);
    });
    var hay = e.pedidos.length > 0 || esperan.length > 0;
    $('calma').hidden = hay;
    if (!hay) {
      var ultimaListo = e.sesiones.filter(function (s) { return s.estado === 'done'; })[0];
      $('calma-s').textContent = ultimaListo ? ultimaListo.nombre + ' terminó ' + haceTexto(ahoraPc() - ultimaListo.desde) : 'Ningún permiso ni pregunta pendiente.';
    }
  }

  function pintarLista(e) {
    var lista = $('lista');
    lista.textContent = '';
    // La de la tarjeta de arriba (el pedido o, si no hay, la primera que espera) va al final: acostado se oculta.
    var conPedido = e.pedidos[0] ? e.pedidos[0].sesionId : null;
    if (!conPedido) conPedido = (e.sesiones.filter(function (s) { return s.estado === 'waiting'; })[0] || { id: null }).id;
    var base = deLaCuenta(e);
    var visibles = filtroEstado ? base.filter(function (s) { return s.estado === filtroEstado; }) : base;
    var conCuenta = e.cuentas.length > 1 && cuentaElegida === TODAS;
    if (!e.sesiones.length) lista.appendChild(el('li', 'vacio', 'No hay espacios abiertos en la PC.'));
    else if (!visibles.length) lista.appendChild(el('li', 'vacio', filtroEstado ? 'Ninguna sesión en «' + FILTROS[filtroEstado] + '»' + (cuentaElegida === TODAS ? '' : ' en esta cuenta') + '.' : 'Esta cuenta no tiene espacios abiertos.'));
    var orden = visibles.filter(function (s) { return s.id !== conPedido; }).concat(visibles.filter(function (s) { return s.id === conPedido; }));
    orden.forEach(function (s) {
      var st = ESTADOS[s.estado] || ESTADOS.idle;
      var li = el('li', s.id === conPedido ? 'del-pedido' : '');
      var punto = el('span', 'punto');
      punto.style.background = st.c;
      var texto = el('div', 's-texto');
      texto.appendChild(el('span', 's-nombre', s.nombre));
      var partes = [];
      if (conCuenta) partes.push(nombreCuenta(e, s.cuentaId));
      if (s.detalle) partes.push(s.detalle);
      if (partes.length) texto.appendChild(el('span', 's-detalle', partes.join(' · ')));
      var lado = el('div', 's-lado');
      var chip = el('span', 's-estado', st.t);
      chip.style.color = st.c;
      chip.style.background = st.f;
      lado.appendChild(chip);
      lado.appendChild(el('span', 's-hace', hace(ahoraPc() - s.desde)));
      li.appendChild(punto);
      li.appendChild(texto);
      li.appendChild(lado);
      var bt = botonTerminal(e, s);
      if (bt) li.appendChild(bt);
      lista.appendChild(li);
    });
    var n = function (k) { return base.filter(function (s) { return s.estado === k; }).length; };
    $('n-espera').textContent = n('waiting');
    $('f-waiting').classList.toggle('hay', n('waiting') > 0);
    $('n-listo').textContent = n('done');
    $('n-trabaja').textContent = n('working');
    for (var k in FILTROS) $('f-' + k).setAttribute('aria-pressed', filtroEstado === k ? 'true' : 'false');
    $('term-nota').hidden = !(window.slothFetch && e.terminalEnWifi);
    var abiertas = e.sesiones.length + (e.sesiones.length === 1 ? ' abierta' : ' abiertas');
    $('resumen').textContent = !e.sesiones.length ? '' : visibles.length === e.sesiones.length ? abiertas : visibles.length + ' de ' + abiertas;
  }
  // Acostado la lista tiene el alto que sobra: se muestran las filas que entran enteras y el resto se cuenta.
  function recortarLista() {
    var lista = $('lista'), mas = $('lista-mas');
    var filas = lista.children ? Array.prototype.slice.call(lista.children) : [];
    filas.forEach(function (li) { li.classList.remove('fuera'); });
    mas.hidden = true;
    if (!esHorizontal() || !filas.length || !lista.getBoundingClientRect) return;
    var desbordan = function () {
      var fondo = lista.getBoundingClientRect().bottom + 0.5;
      return filas.filter(function (li) { return li.offsetParent !== null && li.getBoundingClientRect().bottom > fondo; });
    };
    if (!desbordan().length) return;
    mas.hidden = false;
    mas.textContent = '+';
    desbordan().forEach(function (li) { li.classList.add('fuera'); });
    var n = filas.filter(function (li) { return li.classList.contains('fuera'); }).length;
    mas.textContent = '+' + n + ' más · parado se ven todas';
  }
  window.addEventListener('resize', function () { recortarLista(); deslizar(); });

  Object.keys(FILTROS).forEach(function (k) {
    $('f-' + k).addEventListener('click', function () { filtroEstado = filtroEstado === k ? null : k; pintar(); });
  });

  function pintarConexion() {
    var c = $('conexion');
    var t = $('conexion-texto');
    var lejos = Date.now() - ultimoOk;
    c.classList.toggle('ok', !avisoHora && !!ultimoOk && lejos < 6000);
    c.classList.toggle('mal', avisoHora || !ultimoOk || lejos >= 6000);
    if (avisoHora) t.textContent = HORA_CORRIDA;
    else if (!ultimoOk) t.textContent = 'Buscando la PC…';
    else if (lejos < 6000) t.textContent = 'PC conectada';
    else t.textContent = 'Sin conexión con la PC · ' + haceTexto(lejos);
  }

  function pintar() {
    pintarConexion();
    if (!ultimo) return;
    pintarCuentas(ultimo);
    pintarLimites(ultimo);
    pintarPedidos(ultimo);
    pintarEsperan(ultimo);
    pintarLista(ultimo);
    recortarLista();
  }

  var perdioEscrito = false;
  function sinToken(titulo, texto) {
    $('app').hidden = true;
    $('sin-token').hidden = false;
    if (titulo) $('sin-token-titulo').textContent = titulo;
    if (texto) $('sin-token-texto').textContent = texto + (perdioEscrito ? ' Lo que escribiste en la terminal y no había llegado a la PC se perdió.' : '');
  }

  function consultar() {
    clearTimeout(timer);
    if (qr) return emparejar();
    if (!token) return enlaceMalo ? sinToken('No se pudo conectar', 'El QR no se leyó bien: escanealo de nuevo, de cerca y con buena luz.') : viejo ? sinToken('Hay que volver a conectar este celu', 'Escaneá el QR de nuevo en Sloth.') : sinToken();
    pedirApi('/api/estado')
      .then(function (r) {
        if (r.status === 401) {
          guardar('sloth-token', null);
          guardar('sloth-clave', null);
          token = null;
          sinToken('Este celu ya no tiene acceso', 'Lo sacaron desde la PC, se regeneró el código o pasó un mes sin usarse. Escaneá el QR de Sloth para pedir entrar de nuevo.');
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

  var PAR_CADA_MS = 2000, parPidio = false;
  // 32 bytes al azar en base64url (43 letras), como las que arma la PC.
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function claveNueva() {
    var b = new Uint8Array(32), t = '';
    window.crypto.getRandomValues(b);
    for (var i = 0; i < 32; i += 3) {
      var n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
      t += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) + (i + 1 < 32 ? B64.charAt((n >> 6) & 63) : '') + (i + 2 < 32 ? B64.charAt(n & 63) : '');
    }
    return t;
  }
  function finEmparejar() {
    guardar('sloth-qr', null);
    guardar('sloth-par', null);
    qr = null;
    parPidio = false;
    $('emparejando').hidden = true;
  }
  function sinEntrar(titulo, texto) {
    finEmparejar();
    token = leer('sloth-clave');
    if (token) { consultar(); return; }
    sinToken(titulo, texto);
  }
  function entro(clave) {
    finEmparejar();
    guardar('sloth-clave', clave);
    token = clave;
    $('sin-token').hidden = true;
    $('app').hidden = false;
    consultar();
  }
  // Pide entrar con la clave del QR y después pregunta cada 2 s cómo va. Un celu que ya tenía clave la reusa: no suma otro a la lista.
  function emparejar() {
    clearTimeout(timer);
    var propia = leer('sloth-par') || leer('sloth-clave') || claveNueva();
    guardar('sloth-par', propia);
    token = qr;
    $('app').hidden = true;
    $('sin-token').hidden = true;
    $('emparejando').hidden = false;
    pedirApi('/api/emparejar', parPidio ? { clave: propia, consultar: true } : { clave: propia })
      .then(function (r) {
        if (r.status === 401) { guardar('sloth-par', null); sinEntrar('Este QR ya no sirve', 'En Sloth se regeneró el código. Escaneá el QR nuevo.'); return null; }
        if (!r.json) throw new Error('http ' + r.status);
        return r.json().then(function (j) {
          if (r.ok && j && j.ya === true) { entro(qr); return null; }
          if (r.status === 409 && j && j.error === 'reloj') { $('par-estado').textContent = HORA_CORRIDA; return true; }
          if (!r.ok) { guardar('sloth-par', null); sinEntrar('No se pudo pedir entrar', (j && j.error) || 'La PC no aceptó el pedido.'); return null; }
          if (j.codigo) $('par-codigo').textContent = j.codigo;
          parPidio = true;
          if (j.estado === 'listo') { entro(propia); return null; }
          if (j.estado === 'rechazado') { guardar('sloth-par', null); sinEntrar('No te dejaron entrar', 'En la PC tocaron «No». Si fue un error, escaneá el QR de nuevo.'); return null; }
          if (j.estado === 'vencido') { guardar('sloth-par', null); sinEntrar('Se venció el pedido', 'Pasaron 5 minutos sin respuesta en la PC. Escaneá el QR de nuevo.'); return null; }
          $('par-estado').textContent = 'Esperando la respuesta de la PC…';
          return true;
        });
      })
      .then(null, function () {
        $('par-estado').textContent = 'Sin conexión con la PC. Reintentando…';
        return true;
      })
      .then(function (seguir) { if (seguir && qr && !document.hidden) timer = setTimeout(emparejar, PAR_CADA_MS); });
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
  var TECLAS = {
    esc: '\x1b', escesc: ['\x1b', '\x1b'], tab: '\t', shifttab: '\x1b[Z', arriba: '\x1b[A', abajo: '\x1b[B', der: '\x1b[C', izq: '\x1b[D',
    ctrlc: '\x03', ctrld: '\x04', enter: '\r', barra: '/', inicio: '\x1b[H', fin: '\x1b[F', repag: '\x1b[5~', avpag: '\x1b[6~'
  };
  // Solo en memoria: lo que se le dice a Claude puede tener datos que no conviene dejar guardados en el celu.
  var TERM_HIST_MAX = 20, termHist = [], termHistI = -1;
  var TERM_MAX = 1500, TERM_ESPERA = 20000, TERM_MARGEN = 8000, TERM_ESCRIBIR_MAX = 10000;
  var term = null, termId = null, termDesde = -1, termCola = [], termTam = null;
  var termCerrada = false, xtermCargando = null, conHistoria = false;
  var termVista = 'pc', termHoriz = false, termAlto = 0, botonesTecla = [];
  var TERM_SEGUIR_INMEDIATO = 8000;
  var TERM_FUENTE_MIN = 8, TERM_FUENTE_MAX = 15, TERM_FUENTE_CELU = 13.5;
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

  // La terminal de la PC nunca cambia de tamaño: el celu solo elige cómo mirarla. «PC» muestra todas las columnas con la
  // letra que entre (con un piso legible; si ni así entran, se desliza de costado). «Celu» usa una letra cómoda y la
  // ventana recorre la pantalla de la PC. El texto no se reacomoda al ancho del celu: eso exigiría achicar la terminal de la PC.
  function encajar() {
    if (!term || !termTam) return;
    if (term.cols !== termTam.cols || term.rows !== termTam.rows) term.resize(termTam.cols, termTam.rows);
    var px = term.options.fontSize;
    for (var i = 0; i < 3; i++) {
      var c = celda();
      if (!c || !c.w) break;
      var nuevo = termVista === 'celu' ? TERM_FUENTE_CELU : Math.max(TERM_FUENTE_MIN, Math.min(TERM_FUENTE_MAX, Math.floor(px * anchoUtil() / (c.w * termTam.cols) * 10) / 10));
      if (Math.abs(nuevo - px) < 0.1) break;
      term.options.fontSize = px = nuevo;
    }
    seguirCursor();
  }

  // El cursor tiene que verse sin que la pantalla salte: solo se mueve lo que falta para que entre en la ventana.
  function seguirCursor() {
    if (!term || !termTam || !term.buffer) return;
    var c = celda(), p = $('term-pantalla'), s = p.querySelector('.xterm-screen');
    if (!c || !c.w || !s || !p.getBoundingClientRect) return;
    var b = term.buffer.active, pr = p.getBoundingClientRect(), sr = s.getBoundingClientRect();
    var x = sr.left - pr.left + p.scrollLeft + b.cursorX * c.w, y = sr.top - pr.top + p.scrollTop + b.cursorY * c.h;
    var mx = c.w * 2, my = c.h;
    if (x - mx < p.scrollLeft) p.scrollLeft = Math.max(0, x - mx);
    else if (x + c.w + mx > p.scrollLeft + p.clientWidth) p.scrollLeft = x + c.w + mx - p.clientWidth;
    if (y - my < p.scrollTop) p.scrollTop = Math.max(0, y - my);
    else if (y + c.h + my > p.scrollTop + p.clientHeight) p.scrollTop = y + c.h + my - p.clientHeight;
  }

  function alFondo() {
    if (!term) return;
    term.scrollToBottom();
    seguirCursor();
  }

  var esHorizontal = function () { return !!(window.matchMedia && window.matchMedia('(orientation: landscape)').matches); };
  var claveVista = function () { return 'sloth-term-vista-' + (termHoriz ? 'h' : 'v'); };
  function pintarVista() {
    var b = $('term-vista');
    b.textContent = termVista === 'celu' ? 'Vista celu' : 'Vista PC';
    b.setAttribute('data-vista', termVista);
    b.setAttribute('aria-label', termVista === 'celu' ? 'Vista celu. Tocá para ver la pantalla entera de la PC' : 'Vista PC. Tocá para ver con letra grande');
  }
  // La elección se recuerda por orientación: acostado conviene otra que parado.
  function elegirVista() {
    termVista = leer(claveVista()) === 'celu' ? 'celu' : 'pc';
    pintarVista();
  }

  // La terminal ocupa solo lo que se ve: con el teclado virtual abierto, la ventana visible es más baja que la página.
  function cajaVisible() {
    var el = $('term'), vv = window.visualViewport;
    el.style.top = (vv ? vv.offsetTop : 0) + 'px';
    el.style.height = (vv ? vv.height : window.innerHeight) + 'px';
    el.style.bottom = 'auto';
    var alto = vv ? vv.height : window.innerHeight;
    // Con poca altura (teclado abierto, celu acostado) no entran el cuadro y la botonera: queda el que se está usando.
    if (el.classList) el.classList.toggle('bajo', alto < 420);
    return alto;
  }

  function alCambiarVentana() {
    if (!termId || !term) return;
    var alto = cajaVisible();
    var h = esHorizontal();
    if (h !== termHoriz) { termHoriz = h; elegirVista(); }
    encajar();
    if (alto < termAlto) alFondo();
    termAlto = alto;
  }

  // Lo que sale de teclear en xterm no es todo del usuario: contesta solo a las consultas del programa (posición del
  // cursor, atributos, colores) y avisa foco y toques de mouse. A la terminal de la PC solo va lo que se tipeó.
  // Se deja pasar ESC[1;2R a ESC[1;8R (F3 con modificador: no se distingue de una posición en la fila 1) y la rueda del mouse
  // (ESC[<64;x;yM y ESC[<65;x;yM), que es el usuario deslizando en un programa que pidió mouse.
  var AUTOMATICAS = /(\x1b\[200~[\s\S]*?(?:\x1b\[201~|$))|\x1b\[[?>=]?[\d;:]*\$y|\x1b\[(?!1;[2-8]R)\??\d+;\d+R|\x1b\[[?>=][\d;]*c|\x1b\[\??\d+(?:;\d+)*n|\x1b\[\d+(?:;\d+)*t|\x1b\[[IO]|\x1b\[<(?!6[45];)\d+;\d+;\d+[Mm]|\x1b\[M[\x20-\uffff]{3}|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\/g;
  // Dos veces o más: al sacar una secuencia pueden juntarse los restos y formar otra.
  function sinAutomaticas(t) {
    for (var i = 0; i < 16; i++) {
      var r = t.replace(AUTOMATICAS, function (m, pegado) { return pegado ? m : ''; });
      if (r === t) break;
      t = r;
    }
    return t;
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
    pintarCola();
    enviarEscritura();
  }

  var retardoTerm = function (fallas) { return fallas ? Math.min(4000, 250 * Math.pow(2, fallas - 1)) : 0; };
  var botonesTerm = function () {
    for (var i = 0; i < botonesTecla.length; i++) botonesTecla[i].disabled = termCerrada || termParada;
    pintarCola();
  };

  // Lo que no llega se ve y se puede tirar: si no, con la red caída cada toque se acumula y sale todo junto al volver.
  var aVista = function (t) {
    return t.replace(/\r/g, '⏎').replace(/\x1b\[[\d;]*[A-Za-z~]|\x1b/g, '⎋').replace(/[\x00-\x1f\x7f]/g, '');
  };
  function pintarCola() {
    var hay = termCola.length > 0 && termEscFallas > 0 && !termCerrada && !termParada;
    $('term-cola').hidden = !hay;
    if (!hay) return;
    var t = '';
    for (var i = 0; i < termCola.length && t.length < 60; i++) t += aVista(termCola[i].t);
    if (t.length > 60) t = t.slice(0, 59) + '…';
    $('term-cola-texto').textContent = 'Sin llegar a la PC: ' + (t || 'teclas');
  }

  function descartarCola() {
    var viajaba = !!(termCola[0] && termCola[0].n);
    soltarEscribir();
    termCola = [];
    termEscFallas = 0;
    termNota = viajaba ? 'Descartado. Lo primero ya había salido: puede que haya llegado a la PC.' : '';
    avisoTerm(termNota);
    pintarCola();
  }

  function limpiarTexto(t) {
    return t.replace(/[\x00-\x1f\x7f]+/g, ' ');
  }

  // El cuadro propio deja usar el dictado y el autocorrector del celu, que en la terminal no andan. El Enter va
  // en otro pedido, igual que al tipear en la terminal, para que Claude no lo tome como parte de lo pegado.
  function mandarTexto() {
    var campo = $('term-texto');
    var t = limpiarTexto(campo.value || '');
    if (termCerrada || termParada || !termId || !t.trim()) return;
    encolar(t, true);
    encolar(TECLAS.enter, true);
    if (termHist[termHist.length - 1] !== t) termHist.push(t);
    if (termHist.length > TERM_HIST_MAX) termHist.shift();
    termHistI = -1;
    campo.value = '';
    $('term-hist').disabled = false;
  }

  // Cada toque trae uno más viejo; después del primero vuelve el cuadro vacío.
  function historialAnterior() {
    if (!termHist.length) return;
    termHistI = termHistI < 0 ? termHist.length - 1 : termHistI - 1;
    $('term-texto').value = termHistI < 0 ? '' : termHist[termHistI];
  }

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
        if (r.status === 401) { perdioEscrito = termCola.length > 0 || termEscribiendo; cerrarTerminal(false); consultar(); return null; }
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
        // Con la PC más ancha que el celu, lo que llega puede dejar el cursor fuera de la ventana: se lo sigue siempre. Con una pantalla
        // entera (la foto al abrir) medir el cursor en el callback fuerza un layout de más sobre miles de líneas: se hace un rato después.
        if (j.datos) {
          var grande = j.datos.length > TERM_SEGUIR_INMEDIATO;
          term.write(j.datos, function () {
            if (cambio || j.reinicio) term.scrollToBottom();
            if (grande) setTimeout(seguirCursor, 150); else seguirCursor();
          });
        }
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
    if (termCola[0] === item) termCola.shift();
    pintarCola();
  }

  function programarEscritura() {
    if (!termEscFallas) enviarEscritura();
    else termEscTimer = setTimeout(function () { termEscTimer = null; enviarEscritura(); }, retardoTerm(termEscFallas));
  }

  function falloEscribir(tipo) {
    termEscFallas++;
    if (termEscFallas >= 2) avisoTerm(tipo === 'ocupada' ? 'La PC está ocupada. Reintentando…' : 'Sin conexión con la PC. Reintentando…');
    pintarCola();
  }

  // Un pedido por vez y en orden. Mientras no haya respuesta el item sigue en la cola con su número: si la
  // red falla se reenvía igual y la PC, que ya lo hizo, no lo repite.
  function enviarEscritura() {
    // Con un reintento esperando su backoff, teclear más no lo adelanta.
    if (termEscTimer || !termId || !term || termEscribiendo || termParada || termCerrada || document.hidden) return;
    var item = termCola[0];
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
    pedido.escribir = item.t;
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
        if (r.status === 401) { perdioEscrito = true; cerrarTerminal(false); consultar(); return null; }
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
    termHistI = -1;
    $('term-texto').value = '';
    $('term-nombre').textContent = nombre;
    $('term').hidden = false;
    botonesTerm();
    if (raiz.classList) raiz.classList.add('con-term');
    termHoriz = esHorizontal();
    elegirVista();
    termAlto = cajaVisible();
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
        term.onData(function (d) {
          var t = sinAutomaticas(d);
          // El Enter va en otro pedido: pegado al texto, Claude lo toma como parte de lo pegado y no lo manda. Lo que empieza con ESC
          // (flechas, Esc) tampoco se junta con lo que sigue: ESC y después «[I» tecleados aparte no tienen que parecer un reporte de foco.
          if (t) encolar(t, t === '\r' || t.charAt(0) === '\x1b');
        });
        window.addEventListener('resize', alCambiarVentana);
        window.addEventListener('orientationchange', alCambiarVentana);
        if (window.visualViewport) {
          window.visualViewport.addEventListener('resize', alCambiarVentana);
          window.visualViewport.addEventListener('scroll', alCambiarVentana);
        }
      } else term.reset();
      alCambiarVentana();
      mirar();
      enviarEscritura();
    }, function () { avisoTerm('No se pudo cargar la terminal. Revisá la conexión con la PC.'); });
  }

  function cerrarTerminal(desdeHistoria) {
    if (!termId) return;
    var id = termId;
    termId = null;
    termCola = [];
    soltarMirar();
    soltarEscribir();
    var el = $('term');
    el.hidden = true;
    el.style.top = el.style.height = el.style.bottom = '';
    if (raiz.classList) raiz.classList.remove('con-term');
    if (!desdeHistoria) { try { history.back(); } catch (e) { /* sin historial */ } }
  }

  $('term-volver').addEventListener('click', function () { cerrarTerminal(false); });
  $('term-vista').addEventListener('click', function () {
    termVista = termVista === 'celu' ? 'pc' : 'celu';
    guardar(claveVista(), termVista);
    pintarVista();
    encajar();
  });
  // El foco tiene que salir de un toque del usuario (iOS no abre el teclado si no): xterm enfoca su textarea oculto y de ahí sale lo tipeado.
  $('term-pantalla').addEventListener('click', function () { if (term && !termCerrada) term.focus(); });
  $('term-pantalla').addEventListener('focusin', function () { setTimeout(alFondo, 350); });
  if (document.querySelectorAll) {
    [].forEach.call(document.querySelectorAll('[data-tecla]'), function (b) {
      botonesTecla.push(b);
      // Con el dedo sobre una tecla el foco no se mueve: si se movía, el teclado se cerraba en cada toque.
      b.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
      b.addEventListener('click', function () {
        var v = TECLAS[b.getAttribute('data-tecla')];
        var lista = typeof v === 'string' ? [v] : v || [];
        for (var i = 0; i < lista.length; i++) encolar(lista[i], true);
      });
    });
  }
  botonesTecla.push($('term-texto'), $('term-mandar'), $('term-a-texto'));
  $('term-escribir').addEventListener('submit', function (ev) { ev.preventDefault(); mandarTexto(); });
  // Mandar y el historial no se llevan el foco: el teclado del celu queda abierto para seguir escribiendo.
  $('term-mandar').addEventListener('mousedown', function (ev) { ev.preventDefault(); });
  $('term-hist').addEventListener('mousedown', function (ev) { ev.preventDefault(); });
  $('term-hist').addEventListener('click', historialAnterior);
  $('term-descartar').addEventListener('click', descartarCola);
  // Con poca altura el cuadro se esconde detrás de este botón; el foco sale del mismo toque, o iOS no abre el teclado.
  $('term-a-texto').addEventListener('click', function () {
    if ($('term').classList) $('term').classList.add('escribiendo');
    $('term-texto').focus();
  });
  $('term-texto').addEventListener('focus', function () { if ($('term').classList) $('term').classList.add('escribiendo'); });
  $('term-texto').addEventListener('blur', function () { if ($('term').classList) $('term').classList.remove('escribiendo'); });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { clearTimeout(timer); soltarMirar(); clearTimeout(termEscTimer); termEscTimer = null; }
    else { consultar(); reanudarTerm(); }
  });
  window.addEventListener('online', reanudarTerm);
  window.addEventListener('pageshow', reanudarTerm);
  consultar();
})();
