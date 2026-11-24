import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Select, Space, Spin, Table, Tag } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import type { NodeOverview, Project } from '@shared/types'
import { JobDrawer, useJob } from '../components/JobLog'
import { errText } from '../util'

/** Node.js versions on the server, side by side, with one of them as the default. */
export default function NodePage({ project, canOps }: { project: Project; canOps: boolean }) {
  const { message, modal } = AntApp.useApp()
  const [data, setData] = useState<NodeOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [line, setLine] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const job = useJob(`node:${project.id}`)

  const load = useCallback(async () => {
    try {
      const d = await window.api.node.overview(project.id)
      setData(d)
      setLine((l) => l ?? d.lines[1] ?? d.lines[0] ?? null)
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      message.success(done)
    } catch (err) {
      message.error(errText(err), 8)
    }
    await load()
    setBusy(false)
  }

  if (error) {
    return (
      <div className="card">
        <Alert type="error" showIcon message="Could not read Node.js on this server" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
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

  const remove = (version: string): void => {
    modal.confirm({
      title: `Remove Node.js ${version}?`,
      content: 'Apps that were started with this version keep running until they are restarted, then need another version.',
      okText: 'Remove',
      okButtonProps: { danger: true },
      onOk: () => act(() => window.api.node.remove(project.id, version), `Node.js ${version} removed`)
    })
  }

  return (
    <div className="grid">
      {!data.supported && <Alert type="warning" showIcon message="This server's processor has no official Node.js build." description="Node.js publishes builds for 64-bit Intel/AMD and ARM servers." />}
      {data.foreign && (
        <Alert
          type="info"
          showIcon
          message={`This server already has Node.js ${data.running} at ${data.foreign}, installed another way.`}
          description="It is left alone. A version installed here goes to /usr/local/bin, which most servers look in first, so it becomes the one that answers."
        />
      )}
      <div className="card">
        <div className="card-title">
          <Space wrap>
            Node.js
            {data.running ? <Tag color="green">{`node ${data.running}`}</Tag> : <Tag>Not installed</Tag>}
            {data.npm && <Tag>{`npm ${data.npm}`}</Tag>}
            {data.arch && <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--muted)' }}>{data.arch}</span>}
          </Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} />
        </div>
        <Space wrap style={{ marginBottom: 16 }}>
          <Select
            style={{ width: 170 }}
            value={line}
            onChange={setLine}
            options={data.lines.map((l) => ({ value: l, label: `Node.js ${l}` }))}
            disabled={!canOps || !data.supported}
          />
          <Button
            type="primary"
            disabled={!canOps || !data.supported || line === null}
            onClick={() => line !== null && void job.run(`Install Node.js ${line}`, () => window.api.node.install(project.id, line)).then(load)}
          >
            Install newest {line ?? ''}
          </Button>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>Downloaded from nodejs.org and checked against its published checksum.</span>
        </Space>
        <Table
          size="small"
          rowKey={(v) => v}
          pagination={false}
          dataSource={data.versions}
          locale={{ emptyText: 'No version installed from here yet' }}
          columns={[
            { title: 'Version', render: (_, v) => <span className="mono" style={{ fontWeight: 600 }}>{v}</span> },
            { title: 'Folder', render: (_, v) => <span className="mono" style={{ fontSize: 12 }}>/opt/superdevops/node/{v}</span> },
            { title: '', render: (_, v) => (v === data.current ? <Tag color="blue">Default</Tag> : null) },
            {
              title: '',
              align: 'right',
              render: (_, v) =>
                canOps && (
                  <Space>
                    {v !== data.current && (
                      <Button size="small" loading={busy} onClick={() => void act(() => window.api.node.use(project.id, v), `The default is now Node.js ${v}`)}>
                        Make default
                      </Button>
                    )}
                    <Button size="small" danger disabled={busy} onClick={() => remove(v)}>
                      Remove
                    </Button>
                  </Space>
                )
            }
          ]}
        />
        <p className="db-hint" style={{ margin: '12px 0 0' }}>
          The default is what the commands node, npm and npx run. To run one app on another version, start it with that version's full path, such as /opt/superdevops/node/{data.versions[0] ?? 'v22.x.x'}/bin/node.
        </p>
      </div>
      <JobDrawer job={job} />
    </div>
  )
}
