import { useCallback, useEffect, useState } from 'react'
import { App as AntApp, Button, Empty, Segmented, Spin, Switch, Tooltip } from 'antd'
import type { HistoryPoint, HistoryRange, HistoryStatus } from '@shared/types'
import { bytes, errText } from '../util'
import Sparkline from './Sparkline'

function stamp(ms: number, range: HistoryRange): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`
  return range === '1h' ? time : `${p(d.getDate())}/${p(d.getMonth() + 1)} ${time}`
}

function Series({ title, points, pick, max, color, unit, range }: { title: string; points: HistoryPoint[]; pick: (p: HistoryPoint) => number; max?: number; color: string; unit: (n: number) => string; range: HistoryRange }) {
  const values = points.map(pick)
  const peak = Math.max(0, ...values)
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
  return (
    <div>
      <div className="hist-head">
        <b>{title}</b>
        <span>
          average {unit(avg)} · highest {unit(peak)}
        </span>
      </div>
      <Sparkline values={values} max={max} color={color} slots={Math.max(2, values.length)} />
      <div className="hist-axis">
        <span>{stamp(points[0].ts, range)}</span>
        <span>{stamp(points[points.length - 1].ts, range)}</span>
      </div>
    </div>
  )
}

/** Charts over hours and days, from the record the server keeps itself. */
export default function HistoryCard({ projectId, canChange }: { projectId: string; canChange: boolean }) {
  const { message } = AntApp.useApp()
  const [status, setStatus] = useState<HistoryStatus | null>(null)
  const [range, setRange] = useState<HistoryRange>('24h')
  const [points, setPoints] = useState<HistoryPoint[] | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const st = await window.api.monitor.historyStatus(projectId)
      setStatus(st)
      setPoints(st.points > 0 ? await window.api.monitor.history(projectId, range) : [])
    } catch {
      setPoints([])
    }
  }, [projectId, range])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 60000)
    return () => clearInterval(timer)
  }, [load])

  const toggle = async (on: boolean): Promise<void> => {
    setBusy(true)
    try {
      await window.api.monitor.historySet(projectId, on)
      message.success(on ? 'The server now records its load every minute' : 'Recording stopped. What was recorded is kept.')
    } catch (err) {
      message.error(errText(err), 8)
    } finally {
      setBusy(false)
      void load()
    }
  }

  const pct = (n: number): string => `${n.toFixed(1)}%`
  return (
    <div className="card">
      <div className="card-title">
        <span>History</span>
        <span style={{ display: 'inline-flex', gap: 12, alignItems: 'center' }}>
          {status?.enabled && (
            <Segmented
              size="small"
              value={range}
              onChange={(v) => setRange(v as HistoryRange)}
              options={[
                { value: '1h', label: 'Last hour' },
                { value: '24h', label: '24 hours' },
                { value: '7d', label: '7 days' }
              ]}
            />
          )}
          <Tooltip title={canChange ? 'A one-line record per minute, kept on the server for 7 days (about 500 KB).' : 'Your role cannot change this.'}>
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--muted)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <Switch size="small" checked={!!status?.enabled} loading={busy} disabled={!canChange || !status} onChange={(on) => void toggle(on)} /> Keep history
            </span>
          </Tooltip>
        </span>
      </div>
      {points === null ? (
        <Spin />
      ) : !status?.enabled && points.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span>
              The live charts above only cover the time this app has been open.
              <br />
              Turn on "Keep history" and the server records its own load, so you can look back over 24 hours or 7 days.
            </span>
          }
        >
          {canChange && (
            <Button type="primary" loading={busy} onClick={() => void toggle(true)}>
              Start keeping history
            </Button>
          )}
        </Empty>
      ) : points.length < 2 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Recording has started. The first chart appears after a couple of minutes." />
      ) : (
        <div className="grid cols-3">
          <Series title="CPU" points={points} pick={(p) => p.cpu} max={100} color="#3366ff" unit={pct} range={range} />
          <Series title="Memory" points={points} pick={(p) => p.mem} max={100} color="#7b5cff" unit={pct} range={range} />
          <Series title="Load" points={points} pick={(p) => p.load} color="#12b76a" unit={(n) => n.toFixed(2)} range={range} />
          <Series title="Disk /" points={points} pick={(p) => p.disk} max={100} color="#f79009" unit={(n) => `${Math.round(n)}%`} range={range} />
          <Series title="Network in" points={points} pick={(p) => p.rx} color="#12b76a" unit={(n) => `${bytes(n)}/s`} range={range} />
          <Series title="Network out" points={points} pick={(p) => p.tx} color="#f59a23" unit={(n) => `${bytes(n)}/s`} range={range} />
        </div>
      )}
    </div>
  )
}
