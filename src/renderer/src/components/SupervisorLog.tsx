// Output of one Supervisor program: normal output or errors, newest lines, filter, follow live.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Input, Modal, Segmented, Select, Space } from 'antd'
import { errText } from '../util'

export default function SupervisorLog({ projectId, name, onClose }: { projectId: string; name: string; onClose: () => void }) {
  const [stream, setStream] = useState<'stdout' | 'stderr'>('stdout')
  const [lines, setLines] = useState(300)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(false)
  const [loading, setLoading] = useState(false)
  const box = useRef<HTMLPreElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setText(await window.api.supervisor.logs(projectId, name, stream, lines))
      setError('')
    } catch (err) {
      setError(errText(err))
    } finally {
      setLoading(false)
    }
  }, [projectId, name, stream, lines])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!follow) return
    const t = setInterval(() => void load(), 3000)
    return () => clearInterval(t)
  }, [follow, load])

  // Newest lines are at the bottom: keep the view there.
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [text])

  const shown = (text ?? '')
    .split('\n')
    .filter((l) => !filter || l.toLowerCase().includes(filter.toLowerCase()))
    .join('\n')

  const download = (): void => {
    const url = URL.createObjectURL(new Blob([text ?? ''], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}-${stream}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Modal
      open
      title={`Log of ${name}`}
      width={920}
      onCancel={onClose}
      destroyOnClose
      footer={
        <Space>
          <Button onClick={download} disabled={!text}>
            Download
          </Button>
          <Button onClick={() => void load()} loading={loading}>
            Read again
          </Button>
          <Button type="primary" onClick={onClose}>
            Close
          </Button>
        </Space>
      }
    >
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <Segmented
          value={stream}
          onChange={(v) => setStream(v as 'stdout' | 'stderr')}
          options={[
            { label: 'Output', value: 'stdout' },
            { label: 'Errors', value: 'stderr' }
          ]}
        />
        <Select
          value={lines}
          onChange={setLines}
          style={{ width: 140 }}
          aria-label="How many lines"
          options={[100, 300, 1000, 3000].map((n) => ({ value: n, label: `Last ${n} lines` }))}
        />
        <Input allowClear placeholder="Filter lines" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 220 }} />
        <Checkbox checked={follow} onChange={(e) => setFollow(e.target.checked)}>
          Live (every 3 s)
        </Checkbox>
      </div>
      {error ? (
        <pre className="log-box" style={{ height: 460, color: '#ff8a80' }}>{error}</pre>
      ) : (
        <pre ref={box} className="log-box" style={{ height: 460 }}>
          {text === null ? 'Loading…' : shown || (filter ? 'No line matches the filter.' : '(no output yet)')}
        </pre>
      )}
    </Modal>
  )
}
