import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, App as AntApp, Button, Form, Input, InputNumber, Radio, Select, Space, Spin, Switch, Table, Tabs, Tooltip } from 'antd'
import { ReloadOutlined, SendOutlined, StopOutlined } from '@ant-design/icons'
import type { AlertConfig, LogSource, Project, ThreatRow, Threats } from '@shared/types'
import { errText } from '../util'

function LogViewer({ project }: { project: Project }) {
  const [sources, setSources] = useState<LogSource[] | null>(null)
  const [source, setSource] = useState<string>()
  const [lines, setLines] = useState(200)
  const [filter, setFilter] = useState('')
  const [live, setLive] = useState(false)
  const [text, setText] = useState('')
  const [tidy, setTidy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.api.logs
      .sources(project.id)
      .then((s) => {
        setSources(s)
        setSource((cur) => cur ?? s.find((x) => x.id.includes('auth') || x.id.includes('secure'))?.id ?? s[0]?.id)
      })
      .catch((err) => setError(errText(err)))
  }, [project.id])

  const read = useCallback(async () => {
    if (!source) return
    setLoading(true)
    try {
      setText(await window.api.logs.read(project.id, source, lines, filter, tidy))
      setError(null)
    } catch (err) {
      setError(errText(err))
      setLive(false)
    } finally {
      setLoading(false)
    }
  }, [project.id, source, lines, filter, tidy])

  useEffect(() => {
    void read()
    if (!live) return
    const t = setInterval(() => void read(), 5000)
    return () => clearInterval(t)
  }, [read, live])

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [text])

  if (error && !sources) return <Alert type="error" showIcon message="Could not read the logs" description={error} />
  if (!sources) return <Spin />
  if (sources.length === 0) return <Alert type="info" showIcon message="No log files were found on this server." />

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Space wrap>
        <Select style={{ width: 300 }} value={source} onChange={setSource} options={sources.map((s) => ({ value: s.id, label: s.label }))} aria-label="Log" showSearch optionFilterProp="label" />
        <Select
          style={{ width: 130 }}
          value={lines}
          onChange={setLines}
          options={[200, 500, 1000, 3000].map((n) => ({ value: n, label: `Last ${n} lines` }))}
          aria-label="Lines"
        />
        <Input.Search style={{ width: 240 }} placeholder="Only lines containing…" allowClear onSearch={setFilter} aria-label="Filter" />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void read()}>
          Refresh
        </Button>
        <Space>
          <Switch checked={live} onChange={setLive} aria-label="Live" />
          Live (every 5 s)
        </Space>
        <Tooltip title="Every action of this app runs through sudo, which fills the log with long encoded commands. They are hidden here; other people's sudo commands stay.">
          <Space>
            <Switch checked={tidy} onChange={setTidy} aria-label="Hide this app's own commands" />
            Hide Apsara Panel's own commands
          </Space>
        </Tooltip>
      </Space>
      {error && <Alert type="error" showIcon message={error} />}
      <div className="log-box log-rows" style={{ height: 'calc(100vh - 290px)', minHeight: 260 }}>
        {text ? <LogLines text={text} /> : loading ? 'Loading…' : 'No lines.'}
        <div ref={end} />
      </div>
    </div>
  )
}

