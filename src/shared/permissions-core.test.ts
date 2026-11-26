import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dentroDelRepo, destructivoDe, findRule, permitirDesdeAviso, ruleFor, ruleMatches, type PermissionRequestLike, type PermissionRule } from './permissions-core'

const CWD = 'C:\\dev\\repo'
const pedido = (tool: string, input: Record<string, unknown>): PermissionRequestLike => ({ id: 'p1', ws: 'w1', tool, input, at: 0, expiresAt: 0 })
const regla = (req: PermissionRequestLike): PermissionRule => ({ ...ruleFor(req), id: 'r1', on: true, createdAt: 0 })

test('dentroDelRepo acepta archivos del repo, con cualquier barra y mayúsculas', () => {
  assert.equal(dentroDelRepo('C:\\dev\\repo\\README.md', CWD), true)
  assert.equal(dentroDelRepo('c:/DEV/repo/src/a.ts', CWD), true)
  assert.equal(dentroDelRepo('src\\a.ts', CWD), true)
  assert.equal(dentroDelRepo('/home/ana/repo/a.ts', '/home/ana/repo'), true)
})

test('dentroDelRepo rechaza lo que cae fuera del repo', () => {
  assert.equal(dentroDelRepo('C:\\Users\\ana\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.cmd', CWD), false)
  assert.equal(dentroDelRepo('C:\\dev\\repo\\..\\otro\\a.ts', CWD), false)
  assert.equal(dentroDelRepo('..\\..\\Users\\ana\\.claude\\settings.json', CWD), false)
  assert.equal(dentroDelRepo('C:\\dev\\repo-vecino\\a.ts', CWD), false)
  assert.equal(dentroDelRepo('D:\\dev\\repo\\a.ts', CWD), false)
  assert.equal(dentroDelRepo('C:\\dev\\repo', CWD), false)
  assert.equal(dentroDelRepo('\\\\servidor\\dev\\repo\\a.ts', CWD), false)
})

test('dentroDelRepo rechaza las carpetas del repo que ejecutan lo que se escribe', () => {
  for (const f of ['.git\\hooks\\pre-commit', '.claude\\settings.json', '.vscode\\tasks.json', '.husky\\pre-push', 'paquete\\.git\\config'])
    assert.equal(dentroDelRepo(`${CWD}\\${f}`, CWD), false, f)
  assert.equal(dentroDelRepo(`${CWD}\\.GIT.\\config`, CWD), false)
  assert.equal(dentroDelRepo(`${CWD}\\.git \\config`, CWD), false)
  assert.equal(dentroDelRepo(`${CWD}\\GIT~1\\config`, CWD), false)
  assert.equal(dentroDelRepo(`${CWD}\\a.ts:oculto`, CWD), false)
  assert.equal(dentroDelRepo(`${CWD}\\.gitignore`, CWD), true)
})

test('la regla de ediciones solo aprueba dentro de la carpeta del espacio', () => {
  const r = regla(pedido('Edit', { file_path: `${CWD}\\README.md` }))
  assert.equal(ruleMatches(r, pedido('Write', { file_path: `${CWD}\\src\\b.ts` }), CWD), true)
  assert.equal(ruleMatches(r, pedido('Write', { file_path: 'C:\\Users\\ana\\Documents\\WindowsPowerShell\\profile.ps1' }), CWD), false)
  assert.equal(ruleMatches(r, pedido('Write', { file_path: `${CWD}\\.git\\hooks\\pre-commit` }), CWD), false)
  assert.equal(ruleMatches(r, pedido('NotebookEdit', { notebook_path: `${CWD}\\n.ipynb` }), CWD), true)
})

test('sin carpeta del espacio o sin ruta en el pedido, la regla de ediciones no aprueba', () => {
  const r = regla(pedido('Edit', { file_path: `${CWD}\\README.md` }))
  assert.equal(ruleMatches(r, pedido('Edit', { file_path: `${CWD}\\README.md` })), false)
  assert.equal(ruleMatches(r, pedido('Edit', {}), CWD), false)
})

test('las reglas de comando y de dominio siguen siendo exactas', () => {
  const cmd = regla(pedido('Bash', { command: 'npm test' }))
  assert.equal(findRule([cmd], pedido('Bash', { command: 'npm test' }), CWD)?.id, 'r1')
  assert.equal(findRule([cmd], pedido('Bash', { command: 'npm test; rm -rf x' }), CWD), undefined)
  const net = regla(pedido('WebFetch', { url: 'https://example.com/a' }))
  assert.equal(findRule([net], pedido('WebFetch', { url: 'https://example.com/b' }))?.id, 'r1')
  assert.equal(findRule([net], pedido('WebFetch', { url: 'https://example.org/' })), undefined)
  assert.equal(findRule([cmd], { ...pedido('Bash', { command: 'npm test' }), ws: 'otro' }, CWD), undefined)
})

