import { useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Checkbox, Form, Input, InputNumber, Modal, Segmented, Select, Switch, Tabs } from 'antd'
import { ApiOutlined, CheckCircleFilled, FolderOpenOutlined } from '@ant-design/icons'
import type { DbConnection, DbConnectionInput, Project } from '@shared/types'
import { errText } from '../util'

interface Values {
  name: string
  host: string
  port: number
  username: string
  password?: string
  database?: string
  shared: boolean
  useSsh: boolean
  sshFrom: 'typed' | 'server'
  sshProjectId?: string
  sshHost?: string
  sshPort?: number
  sshUsername?: string
  sshAuth: 'password' | 'key'
  sshPassword?: string
  sshKey?: string
  sshPassphrase?: string
}

const GENERAL = ['name', 'host', 'port', 'username', 'password', 'database']

/** New / edit connection, laid out like a desktop database tool: General and SSH tabs, with a test button. */
export default function DbConnectionForm({ open, editing, projects, onClose, onSaved }: { open: boolean; editing: DbConnection | null; projects: Project[]; onClose: () => void; onSaved: (c: DbConnection) => void }) {
  const { message } = AntApp.useApp()
  const [form] = Form.useForm<Values>()
  const [tab, setTab] = useState('general')
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const useSsh = Form.useWatch('useSsh', form)
  const sshFrom = Form.useWatch('sshFrom', form)
  const sshAuth = Form.useWatch('sshAuth', form)

  useEffect(() => {
    if (!open) return
    setTab('general')
    setResult(null)
    form.resetFields()
    form.setFieldsValue(
      editing
        ? { name: editing.name, host: editing.host, port: editing.port, username: editing.username, database: editing.database, shared: editing.shared, useSsh: editing.useSsh, sshFrom: editing.sshProjectId ? 'server' : 'typed', sshProjectId: editing.sshProjectId, sshHost: editing.sshHost, sshPort: editing.sshPort ?? 22, sshUsername: editing.sshUsername, sshAuth: editing.sshAuth ?? 'password' }
        : { name: '', host: '127.0.0.1', port: 3306, username: 'root', shared: false, useSsh: false, sshFrom: 'typed', sshPort: 22, sshAuth: 'password' }
    )
  }, [open, editing, form])

  const collect = async (): Promise<DbConnectionInput | null> => {
    try {
      const v = await form.validateFields()
      const ssh = v.useSsh
      const typed = ssh && v.sshFrom !== 'server'
      return {
        id: editing?.id,
        name: v.name,
        host: v.host,
        port: v.port,
        username: v.username,
        password: v.password || undefined,
        database: v.database,
        shared: v.shared === true,
        useSsh: ssh,
        sshProjectId: ssh && !typed ? v.sshProjectId : undefined,
        sshHost: typed ? v.sshHost : undefined,
        sshPort: typed ? v.sshPort : undefined,
        sshUsername: typed ? v.sshUsername : undefined,
        sshAuth: typed ? v.sshAuth : undefined,
        sshPassword: typed && v.sshAuth === 'password' ? v.sshPassword || undefined : undefined,
        sshKey: typed && v.sshAuth === 'key' ? v.sshKey || undefined : undefined,
        sshPassphrase: typed && v.sshAuth === 'key' ? v.sshPassphrase || undefined : undefined
      }
    } catch (err) {
      // Show the tab that holds the first field still to be filled in.
      const first = String((err as { errorFields?: { name: (string | number)[] }[] }).errorFields?.[0]?.name?.[0] ?? '')
      if (first) setTab(GENERAL.includes(first) ? 'general' : 'ssh')
      return null
    }
  }

  const test = async (): Promise<void> => {
    const input = await collect()
    if (!input) return
    setBusy('test')
    setResult(null)
    try {
      const r = await window.api.dbconn.test(input)
      setResult({ ok: true, text: `Connection successful. ${r.version} answered in ${r.ms} ms.` })
    } catch (err) {
      setResult({ ok: false, text: errText(err) })
    } finally {
      setBusy(null)
    }
  }

  const save = async (): Promise<void> => {
    const input = await collect()
    if (!input) return
    setBusy('save')
    try {
      const saved = await window.api.dbconn.save(input)
      message.success('Connection saved')
      onSaved(saved)
    } catch (err) {
      setResult({ ok: false, text: errText(err) })
    } finally {
      setBusy(null)
    }
  }

  const loadKey = async (): Promise<void> => {
    try {
      const key = await window.api.projects.readKeyFile()
      if (key) form.setFieldValue('sshKey', key)
    } catch (err) {
      message.error(errText(err))
    }
  }

  const typed = useSsh && sshFrom !== 'server'
  const keep = (has: boolean | undefined): string => (editing && has ? 'Unchanged' : '')

  return (
    <Modal
      open={open}
      title={editing ? `Edit connection: ${editing.name}` : 'New connection: MySQL / MariaDB'}
      onCancel={onClose}
      width={560}
      destroyOnClose
      maskClosable={false}
      footer={
        <div className="conn-footer">
          <Button icon={<ApiOutlined />} loading={busy === 'test'} disabled={busy === 'save'} onClick={() => void test()}>
            Test connection
          </Button>
          <span style={{ flex: 1 }} />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" loading={busy === 'save'} disabled={busy === 'test'} onClick={() => void save()}>
            Save
          </Button>
        </div>
      }
    >
      <Form form={form} layout="vertical" requiredMark={false} className="conn-form">
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: 'general',
              label: 'General',
              forceRender: true,
              children: (
                <>
                  <Form.Item name="name" label="Connection name" rules={[{ required: true, whitespace: true, message: 'Give the connection a name' }]}>
                    <Input placeholder="Shop production" autoFocus maxLength={80} />
                  </Form.Item>
                  <div className="form-row">
                    <Form.Item name="host" label="Host" style={{ flex: 1 }} rules={[{ required: true, whitespace: true, message: 'Enter the host' }]} extra={useSsh ? 'As seen from the SSH server. Usually 127.0.0.1.' : undefined}>
                      <Input className="mono" placeholder="127.0.0.1" spellCheck={false} />
                    </Form.Item>
                    <Form.Item name="port" label="Port" style={{ width: 120 }} rules={[{ required: true, message: 'Enter the port' }]}>
                      <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                    </Form.Item>
                  </div>
                  <div className="form-row">
                    <Form.Item name="username" label="User name" style={{ flex: 1 }} rules={[{ required: true, whitespace: true, message: 'Enter the user name' }]}>
                      <Input className="mono" spellCheck={false} autoComplete="off" />
                    </Form.Item>
                    <Form.Item name="password" label="Password" style={{ flex: 1 }}>
                      <Input.Password placeholder={keep(editing?.hasPassword)} autoComplete="new-password" />
                    </Form.Item>
                  </div>
                  <Form.Item name="database" label="Database to open first" extra="Optional. Needed when the user may only use one database.">
                    <Input className="mono" spellCheck={false} maxLength={64} />
                  </Form.Item>
                  <Form.Item label="Share with the team" extra="Off: only you see this connection. On: everyone on the team who may work with data can use it, with this user name and password.">
                    <Form.Item name="shared" valuePropName="checked" noStyle>
                      <Switch />
                    </Form.Item>
                  </Form.Item>
                </>
              )
            },
            {
              key: 'ssh',
              label: useSsh ? 'SSH (on)' : 'SSH',
              forceRender: true,
              children: (
                <>
                  <Form.Item name="useSsh" valuePropName="checked" extra="The app signs in to a server over SSH and reaches the database from there. Use this when the database only listens on its own server, which is the usual and safe setup.">
                    <Checkbox>Use SSH tunnel</Checkbox>
                  </Form.Item>
                  <div style={{ display: useSsh ? undefined : 'none' }}>
                    <Form.Item name="sshFrom">
                      <Segmented block options={[{ value: 'typed', label: 'Enter an SSH server' }, { value: 'server', label: 'Use a saved server' }]} />
                    </Form.Item>
                    <div style={{ display: typed ? 'none' : undefined }}>
                      <Form.Item name="sshProjectId" label="Saved server" rules={[{ required: !!useSsh && !typed, message: 'Pick a server' }]} extra="Its SSH sign-in is used; nothing more to type.">
                        <Select placeholder="Pick a server" options={projects.map((p) => ({ value: p.id, label: `${p.name} (${p.username}@${p.host})` }))} notFoundContent="No saved servers yet" />
                      </Form.Item>
                    </div>
                    <div style={{ display: typed ? undefined : 'none' }}>
                      <div className="form-row">
                        <Form.Item name="sshHost" label="Host" style={{ flex: 1 }} rules={[{ required: !!typed, whitespace: true, message: 'Enter the SSH host' }]}>
                          <Input className="mono" placeholder="203.0.113.10" spellCheck={false} />
                        </Form.Item>
                        <Form.Item name="sshPort" label="Port" style={{ width: 120 }}>
                          <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                        </Form.Item>
                      </div>
                      <div className="form-row">
                        <Form.Item name="sshUsername" label="User name" style={{ flex: 1 }} rules={[{ required: !!typed, whitespace: true, message: 'Enter the SSH user name' }]}>
                          <Input className="mono" placeholder="root" spellCheck={false} autoComplete="off" />
                        </Form.Item>
                        <Form.Item name="sshAuth" label="Authentication method" style={{ flex: 1 }}>
                          <Select options={[{ value: 'password', label: 'Password' }, { value: 'key', label: 'Public key' }]} />
                        </Form.Item>
                      </div>
                      {sshAuth === 'key' ? (
                        <>
                          <Form.Item label="Private key" required={false}>
                            <Form.Item name="sshKey" noStyle rules={[{ required: !!typed && !editing?.hasSshKey, message: 'Paste the private key or load it from a file' }]}>
                              <Input.TextArea className="mono" rows={4} spellCheck={false} placeholder={editing?.hasSshKey ? 'Unchanged. Paste a new key to replace it.' : '-----BEGIN OPENSSH PRIVATE KEY-----'} />
                            </Form.Item>
                            <Button size="small" icon={<FolderOpenOutlined />} style={{ marginTop: 8 }} onClick={() => void loadKey()}>
                              Load from a file
                            </Button>
                          </Form.Item>
                          <Form.Item name="sshPassphrase" label="Passphrase" extra="Only when the key has one.">
                            <Input.Password autoComplete="new-password" />
                          </Form.Item>
                        </>
                      ) : (
                        <Form.Item name="sshPassword" label="Password" rules={[{ required: !!typed && !editing?.hasSshPassword, message: 'Enter the SSH password' }]}>
                          <Input.Password placeholder={keep(editing?.hasSshPassword)} autoComplete="new-password" />
                        </Form.Item>
                      )}
                    </div>
                  </div>
                </>
              )
            }
          ]}
        />
      </Form>
      {result && <Alert type={result.ok ? 'success' : 'error'} showIcon icon={result.ok ? <CheckCircleFilled /> : undefined} message={result.text} style={{ marginTop: 4 }} />}
    </Modal>
  )
}