const RE_ISO = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)\S*\s+\S+\s+([^:[\s]+)(?:\[\d+\])?:\s?(.*)$/
const RE_SYSLOG = /^([A-Z][a-z]{2}\s+\d+)\s(\d\d:\d\d:\d\d)\s+\S+\s+([^:[\s]+)(?:\[\d+\])?:\s?(.*)$/
const RE_BAD = /\b(fail(ed|ure)?|invalid user|error|denied|refused|fatal|panic|segfault|out of memory|not permitted|unauthorized|break-in|maximum authentication attempts)\b/i
const RE_WARN = /\b(warn(ing)?|timeout|timed out|disconnected|retry|deprecated)\b/i
const RE_GOOD = /\b(accepted (password|publickey)|session opened|started|success(ful)?)\b/i
const RE_ACCESS = /" ([1-5]\d\d) \d+/

/** Log lines as rows: time, program, message, with problems and successes coloured. */
function LogLines({ text }: { text: string }) {
  const rows = useMemo(() => text.split('\n').filter((l) => l.length > 0), [text])
  let lastDay = ''
  return (
    <>
      {rows.map((line, i) => {
        const m = RE_ISO.exec(line) ?? RE_SYSLOG.exec(line)
        const access = m ? null : RE_ACCESS.exec(line)
        const body = m ? m[4] : line
        const tone = access ? (access[1] >= '500' ? 'bad' : access[1] >= '400' ? 'warn' : '') : RE_BAD.test(body) ? 'bad' : RE_WARN.test(body) ? 'warn' : RE_GOOD.test(body) ? 'good' : ''
        if (!m) {
          return (
            <div key={i} className={`log-row raw ${tone}`}>
              {line}
            </div>
          )
        }
        const day = m[1] !== lastDay ? m[1] : ''
        lastDay = m[1]
        return (
          <div key={i}>
            {day && <div className="log-day">{day}</div>}
            <div className={`log-row ${tone}`}>
              <span className="log-time">{m[2]}</span>
              <span className="log-proc">{m[3]}</span>
              <span className="log-msg">{body}</span>
            </div>
          </div>
        )
      })}
    </>
  )
}

function Attacks({ project }: { project: Project }) {
  const { message, modal } = AntApp.useApp()
  const [data, setData] = useState<Threats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await window.api.logs.threats(project.id))
      setError(null)
    } catch (err) {
      setError(errText(err))
    } finally {
      setLoading(false)
    }
  }, [project.id])

  useEffect(() => {
    void load()
  }, [load])

  const block = (ip: string): void => {
    modal.confirm({
      title: `Block ${ip}?`,
      content: 'It is denied in the system firewall (when that is on) and in nginx. Make sure this is not your own IP.',
      okText: 'Block IP',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const where = await window.api.firewall.blockIp(project.id, ip)
          message.success(`${ip} blocked in ${where.join(' and ')}`)
        } catch (err) {
          message.error(errText(err))
        }
      }
    })
  }

  const blockCol = {
    title: '',
    align: 'right' as const,
    render: (_: unknown, r: ThreatRow) => (
      <Button size="small" danger icon={<StopOutlined />} onClick={() => block(r.ip)}>
        Block
      </Button>
    )
  }

  if (error) return <Alert type="error" showIcon message="Could not analyse the logs" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
  if (!data) return <Spin />

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      <div className="grid cols-2">
        <div>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Failed SSH logins, by source</div>
          <Table<ThreatRow>
            rowKey="ip"
            size="small"
            pagination={false}
            dataSource={data.ssh}
            locale={{ emptyText: 'No failed logins in the recent log' }}
            columns={[{ title: 'IP', dataIndex: 'ip', render: (v: string) => <span className="mono">{v}</span> }, { title: 'Failed logins', dataIndex: 'count' }, blockCol]}
          />
        </div>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Busiest web visitors (last 20,000 requests per site)</div>
          <Table<ThreatRow>
            rowKey="ip"
            size="small"
            pagination={false}
            dataSource={data.web}
            locale={{ emptyText: 'No nginx access logs yet' }}
            columns={[
              { title: 'IP', dataIndex: 'ip', render: (v: string) => <span className="mono">{v}</span> },
              { title: 'Requests', dataIndex: 'count' },
              { title: 'Errors (4xx / 5xx)', dataIndex: 'errors' },
              blockCol
            ]}
          />
        </div>
      </div>
    </div>
  )
}

