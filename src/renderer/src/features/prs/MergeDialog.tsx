import { useEffect, useState } from 'react'
import { Modal } from '../../Modal'
import { Button, InlineAlert, Select, Tag, toast } from '../../ui'
import { useUi } from '../host'
import type { MergeMethod, OpenBranchMode, OpenBranchResult, PrRow, RepoPrs } from '../../../../shared/prs'
import { mergeBlocker, methodLabel, samePath } from './model'

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface SeenProps {
  repo: RepoPrs
  /** El PR tal como estaba al abrir el diálogo. */
  pr: PrRow
  /** El mismo PR en la lista actual; null si ya no está. */
  live: PrRow | null
  onClose: () => void
}

/** Lo que se confirma es lo que se vio: si el PR cambió con el diálogo abierto, hay que volver a mirarlo. */
function useSeen(pr: PrRow, live: PrRow | null): { seen: PrRow; stale: string | null; accept: (() => void) | null } {
  const [seen, setSeen] = useState(pr)
  if (!live) return { seen, stale: 'El PR ya no está abierto o no se pudo leer. Cerrá y refrescá.', accept: null }
  if (live.headSha === seen.headSha) return { seen, stale: null, accept: null }
  return { seen, stale: 'El PR cambió mientras mirabas: tiene otro commit. Revisalo antes de confirmar.', accept: () => setSeen(live) }
}

function StaleAlert({ stale, accept }: { stale: string; accept: (() => void) | null }): React.JSX.Element {
  return (
    <InlineAlert
      tone="warning"
      action={
        accept ? (
          <Button size="sm" onClick={accept}>
            Ver el nuevo
          </Button>
        ) : undefined
      }
    >
      {stale}
    </InlineAlert>
  )
}

export function MergeDialog({ repo, pr, live, onClose }: SeenProps): React.JSX.Element {
  const ui = useUi()
  const { seen, stale, accept } = useSeen(pr, live)
  const target = { repo: repo.repo, number: pr.number }
  const methods = repo.mergeMethods
  const [method, setMethod] = useState<MergeMethod>(methods[0] ?? 'squash')
  const [command, setCommand] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const blocker = mergeBlocker(seen)

  useEffect(() => {
    let alive = true
    setCommand(null)
    setError(null)
    ui.invoke<string[]>('feat:prs:mergeCommand', target, method, seen.headSha).then(
      (c) => alive && setCommand(c),
      (e) => alive && setError(msg(e))
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, repo.repo, pr.number, seen.headSha])

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await ui.invoke('feat:prs:merge', target, method, seen.headSha)
      toast({ tone: 'success', message: `#${pr.number} mergeado` })
      onClose()
    } catch (e) {
      setError(msg(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      size="md"
      title={`Mergear #${pr.number}`}
      locked={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="danger" loading={busy} disabled={!!stale || !command} onClick={() => void submit()}>
            Mergear
          </Button>
        </>
      }
    >
      <div className="f-prs-dialog">
        <p className="f-prs-dialog-title">{seen.title}</p>
        <p>
          <Tag>
            {seen.base} ← {seen.head}
          </Tag>
        </p>
        <label className="f-prs-field">
          <span>Método</span>
          {methods.length > 1 ? (
            <Select value={method} onChange={(e) => setMethod(e.target.value as MergeMethod)} options={methods.map((m) => ({ value: m, label: methodLabel(m) }))} />
          ) : (
            <strong>{methodLabel(method)}</strong>
          )}
        </label>
        <div className="f-prs-field">
          <span>Comando</span>
          <code className="f-prs-code">{command ? command.join(' ') : '…'}</code>
        </div>
        {stale && <StaleAlert stale={stale} accept={accept} />}
        {blocker && <InlineAlert tone="warning">{blocker} GitHub decide si lo deja pasar.</InlineAlert>}
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      </div>
    </Modal>
  )
}

export function RebaseDialog({ repo, pr, live, onClose }: SeenProps): React.JSX.Element {
  const ui = useUi()
  const { seen, stale, accept } = useSeen(pr, live)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasWorkspace = ui.workspaces.some((w) => w.branch === seen.head && repo.repoPaths.some((p) => samePath(p, w.repoPath)))

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await ui.invoke('feat:prs:rebase', { repo: repo.repo, number: pr.number }, seen.headSha)
      toast({ tone: 'success', message: `#${pr.number} rebaseado sobre ${seen.base}` })
      onClose()
    } catch (e) {
      setError(msg(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      size="sm"
      title={`Rebase de ${seen.head} sobre ${seen.base}`}
      locked={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="danger" loading={busy} disabled={!!stale} onClick={() => void submit()}>
            Hacer rebase
          </Button>
        </>
      }
    >
      <div className="f-prs-dialog">
        <p>Se hace en GitHub y reescribe la rama remota.</p>
        {hasWorkspace && <p>Tu espacio en esta rama va a tener que traer los cambios.</p>}
        {stale && <StaleAlert stale={stale} accept={accept} />}
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      </div>
    </Modal>
  )
}

type Diverged = Extract<OpenBranchResult, { kind: 'diverged' }>

export function DivergedDialog({ info, onPick, onClose }: { info: Diverged; onPick: (mode: OpenBranchMode) => Promise<void>; onClose: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState<OpenBranchMode | null>(null)
  const pick = async (mode: OpenBranchMode): Promise<void> => {
    setBusy(mode)
    try {
      await onPick(mode)
    } finally {
      setBusy(null)
    }
  }
  const mine = info.ahead === 1 ? '1 commit que el PR no tiene' : `${info.ahead} commits que el PR no tiene`
  const missing = info.behind === 0 ? '' : info.behind === 1 ? ' y le falta 1 del PR' : ` y le faltan ${info.behind} del PR`

  return (
    <Modal
      size="sm"
      title={`Tu rama ${info.branch} no coincide con el PR`}
      locked={busy !== null}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" disabled={busy !== null} onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="secondary" loading={busy === 'local'} disabled={busy !== null} onClick={() => void pick('local')}>
            Usar mi rama local
          </Button>
          <Button variant="primary" loading={busy === 'copy'} disabled={busy !== null} onClick={() => void pick('copy')}>
            Abrir en {info.copy}
          </Button>
        </>
      }
    >
      <div className="f-prs-dialog">
        <p>
          Tu rama local tiene {mine}
          {missing}.
        </p>
        <p>«Abrir en {info.copy}» crea una rama nueva desde el PR y deja la tuya como está. No se borra ni se pisa nada.</p>
      </div>
    </Modal>
  )
}
