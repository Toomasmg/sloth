import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { KillDeps } from './kill-tree'

export function depsReales(): KillDeps {
  return {
    platform: process.platform,
    taskkill: (pid) =>
      new Promise((resolve) => {
        // Ruta absoluta: sin ella Windows busca primero en el cwd y después en un PATH que puede venir recortado.
        const exe = join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'taskkill.exe')
        execFile(exe, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 2500 }, (err) => resolve(!err))
      }),
    killGroup: (pid) => process.kill(-pid, 'SIGKILL'),
    killOne: (pid) => process.kill(pid, 'SIGKILL')
  }
}
