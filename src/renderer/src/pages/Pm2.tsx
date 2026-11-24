import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, App as AntApp, Button, Dropdown, Form, Input, Modal, Select, Space, Spin, Table, Tag } from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { Pm2Action, Pm2Overview, Pm2Process, Pm2StartInput, Project } from '@shared/types'
import { JobDrawer, useJob } from '../components/JobLog'
import { bytes, duration, errText } from '../util'

const STATUS_COLOR: Record<string, string> = { online: 'green', stopped: 'default', stopping: 'orange', launching: 'blue', errored: 'red' }

export default function Pm2({ project }: { project: Project }) {
  const { message, modal } = AntApp.useApp()
  const [user, setUser] = useState(project.username)
  const [data, setData] = useState<Pm2Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [logs, setLogs] = useState<{ proc: Pm2Process; text: string | null } | null>(null)
  const [form] = Form.useForm<Pm2StartInput>()
  const job = useJob(`pm2:${project.id}`)
  const paused = useRef(false)

  const load = useCallback(async () => {
    try {
      setData(await window.api.pm2.overview(project.id, user))
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id, user])

  // Refresh CPU and memory every few seconds while the page is open.
  useEffect(() => {
    setData(null)
    void load()
    const t = setInterval(() => {
      if (!paused.current) void load()
    }, 5000)
    return () => clearInterval(t)
  }, [load])

  const act = async (p: Pm2Process, what: Pm2Action): Promise<void> => {
    setBusy(p.id)
    paused.current = true
    try {
      await window.api.pm2.action(project.id, user, p.id, what)
      message.success(`${p.name}: ${what === 'delete' ? 'removed' : what + ' done'}`)
    } catch (err) {
      message.error(errText(err))
    }
    await load()
    paused.current = false
    setBusy(null)
  }

  const confirmDelete = (p: Pm2Process): void => {
    modal.confirm({
      title: `Remove "${p.name}" from PM2?`,
      content: 'The app is stopped and taken off the list. Its files are not touched.',
      okText: 'Remove',
      okButtonProps: { danger: true },
      onOk: () => act(p, 'delete')
    })
  }

  const showLogs = async (p: Pm2Process): Promise<void> => {
    setLogs({ proc: p, text: null })
    try {
      const text = await window.api.pm2.logs(project.id, user, p.id, 300)
      setLogs({ proc: p, text })
    } catch (err) {
      setLogs(null)
      message.error(errText(err))
    }
  }

  const start = async (): Promise<void> => {
    let v: Pm2StartInput
    try {
      v = await form.validateFields()
    } catch {
      return
    }
    setAdding(false)
    paused.current = true
    const ok = await job.run(`Start ${v.name}`, () => window.api.pm2.start(project.id, user, v))
    if (ok) form.resetFields()
    await load()
    paused.current = false
  }

  const userOptions = [...new Set(['root', project.username, ...(data?.users ?? []), user])].map((u) => ({ value: u, label: u }))

  if (error && !data) {
    return (
      <div className="card">
        <Alert type="error" showIcon message="Could not read PM2" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
      </div>
    )
  }
  if (!data) {
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
          <Space wrap>
            PM2 apps of
            <Select size="small" style={{ width: 150 }} value={user} onChange={setUser} options={userOptions} aria-label="Linux user" />
            {data.installed && <Tag>PM2 {data.pm2Version}</Tag>}
            {data.nodeVersion && <Tag>Node {data.nodeVersion}</Tag>}
          </Space>
          {data.installed && (
            <Space>
              <Button size="small" type="text" icon={<ReloadOutlined />} aria-label="Refresh" onClick={() => void load()} />
              <Button onClick={() => void job.run('Start on boot', () => window.api.pm2.startOnBoot(project.id, user))}>Start on boot</Button>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
                New app
              </Button>
            </Space>
          )}
        </div>

        {!data.installed ? (
          <Alert
            type="info"
            showIcon
            message={`PM2 was not found for the user "${user}".`}
            description="PM2 keeps Node.js apps running and restarts them if they crash. Installing adds Node.js (if missing) and PM2 for the whole server."
            action={
              <Button type="primary" disabled={!data.packageManager && !data.nodeVersion} onClick={() => void job.run('Install PM2', () => window.api.pm2.install(project.id)).then(load)}>
                Install PM2
              </Button>
            }
          />
        ) : (
          <Table<Pm2Process>
            rowKey="id"
            size="middle"
            pagination={false}
            dataSource={data.processes}
            locale={{ emptyText: <div style={{ padding: '24px 0' }}>No apps are managed by PM2 for this user yet.</div> }}
            columns={[
              {
                title: 'App',
                render: (_, p) => (
                  <div>
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    <div className="mono" style={{ color: 'var(--muted)', fontSize: 12 }}>
                      {p.cwd}
                    </div>
                  </div>
                )
              },
              { title: 'Status', render: (_, p) => <Tag color={STATUS_COLOR[p.status] ?? 'default'}>{p.status}</Tag> },
              { title: 'CPU', render: (_, p) => (p.status === 'online' ? `${p.cpu}%` : '-') },
              { title: 'Memory', render: (_, p) => (p.status === 'online' ? bytes(p.memory) : '-') },
              { title: 'Up for', render: (_, p) => (p.status === 'online' && p.startedAt ? duration(Math.max(0, (Date.now() - p.startedAt) / 1000)) : '-') },
              { title: 'Restarts', dataIndex: 'restarts' },
              {
                title: '',
                align: 'right',
                render: (_, p) => (
                  <Space>
                    {p.status === 'online' ? (
                      <>
                        <Button loading={busy === p.id} onClick={() => void act(p, 'restart')}>
                          Restart
                        </Button>
                        <Button disabled={busy === p.id} onClick={() => void act(p, 'stop')}>
                          Stop
                        </Button>
                      </>
                    ) : (
                      <Button type="primary" ghost loading={busy === p.id} onClick={() => void act(p, 'start')}>
                        Start
                      </Button>
                    )}
                    <Button onClick={() => void showLogs(p)}>Logs</Button>
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: [
                          { key: 'reload', label: 'Reload (no downtime in cluster mode)', disabled: p.status !== 'online' },
                          { type: 'divider' },
                          { key: 'delete', label: 'Remove from PM2', danger: true }
                        ],
                        onClick: ({ key }) => (key === 'delete' ? confirmDelete(p) : void act(p, 'reload'))
                      }}
                    >
                      <Button aria-label={`More actions for ${p.name}`}>More</Button>
                    </Dropdown>
                  </Space>
                )
              }
            ]}
          />
        )}
        {data.installed && (
          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 12 }}>
            Each Linux user has its own PM2 list. Every change is saved, so "Start on boot" brings back what is running now. Deploys run as root: in a
            site's post-deploy commands use <span className="mono">sudo -iu {user === 'root' ? 'USER' : user} pm2 reload NAME</span> to reach this list.
          </div>
        )}
      </div>

      <Modal open={adding} title="New PM2 app" okText="Start app" onOk={() => void start()} onCancel={() => setAdding(false)} width={540}>
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item
            name="name"
            label="App name"
            rules={[
              { required: true, message: 'Give the app a name' },
              { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/, message: 'Letters, numbers, dot, dash, underscore' }
            ]}
          >
            <Input placeholder="api" spellCheck={false} />
          </Form.Item>
          <Form.Item name="cwd" label="App folder on the server" rules={[{ required: true, message: 'Enter the folder that holds the app' }]}>
            <Input className="mono" placeholder="/www/wwwroot/api" spellCheck={false} />
          </Form.Item>
          <Form.Item
            name="command"
            label="What to run"
            rules={[{ required: true, message: 'Enter a script or an npm command' }]}
            extra={`A script file (app.js, dist/main.js, ecosystem.config.js) or an npm command (npm run start). It runs as "${user}".`}
          >
            <Input className="mono" placeholder="npm run start" spellCheck={false} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={!!logs}
        title={`Logs · ${logs?.proc.name ?? ''}`}
        width={820}
        onCancel={() => setLogs(null)}
        footer={<Button onClick={() => logs && void showLogs(logs.proc)}>Refresh</Button>}
      >
        <pre className="log-box" style={{ height: 440 }}>
          {logs?.text === null ? 'Loading…' : logs?.text || 'No log lines yet.'}
        </pre>
      </Modal>
      <JobDrawer job={job} />
    </div>
  )
}
