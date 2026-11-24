import heroArt from '../assets/banner-art.png'
import PowerMenu from '../components/PowerMenu'
import { useState } from 'react'
import { Alert, Button, Progress, Spin } from 'antd'
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons'
import type { MonitorSample, Project } from '@shared/types'
import Sparkline from '../components/Sparkline'
import { KEEP, useFeed } from '../monitorFeed'
import HistoryCard from '../components/HistoryCard'
import { bytes, duration, errText, levelColor, cssUrl } from '../util'

function Ring({ pct, label, sub }: { pct: number; label: string; sub: string }) {
  const value = Math.max(0, Math.min(100, pct))
  return (
    <div className="card ring">
      <Progress
        type="dashboard"
        percent={Math.round(value * 10) / 10}
        size={148}
        strokeWidth={10}
        gapDegree={90}
        trailColor="var(--track)"
        strokeColor={value >= 85 ? { '0%': '#ff7a59', '100%': '#f04438' } : value >= 65 ? { '0%': '#ffc24a', '100%': '#f79009' } : { '0%': '#3366ff', '100%': '#7b5cff' }}
        format={(p) => (
          <span className="ring-num">
            {Math.round(p ?? 0)}
            <small>%</small>
          </span>
        )}
      />
      <div className="ring-label">{label}</div>
      <div className="ring-sub">{sub}</div>
    </div>
  )
}

/** Average busy of all cards. */
function gpuPct(s: MonitorSample): number {
  const g = s.gpus ?? []
  return g.length ? g.reduce((a, x) => a + x.util, 0) / g.length : 0
}

