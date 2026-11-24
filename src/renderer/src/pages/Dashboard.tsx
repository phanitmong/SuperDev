import { useEffect, useState } from 'react'
import { Button, Empty, Progress, Select, Space, Tag, Tooltip } from 'antd'
import { CloudServerOutlined, WarningFilled } from '@ant-design/icons'
import type { CertInfo, ConnState, GroupMember, Project, ServerGroup } from '@shared/types'
import { ROLE_OF, sortMembers } from '../groupRoles'
import { useFeed } from '../monitorFeed'
import { SERVER_COLORS, bytes, duration } from '../util'

function Bar({ pct, label }: { pct: number; label: string }) {
  const v = Math.max(0, Math.min(100, pct))
  return (
    <Tooltip title={label}>
      <div className="dash-bar">
        <Progress percent={Math.round(v)} size="small" showInfo={false} strokeColor={v >= 90 ? '#f04438' : v >= 75 ? '#f79009' : { '0%': '#3366ff', '100%': '#7b5cff' }} trailColor="var(--track)" />
        <span>{Math.round(v)}%</span>
      </div>
    </Tooltip>
  )
}

function Row({ project, index, state, onOpen, roles }: { project: Project; index: number; state: ConnState; onOpen: () => void; roles?: GroupMember[] }) {
  const [attempt, setAttempt] = useState(0)
  const feed = useFeed(project.id, attempt)
  const s = feed.history[feed.history.length - 1]
  const [sites, setSites] = useState<number | null>(null)
  const [certs, setCerts] = useState<CertInfo[] | null>(null)
  const ready = !!s

  useEffect(() => {
    if (!ready) return
    window.api.sites
      .list(project.id)
      .then((l) => setSites(l.length))
      .catch(() => setSites(null))
    window.api.monitor
      .certs(project.id)
      .then(setCerts)
      .catch(() => setCerts(null))
  }, [project.id, ready])

  const memPct = s && s.mem.total ? (s.mem.used / s.mem.total) * 100 : 0
  const worst = s ? [...s.disks].sort((a, b) => b.pct - a.pct)[0] : undefined
  const loadPct = s ? (s.load[0] / s.cores) * 100 : 0
  const cert = certs?.[0]
  const warnings: string[] = []
  if (s) {
    if (worst && worst.pct >= 90) warnings.push(`Disk ${worst.mount} is ${Math.round(worst.pct)}% full`)
    if (memPct >= 90) warnings.push(`Memory is ${Math.round(memPct)}% used`)
    if (loadPct >= 150) warnings.push(`Load is ${Math.round(loadPct)}% of the ${s.cores} cores`)
    if (cert && cert.daysLeft < 14) warnings.push(cert.daysLeft < 0 ? `Certificate for ${cert.domain} has expired` : `Certificate for ${cert.domain} expires in ${cert.daysLeft} days`)
  }

  return (
    <tr className="dash-row" onClick={onOpen} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <td>
        <div className="dash-name">
          <span className="server-icon" style={{ background: project.color ?? SERVER_COLORS[index % SERVER_COLORS.length], width: 34, height: 34, fontSize: 16 }}>
            <CloudServerOutlined />
          </span>
          <span>
            <b>{project.name}</b>
            <small className="mono">{project.host}</small>
            {roles && roles.length > 0 && (
              <div className="dash-roles">
                {roles.map((m) => (
                  <Tag key={m.role} color={ROLE_OF[m.role].color}>
                    {ROLE_OF[m.role].label}
                    {m.label ? ` · ${m.label}` : ''}
                  </Tag>
                ))}
              </div>
            )}
          </span>
        </div>
      </td>
      {s ? (
        <>
          <td>
            <Bar pct={s.cpu} label={`${s.cores} cores, load ${s.load.map((n) => n.toFixed(2)).join(' / ')}`} />
          </td>
          <td>
            <Bar pct={memPct} label={`${bytes(s.mem.used)} of ${bytes(s.mem.total)}`} />
          </td>
          <td>{worst ? <Bar pct={worst.pct} label={`${worst.mount}: ${bytes(worst.used)} of ${bytes(worst.total)}`} /> : ''}</td>
          <td className="dash-dim">{duration(s.uptime)}</td>
          <td className="dash-dim">{sites ?? ''}</td>
          <td>{cert ? <Tag color={cert.daysLeft < 14 ? 'red' : cert.daysLeft < 30 ? 'orange' : 'green'}>{cert.daysLeft < 0 ? 'expired' : `${cert.daysLeft} days`}</Tag> : <span className="dash-dim">{certs ? 'none' : ''}</span>}</td>
          <td>
            {warnings.length > 0 ? (
              <Tooltip title={warnings.join('. ')}>
                <span className="dash-warn">
                  <WarningFilled /> {warnings.length === 1 ? warnings[0] : `${warnings.length} things need attention`}
                </span>
              </Tooltip>
            ) : (
              <span className="dash-ok">All good</span>
            )}
          </td>
        </>
      ) : (
        <td colSpan={7}>
          {feed.error ? (
            <span className="dash-warn" onClick={(e) => e.stopPropagation()}>
              <WarningFilled /> Not reachable: {feed.error}{' '}
              <Button size="small" onClick={() => setAttempt((a) => a + 1)}>
                Try again
              </Button>
            </span>
          ) : (
            <span className="dash-dim">{state === 'connecting' ? 'Connecting...' : 'Waiting for the first reading...'}</span>
          )}
        </td>
      )}
    </tr>
  )
}

/** Every server this person can use side by side, or the servers of one project in role order. Opening the page connects to each of them. */
export default function Dashboard({ projects, groups, states, focus, onFocus, onOpen }: { projects: Project[]; groups: ServerGroup[]; states: Record<string, ConnState>; focus?: string; onFocus: (id: string | undefined) => void; onOpen: (id: string) => void }) {
  const group = focus ? groups.find((g) => g.id === focus) : undefined
  if (projects.length === 0) {
    return (
      <div className="card">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No servers yet. Add one under Projects and it shows up here." />
      </div>
    )
  }
  // In a project: one row per server, its roles together, ordered by its first role.
  const rows: { project: Project; roles?: GroupMember[] }[] = []
  if (group) {
    for (const m of sortMembers(group.members)) {
      const p = projects.find((x) => x.id === m.projectId)
      if (!p) continue
      const row = rows.find((r) => r.project.id === p.id)
      if (row) row.roles!.push(m)
      else rows.push({ project: p, roles: [m] })
    }
  } else for (const p of projects) rows.push({ project: p })
  return (
    <div className="card">
      <div className="card-title">
        <Space wrap>
          <Select
            value={group?.id ?? ''}
            onChange={(v) => onFocus(v || undefined)}
            style={{ minWidth: 220 }}
            options={[{ value: '', label: 'All servers' }, ...groups.map((g) => ({ value: g.id, label: `Project: ${g.name}` }))]}
            aria-label="Which servers"
          />
          {group?.note && <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--muted)' }}>{group.note}</span>}
        </Space>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--muted)' }}>Live readings, refreshed every few seconds. Click a server to open it.</span>
      </div>
      {rows.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="This project has no servers you can use." />
      ) : (
        <table className="dash">
          <thead>
            <tr>
              <th>Server</th>
              <th>CPU</th>
              <th>Memory</th>
              <th>Fullest disk</th>
              <th>Up for</th>
              <th>Sites</th>
              <th>Certificate</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <Row key={r.project.id} project={r.project} roles={r.roles} index={i} state={states[r.project.id] ?? 'disconnected'} onOpen={() => onOpen(r.project.id)} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
