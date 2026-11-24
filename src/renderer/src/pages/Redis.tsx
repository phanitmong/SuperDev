import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Checkbox, Form, Input, InputNumber, Select, Space, Spin, Switch, Table, Tabs, Tag } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import type { Project, RedisOverview, RedisSettings } from '@shared/types'
import { REDIS_POLICIES } from '@shared/types'
import { JobDrawer, useJob } from '../components/JobLog'
import VersionInstall from '../components/VersionInstall'
import { bytes, duration, errText } from '../util'

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ color: 'var(--muted)', fontSize: 12 }}>{label}</div>
      <div className="big-num">{value}</div>
      {sub && <div style={{ color: 'var(--muted)', fontSize: 12 }}>{sub}</div>}
    </div>
  )
}

export default function Redis({ project }: { project: Project }) {
  const { message, modal } = AntApp.useApp()
  const [data, setData] = useState<RedisOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [raw, setRaw] = useState('')
  const [form] = Form.useForm<RedisSettings>()
  const appendonly = Form.useWatch('appendonly', form)
  const rdb = Form.useWatch('rdb', form)
  const job = useJob(`redis:${project.id}`)

  const load = useCallback(async () => {
    try {
      const d = await window.api.redis.overview(project.id)
      setData(d)
      setRaw(d.raw)
      form.setFieldsValue(d.settings)
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id, form])

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

  const saveSettings = async (): Promise<void> => {
    let v: RedisSettings
    try {
      v = await form.validateFields()
    } catch {
      return
    }
    await act(() => window.api.redis.saveSettings(project.id, { ...data!.settings, ...v, password: v.password ?? '', removePassword: !!v.removePassword }), 'Redis settings saved and Redis restarted')
  }

  const flush = (db: number | null): void => {
    modal.confirm({
      title: db === null ? 'Delete every key in every database?' : `Delete every key in database ${db}?`,
      content: 'This cannot be undone. Sessions, caches and queues stored there are lost.',
      okText: db === null ? 'Delete everything' : 'Delete keys',
      okButtonProps: { danger: true },
      onOk: () => act(() => window.api.redis.flush(project.id, db), db === null ? 'All databases emptied' : `Database ${db} emptied`)
    })
  }

  if (error) {
    return (
      <div className="card">
        <Alert type="error" showIcon message="Could not read Redis" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
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
          <h3>Redis is not installed on this server</h3>
          <div style={{ marginBottom: 16, maxWidth: 440 }}>Redis is a fast in-memory store used for caches, sessions and queues. It is installed to listen on this server only.</div>
          <VersionInstall projectId={project.id} app="redis" name="Redis" disabled={!data.packageManager} onInstall={(v, label) => void job.run(`Install ${label}`, () => window.api.redis.install(project.id, v)).then(load, load)} />
        </div>
        <JobDrawer job={job} />
      </div>
    )
  }

  const s = data.stats
  const totalKeys = s?.databases.reduce((n, d) => n + d.keys, 0) ?? 0
  const lookups = (s?.hits ?? 0) + (s?.misses ?? 0)

  return (
    <div className="grid">
      {data.exposed && (
        <Alert
          type="error"
          showIcon
          message="Redis can be reached from other machines and has no password."
          description="Anyone who can reach the port can read and delete your data. Set a password in Settings, or listen on 127.0.0.1 only."
        />
      )}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 0 }}>
          <Space wrap>
            Redis
            <Tag>{data.version}</Tag>
            <Tag color={data.running ? 'green' : 'red'}>{data.running ? 'Running' : 'Stopped'}</Tag>
            <Tag color={data.hasPassword ? 'green' : 'default'}>{data.hasPassword ? 'Password set' : 'No password'}</Tag>
            <span className="mono" style={{ fontWeight: 400, fontSize: 12 }}>
              {data.settings.bind.split(/\s+/)[0].replace(/^-/, '')}:{data.settings.port}
            </span>
          </Space>
          <Space>
            <Button size="small" type="text" icon={<ReloadOutlined />} aria-label="Refresh" onClick={() => void load()} />
            {data.running ? (
              <>
                <Button loading={busy} onClick={() => void act(() => window.api.redis.service(project.id, 'restart'), 'Redis restarted')}>
                  Restart
                </Button>
                <Button disabled={busy} onClick={() => void act(() => window.api.redis.service(project.id, 'stop'), 'Redis stopped')}>
                  Stop
                </Button>
              </>
            ) : (
              <Button type="primary" loading={busy} onClick={() => void act(() => window.api.redis.service(project.id, 'start'), 'Redis started')}>
                Start
              </Button>
            )}
          </Space>
        </div>
      </div>

      {s && (
        <div className="grid cols-4">
          <Stat label="Memory used" value={bytes(s.usedMemory)} sub={data.settings.maxmemoryMb ? `limit ${data.settings.maxmemoryMb} MB` : 'no limit set'} />
          <Stat label="Keys" value={totalKeys.toLocaleString()} sub={`${s.databases.length} database${s.databases.length === 1 ? '' : 's'} in use`} />
          <Stat label="Connected clients" value={String(s.clients)} sub={`role: ${s.role}`} />
          <Stat label="Cache hit rate" value={lookups ? `${Math.round((s.hits / lookups) * 100)}%` : '-'} sub={`up for ${duration(s.uptime)}`} />
        </div>
      )}

      <div className="card">
        <Tabs
          items={[
            {
              key: 'settings',
              label: 'Settings',
              children: (
                <Form form={form} layout="vertical" requiredMark={false} style={{ maxWidth: 820 }}>
                  <div className="grid cols-2" style={{ rowGap: 0 }}>
                    <Form.Item name="bind" label="Listen on" extra="127.0.0.1 = this server only. 0.0.0.0 = every network (needs a password and a firewall rule).">
                      <Input className="mono" spellCheck={false} />
                    </Form.Item>
                    <Form.Item name="port" label="Port">
                      <InputNumber min={1} max={65535} style={{ width: 160 }} />
                    </Form.Item>
                    <Form.Item name="password" label="Password" extra={data.hasPassword ? 'A password is set. Leave empty to keep it.' : 'Optional while Redis listens on this server only.'}>
                      <Input.Password autoComplete="off" placeholder={data.hasPassword ? 'Saved' : 'At least 8 characters'} />
                    </Form.Item>
                    <Form.Item name="removePassword" valuePropName="checked" label=" ">
                      <Checkbox disabled={!data.hasPassword}>Remove the password</Checkbox>
                    </Form.Item>
                    <Form.Item name="maxmemoryMb" label="Memory limit" extra="0 = no limit. On a shared server, set one so Redis cannot use all the RAM.">
                      <InputNumber min={0} max={4194304} addonAfter="MB" style={{ width: 200 }} />
                    </Form.Item>
                    <Form.Item name="policy" label="When the limit is reached">
                      <Select options={REDIS_POLICIES} />
                    </Form.Item>
                    <Form.Item name="rdb" valuePropName="checked" label="Snapshots (RDB)" extra="Saves the data to disk from time to time.">
                      <Switch />
                    </Form.Item>
                    <Form.Item name="appendonly" valuePropName="checked" label="Append-only file (AOF)" extra="Logs every write. Safest, uses more disk.">
                      <Switch />
                    </Form.Item>
                  </div>
                  {appendonly === false && rdb === false && (
                    <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="With both turned off, all data is lost every time Redis restarts. Fine for a pure cache, not for sessions or queues." />
                  )}
                  <Button type="primary" loading={busy} onClick={() => void saveSettings()}>
                    Save and restart Redis
                  </Button>
                </Form>
              )
            },
            {
              key: 'dbs',
              label: 'Databases',
              children: !s ? (
                <Alert type="info" showIcon message="Start Redis to see its databases." />
              ) : (
                <div style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
                  <Table
                    rowKey="db"
                    size="small"
                    pagination={false}
                    dataSource={s.databases}
                    locale={{ emptyText: 'No keys stored' }}
                    columns={[
                      { title: 'Database', dataIndex: 'db', render: (v: number) => `db${v}` },
                      { title: 'Keys', dataIndex: 'keys', render: (v: number) => v.toLocaleString() },
                      {
                        title: '',
                        align: 'right',
                        render: (_, d) => (
                          <Button size="small" danger disabled={busy} onClick={() => flush(d.db)}>
                            Empty
                          </Button>
                        )
                      }
                    ]}
                  />
                  {s.databases.length > 0 && (
                    <div>
                      <Button danger disabled={busy} onClick={() => flush(null)}>
                        Empty all databases
                      </Button>
                    </div>
                  )}
                </div>
              )
            },
            {
              key: 'conf',
              label: 'redis.conf',
              children: (
                <div style={{ display: 'grid', gap: 12 }}>
                  <Alert type="info" showIcon message='To switch "appendonly" on or off, use the Settings tab: it converts the stored data first. Changing it here can start Redis empty.' />
                  <Input.TextArea
                    value={raw}
                    onChange={(e) => setRaw(e.target.value)}
                    className="mono"
                    spellCheck={false}
                    aria-label="redis.conf"
                    style={{ height: 'calc(100vh - 420px)', minHeight: 260, fontSize: 12.5, resize: 'none' }}
                  />
                  <Space>
                    <Button type="primary" disabled={raw === data.raw} loading={busy} onClick={() => void act(() => window.api.redis.saveRaw(project.id, raw), 'redis.conf saved and Redis restarted')}>
                      Save and restart Redis
                    </Button>
                    <Button disabled={raw === data.raw} onClick={() => setRaw(data.raw)}>
                      Undo changes
                    </Button>
                    <span className="mono" style={{ color: 'var(--muted)', fontSize: 12 }}>
                      {data.confPath}
                    </span>
                  </Space>
                </div>
              )
            }
          ]}
        />
      </div>
      <JobDrawer job={job} />
    </div>
  )
}
