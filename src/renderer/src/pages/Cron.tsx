import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Dropdown, Form, Input, InputNumber, Modal, Segmented, Select, Space, Spin, Switch, Table, Tag } from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { CronKind, CronOverview, CronTask, Project } from '@shared/types'
import { JobDrawer, useJob } from '../components/JobLog'
import { ago, errText } from '../util'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const NEW_TASK: CronTask = { id: '', name: '', type: 'shell', command: '', kind: 'daily', every: 5, minute: 30, hour: 2, weekday: 1, day: 1, expr: '*/5 * * * *', enabled: true }
const pad = (n: number): string => String(n).padStart(2, '0')

/** Ready-made tasks. `site` and `url` are filled in from the server's first site when there is one. */
interface Template {
  key: string
  title: string
  about: string
  make: (site: string, url: string) => Partial<CronTask>
}
const TEMPLATES: Template[] = [
  { key: 'laravel', title: 'Laravel scheduler', about: 'Every minute', make: (site) => ({ name: 'Laravel scheduler', type: 'shell', kind: 'minutes', every: 1, command: `cd ${site}\nphp artisan schedule:run` }) },
  { key: 'queue', title: 'Restart Laravel queue workers', about: 'Every night', make: (site) => ({ name: 'Restart queue workers', type: 'shell', kind: 'daily', hour: 3, minute: 0, command: `cd ${site}\nphp artisan queue:restart` }) },
  { key: 'wpcron', title: 'WordPress cron', about: 'Every 5 minutes', make: (_s, url) => ({ name: 'WordPress cron', type: 'url', kind: 'minutes', every: 5, command: `${url}/wp-cron.php?doing_wp_cron` }) },
  { key: 'ping', title: 'Visit a page to keep it warm', about: 'Every 5 minutes', make: (_s, url) => ({ name: 'Visit the site', type: 'url', kind: 'minutes', every: 5, command: `${url}/` }) },
  { key: 'logs', title: 'Delete old log files', about: 'Every night, older than 14 days', make: (site) => ({ name: 'Delete old logs', type: 'shell', kind: 'daily', hour: 2, minute: 30, command: `find ${site}/storage/logs -type f -name "*.log" -mtime +14 -delete` }) },
  { key: 'tmp', title: 'Clean temporary files', about: 'Every week, older than 7 days', make: () => ({ name: 'Clean /tmp', type: 'shell', kind: 'weekly', weekday: 0, hour: 4, minute: 0, command: 'find /tmp -xdev -type f -mtime +7 -delete' }) },
  { key: 'cert', title: 'Renew HTTPS certificates', about: 'Every day', make: () => ({ name: 'Renew certificates', type: 'shell', kind: 'daily', hour: 3, minute: 15, command: 'certbot renew --quiet\nnginx -t && (systemctl reload nginx || nginx -s reload)' }) },
  { key: 'fpm', title: 'Restart PHP-FPM', about: 'Every night', make: () => ({ name: 'Restart PHP-FPM', type: 'shell', kind: 'daily', hour: 4, minute: 30, command: 'systemctl restart "php*-fpm.service"' }) },
  { key: 'disk', title: 'Note disk usage in the task log', about: 'Every hour', make: () => ({ name: 'Disk usage', type: 'shell', kind: 'hourly', minute: 0, command: 'df -h / | tail -1' }) },
  { key: 'django', title: 'Django: clear expired sessions', about: 'Every night', make: (site) => ({ name: 'Clear Django sessions', type: 'shell', kind: 'daily', hour: 3, minute: 45, command: `cd ${site}\n.venv/bin/python manage.py clearsessions` }) }
]

function describe(t: CronTask): string {
  switch (t.kind) {
    case 'minutes':
      return t.every === 1 ? 'Every minute' : `Every ${t.every} minutes`
    case 'hourly':
      return `Every hour at :${pad(t.minute)}`
    case 'daily':
      return `Every day at ${pad(t.hour)}:${pad(t.minute)}`
    case 'weekly':
      return `Every ${DAYS[t.weekday]} at ${pad(t.hour)}:${pad(t.minute)}`
    case 'monthly':
      return `Day ${t.day} of each month at ${pad(t.hour)}:${pad(t.minute)}`
    default:
      return t.expr
  }
}

