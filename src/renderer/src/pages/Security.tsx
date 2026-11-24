import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, App as AntApp, Button, Empty, Input, Modal, Progress, Select, Space, Spin, Switch, Tooltip } from 'antd'
import { ArrowRightOutlined, SearchOutlined, SettingOutlined, SyncOutlined, WarningFilled } from '@ant-design/icons'
import type { BannedList, Project, SecurityCheck, SecurityProtection, SecurityReport } from '@shared/types'
import { JobDrawer, useJob } from '../components/JobLog'
import { errText } from '../util'

type Level = 'high' | 'medium' | 'low'
const LEVEL_NAME: Record<Level, string> = { high: 'High', medium: 'Medium', low: 'Low' }
const levelOf = (c: SecurityCheck): Level => (c.weight >= 20 ? 'high' : c.weight >= 10 ? 'medium' : 'low')

function verdict(score: number): { text: string; tone: 'good' | 'fair' | 'warn' | 'bad' } {
  if (score >= 90) return { text: 'Well protected', tone: 'good' }
  if (score >= 70) return { text: 'Mostly protected', tone: 'fair' }
  if (score >= 45) return { text: 'Needs attention', tone: 'warn' }
  return { text: 'At risk', tone: 'bad' }
}

function ago(t: number, now: number): string {
  const m = Math.floor((now - t) / 60000)
  if (m < 1) return 'Just now'
  if (m < 60) return `${m} min ago`
  return `${Math.floor(m / 60)} h ago`
}

function lasts(seconds: number): string {
  if (seconds < 0) return 'for good'
  if (seconds >= 86400) return `for ${Math.round(seconds / 86400)} day${Math.round(seconds / 86400) === 1 ? '' : 's'}`
  if (seconds >= 3600) return `for ${Math.round(seconds / 3600)} hour${Math.round(seconds / 3600) === 1 ? '' : 's'}`
  return `for ${Math.max(1, Math.round(seconds / 60))} minutes`
}

