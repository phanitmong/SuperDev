import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Space, Spin, Tag } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import type { ComposerOverview, Project } from '@shared/types'
import { JobDrawer, useJob } from '../components/JobLog'
import { errText } from '../util'

/** Composer, PHP's package manager. */
export default function ComposerPage({ project, canOps, onOpenPhp }: { project: Project; canOps: boolean; onOpenPhp: () => void }) {
  const { message, modal } = AntApp.useApp()
  const [data, setData] = useState<ComposerOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const job = useJob(`composer:${project.id}`)

  const load = useCallback(async () => {
    try {
      setData(await window.api.composer.overview(project.id))
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
        <Alert type="error" showIcon message="Could not read Composer on this server" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
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

  const install = (title: string): void => void job.run(title, () => window.api.composer.install(project.id)).then(load)
  const remove = (): void => {
    modal.confirm({
      title: 'Remove Composer?',
      content: 'Sites keep working: the packages already in their vendor folders stay. Deploys that run "composer install" will fail until it is installed again.',
      okText: 'Remove',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.api.composer.remove(project.id)
          message.success('Composer removed')
        } catch (err) {
          message.error(errText(err), 8)
        }
        await load()
      }
    })
  }

  if (!data.installed) {
    return (
      <div className="card empty">
        <div>
          <h3>Composer is not installed on this server</h3>
          <div style={{ marginBottom: 16, maxWidth: 460 }}>Composer installs the PHP packages a project lists in composer.json. Laravel, Symfony and most PHP projects need it for deploys.</div>
          {!data.php && <Alert style={{ marginBottom: 16, textAlign: 'left' }} type="warning" showIcon message="Composer needs PHP, and this server has none." action={<Button size="small" onClick={onOpenPhp}>Open PHP</Button>} />}
          <Button type="primary" disabled={!canOps || !data.php} onClick={() => install('Install Composer')}>
            Install Composer
          </Button>
        </div>
        <JobDrawer job={job} />
      </div>
    )
  }

  return (
    <div className="grid">
      <div className="card">
        <div className="card-title">
          <Space wrap>
            Composer
            <Tag color="green">{data.version || 'Installed'}</Tag>
            {data.php ? <Tag>{`PHP ${data.php}`}</Tag> : <Tag color="orange">No PHP</Tag>}
          </Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} />
        </div>
        <dl className="kv">
          <dt>Command</dt>
          <dd className="mono">{data.path}</dd>
          <dt>Runs with</dt>
          <dd>{data.php ? `PHP ${data.php}, the server's default PHP` : 'Nothing: install PHP to use it'}</dd>
        </dl>
        {canOps && (
          <Space style={{ marginTop: 16 }}>
            <Button type="primary" disabled={!data.php} onClick={() => install('Update Composer')}>
              Update to the newest stable
            </Button>
            <Button danger onClick={remove}>
              Remove
            </Button>
          </Space>
        )}
        <p className="db-hint" style={{ margin: '12px 0 0' }}>Downloaded from getcomposer.org and checked against its published checksum before it replaces the one in use.</p>
      </div>
      <JobDrawer job={job} />
    </div>
  )
}
