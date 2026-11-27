// Archivos que acompañan al instalador de Tauri en una release de GitHub:
// - latest.json: lo lee el updater de Tauri (instalaciones nuevas).
// - latest.yml: lo lee electron-updater (instalaciones hechas con Electron, para pasarlas a Tauri sin reinstalar).
import { createHash } from 'node:crypto'

export const REPO = 'Toomasmg/sloth'

/** Nombre que Tauri le pone al instalador. */
export const nombreTauri = (version) => `Sloth_${version}_x64-setup.exe`
/** Nombre que espera electron-updater (el de siempre). */
export const nombreElectron = (version) => `Sloth-Setup-${version}.exe`

export function latestJson({ version, notas, firma, fecha }) {
  return {
    version,
    notes: notas,
    pub_date: fecha,
    platforms: {
      'windows-x86_64': {
        signature: firma,
        url: `https://github.com/${REPO}/releases/download/v${version}/${nombreTauri(version)}`
      }
    }
  }
}

export const sha512Base64 = (bytes) => createHash('sha512').update(bytes).digest('base64')

/** latest.yml en el formato de electron-updater, apuntando al mismo instalador con su nombre de siempre. */
export function latestYml({ version, bytes, fecha }) {
  const sha = sha512Base64(bytes)
  const nombre = nombreElectron(version)
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${nombre}`,
    `    sha512: ${sha}`,
    `    size: ${bytes.length}`,
    `path: ${nombre}`,
    `sha512: ${sha}`,
    `releaseDate: '${fecha}'`,
    ''
  ].join('\n')
}
