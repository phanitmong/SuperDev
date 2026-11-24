import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Select, Space, Spin, Table, Tag } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import type { JavaOverview, Project } from '@shared/types'
import { JobDrawer, useJob } from '../components/JobLog'
import { errText } from '../util'

/** OpenJDK versions on the server, with one of them as what the java command runs. */
export default function JavaPage({ project, canOps }: { project: Project; canOps: boolean }) {
  const { message, modal } = AntApp.useApp()
  const [data, setData] = useState<JavaOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [line, setLine] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const job = useJob(`java:${project.id}`)

  const load = useCallback(async () => {
    try {
      const d = await window.api.java.overview(project.id)
      setData(d)
      setLine((l) => l ?? d.lines[0] ?? null)
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id])

  useEffect(() => {
    void load()
  }, [load])

  if (error) {
    return (
      <div className="card">
        <Alert type="error" showIcon message="Could not read Java on this server" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
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

  const use = async (home: string, version: string): Promise<void> => {
    setBusy(true)
    try {
      await window.api.java.use(project.id, home)
      message.success(`The java command now runs ${version}`)
    } catch (err) {
      message.error(errText(err), 8)
    }
    await load()
    setBusy(false)
  }

  return (
    <div className="grid">
      <div className="card">
        <div className="card-title">
          <Space wrap>
            Java
            {data.installed ? <Tag color="green">{`java ${data.version}`}</Tag> : <Tag>Not installed</Tag>}
          </Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} />
        </div>
        <Space wrap style={{ marginBottom: 16 }}>
          <Select style={{ width: 170 }} value={line} onChange={setLine} options={data.lines.map((l) => ({ value: l, label: `OpenJDK ${l}${l === 21 || l === 17 ? ' (long-term)' : ''}` }))} disabled={!canOps || !data.packageManager} />
          <Button type="primary" disabled={!canOps || !data.packageManager || line === null} onClick={() => line !== null && void job.run(`Install OpenJDK ${line}`, () => window.api.java.install(project.id, line)).then(load)}>
            Install OpenJDK {line ?? ''}
          </Button>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>From the system's own packages. Not every system has every version.</span>
        </Space>
        <Table
          size="small"
          rowKey="home"
          pagination={false}
          dataSource={data.jdks}
          locale={{ emptyText: 'No Java installed yet' }}
          columns={[
            { title: 'Version', render: (_, j) => <span className="mono" style={{ fontWeight: 600 }}>{j.version}</span> },
            { title: 'Folder', render: (_, j) => <span className="mono" style={{ fontSize: 12 }}>{j.home}</span> },
            { title: '', render: (_, j) => <Space size={4}>{j.isDefault && <Tag color="blue">Default</Tag>}{!j.compiler && <Tag>Runs apps only</Tag>}</Space> },
            {
              title: '',
              align: 'right',
              render: (_, j) =>
                canOps && (
                  <Space>
                    {!j.isDefault && (
                      <Button size="small" loading={busy} onClick={() => void use(j.home, j.version)}>
                        Make default
                      </Button>
                    )}
                    {data.lines.includes(j.line) && (
                      <Button
                        size="small"
                        danger
                        disabled={busy}
                        onClick={() =>
                          modal.confirm({
                            title: `Remove OpenJDK ${j.line}?`,
                            content: 'Apps started with it keep running until they are restarted, then need another Java.',
                            okText: 'Remove',
                            okButtonProps: { danger: true },
                            onOk: () => void job.run(`Remove OpenJDK ${j.line}`, () => window.api.java.remove(project.id, j.line)).then(load)
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
        <p className="db-hint" style={{ margin: '12px 0 0' }}>
          To deploy a Java app: Sites & Deploy, new site, type "App on a port", started as Java. Build tools (Maven, Gradle) are not installed from here; a project's own ./mvnw or ./gradlew works in the post-deploy commands.
        </p>
      </div>
      <JobDrawer job={job} />
    </div>
  )
}
