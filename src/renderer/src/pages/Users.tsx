import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Dropdown, Form, Input, Modal, Select, Space, Spin, Switch, Table, Tag, Typography } from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { Role, SessionUser, TeamUser, TeamUserInput } from '@shared/team'
import { ROLE_LABELS, ROLE_SUMMARY } from '@shared/team'
import type { Project } from '@shared/types'
import { ago, errText } from '../util'
import Protection from '../components/Protection'

const ROLE_COLOR: Record<Role, string> = { admin: 'red', developer: 'blue', it_support: 'purple', viewer: 'default' }
const ROLES = Object.keys(ROLE_LABELS) as Role[]

interface FormValues {
  username: string
  displayName: string
  role: Role
  allServers: boolean
  projects: string[]
}

export default function Users({ me, projects }: { me: SessionUser; projects: Project[] }) {
  const { message, modal } = AntApp.useApp()
  const [users, setUsers] = useState<TeamUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<TeamUser | 'new' | null>(null)
  const [secret, setSecret] = useState<{ title: string; username: string; password: string } | null>(null)
  const [form] = Form.useForm<FormValues>()
  const role = (Form.useWatch('role', form) ?? 'developer') as Role
  const allServers = Form.useWatch('allServers', form) ?? true

  const load = useCallback(async () => {
    try {
      setUsers(await window.api.users.list())
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const open = (u: TeamUser | 'new'): void => {
    setEditing(u)
    form.setFieldsValue(
      u === 'new'
        ? { username: '', displayName: '', role: 'developer', allServers: true, projects: [] }
        : { username: u.username, displayName: u.displayName, role: u.role, allServers: u.projects === null, projects: u.projects ?? [] }
    )
  }

  const save = async (): Promise<void> => {
    let v: FormValues
    try {
      v = await form.validateFields()
    } catch {
      return
    }
    const input: TeamUserInput = {
      id: editing !== 'new' ? editing?.id : undefined,
      username: v.username,
      displayName: v.displayName,
      role: v.role,
      disabled: editing !== 'new' ? !!editing?.disabled : false,
      projects: null
    }
    try {
      if (editing === 'new') {
        const res = await window.api.users.create(input)
        setSecret({ title: 'Account created', username: res.user.username, password: res.password })
      } else {
        await window.api.users.update(input)
        message.success('Account updated')
      }
      setEditing(null)
      await load()
    } catch (err) {
      message.error(errText(err))
    }
  }

  const quick = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    try {
      await fn()
      message.success(done)
    } catch (err) {
      message.error(errText(err))
    }
    await load()
  }

  const confirm = (title: string, content: string, okText: string, onOk: () => Promise<void>, danger = true): void => {
    modal.confirm({ title, content, okText, okButtonProps: { danger }, onOk })
  }

  const actions = (u: TeamUser): { key: string; label: string; danger?: boolean; disabled?: boolean }[] => [
    { key: 'edit', label: 'Edit role and servers' },
    { key: 'password', label: 'Reset password' },
    { key: '2fa', label: 'Reset authenticator', disabled: !u.twoFactor },
    ...(u.locked ? [{ key: 'unlock', label: 'Unlock' }] : []),
    { key: 'toggle', label: u.disabled ? 'Enable account' : 'Disable account', disabled: u.id === me.id },
    { key: 'remove', label: 'Delete account', danger: true, disabled: u.id === me.id }
  ]

  const act = (u: TeamUser, key: string): void => {
    if (key === 'edit') open(u)
    if (key === 'unlock') void quick(() => window.api.users.unlock(u.id), `${u.username} unlocked`)
    if (key === 'password') {
      confirm(`Reset the password of ${u.username}?`, 'They are signed out everywhere and get a temporary password that must be changed at next sign-in.', 'Reset password', async () => {
        try {
          const res = await window.api.users.resetPassword(u.id)
          setSecret({ title: 'Password reset', username: res.username, password: res.password })
        } catch (err) {
          message.error(errText(err))
        }
        await load()
      })
    }
    if (key === '2fa') {
      confirm(`Reset the authenticator of ${u.username}?`, 'Use this when they lost or changed their phone. They are signed out and set up Google Authenticator again at next sign-in.', 'Reset authenticator', () =>
        quick(() => window.api.users.resetTwoFactor(u.id), 'Authenticator reset')
      )
    }
    if (key === 'toggle') {
      if (u.disabled) void quick(() => window.api.users.update({ ...u, disabled: false }), `${u.username} enabled`)
      else confirm(`Disable ${u.username}?`, 'They are signed out at once and cannot sign in until you enable the account again.', 'Disable account', () => quick(() => window.api.users.update({ ...u, disabled: true }), `${u.username} disabled`))
    }
    if (key === 'remove') confirm(`Delete ${u.username}?`, 'The account is removed. What they did stays in the audit log.', 'Delete account', () => quick(() => window.api.users.remove(u.id), 'Account deleted'))
  }

  if (error) {
    return (
      <div className="card">
        <Alert type="error" showIcon message="Could not load the accounts" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
      </div>
    )
  }
  if (!users) {
    return (
      <div className="empty">
        <Spin />
      </div>
    )
  }

  return (
    <div className="grid">
      <div className="card">
        <div className="card-title">
          Team accounts
          <Space>
            <Button size="small" type="text" icon={<ReloadOutlined />} aria-label="Refresh" onClick={() => void load()} />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')}>
              New account
            </Button>
          </Space>
        </div>
        <Table<TeamUser>
          rowKey="id"
          size="middle"
          pagination={false}
          dataSource={users}
          columns={[
            {
              title: 'Person',
              render: (_, u) => (
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {u.displayName} {u.id === me.id && <Tag style={{ marginInlineStart: 4 }}>You</Tag>}
                  </div>
                  <div className="mono" style={{ color: 'var(--muted)', fontSize: 12 }}>
                    {u.username}
                  </div>
                </div>
              )
            },
            { title: 'Role', render: (_, u) => <Tag color={ROLE_COLOR[u.role]}>{ROLE_LABELS[u.role]}</Tag> },
            {
              title: 'Status',
              render: (_, u) => (
                <Space size={4} wrap>
                  {u.disabled ? <Tag color="red">Disabled</Tag> : u.locked ? <Tag color="orange">Locked</Tag> : <Tag color="green">Active</Tag>}
                  {!u.twoFactor && <Tag>Authenticator not set up</Tag>}
                  {u.mustChangePassword && <Tag>Temporary password</Tag>}
                </Space>
              )
            },
            { title: 'Last sign-in', render: (_, u) => (u.lastLoginAt ? ago(u.lastLoginAt) : <span style={{ color: 'var(--muted)' }}>Never</span>) },
            {
              title: '',
              align: 'right',
              render: (_, u) => (
                <Dropdown trigger={['click']} menu={{ items: actions(u), onClick: ({ key }) => act(u, key) }}>
                  <Button aria-label={`Actions for ${u.username}`}>Manage</Button>
                </Dropdown>
              )
            }
          ]}
        />
      </div>

      <Protection />

      <div className="card">
        <div className="card-title">What each role can do</div>
        <dl className="kv" style={{ gridTemplateColumns: '110px minmax(0, 1fr)', rowGap: 12 }}>
          {ROLES.map((r) => (
            <div key={r} style={{ display: 'contents' }}>
              <dt>
                <Tag color={ROLE_COLOR[r]}>{ROLE_LABELS[r]}</Tag>
              </dt>
              <dd style={{ whiteSpace: 'normal' }}>{ROLE_SUMMARY[r]}</dd>
            </div>
          ))}
        </dl>
      </div>

      <Modal open={!!editing} title={editing === 'new' ? 'New account' : `Edit ${editing?.username ?? ''}`} okText={editing === 'new' ? 'Create account' : 'Save'} onOk={() => void save()} onCancel={() => setEditing(null)} width={540} destroyOnClose>
        <Form form={form} layout="vertical" requiredMark={false}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Form.Item
              name="username"
              label="Username"
              rules={[
                { required: true, message: 'Enter a username' },
                { pattern: /^[a-z0-9][a-z0-9._-]{2,31}$/, message: '3-32 characters: a-z, 0-9, dot, dash, underscore' }
              ]}
            >
              <Input disabled={editing !== 'new'} spellCheck={false} placeholder="sokha" autoComplete="off" />
            </Form.Item>
            <Form.Item name="displayName" label="Full name" rules={[{ required: true, message: 'Enter their name' }]}>
              <Input placeholder="Sokha Chan" />
            </Form.Item>
          </div>
          <Form.Item name="role" label="Role" extra={ROLE_SUMMARY[role]}>
            <Select options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
          </Form.Item>
          <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Which servers a person can use is decided on each server (Projects, Edit and share), not here." />
          {editing === 'new' && <Alert type="info" showIcon message="A temporary password is created. At first sign-in they set up Google Authenticator and choose their own password." />}
        </Form>
      </Modal>

      <Modal open={!!secret} title={secret?.title} footer={<Button type="primary" onClick={() => setSecret(null)}>Done</Button>} onCancel={() => setSecret(null)}>
        <Alert type="warning" showIcon style={{ marginBottom: 14 }} message="Give this temporary password to the person in a safe way. It is shown only once." />
        <dl className="kv">
          <dt>Username</dt>
          <dd className="mono">{secret?.username}</dd>
          <dt>Password</dt>
          <dd>
            <Typography.Text className="mono" copyable>
              {secret?.password}
            </Typography.Text>
          </dd>
        </dl>
      </Modal>
    </div>
  )
}
