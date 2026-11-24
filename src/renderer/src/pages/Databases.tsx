import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Form, Input, InputNumber, Modal, Segmented, Select, Space, Spin, Switch, Table, Tag, Typography } from 'antd'
import { EyeOutlined, GlobalOutlined, HomeOutlined, PlusOutlined, ReloadOutlined, UnorderedListOutlined } from '@ant-design/icons'
import type { DbAccess, DbBackup, DbInfo, DbOverview, DbSchedule, Project } from '@shared/types'
import { JobDrawer, useJob } from '../components/JobLog'
import OffsiteCard from '../components/OffsiteCard'
import GdriveCard from '../components/GdriveCard'
import VersionInstall from '../components/VersionInstall'
import S3Card from '../components/S3Card'
import ConfirmIdentity from '../components/ConfirmIdentity'
import { ago, bytes, errText } from '../util'

const LOCAL = ['localhost', '127.0.0.1', '::1']
const ADDRESS = /^(\d{1,3}(\.\d{1,3}){3}|\d{1,3}(\.\d{1,3}){0,2}\.%|[0-9a-fA-F:]{3,39})$/

/** The access choice that a user's account hosts add up to. */
function accessOf(hosts: string[]): DbAccess {
  const remote = hosts.filter((h) => !LOCAL.includes(h))
  if (remote.includes('%')) return { mode: 'any', hosts: [] }
  return remote.length ? { mode: 'list', hosts: remote } : { mode: 'local', hosts: [] }
}

/** Who may connect: only the server itself, everyone, or chosen addresses. */
function AccessPicker({ value, onChange, disabled }: { value: DbAccess; onChange: (v: DbAccess) => void; disabled?: boolean }) {
  return (
    <div>
      <Segmented
        block
        disabled={disabled}
        value={value.mode}
        onChange={(m) => onChange({ ...value, mode: m as DbAccess['mode'] })}
        options={[
          { value: 'local', label: 'Local only', icon: <HomeOutlined /> },
          { value: 'list', label: 'Whitelist IPs', icon: <UnorderedListOutlined /> },
          { value: 'any', label: 'Everyone', icon: <GlobalOutlined /> }
        ]}
      />
      {value.mode === 'local' && <p className="db-hint" style={{ margin: '8px 0 0' }}>Only websites and programs on this server can connect. The safest choice.</p>}
      {value.mode === 'list' && (
        <>
          <Select
            aria-label="Addresses that may connect"
            mode="tags"
            style={{ width: '100%', marginTop: 10 }}
            disabled={disabled}
            value={value.hosts}
            onChange={(hosts: string[]) => onChange({ ...value, hosts: hosts.map((h) => h.trim()).filter((h) => ADDRESS.test(h)) })}
            tokenSeparators={[',', ' ', '\n']}
            placeholder="203.0.113.7, or a range such as 192.168.1.%"
            notFoundContent="Type an address and press Enter"
            open={false}
            suffixIcon={null}
          />
          <p className="db-hint" style={{ margin: '8px 0 0' }}>Only these addresses can connect from outside, with the user name and password. The server itself always can.</p>
        </>
      )}
      {value.mode === 'any' && <Alert type="warning" showIcon style={{ marginTop: 10 }} message="Any computer on the internet can try to sign in" description="Only the password protects the data, and exposed databases are attacked all the time. Prefer chosen addresses when you know where the connections come from." />}
    </div>
  )
}

