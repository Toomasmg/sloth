import { writeFileSync } from 'node:fs'

// Arma los SVG animados del README (docs/img/hero*.svg y divisor.svg). Se corre a mano al cambiar un texto:
// `node scripts/readme/hero.mjs`. GitHub muestra los SVG como imagen: anima el CSS, pero no corre JS.
const TEXTOS = {
  es: {
    archivo: 'docs/img/hero.svg',
    sub: 'Varias cuentas de Claude Code a la vez,',
    sub2: 'cada una en su terminal y su repo.',
    tag: 'APP DE ESCRITORIO PARA WINDOWS · LIVIANA A PROPÓSITO',
    estados: ['Trabajando', 'Te necesita', 'Terminó'],
    paneles: [['web', 'Personal'], ['api-pagos', 'Trabajo'], ['docs', 'Personal']]
  },
  en: {
    archivo: 'docs/img/hero-en.svg',
    sub: 'Several Claude Code accounts at once,',
    sub2: 'each one in its own terminal and repo.',
    tag: 'DESKTOP APP FOR WINDOWS · LIGHTWEIGHT BY DESIGN',
    estados: ['Working', 'Needs you', 'Done'],
    paneles: [['web', 'Personal'], ['payments-api', 'Work'], ['docs', 'Personal']]
  }
}

const COLORES = ['#8AB4FF', '#F5B96B', '#6FD3A0']
const FUENTE = "'Segoe UI', Inter, Helvetica, Arial, sans-serif"

function panel(i, [nombre, cuenta], estados) {
  const x = 640
  const y = 46 + i * 98
  // Cada panel recorre los tres estados con un desfase propio: nunca están todos iguales.
  const retraso = (-i * 2.4).toFixed(1)
  const lineas = [0, 1, 2]
    .map((l) => `<rect x="${x + 22}" y="${y + 44 + l * 12}" width="${[210, 150, 180][(l + i) % 3]}" height="5" rx="2.5" fill="#3A4152" class="linea" style="animation-delay:${(l * 0.5 - i).toFixed(1)}s"/>`)
    .join('')
  const pastillas = estados
    .map((e, k) => {
      const c = COLORES[k]
      return `<g class="est est${k}" style="animation-delay:${retraso}s"><rect x="${x + 380}" y="${y + 12}" width="124" height="24" rx="12" fill="${c}" fill-opacity=".14" stroke="${c}" stroke-opacity=".5"/><circle cx="${x + 396}" cy="${y + 24}" r="4" fill="${c}"${k === 0 ? ' class="latido"' : ''}/><text x="${x + 408}" y="${y + 28.5}" fill="${c}" class="pill">${e}</text></g>`
    })
    .join('')
  return `<g class="panel" style="animation-delay:${(0.3 + i * 0.25).toFixed(2)}s">
  <rect x="${x}" y="${y}" width="520" height="84" rx="12" fill="#161922" stroke="#2A3040"/>
  <rect x="${x}" y="${y + 10}" width="3" height="64" rx="1.5" fill="url(#marca)"/>
  <text x="${x + 22}" y="${y + 29}" class="nombre">${nombre}</text>
  <text x="${x + 22 + nombre.length * 8 + 10}" y="${y + 29}" class="cuenta">${cuenta}</text>
  ${lineas}
  ${pastillas}
</g>`
}

function hero(t) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="360" viewBox="0 0 1200 360">
<defs>
  <linearGradient id="fondo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#11141C"/><stop offset=".6" stop-color="#1C1F29"/><stop offset="1" stop-color="#0E1A1D"/></linearGradient>
  <linearGradient id="marca" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9FEAF9"/><stop offset="1" stop-color="#47848F"/></linearGradient>
  <linearGradient id="titulo" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#9FEAF9"><animate attributeName="stop-color" values="#9FEAF9;#47848F;#9FEAF9" dur="6s" repeatCount="indefinite"/></stop>
    <stop offset="1" stop-color="#47848F"><animate attributeName="stop-color" values="#47848F;#9FEAF9;#47848F" dur="6s" repeatCount="indefinite"/></stop>
  </linearGradient>
  <radialGradient id="brillo"><stop offset="0" stop-color="#47848F" stop-opacity=".45"/><stop offset="1" stop-color="#47848F" stop-opacity="0"/></radialGradient>
