import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, App as AntApp, Button, Form, Input, InputNumber, Select, Space, Spin, Switch, Tabs, Tag, Tooltip } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import type { NginxLoad, NginxOverview, NginxTuning, Project } from '@shared/types'
import CodeEditor from '../components/CodeEditor'
import Sparkline from '../components/Sparkline'
import { JobDrawer, useJob } from '../components/JobLog'
import { bytes, duration, errText } from '../util'

/** One setting of the Optimization form: its name in nginx.conf, a unit and a plain explanation. */
const FIELDS: { key: keyof NginxTuning; name: string; unit?: string; help: string; min?: number; max?: number }[] = [
  { key: 'workerProcesses', name: 'worker_processes', help: 'Processes that answer visitors. "auto" means one per processor core.' },
  { key: 'workerConnections', name: 'worker_connections', help: 'Connections each process can hold open at once.', min: 64, max: 1000000 },
  { key: 'keepaliveTimeout', name: 'keepalive_timeout', unit: 's', help: 'How long an idle visitor connection stays open.', min: 0, max: 3600 },
  { key: 'gzip', name: 'gzip', help: 'Compress text (HTML, CSS, JavaScript, JSON) before sending it.' },
  { key: 'gzipMinLengthKb', name: 'gzip_min_length', unit: 'KB', help: 'Smaller responses are sent as they are.', min: 0, max: 10240 },
  { key: 'gzipCompLevel', name: 'gzip_comp_level', help: '1 is fastest, 9 is smallest. 5 is a good balance.', min: 1, max: 9 },
  { key: 'clientMaxBodyMb', name: 'client_max_body_size', unit: 'MB', help: 'Largest upload for the whole server. A site\'s own setting (Reverse proxy & Nginx) wins. 0 means no limit.', min: 0, max: 102400 },
  { key: 'serverNamesHashBucketSize', name: 'server_names_hash_bucket_size', help: 'Room for long domain names. Raise it (128, 512) if nginx says it is too small.', min: 32, max: 4096 },
  { key: 'clientHeaderBufferKb', name: 'client_header_buffer_size', unit: 'KB', help: 'Memory for a visitor\'s request headers (large cookies need more).', min: 1, max: 1024 },
  { key: 'clientBodyBufferKb', name: 'client_body_buffer_size', unit: 'KB', help: 'Form posts larger than this are written to disk first.', min: 1, max: 102400 }
]

