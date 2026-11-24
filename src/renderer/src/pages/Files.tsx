import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, App as AntApp, Button, Checkbox, Dropdown, Empty, Form, Input, Modal, Select, Space, Spin, Switch, Table, Tooltip } from 'antd'
import {
  ArrowUpOutlined,
  CloudUploadOutlined,
  CodeOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FileAddOutlined,
  FileOutlined,
  FileTextOutlined,
  FileZipOutlined,
  FolderAddOutlined,
  FolderFilled,
  LinkOutlined,
  LockOutlined,
  MoreOutlined,
  ReloadOutlined,
  ScissorOutlined,
  SearchOutlined,
  SnippetsOutlined,
  UploadOutlined
} from '@ant-design/icons'
import type { FileEntry, FileListing, Project, TrashEntry } from '@shared/types'
import { JobDrawer, useJob } from '../components/JobLog'
import { MAX_EDIT_BYTES } from '@shared/types'
import { bytes, errText } from '../util'
import CodeWorkspace from '../components/CodeWorkspace'
import { fileIconUrl } from '../fileIcons'

const PLACES = [
  { label: 'Websites', path: '/www/wwwroot' },
  { label: 'Nginx', path: '/etc/nginx' },
  { label: 'Logs', path: '/var/log' },
  { label: 'Root home', path: '/root' },
  { label: 'Top', path: '/' }
]

const ARCHIVE = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/i

