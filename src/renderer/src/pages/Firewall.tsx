import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Input, InputNumber, Select, Space, Spin, Switch, Table, Tag } from 'antd'
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { FirewallRule, FirewallRuleInput, FirewallStatus, NginxFirewall, Project } from '@shared/types'
import { JobDrawer, useJob } from '../components/JobLog'
import { errText } from '../util'

const EMPTY_RULE: FirewallRuleInput = { action: 'allow', port: '', proto: 'tcp', from: '' }

export default function Firewall({ project }: { project: Project }) {
  const { message, modal } = AntApp.useApp()
  const [fw, setFw] = useState<FirewallStatus | null>(null)
  const [ngx, setNgx] = useState<NginxFirewall | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [rule, setRule] = useState<FirewallRuleInput>(EMPTY_RULE)
  const [newIp, setNewIp] = useState('')
  const [ngxDirty, setNgxDirty] = useState(false)
  const job = useJob(`fw:${project.id}`)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [a, b] = await Promise.all([window.api.firewall.status(project.id), window.api.firewall.nginxGet(project.id)])
      setFw(a)
      setNgx(b)
      setNgxDirty(false)
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id])

  useEffect(() => {
    void load()
  }, [load])

  /** Run one change, then re-read the real state from the server. */
  const act = async (fn: () => Promise<unknown>, done?: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      if (done) message.success(done)
    } catch (err) {
      message.error(errText(err))
    }
    await load()
    setBusy(false)
  }

  const toggle = (on: boolean): void => {
    if (!fw) return
    modal.confirm({
      title: on ? 'Switch the firewall on?' : 'Switch the firewall off?',
      content: on
        ? `SSH port ${fw.sshPort} is opened first so this app stays connected. Every other port that has no allow rule becomes unreachable from outside, so add rules for your websites (80, 443) too.`
        : 'All ports become reachable again. The rules are kept.',
      okText: on ? 'Switch on' : 'Switch off',
      onOk: () => act(() => window.api.firewall.setEnabled(project.id, fw.kind, on), on ? 'Firewall is on' : 'Firewall is off')
    })
  }

  const addRule = (): void => {
    if (!fw) return
    void act(async () => {
      await window.api.firewall.addRule(project.id, fw.kind, rule)
      setRule(EMPTY_RULE)
    }, 'Rule added')
  }

  const removeRule = (r: FirewallRule): void => {
    modal.confirm({
      title: 'Delete this rule?',
      content: `${r.action} ${r.to} from ${r.from}`,
      okText: 'Delete rule',
      okButtonProps: { danger: true },
      onOk: () => act(() => window.api.firewall.deleteRule(project.id, r.id))
    })
  }

  const patchNgx = (patch: Partial<NginxFirewall>): void => {
    setNgx((n) => (n ? { ...n, ...patch } : n))
    setNgxDirty(true)
  }

  const addIp = (): void => {
    const ip = newIp.trim()
    if (!ip || !ngx) return
    if (!ngx.blocked.includes(ip)) patchNgx({ blocked: [...ngx.blocked, ip] })
    setNewIp('')
  }

  if (error) {
    return (
      <div className="card">
        <Alert type="error" showIcon message="Could not read the firewall" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
      </div>
    )
  }
  if (!fw || !ngx) {
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
          <Space>
            System firewall
            {fw.kind === 'none' ? <Tag>Not installed</Tag> : <Tag color={fw.active ? 'green' : 'default'}>{fw.kind} · {fw.active ? 'on' : 'off'}</Tag>}
          </Space>
          <Space>
            <Button size="small" type="text" icon={<ReloadOutlined />} aria-label="Refresh" onClick={() => void load()} />
            {fw.kind !== 'none' && <Switch checked={fw.active} loading={busy} onChange={toggle} aria-label="Firewall on or off" />}
          </Space>
        </div>

        {fw.kind === 'none' ? (
          <Alert
            type="info"
            showIcon
            message="No firewall is installed on this server."
            action={
              <Button
                type="primary"
                disabled={!fw.packageManager}
                onClick={() => void job.run('Install firewall', () => window.api.firewall.install(project.id)).then(load)}
              >
                Install {fw.packageManager === 'apt-get' ? 'ufw' : 'firewalld'}
              </Button>
            }
          />
        ) : (
          <>
            {!fw.active && fw.rules.length === 0 && (
              <Alert type="info" showIcon style={{ marginBottom: 12 }} message="The firewall is off. Rules are listed here once it is on." />
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 100px 1.3fr auto', gap: 8, marginBottom: 14 }}>
              <Select
                value={rule.action}
                onChange={(action) => setRule({ ...rule, action })}
                options={[
                  { value: 'allow', label: 'Allow' },
                  { value: 'deny', label: 'Deny' }
                ]}
                aria-label="Action"
              />
              <Input placeholder="Port, e.g. 443 or 8000:8100" value={rule.port} onChange={(e) => setRule({ ...rule, port: e.target.value })} aria-label="Port" />
              <Select
                value={rule.proto}
                onChange={(proto) => setRule({ ...rule, proto })}
                options={[
                  { value: 'tcp', label: 'TCP' },
                  { value: 'udp', label: 'UDP' },
                  { value: 'both', label: 'Both' }
                ]}
                aria-label="Protocol"
              />
              <Input placeholder="From IP (empty = anyone)" value={rule.from} onChange={(e) => setRule({ ...rule, from: e.target.value })} aria-label="From IP" />
              <Button type="primary" icon={<PlusOutlined />} loading={busy} onClick={addRule}>
                Add rule
              </Button>
            </div>
            <Table<FirewallRule>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={fw.rules}
              locale={{ emptyText: 'No rules yet' }}
              columns={[
                { title: 'Port / target', dataIndex: 'to', render: (v: string) => <span className="mono">{v}</span> },
                {
                  title: 'Action',
                  dataIndex: 'action',
                  render: (v: string) => <Tag color={v.startsWith('ALLOW') ? 'green' : v.startsWith('DENY') || v.startsWith('REJECT') ? 'red' : 'default'}>{v}</Tag>
                },
                { title: 'From', dataIndex: 'from', render: (v: string) => <span className="mono">{v}</span> },
                {
                  title: '',
                  align: 'right',
                  render: (_, r) => <Button type="text" danger icon={<DeleteOutlined />} aria-label="Delete rule" disabled={busy} onClick={() => removeRule(r)} />
                }
              ]}
            />
          </>
        )}
      </div>

      <div className="card">
        <div className="card-title">
          <Space>
            Nginx firewall
            <span style={{ fontWeight: 400 }}>applies to every site on this server</span>
          </Space>
        </div>
        {!ngx.available ? (
          <Alert type="info" showIcon message="nginx is not installed on this server. Install it from Sites & Deploy." />
        ) : (
          <div style={{ display: 'grid', gap: 16 }}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Blocked IPs</div>
              <Space size={[6, 6]} wrap>
                {ngx.blocked.length === 0 && <span style={{ color: 'var(--muted)' }}>Nobody is blocked.</span>}
                {ngx.blocked.map((ip) => (
                  <Tag key={ip} closable className="mono" onClose={() => patchNgx({ blocked: ngx.blocked.filter((b) => b !== ip) })}>
                    {ip}
                  </Tag>
                ))}
              </Space>
              <Space.Compact style={{ marginTop: 10, width: 360 }}>
                <Input placeholder="IP or range, e.g. 203.0.113.0/24" value={newIp} onChange={(e) => setNewIp(e.target.value)} onPressEnter={addIp} aria-label="IP to block" />
                <Button onClick={addIp}>Add</Button>
              </Space.Compact>
            </div>
            <div>
              <Space align="center" wrap>
                <Switch checked={ngx.rateLimit} onChange={(rateLimit) => patchNgx({ rateLimit })} aria-label="Rate limit" />
                <span style={{ fontWeight: 600 }}>Limit requests per visitor</span>
                {ngx.rateLimit && (
                  <>
                    <InputNumber min={1} max={10000} value={ngx.rate} onChange={(v) => patchNgx({ rate: v ?? 10 })} addonAfter="per second" style={{ width: 170 }} aria-label="Requests per second" />
                    <InputNumber min={0} max={100000} value={ngx.burst} onChange={(v) => patchNgx({ burst: v ?? 0 })} addonBefore="burst" style={{ width: 150 }} aria-label="Burst" />
                  </>
                )}
              </Space>
              <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>
                Visitors above the limit get error 429. Burst is how many extra requests are let through at once before limiting starts.
              </div>
            </div>
            <div>
              <Button type="primary" disabled={!ngxDirty} loading={busy} onClick={() => void act(() => window.api.firewall.nginxSet(project.id, ngx), 'Nginx firewall updated')}>
                Apply changes
              </Button>
            </div>
          </div>
        )}
      </div>
      <JobDrawer job={job} />
    </div>
  )
}
