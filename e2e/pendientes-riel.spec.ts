import { test, expect } from './sloth'

const pr = (o: Record<string, unknown>) => ({
  repo: 'acme/api',
  number: 1,
  title: 'Un PR',
  url: 'https://github.com/acme/api/pull/1',
  author: 'yo',
  isDraft: false,
  base: 'staging',
  head: 'feat/x',
  crossRepo: false,
  maintainerCanModify: false,
  headSha: 'abc',
  updatedAt: '2026-01-01T00:00:00Z',
  checks: 'ok',
  checkCounts: { ok: 1, fail: 0, pending: 0 },
  failing: [],
  review: 'none',
  reviewRequestedFromMe: false,
  mine: false,
  mergeable: 'yes',
  mergeState: 'CLEAN',
  ...o
})

const prsSnapshot = (prs: unknown[]) => ({
  problem: null,
  login: 'yo',
  repos: [{ repo: 'acme/api', repoPaths: [], defaultBranch: 'staging', mergeMethods: ['squash'], prs, error: null }],
  at: 1,
  refreshing: false
})

const teamSnapshot = (summary: { ciFailing: number; waitingReview: number; blocked: number }, fetchedAt?: number) => ({
  people: [],
  summary: { ...summary, prs: 0, tickets: 0 },
  unassigned: [],
  personasConector: [],
  authors: [],
  mapping: {},
  github: { repos: [], errors: {}, fetchedAt },
  tickets: { conector: null, running: false, model: '', confirmar: false },
  githubRunning: false
})

test('el riel y la barra avisan de PRs rojos, revisiones pedidas y pendientes de equipo', async ({ sloth: { app, page } }) => {
  const enviar = (canal: string, dato: unknown): Promise<void> =>
    app.evaluate(({ BrowserWindow }, [c, d]) => BrowserWindow.getAllWindows()[0].webContents.send(c as string, d), [canal, dato])
  const riel = page.getByRole('navigation', { name: 'Navegación' })
  const chip = page.locator('.sl-sum.is-danger')

  await expect(riel.getByRole('button', { name: 'PRs', exact: true })).toBeVisible()
  await expect(chip).toHaveCount(0)

  await enviar(
    'feat:prs:updated',
    prsSnapshot([
      pr({ number: 1, mine: true, checks: 'fail', failing: [{ name: 'build', url: null }] }),
      pr({ number: 2, reviewRequestedFromMe: true, review: 'required' }),
      pr({ number: 3, reviewRequestedFromMe: true, isDraft: true })
    ])
  )
  await expect(riel.getByRole('button', { name: 'PRs, 1 tuyo con CI fallando, 1 te pide revisión' })).toBeVisible()
  await expect(chip).toHaveText('1 PR rojo')
  await expect(chip).toHaveAccessibleName(/1 PR tuyo con CI fallando/)
  // Sin lectura de GitHub en Equipo, el riel usa lo guardado de PRs.
  await expect(riel.getByRole('button', { name: /^Equipo, 1 PR con CI fallando/ })).toBeVisible()

  const destino = process.env.SLOTH_CAPTURA_RIEL
  if (destino) await page.screenshot({ path: `${destino}-prs.png`, clip: { x: 0, y: 0, width: 1280, height: 420 } })

  await enviar('feat:team:changed', teamSnapshot({ ciFailing: 2, waitingReview: 1, blocked: 1 }, 5))
  await expect(riel.getByRole('button', { name: 'Equipo, 2 PRs con CI fallando, 1 ticket bloqueado, 1 esperando review' })).toBeVisible()

  await enviar('feat:prs:updated', prsSnapshot([pr({ number: 2, reviewRequestedFromMe: true })]))
  await expect(riel.getByRole('button', { name: 'PRs, 1 te pide revisión' })).toBeVisible()
  await expect(chip).toHaveCount(0)

  await enviar('feat:prs:updated', prsSnapshot([]))
  await expect(riel.getByRole('button', { name: 'PRs', exact: true })).toBeVisible()
})
