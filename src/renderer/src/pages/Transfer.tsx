import { useEffect, useRef, useState } from 'react'
import { Alert, App as AntApp, Button, Form, Input, Select, Tag } from 'antd'
import { SwapOutlined } from '@ant-design/icons'
import type { Project } from '@shared/types'
import { errText } from '../util'

interface Values {
  fromPath: string
  toId: string
  toPath: string
}

/** Copy a folder from the current server to another saved server. */
export default function Transfer({ project, projects }: { project: Project; projects: Project[] }) {
  const { modal } = AntApp.useApp()
  const [form] = Form.useForm<Values>()
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<'ok' | 'failed' | null>(null)
  const [logText, setLogText] = useState('')
  const logEnd = useRef<HTMLDivElement>(null)
  const sameTouched = useRef(false)
  const others = projects.filter((p) => p.id !== project.id)

  useEffect(
    () =>
      window.api.sites.onLog(({ jobId, chunk }) => {
        if (jobId === `copy:${project.id}`) setLogText((t) => t + chunk)
      }),
    [project.id]
  )

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'end' })
  }, [logText])

  const start = async (): Promise<void> => {
    let v: Values
    try {
      v = await form.validateFields()
    } catch {
      return
    }
    const target = others.find((p) => p.id === v.toId)
    modal.confirm({
      title: `Copy to ${target?.name}?`,
      content: (
        <div>
          <p>
            <span className="mono">{v.fromPath}</span> on {project.name} will be copied into <span className="mono">{v.toPath}</span> on{' '}
            {target?.name}.
          </p>
          <p>Files with the same name at the destination are overwritten. Other files there are kept.</p>
        </div>
      ),
      okText: 'Start copy',
      onOk: () => {
        setLogText('')
        setResult(null)
        setRunning(true)
        window.api.transfer
          .copy(project.id, v.fromPath, v.toId, v.toPath)
          .then(() => setResult('ok'))
          .catch((err) => {
            setResult('failed')
            // Validation errors are raised before any log line exists.
            setLogText((t) => t || `[failed] ${errText(err)}\n`)
          })
          .finally(() => setRunning(false))
      }
    })
  }

  if (others.length === 0) {
    return (
      <div className="card empty">
        <div>
          <SwapOutlined style={{ fontSize: 40, color: 'var(--primary)' }} />
          <h3>Add a second server first</h3>
          <div>Copying needs a destination. Add another server under "Projects", then come back here.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="grid">
      <div className="card">
        <div className="card-title">Copy a folder to another server</div>
        <Form
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{ fromPath: '', toPath: '' }}
          onValuesChange={(changed: Partial<Values>) => {
            if (changed.toPath !== undefined) sameTouched.current = true
            if (changed.fromPath !== undefined && !sameTouched.current) form.setFieldValue('toPath', changed.fromPath)
          }}
        >
          <div className="grid cols-2">
            <Form.Item
              name="fromPath"
              label={`Folder on ${project.name}`}
              rules={[
                { required: true, message: 'Enter the folder to copy' },
                { pattern: /^\/[A-Za-z0-9._/-]+$/, message: 'Use an absolute path without spaces' }
              ]}
            >
              <Input className="mono" placeholder="/www/wwwroot/shop" spellCheck={false} />
            </Form.Item>
            <Form.Item name="toId" label="Destination server" rules={[{ required: true, message: 'Choose where to copy to' }]}>
              <Select
                placeholder="Choose a server"
                options={others.map((p) => ({ value: p.id, label: `${p.name} (${p.host})` }))}
              />
            </Form.Item>
          </div>
          <Form.Item
            name="toPath"
            label="Folder on the destination"
            extra="Created if it does not exist. The contents of the source folder go inside it."
            rules={[
              { required: true, message: 'Enter the destination folder' },
              { pattern: /^\/[A-Za-z0-9._/-]+$/, message: 'Use an absolute path without spaces' }
            ]}
          >
            <Input className="mono" placeholder="/www/wwwroot/shop" spellCheck={false} />
          </Form.Item>
          <Button type="primary" icon={<SwapOutlined />} loading={running} onClick={() => void start()}>
            Copy folder
          </Button>
        </Form>
      </div>

      <Alert
        type="info"
        showIcon
        message="The data travels through this computer, compressed. The two servers do not need SSH access to each other. Both logins need root or sudo."
      />

      {(running || logText) && (
        <div className="card">
          <div className="card-title">
            Progress
            {running ? <Tag color="processing">Running</Tag> : result === 'ok' ? <Tag color="green">Done</Tag> : <Tag color="red">Failed</Tag>}
          </div>
          <pre className="log-box" style={{ height: 300 }}>
            {logText || 'Starting…'}
            <div ref={logEnd} />
          </pre>
        </div>
      )}
    </div>
  )
}