/** The addresses Fail2ban is blocking right now, with unblock, and a box to block one by hand. */
function BlockedAddresses({ open, projectId, canFix, onClose, onChanged }: { open: boolean; projectId: string; canFix: boolean; onClose: () => void; onChanged: () => void }) {
  const { message } = AntApp.useApp()
  const [list, setList] = useState<BannedList | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [address, setAddress] = useState('')

  const load = useCallback(async () => {
    try {
      setList(await window.api.security.banned(projectId))
      setError('')
    } catch (err) {
      setError(errText(err))
    }
  }, [projectId])

  useEffect(() => {
    if (!open) return
    setList(null)
    setAddress('')
    void load()
  }, [open, load])

  const change = async (kind: 'unban' | 'ban', jail: string, ip: string): Promise<void> => {
    setBusy(`${kind}:${jail}:${ip}`)
    try {
      await window.api.security[kind](projectId, jail, ip)
      message.success(kind === 'ban' ? `${ip} blocked` : `${ip} unblocked`)
      if (kind === 'ban') setAddress('')
      await load()
      onChanged()
    } catch (err) {
      message.error(errText(err), 8)
    } finally {
      setBusy('')
    }
  }

  const total = list?.jails.reduce((n, j) => n + j.addresses.length, 0) ?? 0
  const sshJail = list?.jails.find((j) => j.name === 'sshd') ?? list?.jails[0]
  return (
    <Modal open={open} onCancel={onClose} footer={<Button onClick={onClose}>Close</Button>} width={600} title="Blocked addresses" destroyOnClose>
      {error && <Alert type="error" showIcon message={error} />}
      {!list && !error && (
        <div className="empty" style={{ padding: 30 }}>
          <Spin />
        </div>
      )}
      {list && list.state !== 'running' && <Alert type="info" showIcon message={list.state === 'missing' ? 'Fail2ban is not installed on this server, so nothing is being blocked automatically.' : 'Fail2ban is installed but not running, so nothing is being blocked.'} />}
      {list?.state === 'running' && (
        <>
          <p className="db-hint" style={{ marginTop: 0 }}>
            Fail2ban blocks an address after repeated failed sign-ins, and lets it back in by itself when the time is up. {total === 0 ? 'Nothing is blocked at the moment.' : `${total} address${total === 1 ? ' is' : 'es are'} blocked now.`}
          </p>
          {list.jails.map((j) => (
            <div key={j.name} className="ban-jail">
              <div className="ban-jail-head">
                <b>{j.name === 'sshd' ? 'SSH sign-in (sshd)' : j.name}</b>
                <span className="db-hint">blocks {lasts(j.banSeconds)}</span>
              </div>
              {j.addresses.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No address blocked by this rule" style={{ margin: '8px 0' }} />
              ) : (
                j.addresses.map((ip) => (
                  <div key={ip} className="ban-row">
                    <span className="mono">{ip}</span>
                    <a href={`https://ipinfo.io/${ip.split('/')[0]}`} target="_blank" rel="noreferrer" className="db-hint">
                      Where is it from?
                    </a>
                    <span style={{ flex: 1 }} />
                    <Tooltip title={canFix ? '' : 'An Admin or IT Support person can unblock'}>
                      <Button size="small" disabled={!canFix} loading={busy === `unban:${j.name}:${ip}`} onClick={() => void change('unban', j.name, ip)}>
                        Unblock
                      </Button>
                    </Tooltip>
                  </div>
                ))
              )}
            </div>
          ))}
          {canFix && sshJail && (
            <div className="ban-add">
              <b>Block an address yourself</b>
              <Space.Compact style={{ width: '100%', marginTop: 8 }}>
                <Input className="mono" placeholder="203.0.113.7" value={address} onChange={(e) => setAddress(e.target.value)} onPressEnter={() => address.trim() && void change('ban', sshJail.name, address.trim())} spellCheck={false} aria-label="Address to block" />
                <Button danger disabled={!address.trim()} loading={busy.startsWith('ban:')} onClick={() => void change('ban', sshJail.name, address.trim())}>
                  Block
                </Button>
              </Space.Compact>
              <p className="db-hint" style={{ margin: '8px 0 0' }}>
                Blocked {lasts(sshJail.banSeconds)} by the SSH sign-in rule, then let back in. For a block on every port that never ends, add a Deny rule on the Firewall page.
              </p>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}

/** Security overview: score, what is switched on, figures from the last scan, what to fix first, and every finding. */
export default function Security({ project, canFix, onOpenFirewall, onOpenLogs }: { project: Project; canFix: boolean; onOpenFirewall: () => void; onOpenLogs: () => void }) {
  const { modal } = AntApp.useApp()
  const [report, setReport] = useState<SecurityReport | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'open' | 'passed'>('all')
  const [search, setSearch] = useState('')
  const [now, setNow] = useState(Date.now())
  const [bannedOpen, setBannedOpen] = useState(false)
  const job = useJob(`security:${project.id}`)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setReport(await window.api.security.report(project.id))
      setNow(Date.now())
      setError('')
    } catch (err) {
      setError(errText(err))
    } finally {
      setLoading(false)
    }
  }, [project.id])

  useEffect(() => void load(), [load])
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])

  const goto = (page: 'firewall' | 'logs'): void => (page === 'logs' ? onOpenLogs() : onOpenFirewall())

  const runFix = (a: { fix: Parameters<typeof window.api.security.fix>[1]; label: string; confirm: string }): void => {
    modal.confirm({
      title: `${a.label}?`,
      content: a.confirm,
      okText: a.label,
      onOk: () => {
        void job.run(a.label, () => window.api.security.fix(project.id, a.fix)).then(() => load())
      }
    })
  }

  const act = (a: SecurityCheck['action'] | SecurityProtection['action']): void => {
    if (!a) return
    if (a.kind === 'fix') runFix(a)
    else if (a.kind === 'page') goto(a.page)
  }

  const findings = useMemo(() => {
    if (!report) return []
    const q = search.trim().toLowerCase()
    return [...report.checks.filter((c) => !c.ok).sort((a, b) => b.weight - a.weight), ...report.checks.filter((c) => c.ok)]
      .filter((c) => filter === 'all' || (filter === 'open') === !c.ok)
      .filter((c) => !q || c.title.toLowerCase().includes(q) || c.detail.toLowerCase().includes(q))
  }, [report, filter, search])

  if (error && !report) return <Alert type="error" showIcon message="The scan could not run" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
  if (!report)
    return (
      <div className="empty">
        <div>
          <Spin />
          <div style={{ marginTop: 12 }}>Scanning the server. This takes up to a minute.</div>
        </div>
      </div>
    )

  const v = verdict(report.score)
  const todo = report.checks.filter((c) => !c.ok).sort((a, b) => b.weight - a.weight)
  const enabled = report.protections.filter((p) => p.on).length
  const s = report.stats
  const tiles: { value: string; label: string; note: string; tone: 'bad' | 'warn' | 'good' | 'none' }[] = [
    { value: String(todo.length), label: 'Security risks', note: todo.length ? `${todo.length} unresolved` : 'Nothing open', tone: todo.some((c) => levelOf(c) === 'high') ? 'bad' : todo.length ? 'warn' : 'good' },
    { value: s.failedLogins === null ? '--' : String(s.failedLogins), label: 'Failed SSH sign-ins', note: s.failedLogins === null ? "The server's log could not be read" : 'In the last 24 hours', tone: s.failedLogins === null ? 'none' : s.failedLogins > 50 ? 'warn' : 'good' },
    { value: s.banned === null ? '--' : String(s.banned), label: 'Addresses blocked', note: s.banned === null ? 'Fail2ban is not running' : 'By Fail2ban, right now', tone: s.banned === null ? 'none' : 'good' },
    { value: s.pendingUpdates === null ? '--' : String(s.pendingUpdates), label: 'Security updates waiting', note: s.restartNeeded ? 'A restart is waiting too' : s.pendingUpdates === null ? 'Could not be counted here' : s.pendingUpdates ? 'Not installed yet' : 'Up to date', tone: s.pendingUpdates === null ? 'none' : s.pendingUpdates || s.restartNeeded ? 'warn' : 'good' }
  ]

  return (
    <div className="grid sec">
      <div className="card sec-over">
        <div className={`sec-score ${v.tone}`}>
          <Progress type="circle" percent={report.score} size={112} strokeWidth={8} strokeColor={{ good: '#19b36b', fair: '#4f84ff', warn: '#f59a23', bad: '#f04a4a' }[v.tone]} trailColor="rgba(127,140,170,0.22)" format={(p) => <span className="ring-num">{p}</span>} />
          <h2>{v.text}</h2>
          <p>Last scan: {ago(report.scannedAt, now)}</p>
          <Button type="primary" icon={<SyncOutlined spin={loading} />} disabled={loading} onClick={() => void load()}>
            {loading ? 'Scanning…' : 'Start scan'}
          </Button>
        </div>
        <div className="sec-prot">
          <div className="sec-prot-head">
            <h3>Protection status</h3>
            <span className={`sec-pill ${enabled === report.protections.length ? 'good' : 'warn'}`}>
              Enabled {enabled}/{report.protections.length}
            </span>
          </div>
          <div className="sec-prot-grid">
            {report.protections.map((p) => {
              const fix = p.action?.kind === 'fix' ? p.action : undefined
              const hint = p.on ? (p.action?.kind === 'page' ? p.action.label : 'On') : fix ? (canFix ? fix.label : 'An Admin or IT Support person can turn this on') : p.action?.kind === 'page' ? p.action.label : 'Cannot be changed from here'
              return (
                <div key={p.id} className="sec-prot-row">
                  <span className={`sec-dot ${p.on ? 'on' : ''}`} />
                  <div className="sec-prot-text">
                    <b>{p.name}</b>
                    <small title={p.detail}>{p.detail}</small>
                  </div>
                  {p.id === 'fail2ban' && p.on && (
                    <button type="button" className="link-btn" style={{ fontSize: 12.5, flex: 'none' }} onClick={() => setBannedOpen(true)}>
                      See which
                    </button>
                  )}
                  <Tooltip title={hint}>
                    <Switch
                      size="small"
                      checked={p.on}
                      aria-label={`${p.name}: ${p.on ? 'on' : 'off'}`}
                      disabled={!p.action || (p.on && p.action.kind === 'fix') || (!!fix && !canFix)}
                      onChange={() => act(p.action)}
                    />
                  </Tooltip>
                  {p.id === 'fail2ban' && p.on ? (
                    <Tooltip title="See and unblock the blocked addresses">
                      <Button size="small" type="text" icon={<SettingOutlined />} aria-label="Blocked addresses" onClick={() => setBannedOpen(true)} />
                    </Tooltip>
                  ) : (
                    <Tooltip title={p.action?.kind === 'page' ? p.action.label : 'Settings'}>
                      <Button size="small" type="text" icon={<SettingOutlined />} aria-label={`${p.name} settings`} disabled={!p.action || (p.action.kind === 'fix' && (p.on || !canFix))} onClick={() => act(p.action)} />
                    </Tooltip>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className="sec-heading">
        <h3>Security scan</h3>
        <span className="sec-pill">Scan overview</span>
        <i />
      </div>
      <div className="sec-tiles">
        {tiles.map((t) => (
          <div key={t.label} className={`card sec-tile ${t.tone}`}>
            <div className="sec-tile-top">
              <span className="sec-tile-num">{t.value}</span>
              <b>{t.label}</b>
            </div>
            <p>
              {t.note}
              {t.label === 'Addresses blocked' && s.banned !== null && (
                <>
                  {' · '}
                  <button type="button" className="link-btn" onClick={() => setBannedOpen(true)}>
                    Details
                  </button>
                </>
              )}
            </p>
          </div>
        ))}
      </div>

      <div className="sec-heading">
        <h3>Recommended actions</h3>
        <span className="sec-pill">{todo.length} item{todo.length === 1 ? '' : 's'}</span>
        <i />
      </div>
      {todo.length === 0 ? (
        <div className="card sec-clear">Nothing to do. Every check passed on the last scan.</div>
      ) : (
        todo.map((c) => (
          <div key={c.id} className={`card sec-action ${levelOf(c)}`}>
            <span className="sec-action-icon">
              <WarningFilled />
            </span>
            <div className="sec-text">
              <b>
                {c.title} <span className={`sec-level ${levelOf(c)}`}>{LEVEL_NAME[levelOf(c)]}</span>
              </b>
              <p>{c.detail}</p>
              {c.action?.kind === 'note' && <p className="sec-note">{c.action.label}</p>}
              {c.action?.kind === 'fix' && !canFix && <p className="sec-note">An Admin or IT Support person can fix this from here.</p>}
            </div>
            {c.action?.kind === 'fix' && canFix && (
              <Button onClick={() => act(c.action)}>
                Fix now <ArrowRightOutlined />
              </Button>
            )}
            {c.action?.kind === 'page' && (
              <Button onClick={() => act(c.action)}>
                {c.action.label} <ArrowRightOutlined />
              </Button>
            )}
          </div>
        ))
      )}

      <div className="sec-heading">
        <h3>Scan findings</h3>
        <span className="sec-pill">{report.checks.length} checks</span>
        <i />
      </div>
      <div className="card sec-findings">
        <div className="sec-findings-head">
          <b>What the last scan found</b>
          <span style={{ flex: 1 }} />
          <Select
            value={filter}
            onChange={setFilter}
            style={{ width: 170 }}
            aria-label="Which findings to show"
            options={[
              { value: 'all', label: 'All findings' },
              { value: 'open', label: 'Needs attention' },
              { value: 'passed', label: 'Passed' }
            ]}
          />
          <Input allowClear prefix={<SearchOutlined />} placeholder="Search findings" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 230 }} />
        </div>
        {findings.map((c) => (
          <div key={c.id} className="sec-find">
            <span className={`sec-dot ${c.ok ? 'on' : levelOf(c)}`} />
            <div className="sec-text">
              <b>{c.title}</b>
              <p>{c.detail}</p>
            </div>
            <span className={`sec-level ${c.ok ? 'passed' : levelOf(c)}`}>{c.ok ? 'Passed' : LEVEL_NAME[levelOf(c)]}</span>
          </div>
        ))}
        {findings.length === 0 && <div className="sec-clear">No finding matches.</div>}
        <p className="sec-foot">This looks at the usual ways servers get broken into. It does not scan files for malware or websites for vulnerabilities, so a full score is not a guarantee.</p>
      </div>
      <JobDrawer job={job} />
      <BlockedAddresses open={bannedOpen} projectId={project.id} canFix={canFix} onClose={() => setBannedOpen(false)} onChanged={() => void load()} />
    </div>
  )
}
