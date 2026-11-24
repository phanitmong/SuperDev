import FolderInput from '../components/FolderPicker'
import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Dropdown, Form, Input, InputNumber, Modal, Select, Space, Spin, Table, Tag, Typography } from 'antd'
import { KeyOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { BackupCommit, BackupJob, Project } from '@shared/types'
import { JobDrawer, useJob } from '../components/JobLog'
import ConfirmIdentity from '../components/ConfirmIdentity'
import { ago, errText } from '../util'

const NEW_JOB: BackupJob = { name: '', folder: '', repo: '', branch: 'main', schedule: 'daily', hour: 3 }

export default function Backups({ project }: { project: Project }) {
  const { message, modal } = AntApp.useApp()
  const [jobs, setJobs] = useState<BackupJob[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<BackupJob | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [history, setHistory] = useState<{ job: BackupJob; rows: BackupCommit[] | null } | null>(null)
  const [key, setKey] = useState<string | null>(null)
  const [form] = Form.useForm<BackupJob>()
  const schedule = Form.useWatch('schedule', form)
  const job = useJob(`backup:${project.id}`)

  const load = useCallback(async () => {
    try {
      setJobs(await window.api.backup.list(project.id))
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id])

  useEffect(() => {
    void load()
  }, [load])

  const open = (j: BackupJob, fresh: boolean): void => {
    setIsNew(fresh)
    setEditing(j)
    form.setFieldsValue(j)
  }

  const save = async (): Promise<void> => {
    let v: BackupJob
    try {
      v = await form.validateFields()
    } catch {
      return
    }
    try {
      await window.api.backup.save(project.id, { ...editing!, ...v, hour: v.hour ?? 3 })
      setEditing(null)
      await load()
      message.success('Backup saved')
    } catch (err) {
      message.error(errText(err))
    }
  }

  const remove = (j: BackupJob): void => {
    modal.confirm({
      title: `Remove backup "${j.name}"?`,
      content: 'The schedule and the history kept on the server are removed. The folder itself and the remote repository are not touched.',
      okText: 'Remove backup',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.api.backup.remove(project.id, j.name)
        } catch (err) {
          message.error(errText(err))
        }
        await load()
      }
    })
  }

  const [restoring, setRestoring] = useState<{ job: BackupJob; commit: BackupCommit } | null>(null)
  const showHistory = async (j: BackupJob): Promise<void> => {
    setHistory({ job: j, rows: null })
    try {
      setHistory({ job: j, rows: await window.api.backup.history(project.id, j.name) })
    } catch (err) {
      setHistory(null)
      message.error(errText(err))
    }
  }

  const restore = (j: BackupJob, c: BackupCommit): void => setRestoring({ job: j, commit: c })

  const showKey = async (): Promise<void> => {
    try {
      setKey(await window.api.backup.serverKey(project.id))
    } catch (err) {
      message.error(errText(err))
    }
  }

  if (error) {
    return (
      <div className="card">
        <Alert type="error" showIcon message="Could not read the backups" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
      </div>
    )
  }
  if (!jobs) {
    return (
      <div className="empty">
        <Spin />
      </div>
    )
  }

  return (
    <div className="grid">
      <div className="card">
        <div className="card-title">
          Folder backups to git
          <Space>
            <Button size="small" type="text" icon={<ReloadOutlined />} aria-label="Refresh" onClick={() => void load()} />
            <Button icon={<KeyOutlined />} onClick={() => void showKey()}>
              Server SSH key
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => open(NEW_JOB, true)}>
              New backup
            </Button>
          </Space>
        </div>
        <Table<BackupJob>
          rowKey="name"
          size="middle"
          pagination={false}
          dataSource={jobs}
          locale={{ emptyText: <div style={{ padding: '24px 0' }}>No backups yet. Choose a folder and an empty git repository to push it to.</div> }}
          columns={[
            {
              title: 'Backup',
              render: (_, j) => (
                <div>
                  <div style={{ fontWeight: 600 }}>{j.name}</div>
                  <div className="mono" style={{ color: 'var(--muted)', fontSize: 12 }}>
                    {j.folder}
                  </div>
                </div>
              )
            },
            { title: 'Repository', render: (_, j) => <span className="mono" style={{ fontSize: 12 }}>{j.repo} · {j.branch}</span> },
            {
              title: 'Schedule',
              render: (_, j) => (j.schedule === 'off' ? <Tag>Manual</Tag> : <Tag color="blue">{j.schedule === 'hourly' ? 'Every hour' : `Daily at ${j.hour}:23`}</Tag>)
            },
            { title: 'Last backup', render: (_, j) => (j.lastTime ? ago(j.lastTime) : <span style={{ color: 'var(--muted)' }}>Never</span>) },
            {
              title: '',
              align: 'right',
              render: (_, j) => (
                <Space>
                  <Button type="primary" ghost disabled={job.state === 'running'} onClick={() => void job.run(`Back up ${j.name}`, () => window.api.backup.run(project.id, j.name)).then(load)}>
                    Back up now
                  </Button>
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: [
                        { key: 'history', label: 'History and restore' },
                        { key: 'edit', label: 'Edit' },
                        { type: 'divider' },
                        { key: 'remove', label: 'Remove', danger: true }
                      ],
                      onClick: ({ key: k }) => {
                        if (k === 'history') void showHistory(j)
                        if (k === 'edit') open(j, false)
                        if (k === 'remove') remove(j)
                      }
                    }}
                  >
                    <Button>More</Button>
                  </Dropdown>
                </Space>
              )
            }
          ]}
        />
      </div>

      <Modal open={!!editing} title={isNew ? 'New backup' : `Edit ${editing?.name}`} okText="Save" onOk={() => void save()} onCancel={() => setEditing(null)} width={560} destroyOnClose>
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item
            name="name"
            label="Name"
            rules={[
              { required: true, message: 'Give the backup a name' },
              { pattern: /^[A-Za-z0-9_-]{1,40}$/, message: 'Letters, numbers, dash and underscore' }
            ]}
          >
            <Input placeholder="shop-uploads" disabled={!isNew} spellCheck={false} />
          </Form.Item>
          <Form.Item name="folder" label="Folder on the server" rules={[{ required: true, message: 'Enter the folder to back up' }]}>
            <FolderInput projectId={project.id} placeholder="/www/wwwroot/shop/storage" />
          </Form.Item>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 12 }}>
            <Form.Item
              name="repo"
              label="Git repository"
              rules={[{ required: true, message: 'Enter the repository URL' }]}
              extra="Use an empty private repository. Add the server SSH key to it as a deploy key with write access."
            >
              <Input className="mono" placeholder="git@github.com:you/backups.git" spellCheck={false} />
            </Form.Item>
            <Form.Item name="branch" label="Branch">
              <Input className="mono" spellCheck={false} />
            </Form.Item>
          </div>
          <Space align="start">
            <Form.Item name="schedule" label="Schedule">
              <Select
                style={{ width: 180 }}
                options={[
                  { value: 'daily', label: 'Every day' },
                  { value: 'hourly', label: 'Every hour' },
                  { value: 'off', label: 'Only when I press the button' }
                ]}
              />
            </Form.Item>
            {schedule === 'daily' && (
              <Form.Item name="hour" label="At (server time)">
                <InputNumber min={0} max={23} addonAfter=":23" style={{ width: 120 }} />
              </Form.Item>
            )}
          </Space>
        </Form>
      </Modal>

      <Modal open={!!history} title={`History · ${history?.job.name ?? ''}`} footer={null} width={560} onCancel={() => setHistory(null)}>
        {!history?.rows ? (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : history.rows.length === 0 ? (
          <div style={{ color: 'var(--muted)' }}>No backups have been taken yet.</div>
        ) : (
          <table className="plain">
            <tbody>
              {history.rows.map((c) => (
                <tr key={c.hash}>
                  <td className="mono">{c.hash}</td>
                  <td>{c.message}</td>
                  <td className="nowrap" style={{ color: 'var(--muted)' }}>
                    {ago(c.time)}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Button size="small" onClick={() => restore(history.job, c)}>
                      Restore
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>

      <Modal open={key !== null} title="Server SSH key" footer={null} width={600} onCancel={() => setKey(null)}>
        <p>Add this public key to your git host as a deploy key. Backups need write access; git deploys only need read access.</p>
        <Typography.Paragraph className="mono" copyable style={{ fontSize: 12, wordBreak: 'break-all', userSelect: 'text' }}>
          {key}
        </Typography.Paragraph>
      </Modal>
      <ConfirmIdentity
        open={!!restoring}
        title="Confirm it is you"
        about={restoring ? `Files in ${restoring.job.folder} go back to how they were at "${restoring.commit.message}". Changes made to those files since then are lost; files created later are kept. Enter a fresh code to go ahead.` : ''}
        okText="Restore"
        danger
        onCancel={() => setRestoring(null)}
        onProof={async (proof) => {
          if (!restoring) return
          const r = restoring
          // A wrong code throws here and is shown in this dialog; nothing has started yet.
          await window.api.session.confirm(proof, `restore folder backup ${r.job.name} to ${r.commit.hash.slice(0, 8)}`)
          setRestoring(null)
          setHistory(null)
          void job.run(`Restore ${r.job.name}`, () => window.api.backup.restore(project.id, r.job.name, r.commit.hash))
        }}
      />
      <JobDrawer job={job} />
    </div>
  )
}