/** Each graphics card: busy, its memory, heat and power, the last minutes, and the programs using it. */
function GpuCard({ s, history }: { s: MonitorSample; history: MonitorSample[] }) {
  const gpus = s.gpus ?? []
  const procs = s.gpuProcs ?? []
  return (
    <div className="card">
      <div className="card-title">
        Graphics cards <span className="big-num" style={{ color: 'var(--text)' }}>{gpuPct(s).toFixed(0)}%</span>
      </div>
      <Sparkline values={history.map(gpuPct)} max={100} color="#19b36b" slots={KEEP} />
      <table className="plain" style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>Card</th>
            <th style={{ width: '22%' }}>Busy</th>
            <th style={{ width: '26%' }}>Memory</th>
            <th>Heat</th>
            <th>Power</th>
            <th>Fan</th>
          </tr>
        </thead>
        <tbody>
          {gpus.map((g) => {
            const memPct = g.memTotal ? (g.memUsed / g.memTotal) * 100 : 0
            return (
              <tr key={`${g.vendor}${g.index}`}>
                <td>
                  <div style={{ fontWeight: 600 }}>{g.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    #{g.index} · {g.vendor === 'nvidia' ? 'NVIDIA' : 'AMD'}
                  </div>
                </td>
                <td>
                  <Progress percent={Math.round(g.util)} size="small" strokeColor={levelColor(g.util)} />
                </td>
                <td>
                  <Progress percent={Math.round(memPct)} size="small" strokeColor={levelColor(memPct)} format={() => `${bytes(g.memUsed)} / ${bytes(g.memTotal)}`} />
                </td>
                <td className="nowrap" style={{ color: g.temp !== undefined && g.temp >= 85 ? '#f04438' : g.temp !== undefined && g.temp >= 75 ? '#f79009' : undefined }}>
                  {g.temp !== undefined ? `${g.temp} °C` : '–'}
                </td>
                <td className="nowrap">{g.power !== undefined ? `${Math.round(g.power)}${g.powerLimit ? ` / ${Math.round(g.powerLimit)}` : ''} W` : '–'}</td>
                <td className="nowrap">{g.fan !== undefined ? `${g.fan}%` : '–'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {procs.length > 0 && (
        <table className="plain" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Program on a card</th>
              <th>PID</th>
              <th>Card</th>
              <th>Card memory</th>
            </tr>
          </thead>
          <tbody>
            {procs.map((p) => (
              <tr key={`${p.gpu}-${p.pid}`}>
                <td className="mono">{p.name}</td>
                <td className="mono">{p.pid}</td>
                <td>#{p.gpu}</td>
                <td className="nowrap">{bytes(p.mem)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export default function Overview({ project, canOps, canReboot }: { project: Project; canOps: boolean; canReboot: boolean }) {
  const [attempt, setAttempt] = useState(0)
  const feed = useFeed(project.id, attempt)
  const history = feed.history
  const error = feed.error
  const s = history[history.length - 1]

  if (error && !s) {
    return (
      <div className="card">
        <Alert
          type="error"
          showIcon
          message={/^Signed in to the server/.test(error) ? `Connected to ${project.host}, but it gave no status` : `Could not connect to ${project.host}`}
          description={<span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{error}</span>}
          action={
            <Button onClick={() => setAttempt((a) => a + 1)} type="primary">
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  if (!s) {
    return (
      <div className="empty">
        <div>
          <Spin />
          <div style={{ marginTop: 12 }}>Connecting to {project.host}…</div>
        </div>
      </div>
    )
  }

  const rootDisk = s.disks.find((d) => d.mount === '/') ?? s.disks[0]
  const gpus = s.gpus ?? []
  const memPct = s.mem.total ? (s.mem.used / s.mem.total) * 100 : 0
  const loadPct = Math.min(100, (s.load[0] / s.cores) * 100)

  return (
    <div className="grid">
      {error && (
        <Alert
          type="warning"
          showIcon
          message="Connection lost. Showing the last values."
          description={error}
          action={<Button onClick={() => setAttempt((a) => a + 1)}>Reconnect</Button>}
        />
      )}

      <div className="hero" style={{ backgroundImage: `${cssUrl(heroArt)}, linear-gradient(100deg, #0d1146 0%, #231c84 55%, #5237bd 100%)`, backgroundRepeat: 'no-repeat', backgroundSize: 'auto 270px, cover', backgroundPosition: 'right 180px top -8px, center' }}>
        <div className="hero-actions">
          <PowerMenu project={project} canOps={canOps} canReboot={canReboot} onBack={() => setAttempt((a) => a + 1)} />
        </div>
        <div className="hero-title">{project.name}</div>
        <div className="hero-sub mono">
          {project.username}@{project.host}
        </div>
        <div className="hero-facts">
          <span>{s.os || 'Linux'}</span>
          <span>{s.cores} core{s.cores > 1 ? 's' : ''}</span>
          <span>{bytes(s.mem.total)} memory</span>
          <span>up {duration(s.uptime)}</span>
        </div>
      </div>

      <div className={`grid ${gpus.length ? 'cols-5' : 'cols-4'}`}>
        <Ring pct={loadPct} label="Load" sub={`${s.load.map((n) => n.toFixed(2)).join(' / ')}`} />
        <Ring pct={s.cpu} label="CPU" sub={`${s.cores} core${s.cores > 1 ? 's' : ''}`} />
        <Ring pct={memPct} label="Memory" sub={`${bytes(s.mem.used)} / ${bytes(s.mem.total)}`} />
        <Ring
          pct={rootDisk?.pct ?? 0}
          label={`Disk ${rootDisk?.mount ?? '/'}`}
          sub={rootDisk ? `${bytes(rootDisk.used)} / ${bytes(rootDisk.total)}` : 'No data'}
        />
        {gpus.length > 0 && <Ring pct={gpuPct(s)} label={gpus.length > 1 ? `GPU ×${gpus.length}` : 'GPU'} sub={`${bytes(gpus.reduce((a, g) => a + g.memUsed, 0))} / ${bytes(gpus.reduce((a, g) => a + g.memTotal, 0))}`} />}
      </div>

      <div className="grid cols-3">
        <div className="card">
          <div className="card-title">
            CPU <span className="big-num" style={{ color: 'var(--text)' }}>{s.cpu.toFixed(1)}%</span>
          </div>
          <Sparkline values={history.map((h) => h.cpu)} max={100} color="#3366ff" slots={KEEP} />
        </div>
        <div className="card">
          <div className="card-title">
            Memory <span className="big-num" style={{ color: 'var(--text)' }}>{memPct.toFixed(1)}%</span>
          </div>
          <Sparkline
            values={history.map((h) => (h.mem.total ? (h.mem.used / h.mem.total) * 100 : 0))}
            max={100}
            color="#7b5cff"
            slots={KEEP}
          />
        </div>
        <div className="card">
          <div className="card-title">
            Network
            <span style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
              <ArrowDownOutlined style={{ color: '#19b36b' }} /> {bytes(s.net.rxRate)}/s &nbsp;
              <ArrowUpOutlined style={{ color: '#f59a23' }} /> {bytes(s.net.txRate)}/s
            </span>
          </div>
          <Sparkline
            values={history.map((h) => h.net.rxRate)}
            second={history.map((h) => h.net.txRate)}
            color="#19b36b"
            secondColor="#f59a23"
            slots={KEEP}
          />
        </div>
      </div>

      {gpus.length > 0 && <GpuCard s={s} history={history} />}

      <HistoryCard projectId={project.id} canChange={canOps} />

      <div className="grid cols-2">
        <div className="card">
          <div className="card-title">System</div>
          <dl className="kv">
            <dt>Hostname</dt>
            <dd>{s.hostname}</dd>
            <dt>System</dt>
            <dd>{s.os || 'Linux'}</dd>
            <dt>Kernel</dt>
            <dd>{s.kernel}</dd>
            <dt>Processor</dt>
            <dd title={s.cpuModel}>{s.cpuModel || `${s.cores} cores`}</dd>
            <dt>Uptime</dt>
            <dd>{duration(s.uptime)}</dd>
            <dt>Swap</dt>
            <dd>{s.mem.swapTotal ? `${bytes(s.mem.swapUsed)} / ${bytes(s.mem.swapTotal)}` : 'Off'}</dd>
            <dt>Traffic</dt>
            <dd>
              {bytes(s.net.rxTotal)} in · {bytes(s.net.txTotal)} out
            </dd>
          </dl>
        </div>

        <div className="card">
          <div className="card-title">Disks</div>
          <table className="plain">
            <thead>
              <tr>
                <th>Mount</th>
                <th>Used</th>
                <th>Size</th>
                <th style={{ width: '34%' }}>Usage</th>
              </tr>
            </thead>
            <tbody>
              {s.disks.map((d) => (
                <tr key={d.fs + d.mount}>
                  <td className="mono" title={d.fs}>
                    {d.mount}
                  </td>
                  <td className="nowrap">{bytes(d.used)}</td>
                  <td className="nowrap">{bytes(d.total)}</td>
                  <td>
                    <Progress percent={d.pct} size="small" strokeColor={levelColor(d.pct)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Top processes by CPU</div>
        <table className="plain">
          <thead>
            <tr>
              <th>PID</th>
              <th>User</th>
              <th>CPU %</th>
              <th>Memory %</th>
              <th>Command</th>
            </tr>
          </thead>
          <tbody>
            {s.procs.map((p) => (
              <tr key={p.pid}>
                <td>{p.pid}</td>
                <td>{p.user}</td>
                <td>{p.cpu.toFixed(1)}</td>
                <td>{p.mem.toFixed(1)}</td>
                <td className="mono">{p.cmd}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
