import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Arma docs/img/demo.gif con los cuadros de `demo.spec.ts`. ffmpeg no viene con el repo: se usa el del
// PATH o el que diga FFMPEG (p. ej. el binario de `npm i ffmpeg-static` en otra carpeta).
const DIR = 'test-results/readme-cuadros'
const SALIDA = 'docs/img/demo.gif'
const ANCHO = 960
const FPS = 15
const ffmpeg = process.env.FFMPEG || 'ffmpeg'

const cuadros = JSON.parse(readFileSync(join(DIR, 'cuadros.json'), 'utf8'))
// El screencast solo manda un cuadro cuando cambia algo: cada uno dura hasta que llega el siguiente.
const lineas = []
for (let i = 0; i < cuadros.length; i++) {
  const dur = i + 1 < cuadros.length ? Math.max(cuadros[i + 1].t - cuadros[i].t, 0.001) : 2
  lineas.push(`file '${resolve(DIR, cuadros[i].archivo).replace(/\\/g, '/')}'`, `duration ${dur.toFixed(3)}`)
}
lineas.push(`file '${resolve(DIR, cuadros.at(-1).archivo).replace(/\\/g, '/')}'`)
const lista = join(DIR, 'lista.txt')
writeFileSync(lista, lineas.join('\n'))

const filtro = `fps=${FPS},scale=${ANCHO}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lista, '-filter_complex', filtro, '-loop', '0', SALIDA], { stdio: 'inherit' })
process.stdout.write(`${SALIDA} listo\n`)
