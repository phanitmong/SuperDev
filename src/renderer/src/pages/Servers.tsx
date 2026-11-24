import { useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Dropdown, Form, Input, InputNumber, Modal, Radio, Segmented, Select, Space, Spin, Tag } from 'antd'
import { AppstoreAddOutlined, ClusterOutlined, FolderOutlined, CloudServerOutlined, DeleteOutlined, EllipsisOutlined, FolderOpenOutlined, LockOutlined, PlusOutlined, TeamOutlined } from '@ant-design/icons'
import type { SessionUser, TeamMember } from '@shared/team'
import { ROLE_LABELS } from '@shared/team'
import type { ConnState, GroupMember, GroupNfs, GroupRole, Project, ProjectInput, ServerGroup, ServerGroupInput } from '@shared/types'
import { JobDrawer, useJob } from '../components/JobLog'
import { ROLES, ROLE_OF, placesOf, sortMembers } from '../groupRoles'
import { SERVER_COLORS, errText, cssUrl } from '../util'
import bannerArt from '../assets/banner-art.png'
import welcomeUrl from '../assets/welcome.png'

interface Props {
  projects: Project[]
  groups: ServerGroup[]
  states: Record<string, ConnState>
  loaded: boolean
  me: SessionUser
  /** Viewers cannot add servers. */
  canAdd: boolean
  onChanged: () => Promise<void>
  onOpen: (id: string) => void
  /** Show one project's servers side by side. */
  onOpenGroup: (id: string) => void
}

interface FormValues {
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  password?: string
  privateKey?: string
  passphrase?: string
  note?: string
  shareMode: 'private' | 'team' | 'members'
  members: string[]
}

