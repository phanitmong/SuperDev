import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Checkbox, Form, Input, Modal, Radio, Select, Space, Spin, Table, Tag, Typography } from 'antd'
import { ApiOutlined, ClusterOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { GroupRole, NfsMount, NfsOverview, NfsOwner, NfsShare, Project, ServerGroup } from '@shared/types'
import { ROLES, ROLE_OF } from '../groupRoles'
import FolderInput from '../components/FolderPicker'
import { JobDrawer, runTask, useJob } from '../components/JobLog'
import { bytes, errText } from '../util'

const OWNER_WORDS: Record<NfsOwner, string> = {
  keep: 'Keep owners',
  web: 'Web server (www-data)',
  root: 'Root stays root'
}
const OWNER_HELP: Record<NfsOwner, string> = {
  keep: 'Files keep the owner of whoever writes them; root on the other server acts as a guest. The safe choice.',
  web: 'Every file written by the other servers belongs to the web server user. Best for shared uploads of PHP or Node sites.',
  root: 'Root on the other servers is root here too. Only for servers you trust fully, for example backups that keep owners.'
}

type ShareForm = { path: string; clients: string[]; readOnly: boolean; owner: NfsOwner }
type MountForm = { server: string; remote: string; local: string; readOnly: boolean }
type JoinForm = { path: string; userId: string; local: string; readOnly: boolean; owner: NfsOwner; allowPublic: boolean }
type GroupForm = { groupId: string; roles: GroupRole[]; local: string; readOnly: boolean; allowPublic: boolean }

/** Share folders with other servers, and use folders other servers share, over NFS. */
export default function NfsPage({ project, projects, canOps }: { project: Project; projects: Project[]; canOps: boolean }) {
  const { message, modal } = AntApp.useApp()
  const [data, setData] = useState<NfsOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<NfsShare | 'new' | null>(null)
  const [mounting, setMounting] = useState(false)
  const [joining, setJoining] = useState<string | null>(null)
  const [shareForm] = Form.useForm<ShareForm>()
  const [mountForm] = Form.useForm<MountForm>()
  const [joinForm] = Form.useForm<JoinForm>()
  const [groupForm] = Form.useForm<GroupForm>()
  const [groups, setGroups] = useState<ServerGroup[]>([])
  const [toGroup, setToGroup] = useState<string | null>(null)
  const [groupJob, setGroupJob] = useState('')
  const job = useJob(`nfs:${project.id}`)
  const gJob = useJob(`nfsgroup:${groupJob}`)
  // Projects this server is in, for "Mount on a project".
  const mine = groups.filter((g) => g.members.some((m) => m.projectId === project.id))
  const others = projects.filter((p) => p.id !== project.id)

  const load = useCallback(async () => {
    try {
      setData(await window.api.nfs.overview(project.id))
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id])

  useEffect(() => {
    void load()
    window.api.groups
      .list()
      .then(setGroups)
      .catch(() => setGroups([]))
  }, [load])

  const openGroup = (path: string): void => {
    setToGroup(path)
    groupForm.resetFields()
    const share = data?.shares.find((s) => s.path === path)
    groupForm.setFieldsValue({ groupId: mine[0]?.id, roles: [], local: path, readOnly: share?.readOnly ?? false, allowPublic: false })
  }

  const submitGroup = async (): Promise<void> => {
    let v: GroupForm
    try {
      v = await groupForm.validateFields()
    } catch {
      return
    }
    const g = groups.find((x) => x.id === v.groupId)
    const path = toGroup
    if (!g || !path) return
    const share = data?.shares.find((s) => s.path === path)
    const ruleId = crypto.randomUUID()
    const rule = { id: ruleId, serverId: project.id, path, local: v.local.trim().replace(/\/+$/, ''), readOnly: v.readOnly, owner: share?.owner ?? ('keep' as NfsOwner), roles: v.roles ?? [], allowPublic: v.allowPublic }
    try {
      // Kept on the project, so servers added to it later get the folder too.
      const others = (g.nfs ?? []).filter((n) => !(n.serverId === project.id && n.path === path && n.local === rule.local))
      const saved = await window.api.groups.save({ id: g.id, name: g.name, note: g.note, color: g.color, shared: g.shared, members: g.members, nfs: [...others, rule] })
      setGroups((list) => list.map((x) => (x.id === saved.id ? saved : x)))
    } catch (err) {
      message.error(errText(err), 8)
      return
    }
    setToGroup(null)
    setGroupJob(g.id)
    gJob.setOpen(true)
    const ok = await runTask(`nfsgroup:${g.id}`, `Mount ${path} on project ${g.name}`, () => window.api.nfs.groupSync(g.id, ruleId))
    await load()
    if (ok) message.success(`${path} is mounted on project ${g.name}`)
  }

  const run = async (title: string, fn: () => Promise<unknown>): Promise<boolean> => {
    const ok = await job.run(title, fn)
    await load()
    return ok
  }

  const saveAll = (shares: NfsShare[], title: string): Promise<boolean> => run(title, () => window.api.nfs.saveShares(project.id, shares))

  const openShare = (s: NfsShare | 'new'): void => {
    setEditing(s)
    shareForm.resetFields()
    shareForm.setFieldsValue(s === 'new' ? { path: '/www/shared', clients: [], readOnly: false, owner: 'keep' } : { ...s })
  }

  const submitShare = async (): Promise<void> => {
    let v: ShareForm
    try {
      v = await shareForm.validateFields()
    } catch {
      return
    }
    if (!data) return
    const path = v.path.trim().replace(/\/+$/, '')
    const next = data.shares.filter((s) => s !== editing && s.path !== path)
    next.push({ path, clients: v.clients.map((c) => c.trim()).filter(Boolean), readOnly: v.readOnly, owner: v.owner })
    setEditing(null)
    if (await saveAll(next, `Share ${path}`)) message.success(`${path} is shared`)
  }

  const submitMount = async (): Promise<void> => {
    let v: MountForm
    try {
      v = await mountForm.validateFields()
    } catch {
      return
    }
    setMounting(false)
    if (await run(`Mount ${v.server}:${v.remote}`, () => window.api.nfs.addMount(project.id, { ...v, server: v.server.trim(), remote: v.remote.trim(), local: v.local.trim() }))) message.success(`Mounted at ${v.local}`)
  }

  const openJoin = (path: string): void => {
    setJoining(path)
    joinForm.resetFields()
    const share = data?.shares.find((s) => s.path === path)
    joinForm.setFieldsValue({ path, userId: others[0]?.id, local: path, readOnly: share?.readOnly ?? false, owner: share?.owner ?? 'keep', allowPublic: false })
  }

  const submitJoin = async (): Promise<void> => {
    let v: JoinForm
    try {
      v = await joinForm.validateFields()
    } catch {
      return
    }
    const other = projects.find((p) => p.id === v.userId)
    setJoining(null)
    const ok = await run(`Connect ${other?.name ?? 'server'} to ${v.path}`, () => window.api.nfs.join(project.id, v.path.trim(), v.userId, v.local.trim(), v.readOnly, v.owner, v.allowPublic))
    if (ok) message.success(`${other?.name} now uses ${v.path}`)
  }

  // Saved servers to pick as clients: their SSH address, which is the right one when they connect over the internet.
  const clientOptions = others.filter((p) => /^\d+\.\d+\.\d+\.\d+$/.test(p.host)).map((p) => ({ value: p.host, label: `${p.host} (${p.name})` }))

  if (error) {
    return (
      <div className="card">
        <Alert type="error" showIcon message="Could not read NFS on this server" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
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

  return (
    <div className="grid">
      <Alert
        type="info"
        showIcon
        message="NFS lets several servers use one folder"
        description="One server keeps the files and shares the folder; the others mount it and see the same files, for example uploads behind a load balancer. NFS has no password and no encryption: a folder is shared only with the addresses you list, and is meant for a private network between your servers."
      />

      <div className="card">
        <div className="card-title">
          <Space wrap>
            Shared from this server
            <Tag color={data.serverInstalled ? (data.serverRunning ? 'green' : 'red') : 'default'}>{data.serverInstalled ? (data.serverRunning ? 'NFS server running' : 'NFS server stopped') : 'NFS server not installed'}</Tag>
            {data.addresses.length > 0 && (
              <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 400 }}>
                Addresses: {data.addresses.map((a) => <Typography.Text key={a} copyable className="mono" style={{ fontSize: 12, marginRight: 8 }}>{a}</Typography.Text>)}
              </span>
            )}
          </Space>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void load()} />
            {canOps && !data.serverInstalled && (
              <Button type="primary" onClick={() => void run('Install the NFS server', () => window.api.nfs.install(project.id, 'server'))}>
                Install NFS server
              </Button>
            )}
            {canOps && data.serverInstalled && !data.serverRunning && (
              <Button danger onClick={() => void run('Start the NFS server', () => window.api.nfs.install(project.id, 'server'))}>
                Start NFS server
              </Button>
            )}
            {canOps && data.serverInstalled && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => openShare('new')}>
                Share a folder
              </Button>
            )}
          </Space>
        </div>
        <Table
          size="small"
          rowKey="path"
          pagination={false}
          dataSource={data.shares}
          locale={{ emptyText: data.serverInstalled ? 'No shared folders yet.' : 'Install the NFS server to share folders from this server.' }}
          columns={[
            { title: 'Folder', render: (_, s) => <Typography.Text copyable className="mono">{s.path}</Typography.Text> },
            { title: 'Servers that may use it', render: (_, s) => <Space wrap size={4}>{s.clients.map((c) => <Tag key={c} className="mono">{c}{nameOf(projects, c)}</Tag>)}</Space> },
            { title: 'Access', width: 110, render: (_, s) => <Tag color={s.readOnly ? 'default' : 'blue'}>{s.readOnly ? 'Read only' : 'Read & write'}</Tag> },
            { title: 'Owners', width: 170, render: (_, s) => <span style={{ fontSize: 12 }}>{OWNER_WORDS[s.owner]}</span> },
            {
              title: '',
              align: 'right',
              render: (_, s) =>
                canOps && (
                  <Space wrap>
                    {mine.length > 0 && (
                      <Button size="small" type="primary" icon={<ClusterOutlined />} onClick={() => openGroup(s.path)}>
                        Mount on a project
                      </Button>
                    )}
                    {others.length > 0 && (
                      <Button size="small" type="primary" ghost icon={<ApiOutlined />} onClick={() => openJoin(s.path)}>
                        Connect a server
                      </Button>
                    )}
                    <Button size="small" onClick={() => openShare(s)}>
                      Edit
                    </Button>
                    <Button
                      size="small"
                      danger
                      onClick={() =>
                        modal.confirm({
                          title: `Stop sharing ${s.path}?`,
                          content: 'Servers that mount it lose access at once; programs there that use it get errors. The files stay on this server.',
                          okText: 'Stop sharing',
                          okButtonProps: { danger: true },
                          onOk: () => void saveAll(data.shares.filter((x) => x !== s), `Stop sharing ${s.path}`)
                        })
                      }
                    >
                      Stop sharing
                    </Button>
                  </Space>
                )
            }
          ]}
        />
        {data.otherExports.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>Also shared, from /etc/exports (made outside this app, not changed here):</div>
            <pre className="mono" style={{ fontSize: 12, margin: 0, whiteSpace: 'pre-wrap' }}>{data.otherExports.join('\n')}</pre>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">
          <Space wrap>
            Used by this server
            <Tag color={data.clientInstalled ? 'green' : 'default'}>{data.clientInstalled ? 'NFS client installed' : 'NFS client not installed'}</Tag>
          </Space>
          <Space>
            {canOps && !data.clientInstalled && (
              <Button onClick={() => void run('Install the NFS client', () => window.api.nfs.install(project.id, 'client'))}>Install NFS client</Button>
            )}
            {canOps && data.clientInstalled && (
              <Button
                icon={<PlusOutlined />}
                onClick={() => {
                  mountForm.resetFields()
                  mountForm.setFieldsValue({ server: '', remote: '/www/shared', local: '/www/shared', readOnly: false })
                  setMounting(true)
                }}
              >
                Mount a shared folder
              </Button>
            )}
          </Space>
        </div>
        <Table
          size="small"
          rowKey="local"
          pagination={false}
          dataSource={data.mounts}
          locale={{ emptyText: 'This server uses no folder from another server.' }}
          columns={[
            { title: 'Folder here', render: (_, m) => <Typography.Text copyable className="mono">{m.local}</Typography.Text> },
            { title: 'Comes from', render: (_, m) => <span className="mono">{m.server}{nameOf(projects, m.server)}:{m.remote}</span> },
            {
              title: 'State',
              width: 200,
              render: (_, m: NfsMount) => (
                <Space direction="vertical" size={0}>
                  <Tag color={m.mounted ? 'green' : 'red'}>{m.mounted ? 'Mounted' : 'Not mounted'}</Tag>
                  {m.mounted && m.size ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>{bytes(m.used ?? 0)} of {bytes(m.size)} used</span> : null}
                  {m.readOnly && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Read only</span>}
                </Space>
              )
            },
            {
              title: '',
              align: 'right',
              render: (_, m: NfsMount) =>
                canOps && (
                  <Space wrap>
                    {!m.mounted && (
                      <Button size="small" type="primary" onClick={() => void run(`Mount ${m.local}`, () => window.api.nfs.remount(project.id, m.local))}>
                        Mount again
                      </Button>
                    )}
                    <Button
                      size="small"
                      danger
                      onClick={() =>
                        modal.confirm({
                          title: `Stop using ${m.local}?`,
                          content: `It is unmounted and not mounted after a restart. The files stay on ${m.server}.`,
                          okText: 'Unmount',
                          okButtonProps: { danger: true },
                          onOk: () => void run(`Unmount ${m.local}`, () => window.api.nfs.removeMount(project.id, m.local))
                        })
                      }
                    >
                      Unmount
                    </Button>
                  </Space>
                )
            }
          ]}
        />
      </div>

      <Modal open={editing !== null} title={editing === 'new' ? 'Share a folder' : 'Edit shared folder'} okText="Save" onOk={() => void submitShare()} onCancel={() => setEditing(null)} destroyOnClose width={560}>
        <Form form={shareForm} layout="vertical" requiredMark={false}>
          <Form.Item name="path" label="Folder" rules={[{ required: true, message: 'Choose a folder.' }]} extra="Made if it does not exist.">
            <FolderInput projectId={project.id} placeholder="/www/shared" />
          </Form.Item>
          <Form.Item
            name="clients"
            label="Servers that may use it"
            rules={[{ required: true, type: 'array', min: 1, message: 'Add at least one address.' }]}
            extra="Type an address (10.0.0.5) or a private range (10.0.0.0/24) and press Enter, or pick a saved server. Use private addresses when the servers share a network."
          >
            <Select mode="tags" tokenSeparators={[',', ' ']} options={clientOptions} placeholder="10.0.0.5" />
          </Form.Item>
          <Form.Item name="readOnly" valuePropName="checked">
            <Checkbox>Read only: the other servers can read but not change files</Checkbox>
          </Form.Item>
          <Form.Item name="owner" label="Who owns files the other servers write">
            <Radio.Group>
              <Space direction="vertical">
                {(Object.keys(OWNER_WORDS) as NfsOwner[]).map((k) => (
                  <Radio key={k} value={k}>
                    {OWNER_WORDS[k]}
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{OWNER_HELP[k]}</div>
                  </Radio>
                ))}
              </Space>
            </Radio.Group>
          </Form.Item>
        </Form>
      </Modal>

      <Modal open={mounting} title="Mount a shared folder" okText="Mount" onOk={() => void submitMount()} onCancel={() => setMounting(false)} destroyOnClose width={520}>
        <Form form={mountForm} layout="vertical" requiredMark={false}>
          <Form.Item name="server" label="Server that shares it" rules={[{ required: true, message: 'Enter its address.' }]} extra="Its private address when both servers are on one network.">
            <Input className="mono" placeholder="10.0.0.5" />
          </Form.Item>
          <Form.Item name="remote" label="Shared folder on that server" rules={[{ required: true, message: 'Enter the folder.' }]}>
            <Input className="mono" placeholder="/www/shared" />
          </Form.Item>
          <Form.Item name="local" label="Folder on this server" rules={[{ required: true, message: 'Choose a folder.' }]} extra="An empty or new folder. It is mounted again after every restart.">
            <FolderInput projectId={project.id} placeholder="/www/shared" />
          </Form.Item>
          <Form.Item name="readOnly" valuePropName="checked">
            <Checkbox>Read only</Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      <Modal open={joining !== null} title={`Connect a server to ${joining ?? ''}`} okText="Connect" onOk={() => void submitJoin()} onCancel={() => setJoining(null)} destroyOnClose width={560}>
        <div style={{ marginBottom: 12, color: 'var(--muted)' }}>
          The app installs what is missing, shares the folder with the other server's address, opens port 2049 for it only, and mounts the folder there. It tries the private network first.
        </div>
        <Form form={joinForm} layout="vertical" requiredMark={false}>
          <Form.Item name="path" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="userId" label="Server that will use the folder" rules={[{ required: true, message: 'Choose a server.' }]}>
            <Select options={others.map((p) => ({ value: p.id, label: `${p.name} (${p.host})` }))} />
          </Form.Item>
          <Form.Item name="local" label="Folder on that server" rules={[{ required: true, message: 'Enter a folder.' }]} extra="An empty or new folder there.">
            <Input className="mono" placeholder="/www/shared" />
          </Form.Item>
          <Form.Item name="readOnly" valuePropName="checked">
            <Checkbox>Read only</Checkbox>
          </Form.Item>
          <Form.Item name="owner" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="allowPublic" valuePropName="checked" extra="Only when the servers share no private network. Files then travel over the internet without encryption, and the cloud's security group must allow TCP 2049 between them.">
            <Checkbox>Allow the public internet</Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      <Modal open={toGroup !== null} title={`Mount ${toGroup ?? ''} on a project`} okText="Mount" onOk={() => void submitGroup()} onCancel={() => setToGroup(null)} destroyOnClose width={560}>
        <div style={{ marginBottom: 12, color: 'var(--muted)' }}>
          Every other server of the project gets the folder: the app installs what is missing, shares the folder with each server's address and mounts it there. The rule is kept on the project, so a server added to it later gets the folder by itself.
        </div>
        <Form form={groupForm} layout="vertical" requiredMark={false}>
          <Form.Item name="groupId" label="Project" rules={[{ required: true, message: 'Choose a project.' }]}>
            <Select options={mine.map((g) => ({ value: g.id, label: `${g.name} (${new Set(g.members.map((m) => m.projectId)).size} servers)` }))} />
          </Form.Item>
          <Form.Item name="roles" label="Only servers with these roles" extra="Leave empty for every other server of the project.">
            <Select mode="multiple" allowClear placeholder="Every server" options={ROLES.map((r) => ({ value: r.key, label: r.label }))} tagRender={(t) => <Tag color={ROLE_OF[t.value as GroupRole]?.color} closable={t.closable} onClose={t.onClose} style={{ marginRight: 4 }}>{t.label}</Tag>} />
          </Form.Item>
          <Form.Item name="local" label="Folder on those servers" rules={[{ required: true, message: 'Enter a folder.' }]} extra="An empty or new folder there.">
            <Input className="mono" placeholder="/www/shared" />
          </Form.Item>
          <Form.Item name="readOnly" valuePropName="checked">
            <Checkbox>Read only</Checkbox>
          </Form.Item>
          <Form.Item name="allowPublic" valuePropName="checked" extra="Only when the servers share no private network. Files then travel over the internet without encryption.">
            <Checkbox>Allow the public internet</Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      <JobDrawer job={job} />
      <JobDrawer job={gJob} />
    </div>
  )
}

/** " (name)" for an address that belongs to a saved server. */
function nameOf(projects: Project[], addr: string): string {
  const p = projects.find((x) => x.host === addr)
  return p ? ` (${p.name})` : ''
}
