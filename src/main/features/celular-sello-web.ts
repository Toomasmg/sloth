export const SELLO_JS = `(function () {
  'use strict';
  var ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var NUL = String.fromCharCode(0);
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotd(x, n) { return (x >>> n) | (x << (32 - n)); }

  function sha256(datos) {
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var n = datos.length;
    var total = (((n + 9 + 63) >> 6) << 6);
    var m = new Uint8Array(total);
    m.set(datos);
    m[n] = 0x80;
    var bits = n * 8;
    var dv = new DataView(m.buffer);
    dv.setUint32(total - 8, Math.floor(bits / 4294967296));
    dv.setUint32(total - 4, bits >>> 0);
    var w = new Array(64);
    for (var o = 0; o < total; o += 64) {
      var i;
      for (i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (i = 16; i < 64; i++) {
        var s0 = rotd(w[i - 15], 7) ^ rotd(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotd(w[i - 2], 17) ^ rotd(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotd(e, 6) ^ rotd(e, 11) ^ rotd(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rotd(a, 2) ^ rotd(a, 13) ^ rotd(a, 22);
        var mj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + mj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    var out = new Uint8Array(32);
    var ov = new DataView(out.buffer);
    for (var j = 0; j < 8; j++) ov.setUint32(j * 4, h[j]);
    return out;
  }

  function juntar() {
    var largo = 0, i;
    for (i = 0; i < arguments.length; i++) largo += arguments[i].length;
    var r = new Uint8Array(largo), p = 0;
    for (i = 0; i < arguments.length; i++) { r.set(arguments[i], p); p += arguments[i].length; }
    return r;
  }

  function hmac(clave, datos) {
    var k = clave.length > 64 ? sha256(clave) : clave;
    var ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for (var i = 0; i < 64; i++) {
      var b = i < k.length ? k[i] : 0;
      ipad[i] = b ^ 0x36;
      opad[i] = b ^ 0x5c;
    }
    return sha256(juntar(opad, sha256(juntar(ipad, datos))));
  }

  function iguales(a, b) {
    if (a.length !== b.length) return false;
    var d = 0;
    for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }

  var SBOX = (function () {
    var s = new Array(256), p = 1, q = 1;
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
    return w;
  }

  function xtime(a) { return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff; }

  function aesBloque(rk, entrada) {
    var s = new Uint8Array(entrada), r, i, t;
    for (i = 0; i < 16; i++) s[i] ^= rk[i];
    for (r = 1; r <= 14; r++) {
      for (i = 0; i < 16; i++) s[i] = SBOX[s[i]];
      t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
      t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
      t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
      if (r < 14) {
        for (i = 0; i < 16; i += 4) {
          var a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
          var todo = a0 ^ a1 ^ a2 ^ a3;
          s[i] = a0 ^ todo ^ xtime(a0 ^ a1);
          s[i + 1] = a1 ^ todo ^ xtime(a1 ^ a2);
          s[i + 2] = a2 ^ todo ^ xtime(a2 ^ a3);
          s[i + 3] = a3 ^ todo ^ xtime(a3 ^ a0);
        }
      }
      for (i = 0; i < 16; i++) s[i] ^= rk[r * 16 + i];
    }
    return s;
  }

  function ctr(clave, iv, datos) {
    var rk = expandirClave(clave), cont = new Uint8Array(iv), out = new Uint8Array(datos.length);
    for (var o = 0; o < datos.length; o += 16) {
      var ks = aesBloque(rk, cont);
      for (var i = 0; i < 16 && o + i < datos.length; i++) out[o + i] = datos[o + i] ^ ks[i];
      for (var j = 15; j >= 0; j--) {
        cont[j] = (cont[j] + 1) & 0xff;
        if (cont[j] !== 0) break;
      }
    }
    return out;
  }

  function aBase64url(b) {
    var r = '', i;
    for (i = 0; i + 2 < b.length; i += 3) {
      var v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
      r += ALFABETO.charAt(v >> 18) + ALFABETO.charAt((v >> 12) & 63) + ALFABETO.charAt((v >> 6) & 63) + ALFABETO.charAt(v & 63);
    }
    var resto = b.length - i;
    if (resto === 1) {
      r += ALFABETO.charAt(b[i] >> 2) + ALFABETO.charAt((b[i] & 3) << 4);
    } else if (resto === 2) {
      var u = (b[i] << 8) | b[i + 1];
      r += ALFABETO.charAt(u >> 10) + ALFABETO.charAt((u >> 4) & 63) + ALFABETO.charAt((u & 15) << 2);
    }
    return r;
  }

  function deBase64url(t) {
    if (typeof t !== 'string' || t.length % 4 === 1) return null;
    var n = Math.floor(t.length * 3 / 4), out = new Uint8Array(n), acum = 0, bits = 0, p = 0;
    for (var i = 0; i < t.length; i++) {
      var v = ALFABETO.indexOf(t.charAt(i));
      if (v < 0) return null;
      acum = (acum << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[p++] = (acum >> bits) & 0xff;
        acum &= (1 << bits) - 1;
      }
    }
    if (acum !== 0) return null;
    return aBase64url(out) === t ? out : null;
  }

  function aUtf8(texto) {
    var b = [];
    for (var i = 0; i < texto.length; i++) {
      var c = texto.charCodeAt(i);
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < texto.length) {
        var d = texto.charCodeAt(i + 1);
        if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
      }
      if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
      if (c < 0x80) b.push(c);
      else if (c < 0x800) b.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) b.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else b.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(b);
  }

  function deUtf8(b) {
    var r = '', i = 0;
    while (i < b.length) {
      var c = b[i++], extra = 0, min = 0;
      if (c < 0x80) { r += String.fromCharCode(c); continue; }
      if (c >= 0xc2 && c < 0xe0) { extra = 1; c &= 0x1f; min = 0x80; }
      else if (c >= 0xe0 && c < 0xf0) { extra = 2; c &= 0x0f; min = 0x800; }
      else if (c >= 0xf0 && c < 0xf5) { extra = 3; c &= 0x07; min = 0x10000; }
      else { r += String.fromCharCode(0xfffd); continue; }
      var ok = i + extra <= b.length;
      for (var k = 0; ok && k < extra; k++) {
        if ((b[i + k] & 0xc0) !== 0x80) ok = false;
        else c = (c << 6) | (b[i + k] & 63);
      }
      if (!ok || c < min || c > 0x10ffff || (c >= 0xd800 && c < 0xe000)) { r += String.fromCharCode(0xfffd); continue; }
      i += extra;
      if (c >= 0x10000) { c -= 0x10000; r += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff)); }
      else r += String.fromCharCode(c);
    }
    return r;
  }

  function abrirClave(clave) {
    var bytes = deBase64url(clave);
    if (!bytes || bytes.length !== 32) return null;
    return { enc: hmac(bytes, aUtf8('sloth-wifi enc')), mac: hmac(bytes, aUtf8('sloth-wifi mac')) };
  }

  function sellarPedido(claves, ruta, objeto) {
    var iv = new Uint8Array(16);
    crypto.getRandomValues(iv);
    var claro = aUtf8(JSON.stringify({ t: Date.now(), b: objeto }));
    var ct = ctr(claves.enc, iv, claro);
    var tag = hmac(claves.mac, juntar(aUtf8('q' + ruta + NUL), iv, ct));
    return { sobre: aBase64url(juntar(iv, ct, tag)), iv: iv };
  }

  function abrirRespuesta(claves, ivPedido, sobre) {
    if (typeof sobre !== 'string' || sobre.length > 262144) return null;
    var bytes = deBase64url(sobre);
    if (!bytes || bytes.length < 48) return null;
    var iv = bytes.subarray(0, 16);
    var ct = bytes.subarray(16, bytes.length - 32);
    var tag = bytes.subarray(bytes.length - 32);
    var esperado = hmac(claves.mac, juntar(aUtf8('r'), ivPedido, iv, ct));
    if (!iguales(tag, esperado)) return null;
    return deUtf8(ctr(claves.enc, iv, ct));
  }

  window.slothSello = {
    abrirClave: abrirClave,
    sellarPedido: sellarPedido,
    abrirRespuesta: abrirRespuesta,
    _t: { sha256: sha256, hmac: hmac, aesBloque: function (clave, bloque) { return aesBloque(expandirClave(clave), bloque); } }
  };
})();
`