export default function Servers({ projects, groups, states, loaded, me, canAdd, onChanged, onOpen, onOpenGroup }: Props) {
  const { message, modal } = AntApp.useApp()
  const [editing, setEditing] = useState<Project | 'new' | null>(null)
  const [editingGroup, setEditingGroup] = useState<ServerGroup | 'new' | null>(null)
  const [view, setView] = useState<'projects' | 'servers'>(() => (localStorage.getItem('serversView') === 'servers' ? 'servers' : 'projects'))
  const showView = (v: 'projects' | 'servers'): void => {
    setView(v)
    localStorage.setItem('serversView', v)
  }
  const places = placesOf(groups)
  const loose = projects.filter((p) => !places.has(p.id))

  // Read the project again first: another page (NFS) may have changed it, and saving an old copy would undo that.
  const editGroup = async (g: ServerGroup): Promise<void> => {
    try {
      setEditingGroup((await window.api.groups.list()).find((x) => x.id === g.id) ?? g)
    } catch {
      setEditingGroup(g)
    }
  }

  const removeGroup = (g: ServerGroup): void => {
    modal.confirm({
      title: `Remove the project "${g.name}"?`,
      content: 'Only the grouping is removed. The servers, their sites and everything on them stay.',
      okText: 'Remove project',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.api.groups.remove(g.id)
          await onChanged()
        } catch (err) {
          message.error(errText(err))
        }
      }
    })
  }

  const remove = (p: Project): void => {
    modal.confirm({
      title: `Remove "${p.name}"?`,
      content: 'This removes the saved connection and its site list from Apsara Panel. Nothing on the server is changed.',
      okText: 'Remove server',
      okButtonProps: { danger: true },
      onOk: async () => {
        await window.api.projects.remove(p.id)
        await onChanged()
      }
    })
  }

  const forget = async (p: Project): Promise<void> => {
    try {
      await window.api.projects.forgetHostKey(p.id)
      await onChanged()
      message.success('Host key forgotten. The next connection will save the new key.')
    } catch (err) {
      message.error(errText(err))
    }
  }

  if (!loaded) {
    return (
      <div className="empty">
        <Spin />
      </div>
    )
  }

  return (
    <>
      <div className="banner" style={{ backgroundImage: `${cssUrl(bannerArt)}, linear-gradient(100deg, #12175a 0%, #2a2192 55%, #5a3fc6 100%)`, backgroundRepeat: 'no-repeat', backgroundSize: 'auto 230px, cover', backgroundPosition: 'right 190px top -10px, center' }}>
        <div>
          <div className="banner-title">Projects and servers</div>
          <div className="banner-sub">
            {projects.length === 0
              ? 'Deploy, protect and watch your servers from one place.'
              : `${groups.length ? `${groups.length} project${groups.length === 1 ? '' : 's'} · ` : ''}${projects.length} server${projects.length === 1 ? '' : 's'} · ${Object.values(states).filter((s) => s === 'connected').length} connected`}
          </div>
        </div>
        {projects.length > 0 && canAdd && (
          <Space>
            <Button size="large" icon={<AppstoreAddOutlined />} onClick={() => setEditingGroup('new')}>
              New project
            </Button>
            <Button size="large" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
              Add server
            </Button>
          </Space>
        )}
      </div>
      {projects.length > 0 && (
        <div className="servers-tabs">
          <Segmented
            value={view}
            onChange={(v) => showView(v as 'projects' | 'servers')}
            options={[
              { value: 'projects', label: `Projects${groups.length ? ` (${groups.length})` : ''}` },
              { value: 'servers', label: `All servers (${projects.length})` }
            ]}
          />
          {view === 'projects' && <span style={{ fontSize: 13, color: 'var(--muted)' }}>A project groups the servers of one system (frontend, API, load balancer, database). A server can be in several projects.</span>}
        </div>
      )}
      {projects.length > 0 && view === 'projects' && (
        <>
          {groups.length === 0 ? (
            <div className="card empty" style={{ marginBottom: 16 }}>
              <div>
                <h3>No projects yet</h3>
                <div style={{ maxWidth: 480, margin: '0 auto 16px' }}>Group the servers that run one system, for example demo: a frontend, two APIs behind a load balancer and a database. Then see them side by side and open each one from there.</div>
                {canAdd && (
                  <Button type="primary" icon={<AppstoreAddOutlined />} onClick={() => setEditingGroup('new')}>
                    New project
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="grid cols-3" style={{ marginBottom: 16 }}>
              {groups.map((g, gi) => {
                const members = sortMembers(g.members)
                const up = new Set(g.members.filter((m) => states[m.projectId] === 'connected').map((m) => m.projectId)).size
                const count = new Set(g.members.map((m) => m.projectId)).size
                const mine = g.ownerId === me.id || me.role === 'admin'
                return (
                  <div key={g.id} className="card group-card" style={{ ['--group-color' as string]: g.color ?? SERVER_COLORS[gi % SERVER_COLORS.length] }} role="button" tabIndex={0} onClick={() => onOpenGroup(g.id)} onKeyDown={(e) => e.key === 'Enter' && onOpenGroup(g.id)}>
                    <div className="group-head">
                      <div className="server-icon" style={{ background: g.color ?? SERVER_COLORS[gi % SERVER_COLORS.length] }}>
                        <ClusterOutlined />
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="server-name">{g.name}</div>
                        <div className="server-meta" style={{ whiteSpace: 'normal' }}>
                          {count} server{count === 1 ? '' : 's'} · {up} connected · {g.shared ? <><TeamOutlined /> Whole team</> : <><LockOutlined /> Only me</>}
                        </div>
                      </div>
                      {mine && canAdd && (
                        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                          <Dropdown
                            trigger={['click']}
                            menu={{
                              items: [
                                { key: 'edit', label: 'Edit project' },
                                { type: 'divider' },
                                { key: 'remove', label: 'Remove project', danger: true }
                              ],
                              onClick: ({ key }) => {
                                if (key === 'edit') void editGroup(g)
                                if (key === 'remove') removeGroup(g)
                              }
                            }}
                          >
                            <Button type="text" icon={<EllipsisOutlined />} aria-label={`Options for ${g.name}`} />
                          </Dropdown>
                        </span>
                      )}
                    </div>
                    {g.note && <div className="server-meta">{g.note}</div>}
                    {g.nfs && g.nfs.length > 0 && (
                      <div className="server-meta">
                        <FolderOutlined /> {g.nfs.map((n) => n.local).join(', ')} shared over NFS
                      </div>
                    )}
                    <div className="group-members">
                      {members.length === 0 && <div className="server-meta">No servers you can use are in this project.</div>}
                      {members.map((m) => {
                        const p = projects.find((x) => x.id === m.projectId)
                        if (!p) return null
                        return (
                          <div
                            key={`${m.projectId}:${m.role}`}
                            className="group-row"
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation()
                              onOpen(p.id)
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.stopPropagation()
                                onOpen(p.id)
                              }
                            }}
                            title={`Open ${p.name}`}
                          >
                            <Tag color={ROLE_OF[m.role].color}>{ROLE_OF[m.role].label}</Tag>
                            <span className="group-server">
                              {p.name}
                              {m.label && <small>{m.label}</small>}
                            </span>
                            <i className={`group-dot ${states[p.id] ?? ''}`} />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
              {canAdd && (
                <button className="add-card" onClick={() => setEditingGroup('new')}>
                  <span>
                    <AppstoreAddOutlined /> New project
                  </span>
                </button>
              )}
            </div>
          )}
          {groups.length > 0 && loose.length > 0 && (
            <div className="server-meta" style={{ marginBottom: 10 }}>
              In no project yet: {loose.map((p) => p.name).join(', ')}
            </div>
          )}
        </>
      )}
      {projects.length === 0 ? (
        <div className="card empty">
          <div>
            <img className="welcome-art" src={welcomeUrl} alt="" />
            {canAdd ? (
              <>
                <h3>Add your first server</h3>
                <div style={{ maxWidth: 440, margin: '0 auto 18px' }}>
                  Each server is managed over SSH. Its password or key is kept encrypted on your Apsara Panel service and handed only to the people you share the server with.
            </div>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
                  Add server
                </Button>
              </>
            ) : (
              <>
                <h3>No servers assigned to you yet</h3>
                <div style={{ maxWidth: 420, margin: '0 auto' }}>Ask an admin to give your account access to the servers you work on.</div>
              </>
            )}
          </div>
        </div>
      ) : view === 'servers' ? (
        <div className="grid cols-3">
          {projects.map((p, i) => {
            const state = states[p.id] ?? 'disconnected'
            return (
              <div
                key={p.id}
                className="card server-card"
                role="button"
                tabIndex={0}
                onClick={() => onOpen(p.id)}
                onKeyDown={(e) => e.key === 'Enter' && onOpen(p.id)}
              >
                <div className="server-head">
                  <div className="server-icon" style={{ background: p.color ?? SERVER_COLORS[i % SERVER_COLORS.length] }}>
                    <CloudServerOutlined />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="server-name">{p.name}</div>
                    <div className="server-meta mono">
                      {p.username}@{p.host}
                      {p.port !== 22 ? `:${p.port}` : ''}
                    </div>
                  </div>
                  {(p.ownerId === me.id || me.role === 'admin') && (
                  <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: [
                          { key: 'edit', label: 'Edit and share' },
                          { key: 'forget', label: 'Forget host key', disabled: !p.hostFingerprint },
                          { type: 'divider' },
                          { key: 'remove', label: 'Remove server', danger: true }
                        ],
                        onClick: ({ key }) => {
                          if (key === 'edit') setEditing(p)
                          if (key === 'forget') void forget(p)
                          if (key === 'remove') remove(p)
                        }
                      }}
                    >
                      <Button type="text" icon={<EllipsisOutlined />} aria-label={`Options for ${p.name}`} />
                    </Dropdown>
                  </span>
                  )}
                </div>
                <div className="server-foot">
                  <span className={`status-pill ${state}`}>
                    <i />
                    {state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting' : 'Offline'}
                  </span>
                  <span className="server-meta">
                    {p.share.mode === 'private' ? (
                      <>
                        <LockOutlined /> Only me
                      </>
                    ) : p.share.mode === 'team' ? (
                      <>
                        <TeamOutlined /> Whole team
                      </>
                    ) : (
                      <>
                        <TeamOutlined /> {p.share.members.length} {p.share.members.length === 1 ? 'person' : 'people'}
                        {p.ownerId && p.ownerId !== me.id ? '' : ' + me'}
                      </>
                    )}
                  </span>
                </div>
                {p.note && (
                  <div className="server-meta" style={{ marginTop: 10 }}>
                    {p.note}
                  </div>
                )}
                {places.has(p.id) && (
                  <div className="dash-roles" style={{ marginTop: 10 }}>
                    {places.get(p.id)!.map(({ group, member }) => (
                      <Tag key={`${group.id}:${member.role}`} color={ROLE_OF[member.role].color}>
                        {group.name} · {ROLE_OF[member.role].label}
                      </Tag>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {canAdd && (
            <button className="add-card" onClick={() => setEditing('new')}>
              <span>
                <PlusOutlined /> Add server
              </span>
            </button>
          )}
        </div>
      ) : null}

      {editingGroup && (
        <GroupModal
          group={editingGroup === 'new' ? null : editingGroup}
          projects={projects}
          color={SERVER_COLORS[groups.length % SERVER_COLORS.length]}
          onClose={() => setEditingGroup(null)}
          onSaved={async () => {
            setEditingGroup(null)
            await onChanged()
          }}
        />
      )}

      {editing && (
        <ProjectModal
          project={editing === 'new' ? null : editing}
          color={SERVER_COLORS[projects.length % SERVER_COLORS.length]}
          me={me}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await onChanged()
          }}
        />
      )}
    </>
  )
}

function ProjectModal({
  project,
  color,
  me,
  onClose,
  onSaved
}: {
  project: Project | null
  color: string
  me: SessionUser
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { message } = AntApp.useApp()
  const [form] = Form.useForm<FormValues>()
  const authType = Form.useWatch('authType', form) ?? project?.authType ?? 'password'
  const shareMode = Form.useWatch('shareMode', form) ?? project?.share.mode ?? 'private'
  const [team, setTeam] = useState<TeamMember[]>([])
  useEffect(() => {
    window.api.users
      .directory()
      .then((list) => setTeam(list.filter((m) => m.id !== me.id)))
      .catch(() => setTeam([]))
  }, [me.id])
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const toInput = (v: FormValues): ProjectInput => ({
    id: project?.id,
    name: v.name,
    host: v.host,
    port: v.port,
    username: v.username,
    authType: v.authType,
    password: v.password,
    privateKey: v.authType === 'key' ? v.privateKey : undefined,
    passphrase: v.authType === 'key' ? v.passphrase : undefined,
    note: v.note,
    color: project?.color ?? color,
    share: { mode: v.shareMode, members: v.shareMode === 'members' ? (v.members ?? []) : [] }
  })

  const test = async (): Promise<void> => {
    let values: FormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    setTesting(true)
    setResult(null)
    try {
      const r = await window.api.projects.test(toInput(values))
      setResult({ ok: true, text: `Connected as ${r.user} · ${r.system}` })
    } catch (err) {
      setResult({ ok: false, text: errText(err) })
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    let values: FormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    setSaving(true)
    try {
      await window.api.projects.save(toInput(values))
      await onSaved()
    } catch (err) {
      message.error(errText(err))
    } finally {
      setSaving(false)
    }
  }

  const loadKey = async (): Promise<void> => {
    try {
      const key = await window.api.projects.readKeyFile()
      if (key) form.setFieldValue('privateKey', key)
    } catch (err) {
      message.error(errText(err))
    }
  }

  const needPassword = authType === 'password' && !project?.hasPassword
  const needKey = authType === 'key' && !project?.hasPrivateKey

  return (
    <Modal
      open
      title={project ? 'Edit server' : 'Add server'}
      onCancel={onClose}
      width={560}
      centered
      styles={{ body: { maxHeight: 'calc(100vh - 210px)', overflowY: 'auto', paddingRight: 6 } }}
      maskClosable={false}
      footer={
        <Space>
          <Button onClick={test} loading={testing}>
            Test connection
          </Button>
          <Button type="primary" onClick={save} loading={saving}>
            {project ? 'Save changes' : 'Save server'}
          </Button>
        </Space>
      }
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{
          name: project?.name ?? '',
          host: project?.host ?? '',
          port: project?.port ?? 22,
          username: project?.username ?? 'root',
          authType: project?.authType ?? 'password',
          note: project?.note ?? '',
          shareMode: project?.share.mode ?? 'private',
          members: project?.share.members ?? []
        }}
      >
        <Form.Item name="name" label="Server name" rules={[{ required: true, message: 'Give the server a name' }]}>
          <Input placeholder="e.g. Production web" autoFocus />
        </Form.Item>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 12 }}>
          <Form.Item name="host" label="Host or IP" rules={[{ required: true, message: 'Enter the host or IP' }]}>
            <Input placeholder="203.0.113.10" spellCheck={false} />
          </Form.Item>
          <Form.Item name="port" label="SSH port" rules={[{ required: true, message: 'Enter a port' }]}>
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
        </div>
        <Form.Item name="username" label="Username" rules={[{ required: true, message: 'Enter the SSH username' }]}>
          <Input spellCheck={false} />
        </Form.Item>
        <Form.Item name="authType" label="Sign in with">
          <Segmented
            options={[
              { value: 'password', label: 'Password' },
              { value: 'key', label: 'SSH key' }
            ]}
          />
        </Form.Item>

        {authType === 'password' ? (
          <Form.Item
            name="password"
            label="Password"
            rules={[{ required: needPassword, message: 'Enter the password' }]}
            extra={project?.hasPassword ? 'Leave empty to keep the saved password.' : undefined}
          >
            <Input.Password autoComplete="off" />
          </Form.Item>
        ) : (
          <>
            <Form.Item
              label="Private key"
              extra={project?.hasPrivateKey ? 'Leave empty to keep the saved key.' : undefined}
              style={{ marginBottom: 12 }}
            >
              <Form.Item name="privateKey" noStyle rules={[{ required: needKey, message: 'Paste a private key or load one from a file' }]}>
                <Input.TextArea
                  rows={4}
                  className="mono"
                  spellCheck={false}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  style={{ fontSize: 12 }}
                />
              </Form.Item>
              <Button size="small" icon={<FolderOpenOutlined />} onClick={loadKey} style={{ marginTop: 8 }}>
                Load from file
              </Button>
            </Form.Item>
            <Form.Item name="passphrase" label="Key passphrase (if the key has one)">
              <Input.Password autoComplete="off" />
            </Form.Item>
            <Form.Item
              name="password"
              label="sudo password (optional)"
              extra="Only needed when this user is not root and sudo asks for a password. Used for deploys."
            >
              <Input.Password autoComplete="off" />
            </Form.Item>
          </>
        )}

        <Form.Item name="note" label="Note (optional)">
          <Input placeholder="What runs on this server" />
        </Form.Item>
        <Form.Item
          name="shareMode"
          label="Who can use this server"
          extra={
            shareMode === 'private'
              ? 'Nobody else sees it, not even admins.'
              : shareMode === 'team'
                ? 'Everyone with an account, including people who join later. What each person can do still depends on their role.'
                : 'Only the people you pick, plus admins. What each person can do still depends on their role.'
          }
        >
          <Radio.Group
            options={[
              { value: 'private', label: 'Only me' },
              { value: 'team', label: 'Whole team' },
              { value: 'members', label: 'Chosen people' }
            ]}
          />
        </Form.Item>
        {shareMode === 'members' && (
          <Form.Item name="members" rules={[{ required: true, type: 'array', min: 1, message: 'Pick at least one person' }]}>
            <Select
              mode="multiple"
              placeholder="Pick people"
              optionFilterProp="label"
              options={team.map((m) => ({ value: m.id, label: `${m.displayName} (${ROLE_LABELS[m.role]})` }))}
              dropdownRender={(menu) => (
                <>
                  <div style={{ padding: '4px 8px 8px', borderBottom: '1px solid var(--line)', marginBottom: 4 }}>
                    <Button size="small" type="link" onClick={() => form.setFieldValue('members', team.map((m) => m.id))}>
                      Select everyone
                    </Button>
                    <Button size="small" type="link" onClick={() => form.setFieldValue('members', [])}>
                      Clear
                    </Button>
                  </div>
                  {menu}
                </>
              )}
            />
          </Form.Item>
        )}
        {shareMode !== 'private' && (
          <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Sharing hands this server's SSH login to those people's apps. Share only with people you would trust with that login." />
        )}
      </Form>
      {result && <Alert type={result.ok ? 'success' : 'error'} message={result.text} showIcon />}
    </Modal>
  )
}

function GroupModal({ group, projects, color, onClose, onSaved }: { group: ServerGroup | null; projects: Project[]; color: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const { message } = AntApp.useApp()
  const [name, setName] = useState(group?.name ?? '')
  const [note, setNote] = useState(group?.note ?? '')
  const [shared, setShared] = useState(group?.shared ?? true)
  const [members, setMembers] = useState<GroupMember[]>(() => (group ? sortMembers(group.members) : []))
  const [rules, setRules] = useState<GroupNfs[]>(group?.nfs ?? [])
  const job = useJob(`nfsgroup:${group?.id ?? 'new'}`)
  const nameOf = (id: string): string => projects.find((p) => p.id === id)?.name ?? 'a server you cannot see'

  const [saving, setSaving] = useState(false)
  const [tried, setTried] = useState(false)

  const update = (i: number, patch: Partial<GroupMember>): void => setMembers((list) => list.map((m, j) => (j === i ? { ...m, ...patch } : m)))
  const add = (): void => {
    const used = new Set(members.map((m) => m.projectId))
    const next = projects.find((p) => !used.has(p.id)) ?? projects[0]
    setMembers((list) => [...list, { projectId: next?.id ?? '', role: list.length === 0 ? 'frontend' : 'api' }])
  }
  const dup = new Set<string>()
  const seen = new Set<string>()
  for (const m of members) {
    const k = `${m.projectId}:${m.role}`
    if (seen.has(k)) dup.add(k)
    seen.add(k)
  }

  const save = async (): Promise<void> => {
    setTried(true)
    if (!name.trim() || dup.size > 0 || members.some((m) => !m.projectId)) return
    setSaving(true)
    try {
      const input: ServerGroupInput = { id: group?.id, name: name.trim(), note: note.trim() || undefined, color: group?.color ?? color, shared, nfs: rules, members: members.map((m) => ({ projectId: m.projectId, role: m.role, label: m.label?.trim() || undefined })) }
      await window.api.groups.save(input)
      message.success(`${input.name} saved`)
      await onSaved()
    } catch (err) {
      message.error(errText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      title={group ? `Edit project ${group.name}` : 'New project'}
      onCancel={onClose}
      width={640}
      centered
      maskClosable={false}
      okText={group ? 'Save changes' : 'Save project'}
      confirmLoading={saving}
      onOk={() => void save()}
      styles={{ body: { maxHeight: 'calc(100vh - 210px)', overflowY: 'auto', paddingRight: 6 } }}
    >
      <Form layout="vertical" requiredMark={false}>
        <Form.Item label="Project name" validateStatus={tried && !name.trim() ? 'error' : undefined} help={tried && !name.trim() ? 'Give the project a name' : undefined}>
          <Input id="groupName" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. demo" autoFocus maxLength={80} />
        </Form.Item>
        <Form.Item label="Note (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What this system is" maxLength={500} />
        </Form.Item>
        <Form.Item label="Servers and their roles" extra="Add the same server twice to give it two roles, for example Frontend and API on one machine. The label tells servers of the same role apart (api-1, api-2, primary).">
          {members.map((m, i) => {
            const bad = dup.has(`${m.projectId}:${m.role}`)
            return (
              <div key={i} className="member-edit">
                <Select
                  value={m.projectId || undefined}
                  status={bad || (tried && !m.projectId) ? 'error' : undefined}
                  placeholder="Server"
                  showSearch
                  optionFilterProp="label"
                  onChange={(v) => update(i, { projectId: v })}
                  options={projects.map((p) => ({ value: p.id, label: `${p.name} (${p.host})` }))}
                  aria-label="Server"
                />
                <Select value={m.role} status={bad ? 'error' : undefined} onChange={(v) => update(i, { role: v as GroupRole })} options={ROLES.map((r) => ({ value: r.key, label: r.label }))} aria-label="Role" />
                <Input value={m.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="Label" maxLength={40} aria-label="Label" />
                <Button type="text" icon={<DeleteOutlined />} onClick={() => setMembers((list) => list.filter((_, j) => j !== i))} aria-label="Take out of the project" />
              </div>
            )
          })}
          {dup.size > 0 && <div style={{ color: '#f04438', fontSize: 13, marginBottom: 8 }}>A server is listed twice with the same role.</div>}
          <Button icon={<PlusOutlined />} onClick={add} disabled={projects.length === 0}>
            Add a server
          </Button>
        </Form.Item>
        {rules.length > 0 && (
          <Form.Item label="Shared folders (NFS)" extra="Mounted on the project's servers, and by itself on servers added later. Taking a rule out stops that; folders already mounted stay until unmounted on each server's NFS page.">
            {rules.map((r) => (
              <div key={r.id} className="group-row" style={{ gridTemplateColumns: '1fr auto' }}>
                <span className="group-server">
                  <FolderOutlined /> <b>{nameOf(r.serverId)}</b>:<span className="mono">{r.path}</span> → <span className="mono">{r.local}</span>
                  <small>{r.roles.length ? r.roles.map((x) => ROLE_OF[x].label).join(', ') : 'every server'}{r.readOnly ? ' · read only' : ''}</small>
                </span>
                <Space size={4}>
                  {group && (
                    <Button size="small" onClick={() => void job.run(`Mount ${r.path} on project ${group.name}`, () => window.api.nfs.groupSync(group.id, r.id))}>
                      Mount now
                    </Button>
                  )}
                  <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => setRules((list) => list.filter((x) => x.id !== r.id))} aria-label="Take the rule out" />
                </Space>
              </div>
            ))}
          </Form.Item>
        )}
        <Form.Item label="Who sees this project" extra="Who can use each server is still set on the server: people see only the servers shared with them.">
          <Radio.Group
            value={shared ? 'team' : 'private'}
            onChange={(e) => setShared(e.target.value === 'team')}
            options={[
              { value: 'team', label: 'Whole team' },
              { value: 'private', label: 'Only me' }
            ]}
          />
        </Form.Item>
      </Form>
      <JobDrawer job={job} />
    </Modal>
  )
}
