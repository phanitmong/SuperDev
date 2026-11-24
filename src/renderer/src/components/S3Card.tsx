import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Checkbox, Input, InputNumber, Modal, Select, Space, Spin, Table, Tag } from 'antd'
import { CloudDownloadOutlined, CloudServerOutlined, FolderOpenOutlined } from '@ant-design/icons'
import type { Project, S3Options, S3RemoteFile, S3Status } from '@shared/types'
import { FolderPicker } from './FolderPicker'
import { JobDrawer, useJob } from './JobLog'
import { ago, bytes, errText } from '../util'

/** Endpoint and region of the usual providers, to fill the form. `{x}` parts are replaced by the person. */
const PROVIDERS: { key: string; label: string; endpoint: string; region: string; hint: string }[] = [
  { key: 'aws', label: 'Amazon S3', endpoint: 'https://s3.ap-southeast-1.amazonaws.com', region: 'ap-southeast-1', hint: 'Use the region of your bucket in both fields, for example ap-southeast-1 (Singapore).' },
  { key: 'r2', label: 'Cloudflare R2', endpoint: 'https://ACCOUNT_ID.r2.cloudflarestorage.com', region: 'auto', hint: 'Replace ACCOUNT_ID with your Cloudflare account ID. The region stays "auto".' },
  { key: 'b2', label: 'Backblaze B2', endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004', hint: 'Copy the endpoint shown on the bucket page; the region is the middle part of it.' },
  { key: 'wasabi', label: 'Wasabi', endpoint: 'https://s3.ap-southeast-1.wasabisys.com', region: 'ap-southeast-1', hint: 'Use the region your bucket was made in.' },
  { key: 'do', label: 'DigitalOcean Spaces', endpoint: 'https://sgp1.digitaloceanspaces.com', region: 'sgp1', hint: 'Use the region of your Space, for example sgp1.' },
  { key: 'other', label: 'MinIO or another', endpoint: '', region: 'us-east-1', hint: 'Enter the address of your storage. Most accept the region us-east-1.' }
]

const KIND: Record<S3RemoteFile['kind'], string> = { mysql: 'MySQL', postgres: 'PostgreSQL', 'remote-db': 'Remote database', folders: 'Folder' }

function BringBack({ open, project, onClose, onFetch }: { open: boolean; project: Project; onClose: () => void; onFetch: (f: S3RemoteFile) => void }) {
  const [files, setFiles] = useState<S3RemoteFile[] | null>(null)
  const [error, setError] = useState('')
  const [kind, setKind] = useState<'all' | S3RemoteFile['kind']>('all')
  useEffect(() => {
    if (!open) return
    setFiles(null)
    setError('')
    window.api.s3
      .remote(project.id)
      .then(setFiles)
      .catch((err) => setError(errText(err)))
  }, [open, project.id])
  const shown = (files ?? []).filter((f) => kind === 'all' || f.kind === kind)
  return (
    <Modal open={open} title="Bring a copy back from the bucket" onCancel={onClose} footer={<Button onClick={onClose}>Close</Button>} width={860}>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        A database backup is copied into that database's backup list, where you restore it with your code. A folder archive is unpacked into its own folder under /var/backups/superdevops/from-s3. Nothing live is changed by copying.
      </p>
      {error && <Alert type="error" showIcon message={error} />}
      {!files && !error && <Spin />}
      {files && files.length === 0 && <Alert type="info" showIcon message="This server's folder in the bucket holds no backups yet." />}
      {files && files.length > 0 && (
        <>
          <Select
            value={kind}
            onChange={setKind}
            style={{ width: 240, marginBottom: 10 }}
            options={[{ value: 'all', label: `Everything (${files.length})` }, ...(Object.keys(KIND) as S3RemoteFile['kind'][]).map((k) => ({ value: k, label: `${KIND[k]} (${files.filter((f) => f.kind === k).length})` }))]}
          />
          <Table<S3RemoteFile>
            size="small"
            rowKey="id"
            dataSource={shown}
            pagination={shown.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
            columns={[
              { title: 'File', dataIndex: 'name', render: (v: string) => <span className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{v}</span> },
              { title: 'Kind', dataIndex: 'kind', width: 140, render: (v: S3RemoteFile['kind']) => KIND[v] },
              { title: 'Size', dataIndex: 'size', width: 100, render: (v: number) => bytes(v) },
              { title: 'Uploaded', dataIndex: 'at', width: 130, render: (v: number) => (v ? ago(v) : '') },
              {
                title: '',
                width: 170,
                render: (_: unknown, f) => (
                  <Button size="small" icon={<CloudDownloadOutlined />} onClick={() => onFetch(f)}>
                    Copy to this server
                  </Button>
                )
              }
            ]}
          />
        </>
      )}
    </Modal>
  )
}

const EMPTY: S3Options = { endpoint: '', region: '', bucket: '', prefix: '', accessKey: '', secretKey: '', keepDays: 30, includeDb: true, paths: [], everyHours: 24, dailyHour: 2 }

/** Backups copied to S3-compatible storage on a schedule: database backups and a daily archive of chosen folders. */
export default function S3Card({ project, canChange }: { project: Project; canChange: boolean }) {
  const { message, modal } = AntApp.useApp()
  const [status, setStatus] = useState<S3Status | null>(null)
  const [error, setError] = useState('')
  const [opts, setOpts] = useState<S3Options>(EMPTY)
  const [provider, setProvider] = useState<string | undefined>()
  const [sitePaths, setSitePaths] = useState<string[]>([])
  const [browse, setBrowse] = useState(false)
  const [bringing, setBringing] = useState(false)
  const job = useJob(`s3:${project.id}`)
  const defaultPrefix = project.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

  const load = useCallback(async () => {
    try {
      const s = await window.api.s3.status(project.id)
      setStatus(s)
      setError('')
      if (s.enabled) setOpts({ endpoint: s.endpoint, region: s.region, bucket: s.bucket, prefix: s.prefix, accessKey: s.accessKey, secretKey: '', keepDays: s.keepDays, includeDb: s.includeDb, paths: s.paths, everyHours: s.everyHours ?? 24, dailyHour: s.dailyHour ?? 2 })
      else setOpts((o) => ({ ...o, prefix: o.prefix || defaultPrefix }))
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id, defaultPrefix])

  useEffect(() => void load(), [load])
  useEffect(() => {
    window.api.sites
      .list(project.id)
      .then((list) => setSitePaths([...new Set(list.map((s) => s.rootPath.replace(/\/+$/, '')).filter(Boolean))]))
      .catch(() => setSitePaths([]))
  }, [project.id])

  const on = !!status?.enabled
  const set = (patch: Partial<S3Options>): void => setOpts({ ...opts, ...patch })
  const nothing = !opts.includeDb && opts.paths.length === 0
  const ready = !!opts.endpoint.trim() && !!opts.bucket.trim() && !!opts.accessKey.trim() && (on || !!opts.secretKey) && !nothing
  const changed =
    on &&
    !!status &&
    (opts.endpoint !== status.endpoint ||
      opts.region !== status.region ||
      opts.bucket !== status.bucket ||
      opts.prefix !== status.prefix ||
      opts.accessKey !== status.accessKey ||
      !!opts.secretKey ||
      opts.keepDays !== status.keepDays ||
      opts.includeDb !== status.includeDb ||
      (opts.everyHours ?? 24) !== (status.everyHours ?? 24) ||
      (opts.dailyHour ?? 2) !== (status.dailyHour ?? 2) ||
      opts.paths.join('\n') !== status.paths.join('\n'))

  const save = (): void => {
    void job.run(on ? 'Change S3 backup' : 'Turn on S3 backup', () => window.api.s3.setup(project.id, opts)).then(load, load)
  }

  const disconnect = (): void => {
    modal.confirm({
      title: 'Stop copying backups to the bucket?',
      content: 'The schedule stops and the keys are removed from this server. Files already in the bucket stay there.',
      okText: 'Turn off',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.api.s3.disable(project.id)
          setOpts({ ...EMPTY, prefix: defaultPrefix })
          await load()
        } catch (err) {
          message.error(errText(err))
        }
      }
    })
  }

  const hint = PROVIDERS.find((p) => p.key === provider)?.hint

  return (
    <div className="card">
      <div className="card-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 10 }}>
        <CloudServerOutlined /> Copies in S3 storage
        {on && <Tag color="green">On</Tag>}
      </div>
      {error && <Alert type="warning" showIcon message={error} style={{ marginBottom: 12 }} />}
      {!status && !error && <Spin />}
      {status && (
        <>
          {!on && (
            <p style={{ color: 'var(--muted)', maxWidth: 760, marginTop: 0 }}>
              This server uploads its backups to a bucket you own (Amazon S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO), so they survive even if the server is lost. Nothing is installed on the server. Use a key that can
              only write to this one bucket.
            </p>
          )}
          {on && (
            <dl className="kv" style={{ marginBottom: 14 }}>
              <dt>Bucket</dt>
              <dd>
                {status.bucket}
                {status.prefix ? ` / ${status.prefix}` : ''} <span style={{ color: 'var(--muted)' }}>at {status.endpoint.replace(/^https?:\/\//, '')}</span>
              </dd>
              <dt>In the bucket</dt>
              <dd>
                {status.uploaded} file{status.uploaded === 1 ? '' : 's'} uploaded{status.newest ? `, newest ${status.newest.name}` : ''}
              </dd>
              <dt>Last upload run</dt>
              <dd>{status.last ? <span style={{ color: status.last.ok ? undefined : 'var(--bad)' }}>{ago(status.last.at)} · {status.last.message}</span> : 'Not run yet'}</dd>
            </dl>
          )}
          {on && status.last && !status.last.ok && (
            <Alert type="error" showIcon style={{ marginBottom: 12 }} message="The last upload had a problem" description={<pre className="log-box" style={{ maxHeight: 180, margin: 0, whiteSpace: 'pre-wrap' }}>{status.recent.slice(-8).join('\n')}</pre>} />
          )}
          <div className="gd-form">
            {!on && (
              <div className="gd-field">
                <label htmlFor="s3-provider">
                  <b>Storage</b>
                </label>
                <Select
                  id="s3-provider"
                  value={provider}
                  disabled={!canChange}
                  placeholder="Choose your provider to fill the address"
                  style={{ maxWidth: 320 }}
                  onChange={(v: string) => {
                    const p = PROVIDERS.find((x) => x.key === v)!
                    setProvider(v)
                    set({ endpoint: p.endpoint, region: p.region })
                  }}
                  options={PROVIDERS.map((p) => ({ value: p.key, label: p.label }))}
                />
                {hint && <p className="db-hint" style={{ margin: 0 }}>{hint}</p>}
              </div>
            )}
            <div className="gd-row">
              <div className="gd-field">
                <label htmlFor="s3-endpoint">
                  <b>Endpoint</b>
                </label>
                <Input id="s3-endpoint" value={opts.endpoint} disabled={!canChange} spellCheck={false} placeholder="https://s3.ap-southeast-1.amazonaws.com" onChange={(e) => set({ endpoint: e.target.value.trim() })} />
              </div>
              <div className="gd-field" style={{ flex: 'none', width: 190 }}>
                <label htmlFor="s3-region">
                  <b>Region</b>
                </label>
                <Input id="s3-region" value={opts.region} disabled={!canChange} spellCheck={false} placeholder="ap-southeast-1" onChange={(e) => set({ region: e.target.value.trim() })} />
              </div>
            </div>
            <div className="gd-row">
              <div className="gd-field">
                <label htmlFor="s3-bucket">
                  <b>Bucket</b>
                </label>
                <Input id="s3-bucket" value={opts.bucket} disabled={!canChange} spellCheck={false} placeholder="my-backups" onChange={(e) => set({ bucket: e.target.value.trim() })} />
              </div>
              <div className="gd-field">
                <label htmlFor="s3-prefix">
                  <b>Folder in the bucket</b>
                </label>
                <Input id="s3-prefix" value={opts.prefix} disabled={!canChange} spellCheck={false} placeholder="optional" onChange={(e) => set({ prefix: e.target.value.trim() })} />
              </div>
            </div>
            <div className="gd-row">
              <div className="gd-field">
                <label htmlFor="s3-access">
                  <b>Access key ID</b>
                </label>
                <Input id="s3-access" value={opts.accessKey} disabled={!canChange} spellCheck={false} autoComplete="off" onChange={(e) => set({ accessKey: e.target.value.trim() })} />
              </div>
              <div className="gd-field">
                <label htmlFor="s3-secret">
                  <b>Secret access key</b>
                </label>
                <Input.Password id="s3-secret" value={opts.secretKey} disabled={!canChange} autoComplete="new-password" placeholder={on ? 'Stored on the server. Type a new one to replace it' : ''} onChange={(e) => set({ secretKey: e.target.value.trim() })} />
              </div>
            </div>
            <div className="gd-field">
              <b>What to copy</b>
              <Checkbox checked={opts.includeDb} disabled={!canChange} onChange={(e) => set({ includeDb: e.target.checked })}>
                Every MySQL / MariaDB and PostgreSQL database, backed up once a day (and any backup made by hand or by Database Remote)
              </Checkbox>
              <label htmlFor="s3-paths" style={{ marginTop: 8 }}>
                Folders, packed once a day
              </label>
              <Select id="s3-paths" mode="tags" style={{ width: '100%' }} disabled={!canChange} value={opts.paths} onChange={(v) => set({ paths: v })} placeholder="Pick a website folder or type a path such as /www/wwwroot/shop" options={sitePaths.map((p) => ({ value: p, label: p }))} />
              <div>
                <Button size="small" icon={<FolderOpenOutlined />} disabled={!canChange} onClick={() => setBrowse(true)}>
                  Browse the server for a folder
                </Button>
              </div>
            </div>
            <div className="gd-row">
              <div className="gd-field">
                <label htmlFor="s3-every">
                  <b>Upload</b>
                </label>
                <Select
                  id="s3-every"
                  value={opts.everyHours ?? 24}
                  disabled={!canChange}
                  onChange={(v: number) => set({ everyHours: v })}
                  options={[
                    { value: 1, label: 'Every hour' },
                    { value: 6, label: 'Every 6 hours' },
                    { value: 12, label: 'Every 12 hours' },
                    { value: 24, label: 'Once a day' }
                  ]}
                />
              </div>
              <div className="gd-field" style={{ flex: 'none' }}>
                <label htmlFor="s3-hour">
                  <b>{(opts.everyHours ?? 24) === 24 ? 'At' : "Make the day's backups from"}</b>
                </label>
                <InputNumber id="s3-hour" min={0} max={23} value={opts.dailyHour ?? 2} disabled={!canChange} onChange={(v) => set({ dailyHour: v ?? 2 })} addonAfter=":00" style={{ width: 150 }} />
              </div>
              <div className="gd-field" style={{ flex: 'none' }}>
                <label htmlFor="s3-keep">
                  <b>Keep copies for</b>
                </label>
                <InputNumber id="s3-keep" min={0} max={3650} value={opts.keepDays} disabled={!canChange} onChange={(v) => set({ keepDays: v ?? 30 })} addonAfter="days" style={{ width: 150 }} />
              </div>
            </div>
            <p className="db-hint" style={{ margin: 0 }}>
              The hour is the server's own time{status.serverTime ? ` (it is ${status.serverTime} there now)` : ''}. 0 days keeps everything. One file can be at most 5 GB. Saving sends a small test file first, so a wrong key or bucket is found at once.
            </p>
          </div>
          <Space wrap style={{ marginTop: 14 }}>
            <Button type="primary" disabled={!canChange || !ready || (on && !changed) || job.state === 'running'} onClick={save}>
              {on ? 'Save changes' : 'Check and turn on'}
            </Button>
            {on && (
              <>
                <Button disabled={!canChange || job.state === 'running'} onClick={() => void job.run('Upload to S3 storage', () => window.api.s3.run(project.id)).then(load, load)}>
                  Upload now
                </Button>
                <Button icon={<CloudDownloadOutlined />} disabled={!canChange || job.state === 'running'} onClick={() => setBringing(true)}>
                  Bring a copy back
                </Button>
                <Button danger disabled={!canChange} onClick={disconnect}>
                  Turn off
                </Button>
              </>
            )}
            {!canChange && <span className="db-hint">An Admin or IT Support person can change this.</span>}
          </Space>
        </>
      )}
      <FolderPicker
        projectId={project.id}
        open={browse}
        start={opts.paths[opts.paths.length - 1]}
        onClose={() => setBrowse(false)}
        onPick={(p) => {
          if (!opts.paths.includes(p)) set({ paths: [...opts.paths, p] })
          setBrowse(false)
        }}
      />
      <BringBack
        open={bringing}
        project={project}
        onClose={() => setBringing(false)}
        onFetch={(f) => {
          setBringing(false)
          void job.run(`Bring back ${f.name}`, () => window.api.s3.fetch(project.id, f.id))
        }}
      />
      <JobDrawer job={job} />
    </div>
  )
}
