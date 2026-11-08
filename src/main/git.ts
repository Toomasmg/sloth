import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { windowsHide: true })
  return stdout.trim()
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    return (await git(path, ['rev-parse', '--is-inside-work-tree'])) === 'true'
  } catch {
    return false
  }
}

function sanitize(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'rama'
}

/**
 * Crea un worktree junto al repo: `<padre>/<repo>-worktrees/<rama>`.
 * Usa la rama si ya existe; si no, la crea desde el HEAD actual.
 */
export async function createWorktree(repoPath: string, branch: string, base?: string): Promise<string> {
  if (!(await isGitRepo(repoPath))) throw new Error(`${repoPath} no es un repositorio git`)
  const target = join(dirname(repoPath), `${basename(repoPath)}-worktrees`, sanitize(branch))
  if (existsSync(target)) throw new Error(`Ya existe la carpeta ${target}`)
  let branchExists = true
  try {
    await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  } catch {
    branchExists = false
  }
  // Rama nueva: se crea desde la base elegida (o desde HEAD si no hay).
  const args = branchExists ? ['worktree', 'add', target, branch] : ['worktree', 'add', '-b', branch, target, ...(base ? [base] : [])]
  try {
    await git(repoPath, args)
  } catch (e) {
    const err = e as { stderr?: string; message: string }
    throw new Error(`git worktree falló: ${err.stderr?.trim() || err.message}`)
  }
  return target
}
