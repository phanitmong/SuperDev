import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Form, Input, Modal, Space, Spin, Table, Tag, Typography } from 'antd'
import { EyeOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { PgOverview, Project } from '@shared/types'
import ConfirmIdentity from '../components/ConfirmIdentity'
import { JobDrawer, useJob } from '../components/JobLog'
import VersionInstall from '../components/VersionInstall'
import { ago, bytes, errText } from '../util'

interface Secret {
  id: string
  database: string
  user: string
}

/** PostgreSQL on this server: databases with a user of their own, backups and restore. */
export default function Postgres({ project, canOps, canData, canDanger }: { project: Project; canOps: boolean; canData: boolean; canDanger: boolean }) {
  const { message, modal } = AntApp.useApp()
  const [data, setData] = useState<PgOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [secrets, setSecrets] = useState<Secret[]>([])
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [creating, setCreating] = useState(false)
  const [made, setMade] = useState<{ name: string; user: string; password: string } | null>(null)
  const [asking, setAsking] = useState<Secret | null>(null)
  const [restoring, setRestoring] = useState<{ file: string; database: string } | null>(null)
  const [form] = Form.useForm<{ name: string; user: string; password: string }>()
  const job = useJob(`pg:${project.id}`)

  const load = useCallback(async () => {
    try {
      setData(await window.api.pg.overview(project.id))
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
    // PostgreSQL passwords are kept next to the MySQL ones, marked with pg: so the two never mix.
    window.api.db
      .secrets(project.id)
      .then((all) => setSecrets(all.filter((x) => x.database.startsWith('pg:')).map((x) => ({ id: x.id, database: x.database.slice(3), user: x.user.replace(/^pg:/, '') }))))
      .catch(() => setSecrets([]))
  }, [project.id])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      message.success(done)
    } catch (err) {
      message.error(errText(err), 8)
    }
    await load()
    setBusy(false)
  }

  const create = async (): Promise<void> => {
    let v: { name: string; user: string; password: string }
    try {
      v = await form.validateFields()
    } catch {
      return
    }
    setCreating(true)
    try {
      const res = await window.api.pg.create(project.id, v.name, v.user || v.name, v.password ?? '')
      setAdding(false)
      setMade(res)
    } catch (err) {
      message.error(errText(err), 10)
    }
    setCreating(false)
    await load()
  }

  if (error) {
    return (
      <div className="card">
        <Alert type="error" showIcon message="Could not read PostgreSQL" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
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
          <h3>PostgreSQL is not installed on this server</h3>
          <div style={{ marginBottom: 16, maxWidth: 460 }}>PostgreSQL is a database server. Choose the system's own package or a release from postgresql.org. It listens on this server only.</div>
          <VersionInstall projectId={project.id} app="postgres" name="PostgreSQL" disabled={!canOps || !data.packageManager} onInstall={(v, label) => void job.run(`Install ${label}`, () => window.api.pg.install(project.id, v)).then(load, load)} />
        </div>
        <JobDrawer job={job} />
      </div>
    )
  }

  const local = data.listen.split(',').map((x) => x.trim()).filter((x) => x && !/^(localhost|127\.0\.0\.1|::1)$/.test(x)).length === 0

  return (
    <div className="grid">
      {!data.running && <Alert type="error" showIcon message="PostgreSQL is installed but not running." action={canOps && <Button loading={busy} onClick={() => void act(() => window.api.pg.service(project.id, 'start'), 'PostgreSQL started')}>Start</Button>} />}
      <div className="card">
        <div className="card-title">
          <Space wrap>
            PostgreSQL
            {data.version && <Tag>{data.version}</Tag>}
            <Tag color={data.running ? 'green' : 'red'}>{data.running ? 'Running' : 'Stopped'}</Tag>
            {data.running && <Tag color={local ? 'default' : 'orange'}>{local ? `This server only · port ${data.port}` : `Listens on ${data.listen} · port ${data.port}`}</Tag>}
          </Space>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void load()} />
            {canOps && data.running && (
              <Button loading={busy} onClick={() => modal.confirm({ title: 'Restart PostgreSQL?', content: 'Apps lose their database connections for a few seconds.', okText: 'Restart', onOk: () => act(() => window.api.pg.service(project.id, 'restart'), 'PostgreSQL restarted') })}>
                Restart
              </Button>
            )}
            {canData && data.running && (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => {
                  form.resetFields()
                  setAdding(true)
                }}
              >
                New database
              </Button>
            )}
          </Space>
        </div>
        <Table
          size="small"
          rowKey="name"
          pagination={false}
          dataSource={data.databases}
          locale={{ emptyText: data.running ? 'No databases yet' : 'Start PostgreSQL to see its databases' }}
          columns={[
            { title: 'Name', dataIndex: 'name', render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span> },
            { title: 'Size', dataIndex: 'size', render: (v: number) => bytes(v) },
            {
              title: 'User and password',
              render: (_, d) => {
                const mine = secrets.filter((x) => x.database === d.name)
                if (mine.length === 0) return <Space size={8}><span className="mono">{d.owner}</span><span style={{ color: 'var(--muted)' }}>Password not kept</span></Space>
                return (
                  <Space direction="vertical" size={4}>
                    {mine.map((x) => (
                      <Space key={x.id} size={8}>
                        <span className="mono">{x.user}</span>
                        {canData && (
                          <Button size="small" icon={<EyeOutlined />} onClick={() => setAsking(x)}>
                            Show password
                          </Button>
                        )}
                      </Space>
                    ))}
                  </Space>
                )
              }
            },
            {
              title: '',
              align: 'right',
              render: (_, d) => (
                <Space>
                  {canData && (
                    <Button size="small" onClick={() => void job.run(`Back up ${d.name}`, () => window.api.pg.backup(project.id, d.name)).then(load)}>
                      Back up now
                    </Button>
                  )}
                  {canDanger && (
                    <Button
                      size="small"
                      danger
                      onClick={() =>
                        modal.confirm({
                          title: `Delete the database ${d.name}?`,
                          content: `Every table in it is deleted, and so is its user ${d.owner === 'postgres' ? '' : d.owner}. Backups already made stay. This cannot be undone.`,
                          okText: 'Delete database',
                          okButtonProps: { danger: true },
                          onOk: () => act(() => window.api.pg.drop(project.id, d.name, d.owner === 'postgres' ? '' : d.owner), `${d.name} deleted`)
                        })
                      }
                    >
                      Delete
                    </Button>
                  )}
                </Space>
              )
            }
          ]}
        />
      </div>

      <div className="card">
        <div className="card-title">Backups on this server</div>
        <Table
          size="small"
          rowKey="file"
          pagination={data.backups.length > 20 ? { pageSize: 20 } : false}
          dataSource={data.backups}
          locale={{ emptyText: 'No backups yet. Press "Back up now" on a database.' }}
          columns={[
            { title: 'File', dataIndex: 'file', render: (v: string) => <span className="mono" style={{ fontSize: 12 }}>{v}</span> },
            { title: 'Database', dataIndex: 'database' },
            { title: 'Size', dataIndex: 'size', render: (v: number) => bytes(v) },
            { title: 'Made', dataIndex: 'at', render: (v: number) => ago(v) },
            {
              title: '',
              align: 'right',
              render: (_, b) =>
                canDanger && (
                  <Space>
                    <Button size="small" onClick={() => setRestoring({ file: b.file, database: b.database })}>
                      Restore
                    </Button>
                    <Button size="small" danger onClick={() => modal.confirm({ title: `Delete ${b.file}?`, okText: 'Delete', okButtonProps: { danger: true }, onOk: () => act(() => window.api.pg.deleteBackup(project.id, b.file), 'Backup deleted') })}>
                      Delete
                    </Button>
                  </Space>
                )
            }
          ]}
        />
        <p className="db-hint" style={{ margin: '12px 0 0' }}>Kept in /var/backups/superdevops/postgres. They are on this server only: download or copy them elsewhere for safe keeping.</p>
      </div>

      <Modal open={adding} title="New PostgreSQL database" okText="Create" confirmLoading={creating} onOk={() => void create()} onCancel={() => setAdding(false)} destroyOnClose>
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="name" label="Database name" rules={[{ required: true, pattern: /^[a-z_][a-z0-9_]{0,47}$/, message: 'Small letters, numbers and underscore, starting with a letter' }]}>
            <Input autoComplete="off" spellCheck={false} />
          </Form.Item>
          <Form.Item name="user" label="User" rules={[{ pattern: /^[a-z_][a-z0-9_]{0,47}$/, message: 'Small letters, numbers and underscore, starting with a letter' }]} extra="Leave empty to use the database name. The user owns this database and can reach no other.">
            <Input autoComplete="off" spellCheck={false} />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ pattern: /^[A-Za-z0-9!@#%^*_+=.,:-]{8,64}$/, message: '8-64 characters: letters, numbers and ! @ # % ^ * _ + = . , : -' }]} extra="Leave empty and a strong one is made for you." style={{ marginBottom: 0 }}>
            <Input.Password autoComplete="off" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal open={!!made} title="Database created" footer={<Button type="primary" onClick={() => setMade(null)}>Done</Button>} onCancel={() => setMade(null)} destroyOnClose>
        <dl className="kv">
          <dt>Database</dt>
          <dd className="mono">{made?.name}</dd>
          <dt>User</dt>
          <dd className="mono">{made?.user}</dd>
          <dt>Password</dt>
          <dd><Typography.Text className="mono" copyable>{made?.password}</Typography.Text></dd>
          <dt>Host</dt>
          <dd className="mono">127.0.0.1:{data.port}</dd>
        </dl>
        <p className="db-hint" style={{ margin: '12px 0 0' }}>The password is kept encrypted and can be shown again with an authenticator code.</p>
      </Modal>

      <ConfirmIdentity
        open={!!restoring}
        title="Confirm it is you"
        about={restoring ? `Restoring ${restoring.file} replaces what is in ${restoring.database} now. Enter a fresh code to go ahead.` : ''}
        okText="Restore"
        danger
        onCancel={() => setRestoring(null)}
        onProof={async (proof) => {
          if (!restoring) return
          const r = restoring
          await window.api.session.confirm(proof, `restore PostgreSQL ${r.file}`)
          setRestoring(null)
          void job.run(`Restore ${r.database}`, () => window.api.pg.restore(project.id, r.file)).then(load)
        }}
      />
      <ConfirmIdentity
        open={!!asking}
        title="Show the database password"
        about={asking ? `The password of the PostgreSQL user ${asking.user} is shown after a fresh code. Every look is written to the audit log.` : ''}
        okText="Show password"
        onCancel={() => setAsking(null)}
        onProof={async (proof) => {
          if (!asking) return
          const a = asking
          const res = await window.api.db.revealSecret(a.id, proof)
          setAsking(null)
          setMade({ name: a.database, user: a.user, password: res.password })
        }}
      />
      <JobDrawer job={job} />
    </div>
  )
}
