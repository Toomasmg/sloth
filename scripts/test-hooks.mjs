// Vite resuelve './x' a x.ts; Node no. Este hook hace lo mismo solo para correr los tests con el type stripping nativo.
import { registerHooks } from 'node:module'

const REL = /^\.{1,2}\//
const CON_EXT = /\.[cm]?[jt]sx?$|\.json$/
const NO_ENCONTRADO = ['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT']

registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx)
    } catch (e) {
      if (!NO_ENCONTRADO.includes(e?.code) || !REL.test(spec) || CON_EXT.test(spec)) throw e
      for (const ext of ['.ts', '/index.ts']) {
        try {
          return next(spec + ext, ctx)
        } catch {
          /* sigue */
        }
      }
      throw e
    }
  }
})
