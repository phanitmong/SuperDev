import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Form, Input, InputNumber, Modal, Space, Spin, Switch, Table, Tag } from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { Project, SupervisorOverview, SupervisorProgram, SupervisorProgramInput } from '@shared/types'
import FolderInput from '../components/FolderPicker'
import SupervisorLog from '../components/SupervisorLog'
import { JobDrawer, useJob } from '../components/JobLog'
import { errText } from '../util'

const COLORS: Record<string, string> = { RUNNING: 'green', STARTING: 'blue', PARTLY: 'orange', BACKOFF: 'orange', STOPPED: 'default', EXITED: 'default', FATAL: 'red', UNKNOWN: 'default' }
const WORDS: Record<string, string> = { RUNNING: 'Running', STARTING: 'Starting', PARTLY: 'Partly running', BACKOFF: 'Keeps stopping', STOPPED: 'Stopped', EXITED: 'Ended', FATAL: 'Cannot start', UNKNOWN: 'Not loaded' }

/** Programs that Supervisor keeps running: queue workers, schedulers and the like. */
export default function SupervisorPage({ project, canOps }: { project: Project; canOps: boolean }) {
  const { message, modal } = AntApp.useApp()
  const [data, setData] = useState<SupervisorOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState<SupervisorProgram | 'new' | null>(null)
  const [saving, setSaving] = useState(false)
  const [log, setLog] = useState<{ name: string; text: string } | null>(null)
  const [form] = Form.useForm<SupervisorProgramInput>()
  const job = useJob(`supervisor:${project.id}`)

  const load = useCallback(async () => {
    try {
      setData(await window.api.supervisor.overview(project.id))
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (key: string, fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(key)
    try {
      await fn()
      message.success(done)
    } catch (err) {
      message.error(errText(err), 8)
    }
    await load()
    setBusy('')
  }

  const open = (p: SupervisorProgram | 'new'): void => {
    setEditing(p)
    form.resetFields()
    form.setFieldsValue(p === 'new' ? { name: '', command: '', directory: '', user: 'www-data', numprocs: 1, autostart: true } : { name: p.name, command: p.command, directory: p.directory, user: p.user, numprocs: p.numprocs, autostart: p.autostart })
  }

  const save = async (): Promise<void> => {
    let v: SupervisorProgramInput
    try {
      v = await form.validateFields()
    } catch {
      return
    }
    setSaving(true)
    try {
      await window.api.supervisor.save(project.id, v)
      message.success(`${v.name} saved`)
      setEditing(null)
    } catch (err) {
      message.error(errText(err), 10)
    }
    setSaving(false)
    await load()
  }


  if (error) {
    return (
      <div className="card">
        <Alert type="error" showIcon message="Could not read Supervisor" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
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
  if (!data.installed) {
    return (
      <div className="card empty">
        <div>
          <h3>Supervisor is not installed on this server</h3>
          <div style={{ marginBottom: 16, maxWidth: 460 }}>Supervisor keeps background programs running and starts them again when they stop or the server restarts. Laravel queue workers and Horizon are the usual reason to have it.</div>
          <Button type="primary" disabled={!canOps} onClick={() => void job.run('Install Supervisor', () => window.api.supervisor.install(project.id)).then(load)}>
            Install Supervisor
          </Button>
        </div>
        <JobDrawer job={job} />
      </div>
    )
  }

  return (
    <div className="grid">
      {!data.running && <Alert type="warning" showIcon message="Supervisor is installed but not running." description="Starting any program below starts it." />}
      <div className="card">
        <div className="card-title">
          <Space wrap>
            Supervisor
            {data.version && <Tag>{data.version}</Tag>}
            <Tag color={data.running ? 'green' : 'red'}>{data.running ? 'Running' : 'Stopped'}</Tag>
          </Space>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void load()} />
            {canOps && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')}>
                Add program
              </Button>
            )}
          </Space>
        </div>
        <Table
          size="small"
          rowKey="name"
          pagination={false}
          dataSource={data.programs}
          locale={{ emptyText: 'No programs yet. Add one to keep a worker running.' }}
          columns={[
            {
              title: 'Program',
              render: (_, p) => (
                <div>
                  <span style={{ fontWeight: 600 }}>{p.name}</span>
                  {!p.managed && <Tag style={{ marginLeft: 8 }}>Made outside this app</Tag>}
                  {p.command && <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', wordBreak: 'break-all' }}>{p.command}</div>}
                </div>
              )
            },
            { title: 'State', width: 240, render: (_, p) => <Space direction="vertical" size={0}><Tag color={COLORS[p.state] ?? 'default'}>{WORDS[p.state] ?? p.state}</Tag><span style={{ fontSize: 12, color: 'var(--muted)' }}>{p.detail}</span></Space> },
            { title: 'Runs as', width: 110, render: (_, p) => (p.managed ? `${p.user}${p.numprocs > 1 ? ` × ${p.numprocs}` : ''}` : '') },
            {
              title: '',
              align: 'right',
              render: (_, p) => (
                  <Space wrap>
                    <Button size="small" onClick={() => setLog({ name: p.name, text: '' })}>
                      Log
                    </Button>
                    {canOps && (<>
                    {p.state === 'RUNNING' || p.state === 'PARTLY' || p.state === 'STARTING' || p.state === 'BACKOFF' ? (
                      <>
                        <Button size="small" loading={busy === `${p.name}:restart`} onClick={() => void act(`${p.name}:restart`, () => window.api.supervisor.action(project.id, p.name, 'restart'), `${p.name} restarted`)}>
                          Restart
                        </Button>
                        <Button size="small" loading={busy === `${p.name}:stop`} onClick={() => void act(`${p.name}:stop`, () => window.api.supervisor.action(project.id, p.name, 'stop'), `${p.name} stopped`)}>
                          Stop
                        </Button>
                      </>
                    ) : (
                      <Button size="small" type="primary" loading={busy === `${p.name}:start`} onClick={() => void act(`${p.name}:start`, () => window.api.supervisor.action(project.id, p.name, 'start'), `${p.name} started`)}>
                        Start
                      </Button>
                    )}
                    {p.managed && (
                      <>
                        <Button size="small" onClick={() => open(p)}>
                          Edit
                        </Button>
                        <Button
                          size="small"
                          danger
                          onClick={() =>
                            modal.confirm({
                              title: `Remove ${p.name}?`,
                              content: 'The program is stopped and no longer started with the server. Its files are not touched.',
                              okText: 'Remove',
                              okButtonProps: { danger: true },
                              onOk: () => act(`${p.name}:remove`, () => window.api.supervisor.remove(project.id, p.name), `${p.name} removed`)
                            })
                          }
                        >
                          Remove
                        </Button>
                      </>
                    )}
                    </>)}
                  </Space>
                )
            }
          ]}
        />
      </div>

      <Modal open={!!editing} title={editing === 'new' ? 'Add a program' : `Edit ${editing?.name ?? ''}`} okText="Save and load" confirmLoading={saving} onOk={() => void save()} onCancel={() => setEditing(null)} destroyOnClose width={560}>
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="name" label="Name" rules={[{ required: true, pattern: /^[a-z0-9][a-z0-9_-]{0,39}$/, message: 'Small letters, numbers, - and _' }]} extra={editing === 'new' ? 'Such as shop-queue.' : 'The name cannot be changed. Remove the program and add it again under the new name.'}>
            <Input disabled={editing !== 'new'} autoComplete="off" spellCheck={false} />
          </Form.Item>
          <Form.Item name="command" label="Command" rules={[{ required: true, message: 'Type the command to run' }]} extra="Runs in the foreground. Example: php artisan queue:work --sleep=3 --tries=3">
            <Input className="mono" autoComplete="off" spellCheck={false} />
          </Form.Item>
          <Form.Item name="directory" label="Folder to run it in" extra="Full path, such as /www/wwwroot/shop. Leave empty when the command uses full paths.">
            <FolderInput projectId={project.id} />
          </Form.Item>
          <Space size={16} align="start" wrap>
            <Form.Item name="user" label="Run as user" extra="The user that owns the site's files.">
              <Input style={{ width: 170 }} autoComplete="off" spellCheck={false} />
            </Form.Item>
            <Form.Item name="numprocs" label="Processes">
              <InputNumber min={1} max={20} />
            </Form.Item>
            <Form.Item name="autostart" label="Start with the server" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      {log && <SupervisorLog projectId={project.id} name={log.name} onClose={() => setLog(null)} />}
      <JobDrawer job={job} />
    </div>
  )
}