function join(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

function parent(dir: string): string {
  const i = dir.lastIndexOf('/')
  return i <= 0 ? '/' : dir.slice(0, i)
}

function when(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** "755" -> "rwxr-xr-x" */
function rwx(mode: string): string {
  return mode
    .slice(-3)
    .split('')
    .map((c) => {
      const n = Number(c)
      return `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`
    })
    .join('')
}

function EntryIcon({ e }: { e: FileEntry }) {
  if (e.isDir) return <FolderFilled className="file-icon dir" />
  if (e.type === 'link') return <LinkOutlined className="file-icon" />
  return <img className="file-icon file-icon-img" src={fileIconUrl(e.name)} alt="" draggable={false} />
}

interface Clip {
  mode: 'copy' | 'move'
  paths: string[]
}

/** Browse and change files on the server, like the file manager in a hosting panel. */
export default function Files({ project, projects, canSend: maySend, full, dark, start }: { project: Project; projects: Project[]; canSend: boolean; full: boolean; dark: boolean; /** A folder to open, e.g. a site's folder clicked on the Sites page; `at` makes the same folder open again. */ start?: { path: string; at: number } }) {
  const others = projects.filter((p) => p.id !== project.id)
  const canSend = maySend
  const [send, setSend] = useState<{ path: string; isDir: boolean; toId?: string; toPath: string } | null>(null)
  const sendJob = useJob(`copy:${project.id}`)
  const startSend = (): void => {
    if (!send?.toId || !send.toPath.trim()) return
    const s = send
    setSend(null)
    void sendJob.run(`Copy ${s.path} to ${others.find((p) => p.id === s.toId)?.name ?? 'the other server'}`, () => window.api.transfer.copy(project.id, s.path, s.toId as string, s.toPath.trim()))
  }
  const { modal, message } = AntApp.useApp()
  const id = project.id
  const home = '/www/wwwroot'
  const [listing, setListing] = useState<FileListing | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [clip, setClip] = useState<Clip | null>(null)
  const [filter, setFilter] = useState('')
  const [hidden, setHidden] = useState(true)
  const [typing, setTyping] = useState<string | null>(null)
  const [sizes, setSizes] = useState<Record<string, number>>({})
  // The code editor: the folder its tree starts at, and the file to open first.
  const [ws, setWs] = useState<{ root: string; open?: string } | null>(null)
  const [opening] = useState(false)
  const [ask, setAsk] = useState<null | { kind: 'file' | 'dir' | 'rename' | 'compress' | 'extract'; target?: FileEntry; paths?: string[] }>(null)
  const [perm, setPerm] = useState<null | { paths: string[]; one?: FileEntry }>(null)
  const [busy, setBusy] = useState(false)
  const [trash, setTrash] = useState<TrashEntry[] | null>(null)
  const [trashBusy, setTrashBusy] = useState(false)
  // Kept apart from the list, so a reload that finishes late cannot reopen a dialog the person just closed.
  const [trashOpen, setTrashOpen] = useState(false)
  const [askForm] = Form.useForm<{ name: string; format: 'tar.gz' | 'zip' }>()
  const [permForm] = Form.useForm<{ mode: string; owner: string; group: string; recursive: boolean }>()
  const cwd = listing?.path ?? home

  const open = useCallback(
    async (dir: string, quiet = false): Promise<boolean> => {
      if (!quiet) setLoading(true)
      try {
        const l = await window.api.files.list(id, dir)
        setListing(l)
        setError('')
        setSelected([])
        setSizes({})
        setFilter('')
        return true
      } catch (err) {
        if (!quiet) setError(errText(err))
        return false
      } finally {
        setLoading(false)
      }
    },
    [id]
  )

  const refresh = useCallback(async (): Promise<void> => {
    if (!listing) return
    try {
      const l = await window.api.files.list(id, listing.path)
      setListing(l)
      setSelected((s) => s.filter((n) => l.entries.some((e) => e.name === n)))
    } catch (err) {
      message.error(errText(err))
    }
  }, [id, listing, message])

  useEffect(() => {
    void (async () => {
      // A folder asked for (a site's folder) first; otherwise a website's files; the top when that folder is not there.
      if (start && (await open(start.path, true))) return
      if (start) message.warning(`${start.path} does not exist on the server yet. It appears after the site's first deploy.`)
      if (!(await open(home, true))) {
        if (full) await open('/')
        else {
          setError(`The websites folder ${home} does not exist on this server yet. It appears after the first site is deployed.`)
          setLoading(false)
        }
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, full])

  // Asked again while the page is open (another site's folder).
  const startAt = start?.at
  useEffect(() => {
    if (start && listing && listing.path !== start.path) void open(start.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startAt])

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (listing?.entries ?? [])
      .filter((e) => (hidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  }, [listing, filter, hidden])

  const pathsOf = (names: string[]): string[] => names.map((n) => join(cwd, n))

  /** Run an action; when the server says a name is taken, offer to replace it and run again. */
  const act = async (label: string, fn: (overwrite: boolean) => Promise<unknown>, done?: string): Promise<boolean> => {
    setBusy(true)
    const key = `files-${Date.now()}`
    message.open({ key, type: 'loading', content: label, duration: 0 })
    try {
      await fn(false)
      message.open({ key, type: 'success', content: done ?? 'Done', duration: 2 })
      await refresh()
      return true
    } catch (err) {
      const text = errText(err)
      message.destroy(key)
      if (text.startsWith('EXISTS:')) {
        return await new Promise<boolean>((resolve) => {
          modal.confirm({
            title: `"${text.slice(7)}" already exists there`,
            content: 'Replace it? A file is overwritten; a folder is merged, and files with the same name inside it are overwritten.',
            okText: 'Replace',
            okButtonProps: { danger: true },
            onCancel: () => resolve(false),
            onOk: async () => {
              try {
                await fn(true)
                message.success(done ?? 'Done')
                await refresh()
                resolve(true)
              } catch (e2) {
                message.error(errText(e2))
                resolve(false)
              }
            }
          })
        })
      }
      message.error(text, 6)
      return false
    } finally {
      setBusy(false)
    }
  }

  const openFile = async (e: FileEntry): Promise<void> => {
    if (e.size > MAX_EDIT_BYTES) {
      message.info(`This file is larger than ${MAX_EDIT_BYTES / 1048576} MB. Download it to read or edit it.`)
      return
    }
    setWs({ root: cwd, open: join(cwd, e.name) })
  }

  const remove = (names: string[]): void => {
    const hasDir = names.some((n) => listing?.entries.find((e) => e.name === n)?.isDir)
    let forever = false
    modal.confirm({
      title: names.length === 1 ? `Delete "${names[0]}"?` : `Delete ${names.length} items?`,
      content: (
        <div>
          {names.length > 1 && <p className="mono" style={{ fontSize: 12.5, maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{names.join('\n')}</p>}
          <p>{hasDir ? 'Folders are moved with everything inside them. ' : ''}It goes to the trash on this server, where you can restore it.</p>
          <Checkbox onChange={(e) => (forever = e.target.checked)}>Delete permanently, skip the trash</Checkbox>
        </div>
      ),
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: () => act('Deleting...', () => window.api.files.remove(id, pathsOf(names), forever), forever ? 'Deleted permanently' : 'Moved to trash')
    })
  }

  const loadTrash = async (): Promise<void> => {
    setTrashBusy(true)
    try {
      setTrash(await window.api.files.trashList(id))
    } catch (err) {
      message.error(errText(err))
      setTrash(null)
    } finally {
      setTrashBusy(false)
    }
  }

  const trashAct = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setTrashBusy(true)
    try {
      await fn()
      message.success(done)
    } catch (err) {
      message.error(errText(err), 6)
    }
    await loadTrash()
    void refresh()
  }

  const paste = async (): Promise<void> => {
    if (!clip) return
    const ok = await act(clip.mode === 'copy' ? 'Copying...' : 'Moving...', (ow) => (clip.mode === 'copy' ? window.api.files.copy(id, clip.paths, cwd, ow) : window.api.files.move(id, clip.paths, cwd, ow)), clip.mode === 'copy' ? 'Copied here' : 'Moved here')
    if (ok && clip.mode === 'move') setClip(null)
  }

  const upload = async (kind: 'files' | 'folder'): Promise<void> => {
    const picked = await window.api.files.pickUpload(kind)
    for (const local of picked) {
      const name = local.split(/[\\/]/).pop()
      const ok = await act(`Uploading ${name}...`, (ow) => window.api.files.upload(id, cwd, local, kind === 'folder', ow), `Uploaded ${name}`)
      if (!ok) break
    }
  }

  const download = async (e: FileEntry): Promise<void> => {
    const key = `dl-${Date.now()}`
    message.open({ key, type: 'loading', content: e.isDir ? `Packing and downloading ${e.name}...` : `Downloading ${e.name}...`, duration: 0 })
    try {
      const saved = await window.api.files.download(id, join(cwd, e.name), e.isDir)
      if (saved) message.open({ key, type: 'success', content: `Saved to ${saved}`, duration: 4 })
      else message.destroy(key)
    } catch (err) {
      message.open({ key, type: 'error', content: errText(err), duration: 6 })
    }
  }

  const measure = async (e: FileEntry): Promise<void> => {
    setSizes((s) => ({ ...s, [e.name]: -1 }))
    try {
      const n = await window.api.files.size(id, join(cwd, e.name))
      setSizes((s) => ({ ...s, [e.name]: n }))
    } catch {
      setSizes((s) => {
        const next = { ...s }
        delete next[e.name]
        return next
      })
    }
  }

  const startAsk = (a: NonNullable<typeof ask>): void => {
    askForm.resetFields()
    const base = a.target?.name ?? ''
    askForm.setFieldsValue({
      name: a.kind === 'rename' ? base : a.kind === 'compress' ? (a.paths?.length === 1 ? a.paths[0].split('/').pop() : cwd.split('/').pop() || 'archive') : a.kind === 'extract' ? cwd : '',
      format: 'tar.gz'
    })
    setAsk(a)
  }

  const submitAsk = async (): Promise<void> => {
    if (!ask) return
    let v: { name: string; format: 'tar.gz' | 'zip' }
    try {
      v = await askForm.validateFields()
    } catch {
      return
    }
    const name = v.name.trim()
    const a = ask
    let ok = false
    if (a.kind === 'file' || a.kind === 'dir') {
      ok = await act('Creating...', () => window.api.files.create(id, cwd, name, a.kind as 'file' | 'dir'), 'Created')
      if (ok && a.kind === 'file') {
        setAsk(null)
        void openFile({ name, type: 'file', isDir: false, size: 0, mtime: 0, mode: '644', owner: '', group: '' })
        return
      }
    } else if (a.kind === 'rename' && a.target) ok = await act('Renaming...', () => window.api.files.rename(id, join(cwd, a.target!.name), name), 'Renamed')
    else if (a.kind === 'compress' && a.paths) ok = await act('Compressing...', () => window.api.files.compress(id, a.paths!, name, v.format), 'Archive created')
    else if (a.kind === 'extract' && a.target) ok = await act('Unpacking...', () => window.api.files.extract(id, join(cwd, a.target!.name), name), 'Unpacked')
    if (ok) setAsk(null)
  }

  const startPerm = (paths: string[], one?: FileEntry): void => {
    permForm.resetFields()
    permForm.setFieldsValue({ mode: one?.mode.slice(-3) ?? '644', owner: one?.owner ?? '', group: one?.group ?? '', recursive: false })
    setPerm({ paths, one })
  }

  const submitPerm = async (): Promise<void> => {
    if (!perm) return
    let v: { mode: string; owner: string; group: string; recursive: boolean }
    try {
      v = await permForm.validateFields()
    } catch {
      return
    }
    const ok = await act('Changing permissions...', () => window.api.files.chmod(id, perm.paths, { mode: v.mode, owner: full ? v.owner.trim() || undefined : undefined, group: full ? v.group.trim() || undefined : undefined, recursive: v.recursive }), 'Permissions changed')
    if (ok) setPerm(null)
  }

  const menu = (e: FileEntry) => ({
    items: [
      e.isDir ? { key: 'open', label: 'Open', icon: <FolderFilled /> } : { key: 'edit', label: 'Edit', icon: <EditOutlined /> },
      { key: 'rename', label: 'Rename', icon: <EditOutlined /> },
      { key: 'copy', label: 'Copy', icon: <CopyOutlined /> },
      { key: 'cut', label: 'Cut (to move)', icon: <ScissorOutlined /> },
      { key: 'download', label: e.isDir ? 'Download as .tar.gz' : 'Download', icon: <DownloadOutlined /> },
      ...(!e.isDir && ARCHIVE.test(e.name) ? [{ key: 'extract', label: 'Unpack', icon: <FileZipOutlined /> }] : []),
      { key: 'compress', label: 'Compress', icon: <FileZipOutlined /> },
      { key: 'perm', label: 'Permissions', icon: <LockOutlined /> },
      ...(canSend ? [{ key: 'send', label: 'Copy to another server…', icon: <CloudUploadOutlined /> }] : []),
      { type: 'divider' as const },
      { key: 'delete', label: 'Delete', icon: <DeleteOutlined />, danger: true }
    ],
    onClick: ({ key }: { key: string }) => {
      const p = join(cwd, e.name)
      if (key === 'open') void open(p)
      else if (key === 'edit') void openFile(e)
      else if (key === 'rename') startAsk({ kind: 'rename', target: e })
      else if (key === 'copy') setClip({ mode: 'copy', paths: [p] })
      else if (key === 'cut') setClip({ mode: 'move', paths: [p] })
      else if (key === 'download') void download(e)
      else if (key === 'extract') startAsk({ kind: 'extract', target: e })
      else if (key === 'compress') startAsk({ kind: 'compress', paths: [p] })
      else if (key === 'perm') startPerm([p], e)
      else if (key === 'send') setSend({ path: p, isDir: e.isDir, toId: others[0]?.id, toPath: e.isDir ? p : cwd })
      else if (key === 'delete') remove([e.name])
    }
  })

  const crumbs = cwd === '/' ? [] : cwd.split('/').slice(1)
  const askTitle = ask?.kind === 'file' ? 'New file' : ask?.kind === 'dir' ? 'New folder' : ask?.kind === 'rename' ? `Rename "${ask.target?.name}"` : ask?.kind === 'compress' ? 'Compress' : ask?.kind === 'extract' ? `Unpack "${ask?.target?.name}"` : ''

  return (
    <div className="card files">
      <div className="files-bar">
        <Tooltip title="Up one folder">
          <Button icon={<ArrowUpOutlined />} disabled={cwd === '/' || (!!listing?.root && cwd === listing.root)} onClick={() => void open(parent(cwd))} />
        </Tooltip>
        {typing !== null ? (
          <Input
            autoFocus
            className="mono files-path-input"
            value={typing}
            spellCheck={false}
            onChange={(e) => setTyping(e.target.value)}
            onBlur={() => setTyping(null)}
            onPressEnter={() => {
              const target = typing.trim()
              setTyping(null)
              if (target) void open(target).then((ok) => !ok && void 0)
            }}
          />
        ) : (
          <div className="files-path" onClick={() => setTyping(cwd)} title="Click to type a path">
            <button type="button" className="files-crumb" onClick={(ev) => { ev.stopPropagation(); if (!listing?.root) void open('/') }}>/</button>
            {crumbs.map((c, i) => {
              const target = '/' + crumbs.slice(0, i + 1).join('/')
              const locked = !!listing?.root && !`${target}/`.startsWith(`${listing.root}/`)
              return (
                <span key={target} className="files-seg">
                  <button type="button" className="files-crumb" disabled={locked} onClick={(ev) => { ev.stopPropagation(); void open(target) }}>
                    {c}
                  </button>
                  {i < crumbs.length - 1 && <span className="files-sep">/</span>}
                </span>
              )
            })}
          </div>
        )}
        <Tooltip title="Refresh">
          <Button icon={<ReloadOutlined />} onClick={() => void open(cwd)} />
        </Tooltip>
        {full && (
          <Select
            className="files-places"
            placeholder="Go to"
            value={null}
            options={PLACES.map((p) => ({ value: p.path, label: p.label }))}
            onChange={(v) => v && void open(v)}
            popupMatchSelectWidth={false}
          />
        )}
      </div>

      <div className="files-tools">
        <Space wrap size={8}>
          <Dropdown
            menu={{
              items: [
                { key: 'file', label: 'New file', icon: <FileAddOutlined /> },
                { key: 'dir', label: 'New folder', icon: <FolderAddOutlined /> }
              ],
              onClick: ({ key }) => startAsk({ kind: key as 'file' | 'dir' })
            }}
          >
            <Button type="primary" icon={<FileAddOutlined />} disabled={!listing}>
              New
            </Button>
          </Dropdown>
          <Button icon={<CodeOutlined />} disabled={!listing} onClick={() => setWs({ root: cwd })}>
            Code editor
          </Button>
          <Dropdown
            menu={{
              items: [
                { key: 'files', label: 'Upload files', icon: <UploadOutlined /> },
                { key: 'folder', label: 'Upload a folder', icon: <FolderAddOutlined /> }
              ],
              onClick: ({ key }) => void upload(key as 'files' | 'folder')
            }}
          >
            <Button icon={<UploadOutlined />} disabled={!listing || busy}>
              Upload
            </Button>
          </Dropdown>
          {clip && (
            <>
              <Button icon={<SnippetsOutlined />} type="primary" ghost disabled={busy} onClick={() => void paste()}>
                {clip.mode === 'copy' ? 'Paste copy here' : 'Move here'} ({clip.paths.length})
              </Button>
              <Button type="text" onClick={() => setClip(null)}>
                Cancel
              </Button>
            </>
          )}
          {selected.length > 0 && (
            <>
              <span className="files-count">{selected.length} selected</span>
              <Button icon={<CopyOutlined />} onClick={() => { setClip({ mode: 'copy', paths: pathsOf(selected) }); setSelected([]) }}>
                Copy
              </Button>
              <Button icon={<ScissorOutlined />} onClick={() => { setClip({ mode: 'move', paths: pathsOf(selected) }); setSelected([]) }}>
                Cut
              </Button>
              <Button icon={<FileZipOutlined />} onClick={() => startAsk({ kind: 'compress', paths: pathsOf(selected) })}>
                Compress
              </Button>
              <Button icon={<LockOutlined />} onClick={() => startPerm(pathsOf(selected))}>
                Permissions
              </Button>
              <Button danger icon={<DeleteOutlined />} onClick={() => remove(selected)}>
                Delete
              </Button>
            </>
          )}
        </Space>
        <Space size={12}>
          <Input allowClear prefix={<SearchOutlined />} placeholder="Filter this folder" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 200 }} />
          <span className="files-switch">
            <Switch size="small" checked={hidden} onChange={setHidden} /> Hidden files
          </span>
          <Button
            icon={<DeleteOutlined />}
            onClick={() => {
              setTrashOpen(true)
              void loadTrash()
            }}
          >
            Trash
          </Button>
        </Space>
      </div>

      {listing?.root && <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`Your role works inside ${listing.root} only. Files you create get the same owner as the folder they are in.`} />}
      {error ? (
        <Alert type="error" showIcon message={error} action={<Button size="small" onClick={() => void open(listing?.path ?? (full ? '/' : home))}>Try again</Button>} />
      ) : (
        <Spin spinning={loading || opening}>
          <Table<FileEntry>
            size="middle"
            rowKey="name"
            dataSource={rows}
            pagination={rows.length > 200 ? { pageSize: 200, showSizeChanger: false, size: 'small' } : false}
            rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as string[]) }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filter ? 'Nothing here matches the filter' : 'This folder is empty. Create a file or upload something.'} /> }}
            onRow={(e) => ({ onDoubleClick: () => (e.isDir ? void open(join(cwd, e.name)) : void openFile(e)) })}
            columns={[
              {
                title: 'Name',
                render: (_, e) => (
                  <button type="button" className="file-name" onClick={() => (e.isDir ? void open(join(cwd, e.name)) : void openFile(e))}>
                    <EntryIcon e={e} />
                    <span>{e.name}</span>
                    {e.type === 'link' && <span className="file-note">link</span>}
                  </button>
                )
              },
              {
                title: 'Size',
                width: 120,
                align: 'right',
                render: (_, e) =>
                  !e.isDir ? (
                    bytes(e.size)
                  ) : sizes[e.name] === undefined ? (
                    <button type="button" className="file-link" onClick={() => void measure(e)}>
                      Calculate
                    </button>
                  ) : sizes[e.name] < 0 ? (
                    '...'
                  ) : (
                    bytes(sizes[e.name])
                  )
              },
              { title: 'Modified', width: 150, render: (_, e) => <span className="file-dim">{when(e.mtime)}</span> },
              {
                title: 'Permissions',
                width: 210,
                render: (_, e) => (
                  <button type="button" className="file-link mono" title={rwx(e.mode)} onClick={() => startPerm([join(cwd, e.name)], e)}>
                    {e.mode} {e.owner}:{e.group}
                  </button>
                )
              },
              {
                title: '',
                width: 132,
                align: 'right',
                render: (_, e) => (
                  <Space size={4}>
                    <Tooltip title={e.isDir ? 'Download as .tar.gz' : 'Download'}>
                      <Button type="text" icon={<DownloadOutlined />} onClick={() => void download(e)} />
                    </Tooltip>
                    <Tooltip title="Delete">
                      <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove([e.name])} />
                    </Tooltip>
                    <Dropdown menu={menu(e)} trigger={['click']} placement="bottomRight">
                      <Button type="text" icon={<MoreOutlined />} aria-label={`More actions for ${e.name}`} />
                    </Dropdown>
                  </Space>
                )
              }
            ]}
          />
        </Spin>
      )}
      {listing && !error && (
        <div className="files-foot">
          <span>
            {listing.entries.filter((e) => e.isDir).length} folders, {listing.entries.filter((e) => !e.isDir).length} files
            {listing.truncated ? ' (only the first 3000 are shown; use the terminal for larger folders)' : ''}
          </span>
          {listing.diskTotal > 0 && (
            <span>
              {bytes(listing.diskFree)} free of {bytes(listing.diskTotal)} on this disk
            </span>
          )}
        </div>
      )}

      {ws && (
        <CodeWorkspace
          projectId={id}
          root={ws.root}
          openPath={ws.open}
          dark={dark}
          onClose={() => {
            setWs(null)
            void refresh()
          }}
        />
      )}

      <Modal
        open={trashOpen}
        width="min(980px, 92vw)"
        title="Trash"
        onCancel={() => setTrashOpen(false)}
        footer={
          <div className="editor-foot">
            <span className="file-dim">Items stay here, using disk space, until you restore them or empty the trash.</span>
            <Space>
              <Button
                danger
                disabled={!trash?.length || trashBusy}
                onClick={() =>
                  modal.confirm({
                    title: `Empty the trash (${trash?.length} items)?`,
                    content: 'They are deleted for good. This cannot be undone.',
                    okText: 'Empty trash',
                    okButtonProps: { danger: true },
                    onOk: () => trashAct(() => window.api.files.trashPurge(id), 'Trash emptied')
                  })
                }
              >
                Empty trash
              </Button>
              <Button onClick={() => setTrashOpen(false)}>Close</Button>
            </Space>
          </div>
        }
      >
        <Table<TrashEntry>
          size="middle"
          rowKey="id"
          loading={trashBusy}
          dataSource={trash ?? []}
          pagination={(trash?.length ?? 0) > 50 ? { pageSize: 50, showSizeChanger: false, size: 'small' } : false}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="The trash is empty" /> }}
          columns={[
            {
              title: 'Name',
              render: (_, t) => (
                <span className="file-name" style={{ cursor: 'default' }}>
                  {t.isDir ? <FolderFilled className="file-icon dir" /> : <FileOutlined className="file-icon" />}
                  <span>{t.name}</span>
                </span>
              )
            },
            { title: 'Was in', render: (_, t) => <span className="mono file-dim" style={{ wordBreak: 'break-all' }}>{parent(t.path)}</span> },
            { title: 'Deleted', width: 190, render: (_, t) => <span className="file-dim">{when(t.deletedAt)}{t.by ? ` by ${t.by}` : ''}</span> },
            { title: 'Size', width: 90, align: 'right', render: (_, t) => (t.isDir ? '' : bytes(t.size)) },
            {
              title: '',
              width: 190,
              align: 'right',
              render: (_, t) => (
                <Space size={4}>
                  <Button size="small" type="primary" ghost disabled={trashBusy} onClick={() => void trashAct(() => window.api.files.trashRestore(id, [t.id]), `Restored to ${parent(t.path)}`)}>
                    Restore
                  </Button>
                  <Button
                    size="small"
                    danger
                    type="text"
                    disabled={trashBusy}
                    onClick={() =>
                      modal.confirm({
                        title: `Delete "${t.name}" for good?`,
                        content: 'This cannot be undone.',
                        okText: 'Delete forever',
                        okButtonProps: { danger: true },
                        onOk: () => trashAct(() => window.api.files.trashPurge(id, [t.id]), 'Deleted permanently')
                      })
                    }
                  >
                    Delete forever
                  </Button>
                </Space>
              )
            }
          ]}
        />
      </Modal>

      <Modal open={!!ask} title={askTitle} okText={ask?.kind === 'rename' ? 'Rename' : ask?.kind === 'compress' ? 'Compress' : ask?.kind === 'extract' ? 'Unpack' : 'Create'} confirmLoading={busy} onCancel={() => setAsk(null)} onOk={() => void submitAsk()} destroyOnClose>
        <Form form={askForm} layout="vertical" requiredMark={false} onFinish={() => void submitAsk()}>
          <Form.Item
            name="name"
            label={ask?.kind === 'extract' ? 'Unpack into folder' : ask?.kind === 'compress' ? 'Archive name' : 'Name'}
            extra={ask?.kind === 'extract' ? 'Files with the same name in that folder are overwritten.' : ask?.kind === 'compress' ? `Created in ${cwd}` : ask?.kind === 'file' ? 'The file opens in the editor after it is created.' : undefined}
            rules={[
              { required: true, whitespace: true, message: 'Enter a name' },
              ...(ask?.kind === 'extract' ? [{ pattern: /^\//, message: 'Enter a full path starting with /' }] : [{ pattern: /^[^/]+$/, message: 'A name cannot contain "/"' }])
            ]}
          >
            <Input className="mono" spellCheck={false} autoFocus placeholder={ask?.kind === 'file' ? 'index.php' : ask?.kind === 'dir' ? 'uploads' : undefined} />
          </Form.Item>
          {ask?.kind === 'compress' && (
            <Form.Item name="format" label="Format">
              <Select
                options={[
                  { value: 'tar.gz', label: '.tar.gz (works on every server)' },
                  { value: 'zip', label: '.zip (needs the zip tool on the server)' }
                ]}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Modal open={!!perm} title={perm?.one ? `Permissions of "${perm.one.name}"` : `Permissions of ${perm?.paths.length} items`} okText="Apply" confirmLoading={busy} onCancel={() => setPerm(null)} onOk={() => void submitPerm()} destroyOnClose>
        <Form form={permForm} layout="vertical" requiredMark={false}>
          <Form.Item label="Permissions" required>
            <Space align="start" wrap>
              <Form.Item name="mode" noStyle rules={[{ required: true, pattern: /^[0-7]{3}$/, message: 'Three digits from 0 to 7' }]}>
                <Input className="mono" style={{ width: 90 }} maxLength={3} />
              </Form.Item>
              <Form.Item noStyle shouldUpdate>
                {() => {
                  const m = String(permForm.getFieldValue('mode') ?? '')
                  return <span className="mono file-dim" style={{ lineHeight: '36px' }}>{/^[0-7]{3}$/.test(m) ? rwx(m) : ''}</span>
                }}
              </Form.Item>
              {['644', '755', '600', '775'].map((m) => (
                <Button key={m} size="small" style={{ marginTop: 6 }} onClick={() => permForm.setFieldValue('mode', m)}>
                  {m}
                </Button>
              ))}
            </Space>
            <div className="file-dim" style={{ marginTop: 6, fontSize: 12.5 }}>
              644 is usual for files, 755 for folders. Avoid 777: it lets every user on the server change the file.
            </div>
          </Form.Item>
          {full && (
            <div className="grid cols-2" style={{ rowGap: 0 }}>
              <Form.Item name="owner" label="Owner" extra="Leave empty to keep it. Web files usually belong to www-data.">
                <Input className="mono" spellCheck={false} />
              </Form.Item>
              <Form.Item name="group" label="Group">
                <Input className="mono" spellCheck={false} />
              </Form.Item>
            </div>
          )}
          <Form.Item name="recursive" valuePropName="checked" style={{ marginBottom: 0 }}>
            <Checkbox>Apply to everything inside folders too</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
      <Modal open={!!send} title="Copy to another server" okText="Copy" okButtonProps={{ disabled: !send?.toId || !send?.toPath.trim() }} onCancel={() => setSend(null)} onOk={startSend} destroyOnClose>
        {send && (
          <div style={{ display: 'grid', gap: 14 }}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>{send.isDir ? 'Folder' : 'File'}</div>
              <div className="mono">{send.path}</div>
            </div>
            <div>
              <label htmlFor="send-to" style={{ fontWeight: 600, display: 'block', marginBottom: 6 }}>
                To server
              </label>
              <Select id="send-to" style={{ width: '100%' }} value={send.toId} placeholder="Pick a server" notFoundContent="Add a second server under Projects first" onChange={(v) => setSend({ ...send, toId: v })} options={others.map((p) => ({ value: p.id, label: `${p.name} (${p.host})` }))} />
            </div>
            <div>
              <label htmlFor="send-path" style={{ fontWeight: 600, display: 'block', marginBottom: 6 }}>
                {send.isDir ? 'Into this folder there' : 'Into this folder there (the file keeps its name)'}
              </label>
              <Input id="send-path" className="mono" value={send.toPath} onChange={(e) => setSend({ ...send, toPath: e.target.value })} spellCheck={false} />
            </div>
            <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: 0 }}>
              The data goes through this computer, so the two servers do not need to reach each other. Files with the same name there are replaced; nothing else in that folder is deleted. This is a one-time copy: run it again to send later changes.
            </p>
          </div>
        )}
      </Modal>
      <JobDrawer job={sendJob} />
    </div>
  )
}
