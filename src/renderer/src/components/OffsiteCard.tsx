import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Input, InputNumber, Select, Space, Tag } from 'antd'
import type { OffsiteStatus, Project } from '@shared/types'
import { JobDrawer, useJob } from './JobLog'
import { errText } from '../util'

/** Database backups copied to another server, so losing this one does not lose them. */
export default function OffsiteCard({ project, projects, canChange }: { project: Project; projects: Project[]; canChange: boolean }) {
  const { message, modal } = AntApp.useApp()
  const [status, setStatus] = useState<OffsiteStatus | null>(null)
  const [toId, setToId] = useState<string>()
  const [keep, setKeep] = useState(30)
  const [address, setAddress] = useState('')
  const job = useJob(`offsite:${project.id}`)
  const others = projects.filter((p) => p.id !== project.id)
  const target = others.find((p) => p.id === toId)

  const load = useCallback(async () => {
    try {
      setStatus(await window.api.db.offsiteStatus(project.id))
    } catch {
      setStatus(null)
    }
  }, [project.id])

  useEffect(() => void load(), [load])

  const start = (): void => {
    if (!target) return
    modal.confirm({
      title: `Copy database backups to ${target.name}?`,
      width: 520,
      content: (
        <div>
          <p>
            {project.name} gets its own SSH key. On {target.name} a separate account named <span className="mono">sdbackup</span> is created that can do nothing except hold these files.
          </p>
          <p>Every hour, backups that are not there yet are copied. Copies older than {keep} days are removed from {target.name}.</p>
          <p>
            {project.name} must be able to reach <span className="mono">{address.trim() || target.host}</span> on port {target.port}.
          </p>
        </div>
      ),
      okText: 'Set up',
      onOk: () => {
        void job.run(`Copies on ${target.name}`, () => window.api.db.offsiteEnable(project.id, target.id, keep, address.trim() || undefined)).then(() => load())
      }
    })
  }

  const stop = (): void => {
    modal.confirm({
      title: 'Stop copying backups to the other server?',
      content: 'Copies that are already there stay there. New backups will exist on this server only.',
      okText: 'Stop copying',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.api.db.offsiteDisable(project.id)
          message.success('Stopped')
        } catch (err) {
          message.error(errText(err))
        }
        void load()
      }
    })
  }

  return (
    <div className="card">
      <div className="card-title">
        <span>Copies on another server</span>
        {status?.enabled && <Tag color={status.failing ? 'red' : 'green'}>{status.failing ? 'Last copy failed' : 'On'}</Tag>}
      </div>
      {status?.enabled ? (
        <>
          <p style={{ margin: '0 0 10px' }}>
            Every hour, new backups are copied to <b>{status.label || status.host}</b> (<span className="mono">{status.folder}</span>) and kept there for {status.keepDays} days. {status.copied} of the {status.local} backups on this server have a copy there.
          </p>
          {status.failing && <Alert type="error" showIcon style={{ marginBottom: 10 }} message="The last run could not copy everything. Check that the other server is up and reachable from this one, then use Copy now." />}
          {status.last && <p className="mono" style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--muted)' }}>{status.last}</p>}
          {canChange && (
            <Space>
              <Button onClick={() => void job.run('Copy backups now', () => window.api.db.offsiteRun(project.id)).then(() => load())}>Copy now</Button>
              <Button danger onClick={stop}>
                Stop copying
              </Button>
            </Space>
          )}
        </>
      ) : (
        <>
          <p style={{ margin: '0 0 12px', color: 'var(--muted)', maxWidth: '78ch' }}>
            The backups above sit on the same disk as the databases. If this server is lost, they are lost with it. Pick another of your servers and this one sends it a copy of every backup.
          </p>
          {others.length === 0 ? (
            <Alert type="info" showIcon message="Add a second server under Projects first." />
          ) : canChange ? (
            <Space wrap align="center">
              <Select style={{ width: 220 }} placeholder="Send copies to" value={toId} onChange={setToId} options={others.map((p) => ({ value: p.id, label: p.name }))} aria-label="Server that receives the copies" />
              <span>keep them there for</span>
              <InputNumber min={1} max={3650} value={keep} onChange={(v) => setKeep(v ?? 30)} addonAfter="days" style={{ width: 130 }} aria-label="Days to keep copies" />
              <Input style={{ width: 230 }} className="mono" placeholder={target ? `${target.host} (or a private address)` : 'Address, if different'} value={address} onChange={(e) => setAddress(e.target.value)} aria-label="Address of the other server as seen from this one" />
              <Button type="primary" disabled={!target} onClick={start}>
                Set up
              </Button>
            </Space>
          ) : (
            <Alert type="info" showIcon message="An Admin or IT Support person can set this up." />
          )}
        </>
      )}
      <JobDrawer job={job} />
    </div>
  )
}
