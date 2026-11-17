import { execFile } from 'node:child_process'
import type { KillDeps } from './kill-tree'

export function depsReales(): KillDeps {
  return {
    platform: process.platform,
    taskkill: (pid) =>
      new Promise((resolve) => {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve())
      }),
    killGroup: (pid) => process.kill(-pid, 'SIGKILL'),
    killOne: (pid) => process.kill(pid, 'SIGKILL')
  }
}
