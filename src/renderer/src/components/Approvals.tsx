import { useEffect, useState } from 'react'
import { App as AntApp, Button, Modal, Spin } from 'antd'
import type { ApprovalRequest, ApprovalWaiting, SessionUser } from '@shared/team'
import { APPROVAL_MINUTES } from '@shared/team'
import { ago, errText } from '../util'

/** Plain words for the actions that can wait for approval. */
const WORDS: Record<string, string> = {
  'db:drop': 'Delete a database',
  'pg:drop': 'Delete a PostgreSQL database',
  'mongo:drop': 'Delete a MongoDB database',
  'mongo:restore': 'Restore a MongoDB database from a backup',
  'dbc:dropDatabase': 'Delete a database',
  'db:restore': 'Restore a database from a backup',
  'pg:restore': 'Restore a PostgreSQL database from a backup',
  'backup:restore': 'Restore a folder from a backup',
  'server:shutdown': 'Shut the server down',
  'server:reboot': 'Restart the server',
  'sites:remove': 'Remove a site',
  'projects:remove': 'Remove a server from the app',
  'firewall:setEnabled': 'Switch the firewall off',
  'apps:uninstall': 'Uninstall an app from the server'
}

function Detail({ r }: { r: { action: string; project?: string; target?: string } }) {
  return (
    <dl className="kv" style={{ gridTemplateColumns: '90px minmax(0, 1fr)' }}>
      <dt>Action</dt>
      <dd style={{ whiteSpace: 'normal' }}>
        {WORDS[r.action] ?? r.action} <span className="mono" style={{ color: 'var(--muted)', fontSize: 12 }}>{r.action}</span>
      </dd>
      {r.project && (
        <>
          <dt>Server</dt>
          <dd>{r.project}</dd>
        </>
      )}
      {r.target && (
        <>
          <dt>What</dt>
          <dd className="mono" style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>
            {r.target}
          </dd>
        </>
      )}
    </dl>
  )
}

/** Two dialogs: "your request is waiting", and for admins "someone asks for your approval". */
export default function Approvals({ me }: { me: SessionUser }) {
  const { message } = AntApp.useApp()
  const [waiting, setWaiting] = useState<ApprovalWaiting | null>(null)
  const [pending, setPending] = useState<ApprovalRequest[]>([])
  const [later, setLater] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => window.api.approval.onWaiting(setWaiting), [])
  useEffect(() => {
    if (me.role !== 'admin') return
    window.api.approval
      .list()
      .then(setPending)
      .catch(() => undefined)
    return window.api.approval.onPending(setPending)
  }, [me.role])

  const first = pending.find((r) => !later.includes(r.id))
  const decide = async (approve: boolean): Promise<void> => {
    if (!first) return
    setBusy(true)
    try {
      await window.api.approval.decide(first.id, approve)
      message.success(approve ? `Approved. It now runs for ${first.user}.` : `Refused. Nothing was done.`)
    } catch (err) {
      message.error(errText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Modal
        open={!!waiting}
        title="Waiting for another admin to approve"
        closable={false}
        maskClosable={false}
        keyboard={false}
        footer={
          <Button onClick={() => waiting && void window.api.approval.cancel(waiting.id)}>
            Cancel the request
          </Button>
        }
      >
        {waiting && <Detail r={waiting} />}
        <p style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
          <Spin size="small" />
          <span>Every admin who is signed in sees this request now. It starts by itself once one of them approves, and runs out after {APPROVAL_MINUTES} minutes.</span>
        </p>
      </Modal>

      <Modal
        open={!!first && !waiting}
        title={first ? `${first.user} asks for your approval` : ''}
        onCancel={() => first && setLater([...later, first.id])}
        maskClosable={false}
        footer={
          <>
            <Button onClick={() => first && setLater([...later, first.id])}>Decide later</Button>
            <Button danger loading={busy} onClick={() => void decide(false)}>
              Refuse
            </Button>
            <Button type="primary" loading={busy} onClick={() => void decide(true)}>
              Approve
            </Button>
          </>
        }
      >
        {first && <Detail r={first} />}
        {first && (
          <p style={{ color: 'var(--muted)', marginTop: 12 }}>
            Asked {ago(first.time).toLowerCase()} from {first.ip}. Approve only if you know why {first.user} needs this. If in doubt, ask them directly first.
          </p>
        )}
      </Modal>
    </>
  )
}