test('permitirDesdeAviso: solo comandos cortos que se ven enteros', () => {
  assert.equal(permitirDesdeAviso('cmd', { command: 'npm test' }), true)
  assert.equal(permitirDesdeAviso('cmd', { command: 'x'.repeat(80) }), true)
  assert.equal(permitirDesdeAviso('cmd', { command: 'x'.repeat(81) }), false)
  assert.equal(permitirDesdeAviso('cmd', { command: 'ls\nrm -rf /' }), false)
  assert.equal(permitirDesdeAviso('cmd', { command: 'ls\rrm' }), false)
  assert.equal(permitirDesdeAviso('cmd', {}), false)
  assert.equal(permitirDesdeAviso('edit', { file_path: 'a.ts' }), false)
  assert.equal(permitirDesdeAviso('cmd', { command: 'git commit -m "acción"' }), true)
  assert.equal(permitirDesdeAviso('cmd', { command: 'ls\trm' }), false)
  assert.equal(permitirDesdeAviso('cmd', { command: 'echo ‮gnp.exe' }), false)
  assert.equal(permitirDesdeAviso('cmd', { command: 'rm​ -rf x' }), false)
  assert.equal(permitirDesdeAviso('cmd', { command: 'ls\u001b[2K' }), false)
  assert.equal(permitirDesdeAviso('net', { url: 'https://a.com' }), false)
  assert.equal(permitirDesdeAviso('other', {}), false)
})

const cmd = (command: string): string | null => destructivoDe('cmd', { command })

test('destructivoDe marca los comandos destructivos conocidos', () => {
  const si = [
    'rm -rf node_modules && npm ci',
    'rm -fr build',
    'rm -r dist',
    'rm -f -r dist',
    'rm --recursive dist',
    'sudo rm -rf /var/x',
    'cd x; rm -rf .',
    'git push origin HEAD --force-with-lease',
    'git push --force',
    'git push -f origin main',
    'git push origin main --force-if-includes',
    'git reset --hard HEAD~3',
    'git clean -fdx',
    'git clean -n -f',
    'psql -c "DROP TABLE usuarios"',
    'sqlite3 a.db "drop database x"',
    'psql -c "TRUNCATE TABLE logs"',
    'del /s /q C:\\temp\\*',
    'rmdir /s /q build',
    'Remove-Item -Recurse -Force .\\out',
    'mkfs.ext4 /dev/sdb1',
    'dd if=/dev/zero of=/dev/sda'
  ]
  for (const c of si) assert.notEqual(cmd(c), null, c)
})

test('destructivoDe no marca comandos comunes ni parecidos', () => {
  const no = [
    'rm archivo.txt',
    'rm -i viejo.log',
    'git push origin feat/x',
    'git push -u origin feat/x',
    'git push --follow-tags',
    'git reset --soft HEAD~1',
    'git reset HEAD archivo',
    'git clean -n',
    'git status',
    'npm run format',
    'npm run build -- --force',
    'ls -la',
    'psql -c "SELECT * FROM tabla_drop"',
    'echo dropbox sync',
    'firm -rf x'
  ]
  for (const c of no) assert.equal(cmd(c), null, c)
})

test('destructivoDe solo mira comandos, y los vacíos o raros no rompen', () => {
  assert.equal(destructivoDe('edit', { command: 'rm -rf /' }), null)
  assert.equal(destructivoDe('net', { url: 'https://x.com/rm -rf' }), null)
  assert.equal(destructivoDe('cmd', {}), null)
  assert.equal(destructivoDe('cmd', { command: 42 }), null)
  assert.equal(destructivoDe('cmd', { command: '   ' }), null)
})

test('destructivoDe, límites conocidos: busca texto, no entiende el shell', () => {
  // Falso positivo aceptado: el texto aparece aunque no se ejecute. Es el lado seguro del error.
  assert.notEqual(cmd('echo "rm -rf /"'), null)
  assert.notEqual(cmd('git commit -m "no hagas git reset --hard"'), null)
  // git rm -r también cuenta: se recupera con git, pero el patrón mira solo «rm -r».
  assert.notEqual(cmd('git rm -r src/viejo'), null)
  // Falsos negativos: lo ofuscado o indirecto no se detecta. La etiqueta avisa, no protege.
  assert.equal(cmd('r\\m -rf x'), null)
  assert.equal(cmd('$(echo cm0gLXJmIHg= | base64 -d | sh)'), null)
  assert.equal(cmd('X=rm; $X -rf x'), null)
  assert.equal(cmd('find . -delete'), null)
  assert.equal(cmd('bash borrar.sh'), null)
  assert.equal(cmd('psql -c "DELETE FROM usuarios"'), null)
  assert.equal(cmd('git push origin +main'), null)
  assert.equal(cmd('git checkout -- .'), null)
})
