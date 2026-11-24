import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Checkbox, Dropdown, Input, InputNumber, Modal, Select, Space, Spin, Table, Tag } from 'antd'
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { DockerContainer, DockerImage, DockerOverview, DockerRunInput, Project } from '@shared/types'
import FolderInput from '../components/FolderPicker'
import { JobDrawer, useJob } from '../components/JobLog'
import { errText } from '../util'

const STATE_COLOR: Record<string, string> = { running: 'green', exited: 'default', created: 'default', paused: 'orange', restarting: 'orange', dead: 'red' }
const STATE_WORD: Record<string, string> = { running: 'Running', exited: 'Stopped', created: 'Not started', paused: 'Paused', restarting: 'Restarting', dead: 'Broken' }

const EMPTY_RUN: DockerRunInput = { image: '', name: '', ports: [], volumes: [], env: [], restart: 'unless-stopped', command: '' }

/** The form for starting a new container from an image. */
function RunDialog({ open, project, onClose, onRun }: { open: boolean; project: Project; onClose: () => void; onRun: (input: DockerRunInput) => void }) {
  const [v, setV] = useState<DockerRunInput>(EMPTY_RUN)
  useEffect(() => {
    if (open) setV(EMPTY_RUN)
  }, [open])
  const set = (patch: Partial<DockerRunInput>): void => setV({ ...v, ...patch })
  const suggest = (image: string): string => (image.split('/').pop() ?? '').split(/[:@]/)[0].replace(/[^A-Za-z0-9_.-]/g, '')
  const anyPublic = v.ports.some((p) => p.public)
  const ready = !!v.image.trim() && !!v.name.trim() && v.ports.every((p) => p.host > 0 && p.container > 0) && v.volumes.every((x) => x.host.trim() && x.container.trim())
  return (
    <Modal open={open} title="Run a container" width={720} okText="Fetch the image and start" okButtonProps={{ disabled: !ready }} onOk={() => onRun(v)} onCancel={onClose} destroyOnClose>
      <div className="gd-form">
        <div className="gd-row">
          <div className="gd-field">
            <label htmlFor="dk-image">
              <b>Image</b>
            </label>
            <Input id="dk-image" value={v.image} spellCheck={false} placeholder="nginx:alpine, postgres:17, ghcr.io/owner/app:1.2" onChange={(e) => set({ image: e.target.value.trim(), name: v.name && v.name !== suggest(v.image) ? v.name : suggest(e.target.value.trim()) })} />
          </div>
          <div className="gd-field" style={{ flex: 'none', width: 220 }}>
            <label htmlFor="dk-name">
              <b>Name</b>
            </label>
            <Input id="dk-name" value={v.name} spellCheck={false} onChange={(e) => set({ name: e.target.value.trim() })} />
          </div>
        </div>

        <div className="gd-field">
          <b>Ports</b>
          {v.ports.map((p, i) => (
            <Space key={i} wrap>
              <InputNumber min={1} max={65535} value={p.host || null} addonBefore="Server" style={{ width: 170 }} aria-label="Port on the server" onChange={(n) => set({ ports: v.ports.map((x, j) => (j === i ? { ...x, host: n ?? 0 } : x)) })} />
              <InputNumber min={1} max={65535} value={p.container || null} addonBefore="Container" style={{ width: 190 }} aria-label="Port inside the container" onChange={(n) => set({ ports: v.ports.map((x, j) => (j === i ? { ...x, container: n ?? 0 } : x)) })} />
              <Checkbox checked={p.public === true} onChange={(e) => set({ ports: v.ports.map((x, j) => (j === i ? { ...x, public: e.target.checked } : x)) })}>
                Open to the internet
              </Checkbox>
              <Button type="text" icon={<DeleteOutlined />} aria-label="Remove this port" onClick={() => set({ ports: v.ports.filter((_, j) => j !== i) })} />
            </Space>
          ))}
          <div>
            <Button size="small" icon={<PlusOutlined />} onClick={() => set({ ports: [...v.ports, { host: 0, container: 0 }] })}>
              Add a port
            </Button>
          </div>
          <p className="db-hint" style={{ margin: 0 }}>
            A port is reachable from this server only, unless you tick the box. To put a website in front of it, add a site of the type "App on a port" with the server port.
          </p>
          {anyPublic && <Alert type="warning" showIcon message="Docker opens such a port past the server's firewall" description="Even with the firewall on and the port not allowed there, anyone on the internet can reach it. Tick the box only for something meant to be public." />}
        </div>

        <div className="gd-field">
          <b>Folders and volumes</b>
          {v.volumes.map((x, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ flex: 1 }}>
                <FolderInput projectId={project.id} value={x.host} placeholder="Folder on the server, or a volume name" onChange={(val) => set({ volumes: v.volumes.map((y, j) => (j === i ? { ...y, host: val ?? '' } : y)) })} />
              </div>
              <Input style={{ flex: 1 }} value={x.container} spellCheck={false} placeholder="Path inside the container, e.g. /var/lib/data" aria-label="Path inside the container" onChange={(e) => set({ volumes: v.volumes.map((y, j) => (j === i ? { ...y, container: e.target.value } : y)) })} />
              <Button type="text" icon={<DeleteOutlined />} aria-label="Remove this folder" onClick={() => set({ volumes: v.volumes.filter((_, j) => j !== i) })} />
            </div>
          ))}
          <div>
            <Button size="small" icon={<PlusOutlined />} onClick={() => set({ volumes: [...v.volumes, { host: '', container: '' }] })}>
              Add a folder
            </Button>
          </div>
          <p className="db-hint" style={{ margin: 0 }}>Without one, everything the container writes is lost when the container is removed.</p>
        </div>

        <div className="gd-field">
          <b>Variables</b>
          {v.env.map((x, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Input style={{ width: 240 }} value={x.key} spellCheck={false} placeholder="NAME" aria-label="Variable name" onChange={(e) => set({ env: v.env.map((y, j) => (j === i ? { ...y, key: e.target.value.trim() } : y)) })} />
              <Input.Password style={{ flex: 1 }} value={x.value} placeholder="value" aria-label="Variable value" autoComplete="new-password" onChange={(e) => set({ env: v.env.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)) })} />
              <Button type="text" icon={<DeleteOutlined />} aria-label="Remove this variable" onClick={() => set({ env: v.env.filter((_, j) => j !== i) })} />
            </div>
          ))}
          <div>
            <Button size="small" icon={<PlusOutlined />} onClick={() => set({ env: [...v.env, { key: '', value: '' }] })}>
              Add a variable
            </Button>
          </div>
          <p className="db-hint" style={{ margin: 0 }}>Values are not written to the audit log.</p>
        </div>

        <div className="gd-row">
          <div className="gd-field" style={{ flex: 'none', width: 280 }}>
            <label htmlFor="dk-restart">
              <b>If it stops</b>
            </label>
            <Select
              id="dk-restart"
              value={v.restart}
              onChange={(r) => set({ restart: r })}
              options={[
                { value: 'unless-stopped', label: 'Start it again, also after a reboot' },
                { value: 'on-failure', label: 'Start it again only after a crash' },
                { value: 'always', label: 'Always start it again' },
                { value: 'no', label: 'Leave it stopped' }
              ]}
            />
          </div>
          <div className="gd-field">
            <label htmlFor="dk-command">
              <b>Command (optional)</b>
            </label>
            <Input id="dk-command" value={v.command} spellCheck={false} placeholder="Leave empty to use the image's own" onChange={(e) => set({ command: e.target.value })} />
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** Docker on this server: containers, images and Compose projects. */
export default function DockerPage({ project, canOps }: { project: Project; canOps: boolean }) {
  const { message, modal } = AntApp.useApp()
  const [data, setData] = useState<DockerOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [running, setRunning] = useState(false)
  const [logOf, setLogOf] = useState<DockerContainer | null>(null)
  const [logText, setLogText] = useState<string | null>(null)
  const [composeDir, setComposeDir] = useState<string | null>(null)
  const [pullName, setPullName] = useState<string | null>(null)
  const job = useJob(`docker:${project.id}`)

  const load = useCallback(async () => {
    try {
      setData(await window.api.docker.overview(project.id))
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id])

  useEffect(() => {
    void load()
  }, [load])

  const readLog = useCallback(
    async (c: DockerContainer) => {
      setLogText(null)
      try {
        setLogText(await window.api.docker.logs(project.id, c.id, 400))
      } catch (err) {
        setLogText(`Could not read the output: ${errText(err)}`)
      }
    },
    [project.id]
  )

  if (error) {
    return (
      <div className="card">
        <Alert type="error" showIcon message="Could not read Docker on this server" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
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

  const act = async (c: DockerContainer, action: 'start' | 'stop' | 'restart' | 'remove'): Promise<void> => {
    setBusy(`${c.id}:${action}`)
    try {
      await window.api.docker.container(project.id, c.id, action)
      message.success(`${c.name}: ${action === 'remove' ? 'removed' : action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted'}`)
    } catch (err) {
      message.error(errText(err), 8)
    }
    await load()
    setBusy('')
  }

  const removeImage = async (i: DockerImage): Promise<void> => {
    setBusy(`img:${i.id}`)
    try {
      await window.api.docker.removeImage(project.id, i.id)
      message.success('Image removed')
    } catch (err) {
      message.error(errText(err), 8)
    }
    await load()
    setBusy('')
  }

  const after = (p: Promise<unknown>): void => void p.then(load, load)
  const jobBusy = job.state === 'running'

  if (!data.installed) {
    return (
      <div className="card">
        <div className="card-title">Docker</div>
        <p style={{ color: 'var(--muted)', maxWidth: 640, marginTop: 0 }}>
          Docker runs an app and everything it needs in a container, kept apart from the rest of the server. Installing adds Docker and Compose{data.packageManager === 'apt-get' ? " from the system's own packages" : " from Docker's package repository"}, and
          makes Docker start with the server.
        </p>
        <Button type="primary" disabled={!canOps || !data.packageManager || jobBusy} onClick={() => after(job.run('Install Docker', () => window.api.docker.install(project.id)))}>
          Install Docker
        </Button>
        {!data.packageManager && <Alert type="warning" showIcon style={{ marginTop: 12 }} message="This server has no package manager this app knows (apt, dnf, yum)." />}
        <JobDrawer job={job} />
      </div>
    )
  }

  const live = data.containers.filter((c) => c.state === 'running').length

  return (
    <div className="grid">
      <div className="card">
        <div className="card-title">
          <Space wrap>
            Docker
            <Tag color={data.running ? 'green' : 'red'}>{data.running ? `Running · ${data.version}` : 'Stopped'}</Tag>
            {data.compose ? <Tag>Compose {data.compose}</Tag> : <Tag color="orange">Compose missing</Tag>}
          </Space>
          <Space>
            {canOps && (
              <Dropdown
                trigger={['click']}
                menu={{
                  items: data.running
                    ? [
                        { key: 'restart', label: 'Restart Docker' },
                        { key: 'stop', label: 'Stop Docker', danger: true }
                      ]
                    : [{ key: 'start', label: 'Start Docker' }],
                  onClick: ({ key }) => {
                    const go = (): void => after(job.run(`${key === 'stop' ? 'Stop' : key === 'start' ? 'Start' : 'Restart'} Docker`, () => window.api.docker.service(project.id, key as 'start' | 'stop' | 'restart')))
                    if (key === 'start') return go()
                    modal.confirm({
                      title: key === 'stop' ? 'Stop Docker?' : 'Restart Docker?',
                      content: key === 'stop' ? `All ${live} running container${live === 1 ? '' : 's'} stop with it and stay stopped until Docker is started again.` : 'Every container stops for a moment. Those set to start again come back by themselves.',
                      okText: key === 'stop' ? 'Stop Docker' : 'Restart Docker',
                      okButtonProps: { danger: key === 'stop' },
                      onOk: go
                    })
                  }
                }}
              >
                <Button disabled={jobBusy}>Service</Button>
              </Dropdown>
            )}
            <Button icon={<ReloadOutlined />} aria-label="Refresh" onClick={() => void load()} />
          </Space>
        </div>
        {!data.running && <Alert type="warning" showIcon message="The Docker service is not running" description="Its containers are stopped too. Start it from the Service button." />}
        {data.running && !data.compose && canOps && (
          <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Compose is not installed" description="Containers work without it; Compose projects do not." action={<Button size="small" disabled={jobBusy} onClick={() => after(job.run('Install Compose', () => window.api.docker.install(project.id)))}>Try to install</Button>} />
        )}
        {data.running && (
          <>
            <Space wrap style={{ marginBottom: 14 }}>
              <Button type="primary" icon={<PlusOutlined />} disabled={!canOps || jobBusy} onClick={() => setRunning(true)}>
                Run a container
              </Button>
              <Button disabled={!canOps || jobBusy || !data.compose} onClick={() => setComposeDir('')}>
                Start a Compose project
              </Button>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                {live} running of {data.containers.length}
              </span>
            </Space>
            <Table<DockerContainer>
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={data.containers}
              locale={{ emptyText: 'No containers yet' }}
              columns={[
                {
                  title: 'Container',
                  render: (_, c) => (
                    <div>
                      <div style={{ fontWeight: 600 }}>{c.name}</div>
                      <div className="mono" style={{ color: 'var(--muted)', fontSize: 12 }}>
                        {c.image}
                        {c.project ? ` · project ${c.project}` : ''}
                      </div>
                    </div>
                  )
                },
                {
                  title: 'State',
                  render: (_, c) => (
                    <div>
                      <Tag color={STATE_COLOR[c.state] ?? 'default'}>{STATE_WORD[c.state] ?? c.state}</Tag>
                      <div style={{ color: 'var(--muted)', fontSize: 12 }}>{c.status}</div>
                    </div>
                  )
                },
                { title: 'Ports', render: (_, c) => <span className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{c.ports || '-'}</span> },
                { title: 'CPU / memory', width: 150, render: (_, c) => (c.cpu ? `${c.cpu} · ${c.memory ?? ''}` : '') },
                {
                  title: '',
                  align: 'right',
                  render: (_, c) => (
                    <Space size={4} wrap>
                      <Button
                        size="small"
                        onClick={() => {
                          setLogOf(c)
                          void readLog(c)
                        }}
                      >
                        Output
                      </Button>
                      {canOps &&
                        (c.state === 'running' ? (
                          <>
                            <Button size="small" loading={busy === `${c.id}:restart`} onClick={() => void act(c, 'restart')}>
                              Restart
                            </Button>
                            <Button size="small" loading={busy === `${c.id}:stop`} onClick={() => void act(c, 'stop')}>
                              Stop
                            </Button>
                          </>
                        ) : (
                          <Button size="small" type="primary" loading={busy === `${c.id}:start`} onClick={() => void act(c, 'start')}>
                            Start
                          </Button>
                        ))}
                      {canOps && (
                        <Button
                          size="small"
                          danger
                          loading={busy === `${c.id}:remove`}
                          onClick={() =>
                            modal.confirm({
                              title: `Remove ${c.name}?`,
                              content: `${c.state === 'running' ? 'It is running and will be stopped. ' : ''}What it wrote inside itself is lost. Folders and named volumes you attached are kept.`,
                              okText: 'Remove',
                              okButtonProps: { danger: true },
                              onOk: () => act(c, 'remove')
                            })
                          }
                        >
                          Remove
                        </Button>
                      )}
                    </Space>
                  )
                }
              ]}
            />
          </>
        )}
      </div>

      {data.running && data.projects.length > 0 && (
        <div className="card">
          <div className="card-title">Compose projects</div>
          <Table
            size="small"
            rowKey="name"
            pagination={false}
            dataSource={data.projects}
            columns={[
              { title: 'Project', render: (_, p) => <b>{p.name}</b> },
              { title: 'State', dataIndex: 'status' },
              { title: 'File', render: (_, p) => <span className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{p.files}</span> },
              {
                title: '',
                align: 'right',
                render: (_, p) => {
                  const dir = p.files.split(',')[0].replace(/\/[^/]*$/, '')
                  return (
                    canOps && (
                      <Space size={4}>
                        <Button size="small" disabled={jobBusy} onClick={() => after(job.run(`Update project ${p.name}`, () => window.api.docker.composeUp(project.id, dir)))}>
                          Fetch and restart
                        </Button>
                        <Button
                          size="small"
                          danger
                          disabled={jobBusy}
                          onClick={() =>
                            modal.confirm({
                              title: `Stop project ${p.name}?`,
                              content: 'Its containers are stopped and removed. Named volumes (the data) are kept, and starting the project again brings it back.',
                              okText: 'Stop project',
                              okButtonProps: { danger: true },
                              onOk: () => after(job.run(`Stop project ${p.name}`, () => window.api.docker.composeDown(project.id, dir)))
                            })
                          }
                        >
                          Stop
                        </Button>
                      </Space>
                    )
                  )
                }
              }
            ]}
          />
        </div>
      )}

      {data.running && (
        <div className="card">
          <div className="card-title">
            <Space wrap>
              Images
              {data.disk
                .filter((d) => d.type === 'Images')
                .map((d) => (
                  <Tag key={d.type}>
                    {d.size} on disk · {d.reclaimable} can be freed
                  </Tag>
                ))}
            </Space>
            {canOps && (
              <Space>
                <Button disabled={jobBusy} onClick={() => setPullName('')}>
                  Fetch an image
                </Button>
                <Button
                  disabled={jobBusy || !data.images.some((i) => !i.used)}
                  onClick={() =>
                    modal.confirm({
                      title: 'Remove images that no container uses?',
                      content: 'Images used by a container, running or stopped, are kept. A removed image is fetched again the next time something needs it.',
                      okText: 'Remove unused images',
                      onOk: () => after(job.run('Clean up Docker images', () => window.api.docker.prune(project.id)))
                    })
                  }
                >
                  Clean up
                </Button>
              </Space>
            )}
          </div>
          <Table<DockerImage>
            size="small"
            rowKey="id"
            pagination={data.images.length > 12 ? { pageSize: 12, showSizeChanger: false } : false}
            dataSource={data.images}
            locale={{ emptyText: 'No images on this server' }}
            columns={[
              { title: 'Image', render: (_, i) => <span className="mono">{i.name || `(no name) ${i.id}`}</span> },
              { title: 'Size', dataIndex: 'size', width: 110 },
              { title: 'Made', dataIndex: 'created', width: 150 },
              { title: '', width: 90, render: (_, i) => (i.used ? <Tag color="blue">In use</Tag> : <Tag>Unused</Tag>) },
              {
                title: '',
                align: 'right',
                width: 100,
                render: (_, i) =>
                  canOps &&
                  !i.used && (
                    <Button size="small" danger loading={busy === `img:${i.id}`} onClick={() => void removeImage(i)}>
                      Remove
                    </Button>
                  )
              }
            ]}
          />
        </div>
      )}

      <RunDialog
        open={running}
        project={project}
        onClose={() => setRunning(false)}
        onRun={(input) => {
          setRunning(false)
          after(job.run(`Run ${input.name}`, () => window.api.docker.run(project.id, input)))
        }}
      />

      <Modal open={composeDir !== null} title="Start a Compose project" okText="Check and start" okButtonProps={{ disabled: !composeDir?.trim() }} onCancel={() => setComposeDir(null)} onOk={() => {
          const dir = composeDir ?? ''
          setComposeDir(null)
          after(job.run(`Start project in ${dir}`, () => window.api.docker.composeUp(project.id, dir)))
        }}
      >
        <p style={{ color: 'var(--muted)', marginTop: 0 }}>Choose the folder on the server that holds compose.yaml or docker-compose.yml. Upload the file with the Files page first if it is not there yet. The file is checked before anything is started.</p>
        <FolderInput projectId={project.id} value={composeDir ?? ''} placeholder="/www/wwwroot/myapp" onChange={(val) => setComposeDir(val ?? '')} />
      </Modal>

      <Modal open={pullName !== null} title="Fetch an image" okText="Fetch" okButtonProps={{ disabled: !pullName?.trim() }} onCancel={() => setPullName(null)} onOk={() => {
          const name = (pullName ?? '').trim()
          setPullName(null)
          after(job.run(`Fetch ${name}`, () => window.api.docker.pull(project.id, name)))
        }}
      >
        <Input value={pullName ?? ''} spellCheck={false} placeholder="nginx:alpine" aria-label="Image name" onChange={(e) => setPullName(e.target.value)} />
        <p className="db-hint" style={{ marginBottom: 0 }}>Fetching an image that is already here brings its newest copy.</p>
      </Modal>

      <Modal
        open={!!logOf}
        title={logOf ? `Output of ${logOf.name}` : ''}
        width={900}
        onCancel={() => setLogOf(null)}
        footer={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => logOf && void readLog(logOf)}>
              Refresh
            </Button>
            <Button type="primary" onClick={() => setLogOf(null)}>
              Close
            </Button>
          </>
        }
      >
        {logText === null ? <Spin /> : <pre className="log-box" style={{ maxHeight: 460, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{logText || 'The container has written nothing yet.'}</pre>}
      </Modal>
      <JobDrawer job={job} />
    </div>
  )
}
