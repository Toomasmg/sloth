// Arma la página del celu para GitHub Pages en out/celu-web: la página del Wi-Fi (celular-pagina.ts) más el
// adaptador remoto (remoto.js), el service worker, el manifest y los íconos. No entra en `npm run build`.
import { build } from 'rolldown'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
  "img-src 'self'; connect-src 'self' https: wss:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'"

function reemplazar(html, de, a) {
  if (!html.includes(de)) throw new Error(`build-celu-web: la página de celular-pagina.ts ya no tiene «${de}»; revisá armarIndex`)
  return html.split(de).join(a)
}

/** Transforma el HTML del Wi-Fi para servirlo desde una carpeta estática. Solo texto: no toca el archivo original. */
export function armarIndex(html) {
  let h = html
  h = reemplazar(h, '<link rel="manifest" href="/manifest.webmanifest">', '<link rel="manifest" href="./manifest.webmanifest">')
  h = reemplazar(h, '<link rel="apple-touch-icon" href="/icono.png">', '<link rel="apple-touch-icon" href="./iconos/apple-touch-icon.png">')
  h = reemplazar(h, '<link rel="icon" href="/icono.png">', '<link rel="icon" type="image/png" sizes="32x32" href="./iconos/favicon-32.png">')
  h = reemplazar(h, '<link rel="stylesheet" href="/app.css">', '<link rel="stylesheet" href="./app.css">\n<link rel="stylesheet" href="./remoto.css">')
  h = reemplazar(h, '<script src="/app.js"></script>', '<script src="./remoto.js"></script>\n<script src="./app.js"></script>')
  h = reemplazar(h, '<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${CSP}">`)
  if (!h.includes('name="theme-color" content="#08090B"')) throw new Error('build-celu-web: falta el theme-color #08090B en la página')
  if (/(?:href|src)="\//.test(h)) throw new Error('build-celu-web: quedó una ruta absoluta en el index')
  return h
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const web = join(root, 'src', 'celu-web')
  const out = join(root, 'out', 'celu-web')
  const { PAGINA_HTML, PAGINA_CSS, PAGINA_JS } = await import(pathToFileURL(join(root, 'src', 'main', 'features', 'celular-pagina.ts')).href)

  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })

  const bundle = (entrada, archivo, define) =>
    build({
      input: join(web, entrada),
      platform: 'browser',
      logLevel: 'warn',
      ...(define ? { transform: { define } } : {}),
      output: { file: join(out, archivo), format: 'iife', codeSplitting: false, minify: true, sourcemap: false }
    })
  await bundle('remoto.ts', 'remoto.js')

  writeFileSync(join(out, 'app.css'), PAGINA_CSS)
  writeFileSync(join(out, 'app.js'), PAGINA_JS)
  writeFileSync(join(out, 'index.html'), armarIndex(PAGINA_HTML))
  for (const f of ['remoto.css', 'manifest.webmanifest']) cpSync(join(web, f), join(out, f))
  cpSync(join(web, 'iconos'), join(out, 'iconos'), { recursive: true })
  writeFileSync(join(out, '.nojekyll'), '')

  // El nombre del cache cambia con el contenido: un deploy nuevo borra el cache viejo al activarse.
  const hash = createHash('sha256')
  for (const f of ['index.html', 'app.css', 'app.js', 'remoto.js', 'remoto.css', 'manifest.webmanifest']) hash.update(readFileSync(join(out, f)))
  await bundle('sw.ts', 'sw.js', { __CELU_CACHE__: JSON.stringify(`sloth-celu-${hash.digest('hex').slice(0, 12)}`) })
  console.log(`celu-web: ${out}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
