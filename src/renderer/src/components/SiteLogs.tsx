// A site's own logs, like the Logs button of a hosting panel's site list: the access log as a table
// of requests with a summary on top, and the error log as text. Live refresh, filter, download, clear.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App as AntApp, Button, Drawer, Empty, Input, Segmented, Select, Space, Switch, Table, Tag, Tooltip } from 'antd'
import { DeleteOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import type { Site } from '@shared/types'
import { bytes, errText } from '../util'

type Kind = 'access' | 'error'
type Stats = Awaited<ReturnType<typeof window.api.sites.logStats>>

interface Hit {
  key: number
  ip: string
  time: string
  method: string
  path: string
  status: number
  size: number
  referer: string
  agent: string
  raw: string
}

// nginx's default "combined" format.
const LINE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) ?(\S*)[^"]*" (\d{3}) (\d+|-)(?: "([^"]*)" "([^"]*)")?/

function parse(text: string): Hit[] {
  return text
    .split('\n')
    .filter(Boolean)
    .reverse()
    .map((raw, key) => {
      const m = LINE.exec(raw)
      if (!m) return { key, ip: '', time: '', method: '', path: raw, status: 0, size: 0, referer: '', agent: '', raw }
      return { key, ip: m[1], time: m[2], method: m[3], path: m[4] || '', status: Number(m[5]), size: m[6] === '-' ? 0 : Number(m[6]), referer: m[7] && m[7] !== '-' ? m[7] : '', agent: m[8] ?? '', raw }
    })
}

/** "23/Nov/2026:14:41:18 +0800" → "23 Nov 14:41:18". */
const shortTime = (t: string): string => {
  const m = /^(\d{2})\/(\w{3})\/\d{4}:(\d{2}:\d{2}:\d{2})/.exec(t)
  return m ? `${m[1]} ${m[2]} ${m[3]}` : t
}

const statusColor = (s: number): string => (s >= 500 ? 'red' : s >= 400 ? 'orange' : s >= 300 ? 'blue' : s >= 200 ? 'green' : 'default')

interface Props {
  site: Site | null
  canClear: boolean
  onClose: () => void
}

export default function SiteLogs({ site, canClear, onClose }: Props) {
  const { modal, message } = AntApp.useApp()
  const [kind, setKind] = useState<Kind>('access')
  const [lines, setLines] = useState(500)
  const [filter, setFilter] = useState('')
  const [applied, setApplied] = useState('')
  const [live, setLive] = useState(false)
  const [text, setText] = useState('')
  const [info, setInfo] = useState<{ path: string; exists: boolean; size: number } | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)

  const load = useCallback(
    async (withStats: boolean): Promise<void> => {
      if (!site || busy.current) return
      busy.current = true
      setLoading(true)
      try {
        const [r, s] = await Promise.all([window.api.sites.log(site.id, kind, lines, applied), withStats && kind === 'access' ? window.api.sites.logStats(site.id) : Promise.resolve(null)])
        setText(r.text)
        setInfo({ path: r.path, exists: r.exists, size: r.size })
        if (s) setStats(s)
        setError('')
      } catch (err) {
        setError(errText(err))
      } finally {
        busy.current = false
        setLoading(false)
      }
    },
    [site, kind, lines, applied]
  )

  // A new site, log or filter: load again, with the summary.
  useEffect(() => {
    if (!site) return
    setText('')
    void load(true)
  }, [site, kind, lines, applied, load])

  useEffect(() => {
    if (!site) {
      setLive(false)
      setFilter('')
      setApplied('')
      setStats(null)
      setInfo(null)
    }
  }, [site])

  useEffect(() => {
    if (!live || !site) return
    const t = setInterval(() => void load(false), 4000)
    return () => clearInterval(t)
  }, [live, site, load])

  const hits = useMemo(() => (kind === 'access' ? parse(text) : []), [text, kind])
  const errorLines = useMemo(() => (kind === 'error' ? text.split('\n').filter(Boolean).reverse() : []), [text, kind])

  const clear = (): void => {
    if (!site) return
    modal.confirm({
      title: `Empty the ${kind} log of ${site.name}?`,
      content: 'Everything in it is removed. nginx keeps writing new lines to the same file. Download it first if you may need it.',
      okText: 'Empty log',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.api.sites.logClear(site.id, kind)
          message.success('Log emptied')
          setStats(null)
          await load(true)
        } catch (err) {
          message.error(errText(err), 6)
        }
      }
    })
  }

  const download = async (): Promise<void> => {
    if (!site) return
    try {
      const saved = await window.api.sites.logDownload(site.id, site.name, kind)
      if (saved) message.success(`Saved to ${saved}`, 4)
    } catch (err) {
      message.error(errText(err), 6)
    }
  }

  const total = stats ? stats.status.s2 + stats.status.s3 + stats.status.s4 + stats.status.s5 : 0

  return (
    <Drawer
      open={!!site}
      width="min(1240px, 96vw)"
      title={site ? `Logs · ${site.name}` : ''}
      onClose={onClose}
      destroyOnClose
      extra={
        <Space>
          <Tooltip title="Download the whole file">
            <Button icon={<DownloadOutlined />} disabled={!info?.exists} onClick={() => void download()}>
              Download
            </Button>
          </Tooltip>
          {canClear && (
            <Button danger icon={<DeleteOutlined />} disabled={!info?.exists || !info.size} onClick={clear}>
              Empty
            </Button>
          )}
        </Space>
      }
    >
      <div className="sitelog-bar">
        <Segmented
          value={kind}
          onChange={(v) => setKind(v as Kind)}
          options={[
            { value: 'access', label: 'Access log' },
            { value: 'error', label: 'Error log' }
          ]}
        />
        <Input.Search placeholder={kind === 'access' ? 'Filter: an IP, a path, a status such as " 404 "' : 'Filter: a word such as PHP or upstream'} allowClear style={{ width: 340 }} value={filter} onChange={(e) => setFilter(e.target.value)} onSearch={(v) => setApplied(v.trim())} aria-label="Filter" />
        <Select value={lines} onChange={setLines} style={{ width: 130 }} aria-label="Lines" options={[200, 500, 1000, 2000, 5000].map((n) => ({ value: n, label: `Last ${n}` }))} />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load(true)}>
          Refresh
        </Button>
        <span className="sitelog-live">
          <Switch size="small" checked={live} onChange={setLive} /> Live
        </span>
        {info && (
          <span className="sitelog-file mono" title={info.path}>
            {info.path} · {info.exists ? bytes(info.size) : 'not created yet'}
          </span>
        )}
      </div>

      {error && <div className="sitelog-error">{error}</div>}

      {kind === 'access' && stats && stats.requests > 0 && !applied && (
        <div className="sitelog-stats">
          <div className="sitelog-cards">
            <div>
              <b>{stats.requests.toLocaleString()}</b>
              <span>requests{stats.requests >= 50000 ? ' (newest 50 000)' : ''}</span>
            </div>
            <div>
              <b>{bytes(stats.bytes)}</b>
              <span>sent</span>
            </div>
            <div className="ok">
              <b>{stats.status.s2.toLocaleString()}</b>
              <span>2xx OK</span>
            </div>
            <div className="info">
              <b>{stats.status.s3.toLocaleString()}</b>
              <span>3xx redirect</span>
            </div>
            <div className="warn">
              <b>{stats.status.s4.toLocaleString()}</b>
              <span>4xx client error</span>
            </div>
            <div className="bad">
              <b>{stats.status.s5.toLocaleString()}</b>
              <span>5xx server error</span>
            </div>
          </div>
          {total > 0 && (
            <div className="sitelog-split" aria-hidden>
              <i className="ok" style={{ flex: stats.status.s2 }} />
              <i className="info" style={{ flex: stats.status.s3 }} />
              <i className="warn" style={{ flex: stats.status.s4 }} />
              <i className="bad" style={{ flex: stats.status.s5 }} />
            </div>
          )}
          <div className="sitelog-period">
            From {shortTime(stats.first)} to {shortTime(stats.last)}
          </div>
          <div className="sitelog-tops">
            <div>
              <h4>Top visitors</h4>
              {stats.ips.map((r) => (
                <button type="button" key={r.ip} className="sitelog-top" onClick={() => (setFilter(r.ip), setApplied(r.ip))} title={`Show only ${r.ip}`}>
                  <span className="mono">{r.ip}</span>
                  <span>
                    {r.count.toLocaleString()}
                    {r.errors ? <em> · {r.errors.toLocaleString()} errors</em> : null}
                  </span>
                </button>
              ))}
            </div>
            <div>
              <h4>Top pages</h4>
              {stats.paths.map((r) => (
                <button type="button" key={r.path} className="sitelog-top" onClick={() => (setFilter(r.path), setApplied(r.path))} title={`Show only ${r.path}`}>
                  <span className="mono">{r.path}</span>
                  <span>{r.count.toLocaleString()}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {kind === 'access' ? (
        <Table<Hit>
          size="small"
          rowKey="key"
          dataSource={hits}
          loading={loading && hits.length === 0}
          pagination={hits.length > 100 ? { pageSize: 100, showSizeChanger: false, size: 'small' } : false}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={info && !info.exists ? 'This site has no access log yet. It appears with the first visit.' : applied ? `No line contains "${applied}"` : 'No requests yet'} /> }}
          columns={[
            { title: 'Time', width: 150, render: (_, h) => <span className="mono sitelog-dim">{shortTime(h.time)}</span> },
            { title: 'Visitor', width: 150, render: (_, h) => <span className="mono">{h.ip}</span> },
            { title: 'Status', width: 74, render: (_, h) => (h.status ? <Tag color={statusColor(h.status)}>{h.status}</Tag> : null) },
            {
              title: 'Request',
              render: (_, h) => (
                <span className="mono sitelog-req" title={h.raw}>
                  {h.method && <b>{h.method} </b>}
                  {h.path}
                </span>
              )
            },
            { title: 'Size', width: 90, align: 'right', render: (_, h) => <span className="sitelog-dim">{h.status ? bytes(h.size) : ''}</span> },
            { title: 'Browser', width: 230, render: (_, h) => <span className="sitelog-agent" title={h.agent}>{h.agent}</span> }
          ]}
        />
      ) : (
        <pre className="sitelog-errors">
          {errorLines.length === 0 ? (
            <span className="sitelog-dim">{info && !info.exists ? 'This site has no error log yet.' : applied ? `No line contains "${applied}"` : 'No errors. Good.'}</span>
          ) : (
            errorLines.map((l, i) => (
              <div key={i} className={/\[(error|crit|alert|emerg)\]/.test(l) ? 'bad' : /\[warn\]/.test(l) ? 'warn' : ''}>
                {l}
              </div>
            ))
          )}
        </pre>
      )}
    </Drawer>
  )
}
