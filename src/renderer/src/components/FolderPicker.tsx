import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Input, Modal, Space, Spin } from 'antd'
import { ArrowUpOutlined, FolderFilled, FolderOpenOutlined } from '@ant-design/icons'
import { errText } from '../util'

/** Browse the server's folders and pick one. */
export function FolderPicker({ projectId, open, start, onPick, onClose }: { projectId: string; open: boolean; start?: string; onPick: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState('/')
  const [typed, setTyped] = useState('/')
  const [folders, setFolders] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState(false)

  const go = useCallback(
    async (dir: string) => {
      setFolders(null)
      setError(null)
      try {
        const l = await window.api.files.list(projectId, dir || '/')
        setPath(l.path)
        setTyped(l.path)
        setFolders(l.entries.filter((e) => e.isDir).map((e) => e.name).sort((a, b) => a.localeCompare(b)))
        setMore(l.truncated)
      } catch (err) {
        setError(errText(err))
        setFolders([])
      }
    },
    [projectId]
  )

  useEffect(() => {
    if (!open) return
    // Start where the field already points, or one level up when that folder does not exist yet.
    const first = start && start.startsWith('/') ? start : '/www/wwwroot'
    void (async () => {
      try {
        const l = await window.api.files.list(projectId, first)
        setPath(l.path)
        setTyped(l.path)
        setFolders(l.entries.filter((e) => e.isDir).map((e) => e.name).sort((a, b) => a.localeCompare(b)))
        setMore(l.truncated)
        setError(null)
      } catch {
        await go(first.replace(/\/[^/]*\/?$/, '') || '/')
      }
    })()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const parent = path === '/' ? null : path.replace(/\/[^/]+\/?$/, '') || '/'
  const parts = path.split('/').filter(Boolean)

  return (
    <Modal
      open={open}
      title="Choose a folder on the server"
      width={560}
      onCancel={onClose}
      destroyOnClose
      footer={
        <Space>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" disabled={!!error || folders === null} onClick={() => onPick(path)}>
            Choose this folder
          </Button>
        </Space>
      }
    >
      <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
        <Button icon={<ArrowUpOutlined />} disabled={!parent} onClick={() => parent && void go(parent)} aria-label="Up one folder" />
        <Input className="mono" value={typed} onChange={(e) => setTyped(e.target.value)} onPressEnter={() => void go(typed.trim())} spellCheck={false} aria-label="Folder path" />
        <Button onClick={() => void go(typed.trim())}>Go</Button>
      </Space.Compact>
      <div className="folder-crumbs">
        <button type="button" className="link-btn" onClick={() => void go('/')}>
          /
        </button>
        {parts.map((p, i) => (
          <span key={i}>
            <button type="button" className="link-btn" onClick={() => void go('/' + parts.slice(0, i + 1).join('/'))}>
              {p}
            </button>
            {i < parts.length - 1 && <span style={{ color: 'var(--muted)' }}> / </span>}
          </span>
        ))}
      </div>
      {error && <Alert style={{ marginBottom: 8 }} type="error" showIcon message="Could not open that folder" description={error} />}
      <div className="folder-list">
        {folders === null ? (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : folders.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>{error ? '' : 'No folders inside this one'}</div>
        ) : (
          folders.map((f) => (
            <button type="button" key={f} className="folder-row" onDoubleClick={() => void go(`${path === '/' ? '' : path}/${f}`)} onClick={() => void go(`${path === '/' ? '' : path}/${f}`)}>
              <FolderFilled style={{ color: '#f5b83d' }} />
              <span className="mono">{f}</span>
            </button>
          ))
        )}
      </div>
      {more && <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>This folder has more entries than are shown. Type the path to go deeper.</div>}
    </Modal>
  )
}

/** A path field with a Browse button. Works as a form control (value / onChange). */
export default function FolderInput({ projectId, value, onChange, placeholder, disabled, id }: { projectId: string; value?: string; onChange?: (v: string) => void; placeholder?: string; disabled?: boolean; id?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Space.Compact style={{ width: '100%' }}>
        <Input id={id} className="mono" value={value} onChange={(e) => onChange?.(e.target.value)} placeholder={placeholder} spellCheck={false} autoComplete="off" disabled={disabled} />
        <Button icon={<FolderOpenOutlined />} disabled={disabled} onClick={() => setOpen(true)}>
          Browse
        </Button>
      </Space.Compact>
      <FolderPicker
        projectId={projectId}
        open={open}
        start={value}
        onClose={() => setOpen(false)}
        onPick={(p) => {
          onChange?.(p)
          setOpen(false)
        }}
      />
    </>
  )
}
