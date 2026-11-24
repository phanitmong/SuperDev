import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Space, Spin, Table, Tag } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import type { Project, PythonOverview } from '@shared/types'
import { JobDrawer, useJob } from '../components/JobLog'
import { errText } from '../util'

/** Python on the server: the system's python3 with pip and virtual environments. */
export default function PythonPage({ project, canOps }: { project: Project; canOps: boolean }) {
  const [data, setData] = useState<PythonOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const job = useJob(`python:${project.id}`)

  const load = useCallback(async () => {
    try {
      setData(await window.api.python.overview(project.id))
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
        <Alert type="error" showIcon message="Could not read Python on this server" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
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
  const install = (title: string): void => void job.run(title, () => window.api.python.install(project.id)).then(load)

  if (!data.installed) {
    return (
      <div className="card empty">
        <div>
          <h3>Python is not installed on this server</h3>
          <div style={{ marginBottom: 16, maxWidth: 460 }}>Installs Python 3 with pip and virtual environments from the system's own packages. A Python site makes its own environment from it at deploy time.</div>
          <Button type="primary" disabled={!canOps || !data.packageManager} onClick={() => install('Install Python')}>
            Install Python
          </Button>
        </div>
        <JobDrawer job={job} />
      </div>
    )
  }

  return (
    <div className="grid">
      {!data.venv && (
        <Alert
          type="warning"
          showIcon
          message="This Python cannot make virtual environments yet."
          description="Python sites need one. Installing adds the missing part (python3-venv)."
          action={canOps && <Button type="primary" onClick={() => install('Add virtual environments')}>Install</Button>}
        />
      )}
      <div className="card">
        <div className="card-title">
          <Space wrap>
            Python
            <Tag color="green">{data.version}</Tag>
            <Tag color={data.venv ? 'green' : 'orange'}>{data.venv ? 'Virtual environments' : 'No virtual environments'}</Tag>
            <Tag color={data.pip ? 'green' : 'orange'}>{data.pip ? `pip ${data.pip}` : 'No pip'}</Tag>
          </Space>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void load()} />
            {canOps && !data.pip && <Button onClick={() => install('Add pip')}>Add pip</Button>}
          </Space>
        </div>
        <Table
          size="small"
          rowKey="path"
          pagination={false}
          dataSource={data.others}
          locale={{ emptyText: 'Only the default python3 was found' }}
          columns={[
            { title: 'Version', dataIndex: 'version', render: (v: string) => <span className="mono" style={{ fontWeight: 600 }}>{v}</span> },
            { title: 'Command', dataIndex: 'path', render: (v: string) => <span className="mono" style={{ fontSize: 12 }}>{v}</span> },
            { title: '', render: (_, r) => (r.version === data.version ? <Tag color="blue">python3</Tag> : null) }
          ]}
        />
        <p className="db-hint" style={{ margin: '12px 0 0' }}>
          To deploy a Python app: Sites & Deploy, new site, type "App on a port", started as Python. Each site gets its own environment in a .venv folder, so sites do not share packages. This page installs the system's Python; other Python versions are not installed from here.
        </p>
      </div>
      <JobDrawer job={job} />
    </div>
  )
}