export default function Cron({ project }: { project: Project }) {
  const { message, modal } = AntApp.useApp()
  const [data, setData] = useState<CronOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<CronTask | null>(null)
  const [log, setLog] = useState<{ task: CronTask; text: string | null } | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm<CronTask>()
  // The first site on this server, so a template comes with a real path and address where possible.
  const [first, setFirst] = useState<{ site: string; url: string }>({ site: '/www/wwwroot/your-site', url: 'https://example.com' })
  useEffect(() => {
    window.api.sites
      .list(project.id)
      .then((list) => {
        const s = list.find((x) => x.appType !== 'balancer' && x.rootPath) ?? list[0]
        if (s) setFirst({ site: s.rootPath || '/www/wwwroot/your-site', url: `http${s.ssl ? 's' : ''}://${s.domain.split(/[\s,]+/)[0]}` })
      })
      .catch(() => undefined)
  }, [project.id])
  const useTemplate = (t: Template): void => {
    const task = { ...NEW_TASK, ...t.make(first.site, first.url) }
    setEditing(task)
    form.setFieldsValue(task)
  }
  const kind = (Form.useWatch('kind', form) ?? 'daily') as CronKind
  const type = Form.useWatch('type', form) ?? 'shell'
  const job = useJob(`cron:${project.id}`)

  const load = useCallback(async () => {
    try {
      setData(await window.api.cron.list(project.id))
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id])

  useEffect(() => {
    void load()
  }, [load])

  const open = (t: CronTask): void => {
    setEditing(t)
    form.setFieldsValue(t)
  }

  const save = async (): Promise<void> => {
    let v: CronTask
    try {
      v = await form.validateFields()
    } catch {
      return
    }
    setSaving(true)
    try {
      await window.api.cron.save(project.id, { ...editing!, ...v })
      setEditing(null)
      await load()
      message.success('Task saved')
    } catch (err) {
      message.error(errText(err))
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (t: CronTask, enabled: boolean): Promise<void> => {
    try {
      await window.api.cron.save(project.id, { ...t, enabled })
    } catch (err) {
      message.error(errText(err))
    }
    await load()
  }

  const remove = (t: CronTask): void => {
    modal.confirm({
      title: `Delete task "${t.name}"?`,
      content: 'The schedule, the script and its log are removed from the server.',
      okText: 'Delete task',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.api.cron.remove(project.id, t.id)
        } catch (err) {
          message.error(errText(err))
        }
        await load()
      }
    })
  }

  const showLog = async (t: CronTask): Promise<void> => {
    setLog({ task: t, text: null })
    try {
      const text = await window.api.cron.log(project.id, t.id)
      setLog({ task: t, text })
    } catch (err) {
      setLog(null)
      message.error(errText(err))
    }
  }

  if (error) {
    return (
      <div className="card">
        <Alert type="error" showIcon message="Could not read the scheduled tasks" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
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

  const timeFields = (
    <>
      <Form.Item name="hour" label="Hour">
        <InputNumber min={0} max={23} style={{ width: 90 }} />
      </Form.Item>
      <Form.Item name="minute" label="Minute">
        <InputNumber min={0} max={59} style={{ width: 90 }} />
      </Form.Item>
    </>
  )

  return (
    <div className="grid">
      {!data.daemonRunning && (
        <Alert
          type="warning"
          showIcon
          message="The cron service is not running on this server."
          description="Scheduled tasks, backups and alerts will not fire until it runs. Start it from the Terminal: systemctl enable --now cron (or crond)."
        />
      )}
      <div className="card">
        <div className="card-title">
          Scheduled tasks
          <Space>
            <Button size="small" type="text" icon={<ReloadOutlined />} aria-label="Refresh" onClick={() => void load()} />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => open(NEW_TASK)}>
              New task
            </Button>
          </Space>
        </div>
        <Table<CronTask>
          rowKey="id"
          size="middle"
          pagination={false}
          dataSource={data.tasks}
          locale={{ emptyText: <div style={{ padding: '24px 0' }}>No tasks yet. Add one to run a script or visit a URL on a schedule.</div> }}
          columns={[
            {
              title: 'Task',
              render: (_, t) => (
                <div>
                  <div style={{ fontWeight: 600 }}>{t.name}</div>
                  <div className="mono" style={{ color: 'var(--muted)', fontSize: 12, maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.command.split('\n')[0]}
                  </div>
                </div>
              )
            },
            { title: 'Type', render: (_, t) => <Tag>{t.type === 'url' ? 'Visit URL' : 'Shell script'}</Tag> },
            { title: 'Schedule', render: (_, t) => describe(t) },
            {
              title: 'Last run',
              render: (_, t) =>
                t.lastRun ? (
                  <Space size={6}>
                    <Tag color={t.lastExit === 0 ? 'green' : 'red'} style={{ marginInlineEnd: 0 }}>
                      {t.lastExit === 0 ? 'OK' : `Failed (${t.lastExit})`}
                    </Tag>
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>{ago(t.lastRun)}</span>
                  </Space>
                ) : (
                  <span style={{ color: 'var(--muted)' }}>Never</span>
                )
            },
            { title: 'On', render: (_, t) => <Switch size="small" checked={t.enabled} onChange={(v) => void toggle(t, v)} aria-label={`Enable ${t.name}`} /> },
            {
              title: '',
              align: 'right',
              render: (_, t) => (
                <Space>
                  <Button type="primary" ghost disabled={job.state === 'running'} onClick={() => void job.run(`Run ${t.name}`, () => window.api.cron.run(project.id, t.id)).then(load)}>
                    Run now
                  </Button>
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: [
                        { key: 'log', label: 'View log' },
                        { key: 'edit', label: 'Edit' },
                        { type: 'divider' },
                        { key: 'remove', label: 'Delete', danger: true }
                      ],
                      onClick: ({ key }) => {
                        if (key === 'log') void showLog(t)
                        if (key === 'edit') open(t)
                        if (key === 'remove') remove(t)
                      }
                    }}
                  >
                    <Button aria-label={`More actions for ${t.name}`}>More</Button>
                  </Dropdown>
                </Space>
              )
            }
          ]}
        />
        <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 12 }}>Tasks run as root, in server time. Each keeps its own log.</div>
      </div>

      {data.other.length > 0 && (
        <div className="card">
          <div className="card-title">Other entries in root's crontab (not managed here)</div>
          <pre className="log-box" style={{ height: 'auto', maxHeight: 180 }}>
            {data.other.join('\n')}
          </pre>
        </div>
      )}

      <Modal
        open={!!editing}
        title={editing?.id ? `Edit ${editing.name}` : 'New task'}
        okText="Save task"
        confirmLoading={saving}
        onOk={() => void save()}
        onCancel={() => setEditing(null)}
        width={600}
        destroyOnClose
      >
        {editing && !editing.id && (
          <div className="cron-templates">
            <div className="cron-templates-title">Start from a template, then adjust it</div>
            <div className="cron-templates-list">
              {TEMPLATES.map((t) => (
                <button type="button" key={t.key} className="cron-template" onClick={() => useTemplate(t)}>
                  <span>{t.title}</span>
                  <small>{t.about}</small>
                </button>
              ))}
            </div>
          </div>
        )}
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="name" label="Task name" rules={[{ required: true, message: 'Give the task a name' }]}>
            <Input placeholder="Clear cache every night" maxLength={60} />
          </Form.Item>
          <Form.Item name="type" label="What it does">
            <Segmented
              options={[
                { value: 'shell', label: 'Run a shell script' },
                { value: 'url', label: 'Visit a URL' }
              ]}
            />
          </Form.Item>
          <Space align="start" wrap>
            <Form.Item name="kind" label="When">
              <Select
                style={{ width: 190 }}
                options={[
                  { value: 'minutes', label: 'Every N minutes' },
                  { value: 'hourly', label: 'Every hour' },
                  { value: 'daily', label: 'Every day' },
                  { value: 'weekly', label: 'Every week' },
                  { value: 'monthly', label: 'Every month' },
                  { value: 'custom', label: 'Custom (cron expression)' }
                ]}
              />
            </Form.Item>
            {kind === 'minutes' && (
              <Form.Item name="every" label="N">
                <InputNumber min={1} max={59} addonAfter="min" style={{ width: 120 }} />
              </Form.Item>
            )}
            {kind === 'hourly' && (
              <Form.Item name="minute" label="At minute">
                <InputNumber min={0} max={59} style={{ width: 100 }} />
              </Form.Item>
            )}
            {kind === 'weekly' && (
              <Form.Item name="weekday" label="Day">
                <Select style={{ width: 140 }} options={DAYS.map((d, i) => ({ value: i, label: d }))} />
              </Form.Item>
            )}
            {kind === 'monthly' && (
              <Form.Item name="day" label="Day of month">
                <InputNumber min={1} max={31} style={{ width: 110 }} />
              </Form.Item>
            )}
            {(kind === 'daily' || kind === 'weekly' || kind === 'monthly') && timeFields}
            {kind === 'custom' && (
              <Form.Item name="expr" label="minute hour day month weekday" rules={[{ required: true, message: 'Enter the 5 fields' }]}>
                <Input className="mono" style={{ width: 220 }} placeholder="*/10 8-18 * * 1-5" spellCheck={false} />
              </Form.Item>
            )}
          </Space>
          {type === 'url' ? (
            <Form.Item name="command" label="URL" rules={[{ required: true, message: 'Enter the URL' }]} extra="The task fails when the site answers with an error.">
              <Input className="mono" placeholder="https://example.com/cron.php" spellCheck={false} />
            </Form.Item>
          ) : (
            <Form.Item name="command" label="Script" rules={[{ required: true, message: 'Enter the commands to run' }]}>
              <Input.TextArea rows={6} className="mono" spellCheck={false} placeholder={'cd /www/wwwroot/shop\nphp artisan schedule:run'} style={{ fontSize: 12.5 }} />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Modal open={!!log} title={`Log · ${log?.task.name ?? ''}`} width={780} onCancel={() => setLog(null)} footer={<Button onClick={() => log && void showLog(log.task)}>Refresh</Button>}>
        <pre className="log-box" style={{ height: 420 }}>
          {log?.text === null ? 'Loading…' : log?.text || 'This task has not run yet.'}
        </pre>
      </Modal>
      <JobDrawer job={job} />
    </div>
  )
}
