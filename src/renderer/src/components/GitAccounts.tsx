import { useState } from 'react'
import { Alert, App as AntApp, Button, Checkbox, Form, Input, Modal, Segmented, Space, Table, Tag } from 'antd'
import { DeleteOutlined, GithubOutlined, PlusOutlined } from '@ant-design/icons'
import type { GitAccount } from '@shared/types'
import { errText } from '../util'

interface Values {
  provider: 'github' | 'other'
  name: string
  username: string
  token: string
  shared: boolean
}

/** Saved sign-ins for Git hosts. A site that uses one deploys a private repository without anyone typing a token. */
export default function GitAccounts({ open, accounts, onClose, onChanged }: { open: boolean; accounts: GitAccount[]; onClose: () => void; onChanged: () => Promise<void> }) {
  const { message, modal } = AntApp.useApp()
  const [editing, setEditing] = useState<GitAccount | 'new' | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm<Values>()
  const provider = Form.useWatch('provider', form) ?? 'github'

  const start = (a: GitAccount | 'new'): void => {
    form.resetFields()
    form.setFieldsValue(a === 'new' ? { provider: 'github', name: '', username: '', token: '', shared: false } : { provider: a.provider, name: a.name, username: a.username === 'git' ? '' : a.username, token: '', shared: a.shared })
    setEditing(a)
  }

  const save = async (): Promise<void> => {
    let v: Values
    try {
      v = await form.validateFields()
    } catch {
      return
    }
    setSaving(true)
    try {
      await window.api.git.save({ id: editing && editing !== 'new' ? editing.id : undefined, name: v.name, username: v.provider === 'github' ? '' : v.username, token: v.token, shared: v.shared, provider: v.provider })
      await onChanged()
      setEditing(null)
      message.success(v.provider === 'github' ? 'GitHub accepted the token. Account saved.' : 'Git account saved')
    } catch (err) {
      message.error(errText(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = (a: GitAccount): void => {
    modal.confirm({
      title: `Remove "${a.name}"?`,
      content: 'Sites that use it will fail to fetch a private repository until you choose another account for them.',
      okText: 'Remove',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.api.git.remove(a.id)
          await onChanged()
        } catch (err) {
          message.error(errText(err))
        }
      }
    })
  }

  return (
    <Modal open={open} title="Git accounts" width={680} onCancel={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        Save an access token once. Sites that use the account fetch their code with it on every deploy; the token is handed to git for that one run and is not stored on the server.
      </p>
      <Table<GitAccount>
        size="middle"
        rowKey="id"
        dataSource={accounts}
        pagination={false}
        locale={{ emptyText: 'No Git accounts yet' }}
        columns={[
          { title: 'Name', render: (_, a) => <b>{a.name}</b> },
          { title: 'Signs in as', render: (_, a) => (a.provider === 'github' ? <span><GithubOutlined /> {a.login ?? a.username}</span> : <span className="mono">{a.username}</span>) },
          { title: 'Who can use it', render: (_, a) => (a.shared ? <Tag color="blue">Whole team</Tag> : <Tag>Only its owner</Tag>) },
          {
            title: '',
            align: 'right',
            render: (_, a) => (
              <Space size={4}>
                <Button size="small" onClick={() => start(a)}>
                  Edit
                </Button>
                <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`Remove ${a.name}`} onClick={() => remove(a)} />
              </Space>
            )
          }
        ]}
      />
      <Button type="primary" icon={<PlusOutlined />} style={{ marginTop: 14 }} onClick={() => start('new')}>
        Add a Git account
      </Button>

      <Modal open={!!editing} title={editing === 'new' ? 'Add a Git account' : 'Edit Git account'} okText="Save" confirmLoading={saving} onCancel={() => setEditing(null)} onOk={() => void save()} destroyOnClose>
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="provider" label="Git host">
            <Segmented
              options={[
                { value: 'github', label: 'GitHub', icon: <GithubOutlined /> },
                { value: 'other', label: 'Other (GitLab, Bitbucket, Gitea...)' }
              ]}
            />
          </Form.Item>
          <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true, message: 'Give it a name' }]}>
            <Input placeholder="Company GitHub" autoFocus />
          </Form.Item>
          <Form.Item
            name="token"
            label="Access token"
            rules={[{ required: editing === 'new', message: 'Paste the access token' }]}
            extra={
              editing !== 'new' ? (
                'Leave empty to keep the saved token.'
              ) : provider === 'github' ? (
                <span>
                  On GitHub: Settings, Developer settings, Personal access tokens, Fine-grained tokens. Give it "Contents: Read-only" on the repositories you deploy.{' '}
                  <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
                    Open that page
                  </a>
                </span>
              ) : (
                'Create one on your Git host with read access to the repositories.'
              )
            }
          >
            <Input.Password autoComplete="off" spellCheck={false} placeholder={editing !== 'new' ? 'Saved' : provider === 'github' ? 'github_pat_... or ghp_...' : 'glpat-...'} />
          </Form.Item>
          {provider === 'other' && (
            <Form.Item name="username" label="Sign-in name (optional)" extra="GitLab: oauth2. Bitbucket: your Bitbucket username.">
              <Input className="mono" spellCheck={false} placeholder="git" />
            </Form.Item>
          )}
          <Form.Item name="shared" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Checkbox>Let the whole team deploy with this account</Checkbox>
          </Form.Item>
          <Alert type="info" showIcon message="Use a token that can only read the repositories you deploy. Anyone you share it with receives the token in their app." />
        </Form>
      </Modal>
    </Modal>
  )
}
