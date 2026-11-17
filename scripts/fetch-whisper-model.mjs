// Baja el modelo de dictado a vendor/whisper (verificado con SHA-256) para dev y e2e. No lo corre el build
// ni el postinstall, y el instalador lo excluye: la app lo baja sola a userData la primera vez que se dicta.
import { join } from 'node:path'
import { MODELO_BYTES, MODELO_HOSTS, MODELO_SHA256, MODELO_URL, WHISPER_MODEL } from '../src/main/dictado-core.ts'
import { asegurarModelo } from '../src/main/dictado-modelo.ts'
import { depsModeloReales } from '../src/main/dictado-modelo-real.ts'

const destino = join(import.meta.dirname, '..', 'vendor', 'whisper', WHISPER_MODEL)
let ultimo = -1
console.log('whisper: asegurando el modelo (190 MB la primera vez)…')
await asegurarModelo(
  {
    url: MODELO_URL,
    sha256: MODELO_SHA256,
    destino,
    hosts: MODELO_HOSTS,
    maxBytes: 256 * 1024 * 1024,
    bytesAprox: MODELO_BYTES,
    onProgreso: (r, t) => {
      const pct = Math.floor((100 * r) / t / 10) * 10
      if (pct !== ultimo) {
        ultimo = pct
        console.log(`whisper: ${pct} %`)
      }
    }
  },
  depsModeloReales
)
console.log(`whisper: modelo listo en ${destino}`)