</defs>
<style>
  .titulo{font:800 84px ${FUENTE};letter-spacing:-2px}
  .sub{font:500 22px ${FUENTE};fill:#E2E8F0}
  .tag{font:700 12px ${FUENTE};fill:#7C8799;letter-spacing:3px}
  .nombre{font:600 15px ${FUENTE};fill:#E6E9EF}
  .cuenta{font:500 12px ${FUENTE};fill:#7C8799}
  .pill{font:600 12px ${FUENTE}}
  .entra{opacity:0;animation:entra 1s ease forwards}
  .panel{opacity:0;animation:entra .9s ease forwards}
  @keyframes entra{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  .orbita{animation:gira 14s linear infinite}
  @keyframes gira{to{transform:rotate(360deg)}}
  .halo{transform-box:fill-box;transform-origin:center;animation:halo 4s ease-in-out infinite}
  @keyframes halo{50%{transform:scale(1.12);opacity:.7}}
  .cursor{animation:parpadea 1.1s steps(1) infinite}
  @keyframes parpadea{50%{opacity:0}}
  .est{opacity:0;animation:9s linear infinite}
  .est0{animation-name:e0}.est1{animation-name:e1}.est2{animation-name:e2}
  @keyframes e0{0%,30%{opacity:1}33.3%,100%{opacity:0}}
  @keyframes e1{0%,33.3%{opacity:0}36.6%,63%{opacity:1}66.6%,100%{opacity:0}}
  @keyframes e2{0%,66.6%{opacity:0}70%,97%{opacity:1}100%{opacity:0}}
  .latido{transform-box:fill-box;transform-origin:center;animation:latido 1.2s ease-in-out infinite}
  @keyframes latido{50%{transform:scale(.55)}}
  .linea{animation:escribe 3s ease-in-out infinite alternate}
  @keyframes escribe{from{opacity:.35}to{opacity:1}}
  @media (prefers-reduced-motion: reduce){*{animation:none!important}.est0,.panel,.entra{opacity:1}}
</style>
<rect width="1200" height="360" rx="24" fill="url(#fondo)"/>
<circle cx="131" cy="150" r="120" fill="url(#brillo)" class="halo"/>
<g transform="translate(73 92) scale(3.6)">
  <g class="orbita" style="transform-origin:16px 16px">
    <ellipse cx="16" cy="16" rx="13" ry="5.2" transform="rotate(-30 16 16)" fill="none" stroke="url(#marca)" stroke-width="1.4"/>
    <circle cx="27.3" cy="9.5" r="1.7" fill="#9FEAF9"/>
  </g>
  <g class="orbita" style="transform-origin:16px 16px">
    <ellipse cx="16" cy="16" rx="13" ry="5.2" transform="rotate(30 16 16)" fill="none" stroke="url(#marca)" stroke-width="1.4"/>
    <circle cx="4.7" cy="9.5" r="1.7" fill="#47848F"/>
  </g>
  <rect x="10.5" y="10.5" width="11" height="11" rx="3" fill="#1C1F29" stroke="url(#marca)" stroke-width="1.2"/>
  <path d="M14 14l2.6 2-2.6 2" fill="none" stroke="#9FEAF9" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M17.6 18.6h2" fill="none" stroke="#9FEAF9" stroke-width="1.5" stroke-linecap="round" class="cursor"/>
</g>
<text x="262" y="175" class="titulo entra" fill="url(#titulo)">Sloth</text>
<text x="66" y="262" class="sub entra" style="animation-delay:.35s">${t.sub}</text>
<text x="66" y="292" class="sub entra" style="animation-delay:.5s">${t.sub2}</text>
<text x="66" y="328" class="tag entra" style="animation-delay:.8s">${t.tag}</text>
${t.paneles.map((p, i) => panel(i, p, t.estados)).join('\n')}
</svg>
`
}

const DIVISOR = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="24" viewBox="0 0 1200 24">
<defs><linearGradient id="d" x1="0" x2="1"><stop offset="0" stop-color="#47848F" stop-opacity="0"/><stop offset=".5" stop-color="#9FEAF9"/><stop offset="1" stop-color="#47848F" stop-opacity="0"/></linearGradient></defs>
<style>.p{animation:va 5s ease-in-out infinite alternate}@keyframes va{from{transform:translateX(-380px)}to{transform:translateX(380px)}}@media (prefers-reduced-motion: reduce){.p{animation:none}}</style>
<rect x="100" y="11.5" width="1000" height="1" fill="#2A3040"/>
<rect x="420" y="11" width="360" height="2" rx="1" fill="url(#d)" class="p"/>
</svg>
`

for (const t of Object.values(TEXTOS)) writeFileSync(t.archivo, hero(t))
writeFileSync('docs/img/divisor.svg', DIVISOR)
process.stdout.write('docs/img/hero.svg, hero-en.svg y divisor.svg listos\n')