/** The web server itself, as a hosting panel shows it: service, performance settings, nginx.conf, load and errors. */
export default function NginxPage({ project, canOps, dark, onOpenSites }: { project: Project; canOps: boolean; dark: boolean; onOpenSites: () => void }) {
  const { message, modal } = AntApp.useApp()
  const [info, setInfo] = useState<NginxOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState('service')
  const job = useJob(`nginx:${project.id}`)

  const load = useCallback(async () => {
    try {
      setInfo(await window.api.nginx.overview(project.id))
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (action: 'reload' | 'start' | 'stop' | 'test', title: string): Promise<void> => {
    await job.run(title, () => window.api.nginx.control(project.id, action))
    await load()
  }

  if (error) {
    return (
      <div className="card">
        <Alert type="error" showIcon message="Could not read nginx on this server" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
      </div>
    )
  }
  if (!info) {
    return (
      <div className="empty">
        <Spin />
      </div>
    )
  }
  if (!info.installed) {
    return (
      <div className="card">
        <Alert type="info" showIcon message="nginx is not installed on this server" description="Sites & Deploy installs it with one click, together with everything sites need." action={<Button onClick={onOpenSites}>Open Sites & Deploy</Button>} />
      </div>
    )
  }

  return (
    <div className="card nginx-page">
      <Tabs
        tabPosition="left"
        activeKey={tab}
        onChange={setTab}
        destroyInactiveTabPane
        items={[
          {
            key: 'service',
            label: 'Service',
            children: (
              <div className="nginx-pane">
                <div className="nginx-status">
                  <Tag color={info.running ? 'green' : 'red'} style={{ fontSize: 13, padding: '2px 10px' }}>
                    {info.running ? 'Running' : 'Stopped'}
                  </Tag>
                  <span>nginx {info.version}</span>
                  {info.running && (
                    <span className="nginx-muted">
                      {info.workers} worker{info.workers === 1 ? '' : 's'} · {bytes(info.memoryKb * 1024)} memory · up {duration(info.upSeconds)}
                    </span>
                  )}
                  <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} aria-label="Refresh" />
                </div>
                <div className={`nginx-test ${info.configOk ? 'ok' : 'bad'}`}>
                  {info.configOk ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                  <div>
                    <b>{info.configOk ? 'The configuration is valid' : 'The configuration has an error'}</b>
                    {!info.configOk && <pre className="mono">{info.testOutput}</pre>}
                  </div>
                </div>
                {canOps && (
                  <Space wrap>
                    {info.running ? (
                      <>
                        <Tooltip title="Reads the configuration again without dropping visitors">
                          <Button type="primary" onClick={() => void act('reload', 'Reload nginx')}>
                            Reload
                          </Button>
                        </Tooltip>
                        <Button
                          onClick={() =>
                            modal.confirm({
                              title: 'Restart nginx?',
                              content: 'Every site pauses for about a second. The configuration is checked first.',
                              okText: 'Restart',
                              onOk: () => job.run('Restart nginx', () => window.api.server.restartService(project.id, 'nginx')).then(load)
                            })
                          }
                        >
                          Restart
                        </Button>
                        <Button
                          danger
                          onClick={() =>
                            modal.confirm({
                              title: 'Stop nginx?',
                              content: 'Every site on this server goes offline until nginx is started again. If the panel\'s own service runs behind nginx on this server, the app loses it too.',
                              okText: 'Stop nginx',
                              okButtonProps: { danger: true },
                              onOk: () => act('stop', 'Stop nginx')
                            })
                          }
                        >
                          Stop
                        </Button>
                      </>
                    ) : (
                      <Button type="primary" onClick={() => void act('start', 'Start nginx')}>
                        Start
                      </Button>
                    )}
                    <Button onClick={() => void act('test', 'Check nginx configuration')}>Check configuration</Button>
                    <Button type="link" onClick={onOpenSites}>
                      Sites & Deploy
                    </Button>
                  </Space>
                )}
              </div>
            )
          },
          { key: 'tuning', label: 'Optimization', children: <TuningPane project={project} canOps={canOps} onSaved={load} job={job} /> },
          { key: 'config', label: 'Config file', children: <ConfigPane project={project} canOps={canOps} dark={dark} job={job} onSaved={load} /> },
          { key: 'load', label: 'Load status', children: <LoadPane project={project} canOps={canOps} running={info.running} /> },
          { key: 'errors', label: 'Error log', children: <ErrorPane project={project} canOps={canOps} message={message} /> }
        ]}
      />
      <JobDrawer job={job} />
    </div>
  )
}

type Job = ReturnType<typeof useJob>

function TuningPane({ project, canOps, onSaved, job }: { project: Project; canOps: boolean; onSaved: () => void; job: Job }) {
  const [form] = Form.useForm<NginxTuning>()
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const gzip = Form.useWatch('gzip', form)

  const read = useCallback(async () => {
    try {
      form.setFieldsValue(await window.api.nginx.tuning(project.id))
      setLoaded(true)
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [form, project.id])

  useEffect(() => {
    void read()
  }, [read])

  const save = async (): Promise<void> => {
    let v: NginxTuning
    try {
      v = await form.validateFields()
    } catch {
      return
    }
    const ok = await job.run('Save nginx settings', () => window.api.nginx.saveTuning(project.id, v))
    if (ok) await read()
    onSaved()
  }

  if (error) return <Alert type="error" showIcon message={error} />
  if (!loaded) return <Spin />
  return (
    <div className="nginx-pane">
      <div className="nginx-muted" style={{ marginBottom: 16 }}>
        These live in /etc/nginx/nginx.conf and apply to every site. Saving checks the file with nginx first; a value nginx refuses changes nothing.
      </div>
      <Form form={form} layout="horizontal" labelCol={{ flex: '270px' }} labelWrap labelAlign="right" colon={false} requiredMark={false} disabled={!canOps} className="nginx-form">
        {FIELDS.map((f) => (
          <Form.Item
            key={f.key}
            label={<span className="mono">{f.name}</span>}
            extra={f.help}
            name={f.key}
            valuePropName={f.key === 'gzip' ? 'checked' : 'value'}
            rules={f.key === 'workerProcesses' ? [{ required: true, pattern: /^(auto|\d{1,3})$/, message: '"auto" or a number' }] : f.key === 'gzip' ? [] : [{ required: true, message: 'Enter a number' }]}
          >
            {f.key === 'gzip' ? (
              <Switch checkedChildren="On" unCheckedChildren="Off" />
            ) : f.key === 'workerProcesses' ? (
              <Input style={{ width: 200 }} />
            ) : (
              <InputNumber style={{ width: 200 }} min={f.min} max={f.max} precision={0} addonAfter={f.unit} disabled={!canOps || ((f.key === 'gzipMinLengthKb' || f.key === 'gzipCompLevel') && !gzip)} />
            )}
          </Form.Item>
        ))}
        {canOps && (
          <Form.Item label=" ">
            <Space>
              <Button type="primary" onClick={() => void save()}>
                Save
              </Button>
              <Button onClick={() => void read()}>Undo changes</Button>
            </Space>
          </Form.Item>
        )}
      </Form>
    </div>
  )
}

function ConfigPane({ project, canOps, dark, job, onSaved }: { project: Project; canOps: boolean; dark: boolean; job: Job; onSaved: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [key, setKey] = useState(0)
  const draft = useRef('')

  const read = useCallback(async () => {
    try {
      const t = await window.api.nginx.config(project.id)
      draft.current = t
      setText(t)
      setKey((k) => k + 1)
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id])

  useEffect(() => {
    if (canOps) void read()
  }, [read, canOps])

  const save = async (): Promise<void> => {
    if (await job.run('Save nginx.conf', () => window.api.nginx.saveConfig(project.id, draft.current))) await read()
    onSaved()
  }

  if (!canOps) return <Alert type="info" showIcon message="Opening nginx.conf needs the Operations permission." />
  if (error) return <Alert type="error" showIcon message={error} />
  if (text === null) return <Spin />
  return (
    <div className="nginx-pane">
      <div className="nginx-muted" style={{ marginBottom: 10 }}>
        /etc/nginx/nginx.conf. Saving checks it with nginx first; a file nginx refuses is put back and its message shown. Each site&apos;s own file is made by the app from Sites &amp; Deploy.
      </div>
      <div className="nginx-editor">
        <CodeEditor docKey={`nginx-${project.id}-${key}`} path="/etc/nginx/nginx.conf" value={text} dark={dark} onChange={(t) => (draft.current = t)} onSave={() => void save()} />
      </div>
      <Space style={{ marginTop: 12 }}>
        <Button type="primary" onClick={() => void save()}>
          Save
        </Button>
        <Button onClick={() => void read()}>Reload from server</Button>
      </Space>
    </div>
  )
}

function LoadPane({ project, canOps, running }: { project: Project; canOps: boolean; running: boolean }) {
  const [samples, setSamples] = useState<NginxLoad[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!canOps || !running) return
    let stop = false
    const tick = async (): Promise<void> => {
      try {
        const s = await window.api.nginx.load(project.id)
        if (!stop) setSamples((list) => [...list.slice(-59), s])
        setError(null)
      } catch (err) {
        if (!stop) setError(errText(err))
      }
    }
    void tick()
    const t = setInterval(() => void tick(), 3000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [project.id, canOps, running])

  if (!running) return <Alert type="warning" showIcon message="nginx is not running." />
  if (!canOps) return <Alert type="info" showIcon message="Load status needs the Operations permission (it adds a status page on 127.0.0.1 the first time)." />
  if (error) return <Alert type="error" showIcon message={error} />
  const s = samples[samples.length - 1]
  if (!s) return <Spin />
  const rates = samples.slice(1).map((x, i) => Math.max(0, (x.requests - samples[i].requests) / Math.max(1, (x.at - samples[i].at) / 1000)))
  const rate = rates[rates.length - 1] ?? 0
  const rows: [string, string, string][] = [
    ['Active connections', String(s.active), 'Visitors connected right now, including idle ones kept open.'],
    ['Requests per second', rate.toFixed(1), 'Over the last few seconds.'],
    ['Reading', String(s.reading), 'Connections nginx is reading a request from.'],
    ['Writing', String(s.writing), 'Connections nginx is sending an answer to.'],
    ['Waiting', String(s.waiting), 'Idle connections kept open for the next request.'],
    ['Accepted', s.accepts.toLocaleString(), 'Connections since nginx started.'],
    ['Handled', s.handled.toLocaleString(), 'Fewer than accepted means connections were refused (worker_connections too low).'],
    ['Requests', s.requests.toLocaleString(), 'Requests since nginx started.'],
    ['Workers', String(s.workers), 'Worker processes.'],
    ['Memory', bytes(s.memoryKb * 1024), 'All nginx processes together.']
  ]
  return (
    <div className="nginx-pane">
      <div className="card-title" style={{ marginBottom: 4 }}>
        Requests per second <span className="big-num">{rate.toFixed(1)}</span>
      </div>
      <Sparkline values={rates} color="#3366ff" slots={60} />
      <table className="plain" style={{ marginTop: 14 }}>
        <tbody>
          {rows.map(([k, v, h]) => (
            <tr key={k}>
              <td style={{ width: 200 }}>{k}</td>
              <td className="nowrap" style={{ width: 140, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                {v}
              </td>
              <td className="nginx-muted">{h}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {s.accepts > s.handled && <Alert style={{ marginTop: 12 }} type="warning" showIcon message={`${(s.accepts - s.handled).toLocaleString()} connections were dropped. Raise worker_connections under Optimization.`} />}
    </div>
  )
}

function ErrorPane({ project, canOps, message }: { project: Project; canOps: boolean; message: ReturnType<typeof AntApp.useApp>['message'] }) {
  const [lines, setLines] = useState(200)
  const [data, setData] = useState<{ path: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const read = useCallback(async () => {
    try {
      setData(await window.api.nginx.errorLog(project.id, lines))
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id, lines])

  useEffect(() => {
    void read()
  }, [read])

  if (error) return <Alert type="error" showIcon message={error} />
  if (!data) return <Spin />
  const shown = data.text
    .split('\n')
    .filter((l) => !filter || l.toLowerCase().includes(filter.toLowerCase()))
    .reverse()
  return (
    <div className="nginx-pane">
      <Space wrap style={{ marginBottom: 10 }}>
        <span className="mono nginx-muted">{data.path}</span>
        <Select value={lines} onChange={setLines} style={{ width: 140 }} options={[100, 200, 500, 1000, 5000].map((n) => ({ value: n, label: `Last ${n} lines` }))} />
        <Input.Search allowClear placeholder="Filter" onSearch={setFilter} onChange={(e) => !e.target.value && setFilter('')} style={{ width: 200 }} />
        <Button icon={<ReloadOutlined />} onClick={() => void read()}>
          Refresh
        </Button>
        {canOps && (
          <Button
            danger
            onClick={() =>
              void window.api.nginx
                .clearErrorLog(project.id)
                .then(() => {
                  message.success('Error log emptied')
                  return read()
                })
                .catch((err) => message.error(errText(err)))
            }
          >
            Empty
          </Button>
        )}
      </Space>
      <div className="nginx-log mono">
        {shown.filter((l) => l.trim()).length === 0 ? (
          <div className="nginx-muted">No errors.</div>
        ) : (
          shown.map((l, i) =>
            l.trim() ? (
              <div key={i} className={/\[(emerg|alert|crit|error)\]/.test(l) ? 'lv-error' : /\[warn\]/.test(l) ? 'lv-warn' : ''}>
                {l}
              </div>
            ) : null
          )
        )}
      </div>
      <div className="nginx-muted" style={{ marginTop: 6 }}>
        Newest first. Each site&apos;s own errors are under Sites &amp; Deploy → More → Logs.
      </div>
    </div>
  )
}
