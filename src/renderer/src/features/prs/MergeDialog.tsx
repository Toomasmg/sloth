import { useEffect, useState } from 'react'
import { Modal } from '../../Modal'
import { Button, InlineAlert, Select, Tag, toast } from '../../ui'
import { useUi } from '../host'
import type { MergeMethod, PrRow, RepoPrs } from '../../../../shared/prs'
import { mergeBlocker, methodLabel } from './model'

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function MergeDialog({ repo, pr, onClose, onDone }: { repo: RepoPrs; pr: PrRow; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const ui = useUi()
  const target = { repo: repo.repo, number: pr.number }
  const methods = repo.mergeMethods
  const [method, setMethod] = useState<MergeMethod>(methods[0] ?? 'squash')
  const [command, setCommand] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const blocker = mergeBlocker(pr)

  useEffect(() => {
    let live = true
    setCommand(null)
    ui.invoke<string[]>('feat:prs:mergeCommand', target, method).then(
      (c) => live && setCommand(c),
      (e) => live && setError(msg(e))
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, repo.repo, pr.number])

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await ui.invoke('feat:prs:merge', target, method)
      toast({ tone: 'success', message: `#${pr.number} mergeado` })
      onDone()
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
          <Button variant="danger" loading={busy} onClick={() => void submit()}>
            Mergear
          </Button>
        </>
      }
    >
      <div className="f-prs-dialog">
        <p className="f-prs-dialog-title">{pr.title}</p>
        <p>
          <Tag>
            {pr.base} ← {pr.head}
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
        {blocker && <InlineAlert tone="warning">{blocker} GitHub decide si lo deja pasar.</InlineAlert>}
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      </div>
    </Modal>
  )
}

export function RebaseDialog({ repo, pr, onClose }: { repo: RepoPrs; pr: PrRow; onClose: () => void }): React.JSX.Element {
  const ui = useUi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasWorkspace = ui.workspaces.some((w) => w.branch === pr.head)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await ui.invoke('feat:prs:rebase', { repo: repo.repo, number: pr.number })
      toast({ tone: 'success', message: `#${pr.number} rebaseado sobre ${pr.base}` })
      onClose()
    } catch (e) {
      setError(msg(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      size="sm"
      title={`Rebase de ${pr.head} sobre ${pr.base}`}
      locked={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void submit()}>
            Hacer rebase
          </Button>
        </>
      }
    >
      <div className="f-prs-dialog">
        <p>Se hace en GitHub y reescribe la rama remota.</p>
        {hasWorkspace && <p>Tu espacio en esta rama va a tener que traer los cambios.</p>}
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      </div>
    </Modal>
  )
}
