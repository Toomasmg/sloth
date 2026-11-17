import { access, mkdir, open, rename, rm } from 'node:fs/promises'
import type { ModeloDeps } from './dictado-modelo'

export const depsModeloReales: ModeloDeps = {
  fetch: (url, init) => fetch(url, init),
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true })
  },
  abrir: async (path) => {
    const fh = await open(path, 'w')
    return {
      write: (chunk) => fh.write(chunk).then(() => undefined),
      close: () => fh.close()
    }
  },
  rename,
  rm: (path) => rm(path, { force: true }),
  existe: (path) =>
    access(path).then(
      () => true,
      () => false
    ),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}