export default function Databases({ project, projects, canOps }: { project: Project; projects: Project[]; canOps: boolean }) {
  const { message, modal } = AntApp.useApp()
  const [data, setData] = useState<DbOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [created, setCreated] = useState<{ name: string; user: string; password: string; hosts: string[]; notes: string[] } | null>(null)
  const [access, setAccess] = useState<DbAccess>({ mode: 'local', hosts: [] })
  const [changing, setChanging] = useState<{ db: string; user: string; access: DbAccess } | null>(null)
  const [restoring, setRestoring] = useState<{ file: string; db: string; into: string } | null>(null)
  const [secrets, setSecrets] = useState<{ id: string; database: string; user: string; createdBy?: string; createdAt: number }[]>([])
  const [asking, setAsking] = useState<{ id: string; user: string } | null>(null)
  const [shown, setShown] = useState<{ database: string; user: string; password: string } | null>(null)
  const loadSecrets = (): void => void window.api.db.secrets(project.id).then(setSecrets).catch(() => setSecrets([]))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadSecrets, [project.id])
  const [schedule, setSchedule] = useState<DbSchedule | null>(null)
  const [form] = Form.useForm<{ name: string; user: string; password: string }>()
  const job = useJob(`db:${project.id}`)

  const load = useCallback(async () => {
    try {
      const d = await window.api.db.overview(project.id)
      setData(d)
      setSchedule(d.schedule)
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id])

  useEffect(() => {
    void load()
  }, [load])

  const quick = async (fn: () => Promise<unknown>, done?: string): Promise<void> => {
    try {
      await fn()
      if (done) message.success(done)
    } catch (err) {
      message.error(errText(err))
    }
    await load()
  }

  const create = async (): Promise<void> => {
    let v: { name: string; user: string; password: string }
    try {
      v = await form.validateFields()
    } catch {
      return
    }
    if (access.mode === 'list' && access.hosts.length === 0) {
      message.error('Add at least one address that may connect, or choose another option.')
      return
    }
    setCreateBusy(true)
    try {
      const res = await window.api.db.create(project.id, v.name, v.user || v.name, v.password ?? '', access)
      setCreating(false)
      form.resetFields()
      setAccess({ mode: 'local', hosts: [] })
      setCreated(res)
      loadSecrets()
      await load()
    } catch (err) {
      message.error(errText(err), 8)
    } finally {
      setCreateBusy(false)
    }
  }

  const drop = (db: DbInfo): void => {
    const sameUser = data?.users.some((u) => u.user === db.name && u.host === 'localhost') ? db.name : ''
    modal.confirm({
      title: `Delete database "${db.name}"?`,
      content: `All ${db.tables} table(s) and their data are deleted for good${sameUser ? `, together with the user "${sameUser}"` : ''}. Backups already taken are kept.`,
      okText: 'Delete database',
      okButtonProps: { danger: true },
      onOk: () => quick(() => window.api.db.drop(project.id, db.name, sameUser), `${db.name} deleted`)
    })
  }

  const restore = (b: DbBackup): void => {
    let into = b.db
    modal.confirm({
      title: 'Restore this backup?',
      width: 480,
      content: (
        <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
          <div className="mono" style={{ fontSize: 12 }}>
            {b.file}
          </div>
          <Input addonBefore="Into database" defaultValue={into} onChange={(e) => (into = e.target.value)} spellCheck={false} />
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>
            Tables in that database are replaced by the ones in the backup. Use a new name to restore into a separate copy.
          </div>
        </div>
      ),
      okText: 'Restore',
      onOk: () => setRestoring({ file: b.file, db: b.db, into: into.trim() })
    })
  }

  const download = async (b: DbBackup): Promise<void> => {
    const hide = message.loading('Downloading…', 0)
    try {
      const path = await window.api.db.download(project.id, b.file)
      if (path) message.success(`Saved to ${path}`)
    } catch (err) {
      message.error(errText(err))
    } finally {
      hide()
    }
  }

  if (error) {
    return (
      <div className="card">
        <Alert type="error" showIcon message="Could not read the databases" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
      </div>
    )
  }
  if (!data || !schedule) {
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
          <h3>No MySQL or MariaDB on this server</h3>
          <div style={{ marginBottom: 16 }}>Install MariaDB to create and back up databases from here.</div>
          <VersionInstall projectId={project.id} app="mariadb" name="MariaDB" disabled={!data.packageManager} onInstall={(v, label) => void job.run(`Install ${label}`, () => window.api.db.install(project.id, v)).then(load, load)} />
        </div>
        <JobDrawer job={job} />
      </div>
    )
  }

  const scheduleDirty = JSON.stringify(schedule) !== JSON.stringify(data.schedule)

  return (
    <div className="grid">
      {data.error && <Alert type="warning" showIcon message={data.error} />}
      <div className="card">
        <div className="card-title">
          <Space>
            Databases <Tag>{data.version}</Tag>
          </Space>
          <Space>
            <Button size="small" type="text" icon={<ReloadOutlined />} aria-label="Refresh" onClick={() => void load()} />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              New database
            </Button>
          </Space>
        </div>
        <Table<DbInfo>
          rowKey="name"
          size="middle"
          pagination={false}
          dataSource={data.databases}
          locale={{ emptyText: 'No databases yet' }}
          columns={[
            { title: 'Name', dataIndex: 'name', render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span> },
            { title: 'Tables', dataIndex: 'tables' },
            { title: 'Size', dataIndex: 'size', render: (v: number) => bytes(v) },
            {
              title: 'User and password',
              render: (_, d) => {
                const mine = secrets.filter((x) => x.database === d.name)
                if (mine.length === 0) return <span style={{ color: 'var(--muted)' }}>Password not kept</span>
                return (
                  <Space direction="vertical" size={4}>
                    {mine.map((x) => (
                      <Space key={x.id} size={8}>
                        <span className="mono">{x.user}</span>
                        <Button size="small" icon={<EyeOutlined />}  onClick={() => setAsking({ id: x.id, user: x.user })}>
                          Show password
                        </Button>
                      </Space>
                    ))}
                  </Space>
                )
              }
            },
            {
              title: 'Who can connect',
              render: (_, d) => {
                const user = secrets.find((x) => x.database === d.name)?.user ?? (data.users.some((u) => u.user === d.name) ? d.name : '')
                if (!user) return <span style={{ color: 'var(--muted)' }}>No user of its own</span>
                const a = accessOf(data.users.filter((u) => u.user === user).map((u) => u.host))
                return (
                  <Space size={8} wrap>
                    {a.mode === 'local' && <Tag icon={<HomeOutlined />}>Local only</Tag>}
                    {a.mode === 'any' && <Tag color="orange" icon={<GlobalOutlined />}>Everyone</Tag>}
                    {a.mode === 'list' && (
                      <Tag color="blue" icon={<UnorderedListOutlined />} title={a.hosts.join(', ')}>
                        {a.hosts.length === 1 ? a.hosts[0] : `${a.hosts.length} addresses`}
                      </Tag>
                    )}
                    {canOps && (
                      <Button size="small" onClick={() => setChanging({ db: d.name, user, access: a })}>
                        Change
                      </Button>
                    )}
                  </Space>
                )
              }
            },
            {
              title: '',
              align: 'right',
              render: (_, d) => (
                <Space>
                  <Button disabled={job.state === 'running'} onClick={() => void job.run(`Back up ${d.name}`, () => window.api.db.backup(project.id, d.name)).then(load)}>
                    Back up now
                  </Button>
                  <Button danger onClick={() => drop(d)}>
                    Delete
                  </Button>
                </Space>
              )
            }
          ]}
        />
        {data.users.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <span style={{ color: 'var(--muted)', marginRight: 8 }}>Users:</span>
            {data.users.map((u) => (
              <Tag key={u.user + u.host} className="mono">
                {u.user}@{u.host}
              </Tag>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Automatic backups</div>
        <Space wrap align="center">
          <Switch checked={schedule.enabled} onChange={(enabled) => setSchedule({ ...schedule, enabled })} aria-label="Daily backups" />
          <span>Back up every database daily at</span>
          <InputNumber min={0} max={23} value={schedule.hour} onChange={(v) => setSchedule({ ...schedule, hour: v ?? 2 })} addonAfter=":00" style={{ width: 110 }} aria-label="Hour" />
          <span>and keep them for</span>
          <InputNumber min={1} max={3650} value={schedule.keepDays} onChange={(v) => setSchedule({ ...schedule, keepDays: v ?? 7 })} addonAfter="days" style={{ width: 130 }} aria-label="Days to keep" />
          <Button type="primary" disabled={!scheduleDirty} onClick={() => void quick(() => window.api.db.setSchedule(project.id, schedule), 'Schedule saved')}>
            Save
          </Button>
        </Space>
        <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>
          Server time. Backups are stored on the server in /var/backups/superdevops/mysql.
        </div>
      </div>

      <OffsiteCard project={project} projects={projects} canChange={canOps} />
      <GdriveCard project={project} canChange={canOps} />
      <S3Card project={project} canChange={canOps} />

      <div className="card">
        <div className="card-title">Backups</div>
        <Table<DbBackup>
          rowKey="file"
          size="small"
          pagination={data.backups.length > 12 ? { pageSize: 12 } : false}
          dataSource={data.backups}
          locale={{ emptyText: 'No backups yet' }}
          columns={[
            { title: 'Database', dataIndex: 'db' },
            { title: 'File', dataIndex: 'file', render: (v: string) => <span className="mono" style={{ fontSize: 12 }}>{v}</span> },
            { title: 'Size', dataIndex: 'size', render: (v: number) => bytes(v) },
            { title: 'Taken', dataIndex: 'time', render: (v: number) => ago(v) },
            {
              title: '',
              align: 'right',
              render: (_, b) => (
                <Space>
                  <Button size="small" onClick={() => restore(b)}>
                    Restore
                  </Button>
                  <Button size="small" onClick={() => void download(b)}>
                    Download
                  </Button>
                  <Button
                    size="small"
                    danger
                    onClick={() =>
                      modal.confirm({
                        title: 'Delete this backup file?',
                        content: b.file,
                        okText: 'Delete backup',
                        okButtonProps: { danger: true },
                        onOk: () => quick(() => window.api.db.deleteBackup(project.id, b.file))
                      })
                    }
                  >
                    Delete
                  </Button>
                </Space>
              )
            }
          ]}
        />
      </div>

      <Modal open={creating} title="New database" okText="Create database" confirmLoading={createBusy} onOk={() => void create()} onCancel={() => setCreating(false)} destroyOnClose>
        <Form
          form={form}
          layout="vertical"
          requiredMark={false}
          onValuesChange={(c: { name?: string }) => {
            if (c.name !== undefined && !form.isFieldTouched('user')) form.setFieldValue('user', c.name.slice(0, 32))
          }}
        >
          <Form.Item
            name="name"
            label="Database name"
            rules={[
              { required: true, message: 'Enter a name' },
              { pattern: /^[A-Za-z0-9_]{1,48}$/, message: 'Letters, numbers and underscore only' }
            ]}
          >
            <Input placeholder="shop_db" spellCheck={false} autoFocus />
          </Form.Item>
          <Form.Item name="user" label="User" rules={[{ pattern: /^[A-Za-z0-9_]{1,32}$/, message: 'Letters, numbers and underscore, up to 32' }]} extra="Gets full access to this database only.">
            <Input spellCheck={false} />
          </Form.Item>
          <Form.Item name="password" label="Password" extra="Leave empty to generate a strong one.">
            <Input.Password autoComplete="off" />
          </Form.Item>
          <Form.Item label="Who can connect" style={{ marginBottom: 0 }} extra={!canOps && 'Letting other computers connect needs an Admin or IT Support person.'}>
            <AccessPicker value={access} onChange={setAccess} disabled={!canOps} />
            {access.mode !== 'local' && data?.listen && !data.listen.remote && <p className="db-hint" style={{ margin: '8px 0 0' }}>The database server only listens on this server right now. It will be set to listen for other computers and restarted once, which takes a few seconds.</p>}
          </Form.Item>
        </Form>
      </Modal>

      <ConfirmIdentity
        open={!!restoring}
        title="Confirm it is you"
        about={restoring ? `Restoring ${restoring.file} replaces the tables in ${restoring.into}. Enter a fresh code to go ahead.` : ''}
        okText="Restore"
        danger
        onCancel={() => setRestoring(null)}
        onProof={async (proof) => {
          if (!restoring) return
          const r = restoring
          // A wrong code throws here and is shown in this dialog; nothing has started yet.
          await window.api.session.confirm(proof, `restore ${r.file} into ${r.into}`)
          setRestoring(null)
          void job.run(`Restore ${r.db}`, () => window.api.db.restore(project.id, r.file, r.into)).then(load)
        }}
      />
      <ConfirmIdentity
        open={!!asking}
        title="Show the database password"
        about={asking ? `The password of the database user ${asking.user} is shown after a fresh code. Every look is written to the audit log.` : ''}
        okText="Show password"
        onCancel={() => setAsking(null)}
        onProof={async (proof) => {
          if (!asking) return
          setShown(await window.api.db.revealSecret(asking.id, proof))
          setAsking(null)
        }}
      />
      <Modal open={!!shown} title="Database password" footer={<Button type="primary" onClick={() => setShown(null)}>Done</Button>} onCancel={() => setShown(null)} destroyOnClose>
        <dl className="kv">
          <dt>Database</dt>
          <dd className="mono">{shown?.database}</dd>
          <dt>User</dt>
          <dd className="mono">{shown?.user}</dd>
          <dt>Password</dt>
          <dd>
            <Typography.Text className="mono" copyable>
              {shown?.password}
            </Typography.Text>
          </dd>
          <dt>Host</dt>
          <dd className="mono">
            127.0.0.1 on the server{created && created.hosts.length > 0 ? `; ${project.host} from ${created.hosts.includes('%') ? 'any address' : created.hosts.join(', ')}` : ''} (port {data?.listen?.port ?? 3306})
          </dd>
        </dl>
        {created?.notes.map((n) => <Alert key={n} type="warning" showIcon style={{ marginTop: 10 }} message={n} />)}
        {created && created.hosts.length > 0 && <p className="db-hint">If the server is behind a cloud firewall (security group), port {data?.listen?.port ?? 3306} must be opened there too; this app cannot reach it.</p>}
        <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: '12px 0 0' }}>If the password was changed outside this app, what is kept here is the old one.</p>
      </Modal>

      <Modal open={!!created} title="Database created" footer={<Button type="primary" onClick={() => setCreated(null)}>I saved it</Button>} onCancel={() => setCreated(null)}>
        <Alert type="warning" showIcon style={{ marginBottom: 14 }} message="Copy the password now. It is also kept encrypted, and can be shown again later with a code from Google Authenticator." />
        <dl className="kv">
          <dt>Database</dt>
          <dd className="mono">{created?.name}</dd>
          <dt>User</dt>
          <dd className="mono">{created?.user}</dd>
          <dt>Password</dt>
          <dd>
            <Typography.Text className="mono" copyable>
              {created?.password}
            </Typography.Text>
          </dd>
          <dt>Host</dt>
          <dd className="mono">
            127.0.0.1 on the server{created && created.hosts.length > 0 ? `; ${project.host} from ${created.hosts.includes('%') ? 'any address' : created.hosts.join(', ')}` : ''} (port {data?.listen?.port ?? 3306})
          </dd>
        </dl>
        {created?.notes.map((n) => <Alert key={n} type="warning" showIcon style={{ marginTop: 10 }} message={n} />)}
        {created && created.hosts.length > 0 && <p className="db-hint">If the server is behind a cloud firewall (security group), port {data?.listen?.port ?? 3306} must be opened there too; this app cannot reach it.</p>}
      </Modal>
      <Modal
        open={!!changing}
        title={changing ? `Who can connect to ${changing.db}` : ''}
        okText="Save"
        okButtonProps={{ disabled: !changing || (changing.access.mode === 'list' && changing.access.hosts.length === 0) }}
        onCancel={() => setChanging(null)}
        onOk={() => {
          if (!changing) return
          const c = changing
          setChanging(null)
          void job.run(`Access for ${c.user}`, () => window.api.db.setAccess(project.id, c.db, c.user, c.access)).then(load)
        }}
        destroyOnClose
      >
        {changing && (
          <>
            <p style={{ marginTop: 0 }}>
              Database user <span className="mono">{changing.user}</span>. The password stays the same.
            </p>
            <AccessPicker value={changing.access} onChange={(a) => setChanging({ ...changing, access: a })} />
            {changing.access.mode !== 'local' && data?.listen && !data.listen.remote && <p className="db-hint" style={{ margin: '8px 0 0' }}>The database server only listens on this server right now. It will be set to listen for other computers and restarted once, which takes a few seconds.</p>}
            {changing.access.mode !== 'local' && <p className="db-hint" style={{ margin: '8px 0 0' }}>An active ufw firewall on the server is opened for exactly these addresses on port {data?.listen?.port ?? 3306}. A cloud firewall (security group) has to be opened by you.</p>}
          </>
        )}
      </Modal>
      <JobDrawer job={job} />
    </div>
  )
}
