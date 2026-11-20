export const SELLO_JS = `(function () {
  'use strict';
  var ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var NUL = String.fromCharCode(0);
  var CODIGOS = new Uint8Array(64);
  var TABLA = new Int8Array(128);
  var PREFIJO_R = new Uint8Array([0x72]);
  (function () {
    var i;
    for (i = 0; i < 128; i++) TABLA[i] = -1;
    for (i = 0; i < 64; i++) {
      CODIGOS[i] = ALFABETO.charCodeAt(i);
      TABLA[CODIGOS[i]] = i;
    }
  })();

  var K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  var IV256 = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  var W = new Int32Array(64);

  function bloques(h, d, o, fin) {
    var a, b, c, dd, e, f, g, hh, i, j, x, y, t1, t2;
    for (; o < fin; o += 64) {
      for (i = 0; i < 16; i++) {
        j = o + i * 4;
        W[i] = (d[j] << 24) | (d[j + 1] << 16) | (d[j + 2] << 8) | d[j + 3];
      }
      for (i = 16; i < 64; i++) {
        x = W[i - 15];
        y = W[i - 2];
        W[i] = (W[i - 16] + (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + W[i - 7] +
          (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))) | 0;
      }
      a = h[0]; b = h[1]; c = h[2]; dd = h[3]; e = h[4]; f = h[5]; g = h[6]; hh = h[7];
      for (i = 0; i < 64; i++) {
        t1 = (hh + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
        t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (dd + t1) | 0;
        dd = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + dd) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
  }

  function nuevoHash(estado, previos) {
    return { h: new Int32Array(estado), b: new Uint8Array(64), n: 0, t: previos };
  }

  function alimentar(s, d, ini, fin) {
    var i = ini, enteros;
    s.t += fin - ini;
    if (s.n > 0) {
      while (i < fin && s.n < 64) s.b[s.n++] = d[i++];
      if (s.n < 64) return;
      bloques(s.h, s.b, 0, 64);
      s.n = 0;
    }
    enteros = (fin - i) & ~63;
    if (enteros > 0) {
      bloques(s.h, d, i, i + enteros);
      i += enteros;
    }
    while (i < fin) s.b[s.n++] = d[i++];
  }

  function terminar(s) {
    var b = s.b, n = s.n, i, hi = Math.floor(s.t / 536870912), lo = s.t << 3;
    b[n++] = 0x80;
    if (n > 56) {
      while (n < 64) b[n++] = 0;
      bloques(s.h, b, 0, 64);
      n = 0;
    }
    while (n < 56) b[n++] = 0;
    b[56] = hi >>> 24; b[57] = (hi >>> 16) & 255; b[58] = (hi >>> 8) & 255; b[59] = hi & 255;
    b[60] = lo >>> 24; b[61] = (lo >>> 16) & 255; b[62] = (lo >>> 8) & 255; b[63] = lo & 255;
    bloques(s.h, b, 0, 64);
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) {
      out[i * 4] = s.h[i] >>> 24; out[i * 4 + 1] = (s.h[i] >>> 16) & 255;
      out[i * 4 + 2] = (s.h[i] >>> 8) & 255; out[i * 4 + 3] = s.h[i] & 255;
    }
    return out;
  }

  function sha256(datos) {
    var s = nuevoHash(IV256, 0);
    alimentar(s, datos, 0, datos.length);
    return terminar(s);
  }

  function hmacInicio(clave) {
    var k = clave.length > 64 ? sha256(clave) : clave;
    var ipad = new Uint8Array(64), opad = new Uint8Array(64), i;
    for (i = 0; i < 64; i++) {
      var b = i < k.length ? k[i] : 0;
      ipad[i] = b ^ 0x36;
      opad[i] = b ^ 0x5c;
    }
    var interno = new Int32Array(IV256), externo = new Int32Array(IV256);
    bloques(interno, ipad, 0, 64);
    bloques(externo, opad, 0, 64);
    return { i: interno, o: externo };
  }

  function hmacPartes(inicio, partes) {
    var s = nuevoHash(inicio.i, 64), i;
    for (i = 0; i < partes.length; i++) alimentar(s, partes[i], 0, partes[i].length);
    var e = nuevoHash(inicio.o, 64);
    alimentar(e, terminar(s), 0, 32);
    return terminar(e);
  }

  function hmac(clave, datos) {
    return hmacPartes(hmacInicio(clave), [datos]);
  }

  function iguales(a, b) {
    if (a.length !== b.length) return false;
    var d = 0;
    for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }

  function xtime(a) { return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff; }

  var SBOX = (function () {
    var s = new Uint8Array(256), p = 1, q = 1;
    do {
      p = (p ^ (p << 1) ^ ((p & 0x80) ? 0x11b : 0)) & 0xff;
      q = (q ^ (q << 1)) & 0xff;
      q = (q ^ (q << 2)) & 0xff;
      q = (q ^ (q << 4)) & 0xff;
      if (q & 0x80) q ^= 0x09;
      var x = q ^ (((q << 1) | (q >> 7)) & 0xff) ^ (((q << 2) | (q >> 6)) & 0xff) ^ (((q << 3) | (q >> 5)) & 0xff) ^ (((q << 4) | (q >> 4)) & 0xff);
      s[p] = (x ^ 0x63) & 0xff;
    } while (p !== 1);
    s[0] = 0x63;
    return s;
  })();

  var TE0 = new Int32Array(256), TE1 = new Int32Array(256), TE2 = new Int32Array(256), TE3 = new Int32Array(256);
  (function () {
    for (var i = 0; i < 256; i++) {
      var s = SBOX[i], s2 = xtime(s), w = (s2 << 24) | (s << 16) | (s << 8) | (s2 ^ s);
      TE0[i] = w;
      TE1[i] = (w >>> 8) | (w << 24);
      TE2[i] = (w >>> 16) | (w << 16);
      TE3[i] = (w >>> 24) | (w << 8);
    }
  })();

  function expandirClave(clave) {
    var w = new Uint8Array(240), i, t = new Array(4), rcon = 1;
    w.set(clave);
    for (i = 8; i < 60; i++) {
      for (var j = 0; j < 4; j++) t[j] = w[(i - 1) * 4 + j];
      if (i % 8 === 0) {
        var x = t[0];
        t[0] = SBOX[t[1]] ^ rcon; t[1] = SBOX[t[2]]; t[2] = SBOX[t[3]]; t[3] = SBOX[x];
        rcon = ((rcon << 1) ^ ((rcon & 0x80) ? 0x11b : 0)) & 0xff;
      } else if (i % 8 === 4) {
        for (var k = 0; k < 4; k++) t[k] = SBOX[t[k]];
      }
      for (var m = 0; m < 4; m++) w[i * 4 + m] = w[(i - 8) * 4 + m] ^ t[m];
    }
    var rk = new Int32Array(60);
    for (i = 0; i < 60; i++) rk[i] = (w[i * 4] << 24) | (w[i * 4 + 1] << 16) | (w[i * 4 + 2] << 8) | w[i * 4 + 3];
    return rk;
  }

  var KS = new Int32Array(4);

  function cifrar(rk, a0, a1, a2, a3) {
    var s0 = a0 ^ rk[0], s1 = a1 ^ rk[1], s2 = a2 ^ rk[2], s3 = a3 ^ rk[3], t0, t1, t2, t3, k = 4;
    for (var r = 1; r < 14; r++) {
      t0 = TE0[s0 >>> 24] ^ TE1[(s1 >>> 16) & 255] ^ TE2[(s2 >>> 8) & 255] ^ TE3[s3 & 255] ^ rk[k];
      t1 = TE0[s1 >>> 24] ^ TE1[(s2 >>> 16) & 255] ^ TE2[(s3 >>> 8) & 255] ^ TE3[s0 & 255] ^ rk[k + 1];
      t2 = TE0[s2 >>> 24] ^ TE1[(s3 >>> 16) & 255] ^ TE2[(s0 >>> 8) & 255] ^ TE3[s1 & 255] ^ rk[k + 2];
      t3 = TE0[s3 >>> 24] ^ TE1[(s0 >>> 16) & 255] ^ TE2[(s1 >>> 8) & 255] ^ TE3[s2 & 255] ^ rk[k + 3];
      s0 = t0; s1 = t1; s2 = t2; s3 = t3;
      k += 4;
    }
    KS[0] = ((SBOX[s0 >>> 24] << 24) | (SBOX[(s1 >>> 16) & 255] << 16) | (SBOX[(s2 >>> 8) & 255] << 8) | SBOX[s3 & 255]) ^ rk[k];
    KS[1] = ((SBOX[s1 >>> 24] << 24) | (SBOX[(s2 >>> 16) & 255] << 16) | (SBOX[(s3 >>> 8) & 255] << 8) | SBOX[s0 & 255]) ^ rk[k + 1];
    KS[2] = ((SBOX[s2 >>> 24] << 24) | (SBOX[(s3 >>> 16) & 255] << 16) | (SBOX[(s0 >>> 8) & 255] << 8) | SBOX[s1 & 255]) ^ rk[k + 2];
    KS[3] = ((SBOX[s3 >>> 24] << 24) | (SBOX[(s0 >>> 16) & 255] << 16) | (SBOX[(s1 >>> 8) & 255] << 8) | SBOX[s2 & 255]) ^ rk[k + 3];
  }

  function aesBloque(rk, entrada) {
    var s = new Uint8Array(16), i;
    cifrar(rk,
      (entrada[0] << 24) | (entrada[1] << 16) | (entrada[2] << 8) | entrada[3],
      (entrada[4] << 24) | (entrada[5] << 16) | (entrada[6] << 8) | entrada[7],
      (entrada[8] << 24) | (entrada[9] << 16) | (entrada[10] << 8) | entrada[11],
      (entrada[12] << 24) | (entrada[13] << 16) | (entrada[14] << 8) | entrada[15]);
    for (i = 0; i < 16; i++) s[i] = KS[i >> 2] >>> (24 - 8 * (i & 3));
    return s;
  }

  function ctr(rk, iv, datos, out, destino) {
    var c0 = (iv[0] << 24) | (iv[1] << 16) | (iv[2] << 8) | iv[3];
    var c1 = (iv[4] << 24) | (iv[5] << 16) | (iv[6] << 8) | iv[7];
    var c2 = (iv[8] << 24) | (iv[9] << 16) | (iv[10] << 8) | iv[11];
    var c3 = (iv[12] << 24) | (iv[13] << 16) | (iv[14] << 8) | iv[15];
    var n = datos.length, o = 0, p, k0, k1, k2, k3, i;
    for (; o + 16 <= n; o += 16) {
      cifrar(rk, c0, c1, c2, c3);
      k0 = KS[0]; k1 = KS[1]; k2 = KS[2]; k3 = KS[3];
      p = destino + o;
      out[p] = datos[o] ^ (k0 >>> 24); out[p + 1] = datos[o + 1] ^ (k0 >>> 16); out[p + 2] = datos[o + 2] ^ (k0 >>> 8); out[p + 3] = datos[o + 3] ^ k0;
      out[p + 4] = datos[o + 4] ^ (k1 >>> 24); out[p + 5] = datos[o + 5] ^ (k1 >>> 16); out[p + 6] = datos[o + 6] ^ (k1 >>> 8); out[p + 7] = datos[o + 7] ^ k1;
      out[p + 8] = datos[o + 8] ^ (k2 >>> 24); out[p + 9] = datos[o + 9] ^ (k2 >>> 16); out[p + 10] = datos[o + 10] ^ (k2 >>> 8); out[p + 11] = datos[o + 11] ^ k2;
      out[p + 12] = datos[o + 12] ^ (k3 >>> 24); out[p + 13] = datos[o + 13] ^ (k3 >>> 16); out[p + 14] = datos[o + 14] ^ (k3 >>> 8); out[p + 15] = datos[o + 15] ^ k3;
      c3 = (c3 + 1) | 0;
      if (c3 === 0) {
        c2 = (c2 + 1) | 0;
        if (c2 === 0) {
          c1 = (c1 + 1) | 0;
          if (c1 === 0) c0 = (c0 + 1) | 0;
        }
      }
    }
    if (o < n) {
      cifrar(rk, c0, c1, c2, c3);
      for (i = 0; o + i < n; i++) out[destino + o + i] = datos[o + i] ^ (KS[i >> 2] >>> (24 - 8 * (i & 3)));
    }
  }

  function aTexto(c) {
    var r = '';
    for (var i = 0; i < c.length; i += 8192) r += String.fromCharCode.apply(null, Array.prototype.slice.call(c, i, i + 8192));
    return r;
  }

  function aBase64url(b) {
    var n = b.length, m = Math.floor(n / 3), resto = n - m * 3, i, p = 0, v;
    var c = new Uint8Array(m * 4 + (resto ? resto + 1 : 0));
    for (i = 0; i < m * 3; i += 3) {
      v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
      c[p++] = CODIGOS[v >> 18]; c[p++] = CODIGOS[(v >> 12) & 63]; c[p++] = CODIGOS[(v >> 6) & 63]; c[p++] = CODIGOS[v & 63];
    }
    if (resto === 1) {
      c[p++] = CODIGOS[b[i] >> 2]; c[p++] = CODIGOS[(b[i] & 3) << 4];
    } else if (resto === 2) {
      v = (b[i] << 8) | b[i + 1];
      c[p++] = CODIGOS[v >> 10]; c[p++] = CODIGOS[(v >> 4) & 63]; c[p++] = CODIGOS[(v & 15) << 2];
    }
    return aTexto(c);
  }

  function deBase64url(t) {
    if (typeof t !== 'string' || t.length % 4 === 1) return null;
    var largo = t.length, m = largo >> 2, resto = largo - m * 4;
    var out = new Uint8Array(m * 3 + (resto ? resto - 1 : 0)), i, p = 0, q = 0, a, b, c, d;
    for (i = 0; i < m; i++) {
      a = t.charCodeAt(p++); b = t.charCodeAt(p++); c = t.charCodeAt(p++); d = t.charCodeAt(p++);
      if (a > 127 || b > 127 || c > 127 || d > 127) return null;
      a = TABLA[a]; b = TABLA[b]; c = TABLA[c]; d = TABLA[d];
      if ((a | b | c | d) < 0) return null;
      out[q++] = (a << 2) | (b >> 4); out[q++] = ((b & 15) << 4) | (c >> 2); out[q++] = ((c & 3) << 6) | d;
    }
    if (resto === 0) return out;
    a = t.charCodeAt(p++); b = t.charCodeAt(p++);
    if (a > 127 || b > 127) return null;
    a = TABLA[a]; b = TABLA[b];
    if ((a | b) < 0) return null;
    out[q++] = (a << 2) | (b >> 4);
    if (resto === 2) return (b & 15) === 0 ? out : null;
    c = t.charCodeAt(p++);
    if (c > 127) return null;
    c = TABLA[c];
    if (c < 0) return null;
    out[q++] = ((b & 15) << 4) | (c >> 2);
    return (c & 3) === 0 ? out : null;
  }

  function aUtf8(texto) {
    var b = new Uint8Array(texto.length * 3), p = 0;
    for (var i = 0; i < texto.length; i++) {
      var c = texto.charCodeAt(i);
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < texto.length) {
        var d = texto.charCodeAt(i + 1);
        if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
      }
      if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
      if (c < 0x80) b[p++] = c;
      else if (c < 0x800) { b[p++] = 0xc0 | (c >> 6); b[p++] = 0x80 | (c & 63); }
      else if (c < 0x10000) { b[p++] = 0xe0 | (c >> 12); b[p++] = 0x80 | ((c >> 6) & 63); b[p++] = 0x80 | (c & 63); }
      else { b[p++] = 0xf0 | (c >> 18); b[p++] = 0x80 | ((c >> 12) & 63); b[p++] = 0x80 | ((c >> 6) & 63); b[p++] = 0x80 | (c & 63); }
    }
    return b.subarray(0, p);
  }

  function deUtf8(b) {
    var u = new Uint16Array(b.length), p = 0, i = 0, n = b.length;
    while (i < n) {
      var c = b[i++], extra = 0, min = 0;
      if (c < 0x80) { u[p++] = c; continue; }
      if (c >= 0xc2 && c < 0xe0) { extra = 1; c &= 0x1f; min = 0x80; }
      else if (c >= 0xe0 && c < 0xf0) { extra = 2; c &= 0x0f; min = 0x800; }
      else if (c >= 0xf0 && c < 0xf5) { extra = 3; c &= 0x07; min = 0x10000; }
      else { u[p++] = 0xfffd; continue; }
      var ok = i + extra <= n;
      for (var k = 0; ok && k < extra; k++) {
        if ((b[i + k] & 0xc0) !== 0x80) ok = false;
        else c = (c << 6) | (b[i + k] & 63);
      }
      if (!ok || c < min || c > 0x10ffff || (c >= 0xd800 && c < 0xe000)) { u[p++] = 0xfffd; continue; }
      i += extra;
      if (c >= 0x10000) { c -= 0x10000; u[p++] = 0xd800 + (c >> 10); u[p++] = 0xdc00 + (c & 0x3ff); }
      else u[p++] = c;
    }
    return aTexto(u.subarray(0, p));
  }

  function preparar(claves) {
    if (!claves._rk) {
      claves._rk = expandirClave(claves.enc);
      claves._mac = hmacInicio(claves.mac);
    }
    return claves;
  }

  function abrirClave(clave) {
    var bytes = deBase64url(clave);
    if (!bytes || bytes.length !== 32) return null;
    var inicio = hmacInicio(bytes);
    return preparar({ enc: hmacPartes(inicio, [aUtf8('sloth-wifi enc')]), mac: hmacPartes(inicio, [aUtf8('sloth-wifi mac')]) });
  }

  function sellarPedido(claves, ruta, objeto) {
    preparar(claves);
    var iv = new Uint8Array(16);
    crypto.getRandomValues(iv);
    var claro = aUtf8(JSON.stringify({ t: Date.now(), b: objeto }));
    var n = claro.length, sobre = new Uint8Array(16 + n + 32);
    sobre.set(iv);
    ctr(claves._rk, iv, claro, sobre, 16);
    var tag = hmacPartes(claves._mac, [aUtf8('q' + ruta + NUL), iv, sobre.subarray(16, 16 + n)]);
    sobre.set(tag, 16 + n);
    return { sobre: aBase64url(sobre), iv: iv };
  }

  function abrirRespuesta(claves, ivPedido, sobre) {
    if (typeof sobre !== 'string' || sobre.length > 262144) return null;
    var bytes = deBase64url(sobre);
    if (!bytes || bytes.length < 48) return null;
    preparar(claves);
    var fin = bytes.length - 32;
    var iv = bytes.subarray(0, 16);
    var ct = bytes.subarray(16, fin);
    var esperado = hmacPartes(claves._mac, [PREFIJO_R, ivPedido, iv, ct]);
    if (!iguales(bytes.subarray(fin), esperado)) return null;
    var claro = new Uint8Array(ct.length);
    ctr(claves._rk, iv, ct, claro, 0);
    return deUtf8(claro);
  }

  window.slothSello = {
    abrirClave: abrirClave,
    sellarPedido: sellarPedido,
    abrirRespuesta: abrirRespuesta,
    _t: {
      sha256: sha256,
      hmac: hmac,
      hmacPartes: function (clave, partes) { return hmacPartes(hmacInicio(clave), partes); },
      aesBloque: function (clave, bloque) { return aesBloque(expandirClave(clave), bloque); },
      ctr: function (clave, iv, datos) {
        var out = new Uint8Array(datos.length);
        ctr(expandirClave(clave), iv, datos, out, 0);
        return out;
      },
      aBase64url: aBase64url,
      deBase64url: deBase64url,
      aUtf8: aUtf8,
      deUtf8: deUtf8
    }
  };
})();
`