function TelegramAlerts({ project }: { project: Project }) {
  const { message } = AntApp.useApp()
  const [form] = Form.useForm<AlertConfig>()
  const [cfg, setCfg] = useState<AlertConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const via = (Form.useWatch('via', form) ?? 'own') as 'team' | 'own'

  const load = useCallback(async () => {
    try {
      const c = await window.api.alerts.get(project.id)
      // A server that has no alerts yet starts with the team's Telegram when there is one: nothing more to type.
      const via = c.via === 'team' || (!c.hasToken && !c.enabled && c.teamReady) ? 'team' : 'own'
      setCfg({ ...c, via })
      form.setFieldsValue({ ...c, via })
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id, form])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (): Promise<boolean> => {
    let v: AlertConfig
    try {
      v = await form.validateFields()
    } catch {
      return false
    }
    setSaving(true)
    try {
      await window.api.alerts.save(project.id, { ...cfg!, ...v, token: v.token ?? '' })
      await load()
      message.success('Alert settings saved')
      return true
    } catch (err) {
      message.error(errText(err))
      return false
    } finally {
      setSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    if (!(await save())) return
    setTesting(true)
    try {
      await window.api.alerts.test(project.id)
      message.success('Test message sent. Check Telegram.')
    } catch (err) {
      message.error(errText(err))
    } finally {
      setTesting(false)
    }
  }

  if (error) return <Alert type="error" showIcon message="Could not read the alert settings" description={error} />
  if (!cfg) return <Spin />

  return (
    <div style={{ maxWidth: 720 }}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="The server checks itself every 2 minutes and sends alerts even when this app is closed."
        description="With the team's Telegram, the bot is set once (Team, Protection) and every server sends through the service: nothing to type here, and no bot token is kept on the server."
      />
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="enabled" valuePropName="checked" label="Alerts">
          <Switch checkedChildren="On" unCheckedChildren="Off" />
        </Form.Item>
        <Form.Item name="via" label="Send through" extra={via === 'team' ? (cfg.teamReady ? "Alerts arrive in the team's chat with the server's name in front. The server must be able to reach the service's address." : "The team's Telegram is not set up yet. An admin sets it once under Team, Protection; then save here.") : 'Create a bot with @BotFather in Telegram to get a token. Then open a chat with your bot and press Start. Your chat ID is shown by @userinfobot.'}>
          <Radio.Group
            options={[
              { value: 'team', label: "The team's Telegram (set once)" },
              { value: 'own', label: "This server's own bot" }
            ]}
          />
        </Form.Item>
        <div className="grid cols-2" style={{ display: via === 'team' ? 'none' : undefined }}>
          <Form.Item
            name="token"
            label="Bot token"
            rules={[{ required: via !== 'team' && !cfg.hasToken, message: 'Enter the bot token' }]}
            extra={cfg.hasToken ? 'A token is saved. Leave empty to keep it.' : undefined}
          >
            <Input.Password autoComplete="off" placeholder={cfg.hasToken ? 'Saved' : '123456:ABC-DEF…'} />
          </Form.Item>
          <Form.Item name="chatId" label="Chat ID" rules={[{ required: via !== 'team', message: 'Enter the chat ID' }]}>
            <Input placeholder="e.g. 123456789" spellCheck={false} />
          </Form.Item>
        </div>
        <div className="grid cols-3">
          <Form.Item name="diskPct" label="Disk fuller than">
            <InputNumber min={1} max={100} addonAfter="%" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="memPct" label="Memory use above">
            <InputNumber min={1} max={100} addonAfter="%" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="loadPct" label="CPU load above" extra="100% = all cores busy">
            <InputNumber min={10} max={10000} addonAfter="%" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="sshFails" label="Failed SSH logins" extra="Per 2 minutes. 0 = do not watch">
            <InputNumber min={0} max={100000} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="cooldownMin" label="Repeat the same alert after">
            <InputNumber min={1} max={1440} addonAfter="min" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="certDays" label="Warn when an HTTPS certificate has fewer than" extra="Certificates normally renew themselves about 30 days before they expire. 0 turns this off.">
            <InputNumber min={0} max={90} addonAfter="days left" style={{ width: 200 }} />
          </Form.Item>
          <Form.Item name="backupHours" label="Warn when a backup has made nothing new for" extra="Covers the daily database backup and the copies on Google Drive, where they are switched on. Said once a day. 0 turns this off.">
            <InputNumber min={0} max={720} addonAfter="hours" style={{ width: 170 }} />
          </Form.Item>
          <Form.Item name="watchSites" valuePropName="checked" label="Alert when a site stops answering" extra="Checked every 2 minutes on the server itself. You also get a message when the site is back.">
            <Switch />
          </Form.Item>
          <Form.Item name="watchNginx" valuePropName="checked" label="Alert when nginx stops">
            <Switch />
          </Form.Item>
        </div>
        <Space>
          <Button type="primary" loading={saving} onClick={() => void save()}>
            Save
          </Button>
          <Button icon={<SendOutlined />} loading={testing} onClick={() => void test()}>
            Save and send a test message
          </Button>
        </Space>
      </Form>
    </div>
  )
}

export default function Logs({ project }: { project: Project }) {
  return (
    <div className="card">
      <Tabs
        destroyInactiveTabPane
        items={[
          { key: 'logs', label: 'Logs', children: <LogViewer project={project} /> },
          { key: 'attacks', label: 'Attacks', children: <Attacks project={project} /> },
          { key: 'alerts', label: 'Telegram alerts', children: <TelegramAlerts project={project} /> }
        ]}
      />
    </div>
  )
}
