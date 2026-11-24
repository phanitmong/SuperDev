import { FolderOpenOutlined } from '@ant-design/icons'
import { FolderPicker } from './FolderPicker'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, App as AntApp, Button, Checkbox, Input, InputNumber, Modal, Select, Space, Spin, Table, Tag } from 'antd'
import { CloudDownloadOutlined, CloudUploadOutlined, CopyOutlined, GoogleOutlined } from '@ant-design/icons'
import type { GdriveOptions, GdriveRemoteFile, GdriveStatus, GoogleConnectStart, GoogleStatus, Project } from '@shared/types'
import { JobDrawer, useJob } from './JobLog'
import { ago, bytes, errText } from '../util'

type Step = 'loading' | 'setup' | 'ask-admin' | 'choose' | 'code' | 'expired' | 'denied'

/** Sign in to Google with a short code. The first time, an admin enters the team's Google OAuth client. */
export function GoogleConnect({ open, onClose, onConnected, team = false }: { open: boolean; onClose: () => void; onConnected: (email: string) => void; /** Connect the team's own account (Team → Integrations). */ team?: boolean }) {
  const { message } = AntApp.useApp()
  const [step, setStep] = useState<Step>('loading')
  const [status, setStatus] = useState<GoogleStatus | null>(null)
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [flow, setFlow] = useState<GoogleConnectStart | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const alive = useRef(false)

  const begin = async (): Promise<void> => {
    setError('')
    setStep('loading')
    try {
      const f = await window.api.google.connectStart(team)
      if (!alive.current) return
      setFlow(f)
      setStep('code')
      window.open(f.verificationUrl, '_blank')
      const check = async (): Promise<void> => {
        if (!alive.current) return
        try {
          const r = await window.api.google.connectPoll()
          if (!alive.current) return
          if (r.state === 'done') return onConnected(r.email ?? '')
          if (r.state === 'pending') timer.current = setTimeout(() => void check(), ((r.interval ?? f.interval) + 1) * 1000)
          else setStep(r.state === 'denied' ? 'denied' : 'expired')
        } catch (err) {
          setError(errText(err))
          setStep('expired')
        }
      }
      timer.current = setTimeout(() => void check(), (f.interval + 1) * 1000)
    } catch (err) {
      if (!alive.current) return
      setError(errText(err))
      setStep('expired')
    }
  }

  useEffect(() => {
    if (!open) return
    alive.current = true
    setError('')
    setFlow(null)
    setStep('loading')
    window.api.google
      .status()
      .then((s) => {
        if (!alive.current) return
        setStatus(s)
        setClientId(s.clientId ?? '')
        if (s.configured && !team && s.team) setStep('choose')
        else if (s.configured) void begin()
        else setStep(s.canSetup ? 'setup' : 'ask-admin')
      })
      .catch((err) => {
        setError(errText(err))
        setStep('expired')
      })
    return () => {
      alive.current = false
      clearTimeout(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const saveSetup = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await window.api.google.setup(clientId.trim(), secret.trim())
      await begin()
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  const useTeam = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const r = await window.api.google.useTeam()
      onConnected(r.email)
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={560} destroyOnClose maskClosable={false} title={<span><GoogleOutlined /> {team ? 'Connect the team Google account' : 'Connect Google Drive'}</span>}>
      {step === 'choose' && status?.team && (
        <>
          <p className="gh-lead">Which Google account should hold this server's backups?</p>
          <div className="gd-choice">
            <button type="button" className="gd-choice-item" disabled={busy} onClick={() => void useTeam()}>
              <b>The team's account</b>
              <span className="mono">{status.team.email}</span>
              <span className="db-hint">Connected by {status.team.by ?? 'an admin'}. No Google sign-in needed.</span>
            </button>
            <button type="button" className="gd-choice-item" disabled={busy} onClick={() => void begin()}>
              <b>Another Google account</b>
              <span className="db-hint">Sign in to Google with a short code.</span>
            </button>
          </div>
          {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}
        </>
      )}
      {step === 'loading' && (
        <div className="empty" style={{ padding: 30 }}>
          <Spin />
        </div>
      )}
      {step === 'ask-admin' && <Alert type="info" showIcon message="Not set up yet" description="An admin of this team has to set up the Google connection once. Ask them to open this page, press Connect Google Drive and follow the steps." />}
      {step === 'setup' && (
        <>
          <p className="gh-lead">One-time setup for the whole team, in the Google Cloud Console. It is free and takes about five minutes.</p>
          <ol className="gh-steps">
            <li>
              Open{' '}
              <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">
                console.cloud.google.com
              </a>{' '}
              and create a project, for example <span className="mono">Apsara Panel</span>.
            </li>
            <li>
              <b>APIs &amp; Services → Library</b>: find <b>Google Drive API</b> and press Enable.
            </li>
            <li>
              <b>APIs &amp; Services → OAuth consent screen</b>: choose External, give the app a name and your e-mail. Then, under <b>Audience</b>, press <b>Publish app</b>. If it stays in "Testing", Google ends the sign-in after 7 days and the uploads stop.
            </li>
            <li>
              <b>Credentials → Create credentials → OAuth client ID</b>, application type <b>TVs and Limited Input devices</b>. Copy the Client ID and the Client secret here.
            </li>
          </ol>
          <Input className="mono" placeholder="1234567890-abc...apps.googleusercontent.com" value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} aria-label="Google Client ID" style={{ marginBottom: 8 }} />
          <Input.Password className="mono" placeholder="Client secret" value={secret} onChange={(e) => setSecret(e.target.value)} onPressEnter={() => void saveSetup()} aria-label="Google client secret" autoComplete="off" />
          {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}
          <div className="gh-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="primary" loading={busy} disabled={!clientId.trim() || !secret.trim()} onClick={() => void saveSetup()}>
              Save and connect
            </Button>
          </div>
        </>
      )}
      {step === 'code' && flow && (
        <>
          <p className="gh-lead">Google has opened in your browser. Enter this code there, choose the Google account that should hold the backups, and allow. This window notices by itself when you are done.</p>
          <div className="gh-code">
            <span className="mono">{flow.userCode}</span>
            <Button icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(flow.userCode).then(() => message.success('Code copied'), () => undefined)}>
              Copy
            </Button>
          </div>
          <div className="gh-wait">
            <Spin size="small" /> Waiting for your approval on Google…
          </div>
          <div className="gh-actions">
            <Button onClick={() => window.open(flow.verificationUrl, '_blank')}>Open Google again</Button>
            <Button onClick={onClose}>Cancel</Button>
          </div>
          <p className="db-hint" style={{ marginTop: 12 }}>The app is only allowed to see and change the files it uploads itself. It cannot read anything else in the Drive. You can take the permission back at myaccount.google.com under Security.</p>
        </>
      )}
      {(step === 'expired' || step === 'denied') && (
        <>
          <Alert type={step === 'denied' ? 'warning' : 'error'} showIcon message={step === 'denied' ? 'You declined on Google, so nothing was connected.' : error || 'The code ran out before it was approved.'} />
          <div className="gh-actions">
            {status?.canSetup && <Button onClick={() => { setError(''); setStep('setup') }}>Change the Google client</Button>}
            <Button onClick={onClose}>Close</Button>
            <Button type="primary" onClick={() => void begin()}>
              Try again
            </Button>
          </div>
        </>
      )}
    </Modal>
  )
}

/** What is in the Drive folder, with a button to copy one file back onto the server. */
function BringBack({ open, project, onClose, onFetch }: { open: boolean; project: Project; onClose: () => void; onFetch: (f: GdriveRemoteFile) => void }) {
  const [files, setFiles] = useState<GdriveRemoteFile[] | null>(null)
  const [error, setError] = useState('')
  const [kind, setKind] = useState<'all' | 'database' | 'folder'>('all')

  useEffect(() => {
    if (!open) return
    setFiles(null)
    setError('')
    setKind('all')
    window.api.gdrive
      .remote(project.id)
      .then(setFiles)
      .catch((err) => setError(errText(err)))
  }, [open, project.id])

  const shown = (files ?? []).filter((f) => kind === 'all' || f.kind === kind)
  return (
    <Modal open={open} title="Bring a copy back from Google Drive" footer={<Button onClick={onClose}>Close</Button>} onCancel={onClose} width={820} destroyOnClose>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        A database backup is copied into the backup list on the Databases page; restoring it there asks for your code. A folder archive is unpacked into its own folder under /var/backups/superdevops/from-drive, so nothing on a live site changes until you copy files yourself.
      </p>
      {error && <Alert type="error" showIcon message="Could not look in Google Drive" description={<span style={{ whiteSpace: 'pre-wrap' }}>{error}</span>} />}
      {!files && !error && <Spin />}
      {files && files.length === 0 && <Alert type="info" showIcon message={'There is nothing in this Drive folder yet. Press "Upload now" first.'} />}
      {files && files.length > 0 && (
        <>
          <Select
            aria-label="Kind of backup"
            value={kind}
            onChange={setKind}
            style={{ width: 200, marginBottom: 10 }}
            options={[
              { value: 'all', label: `Everything (${files.length})` },
              { value: 'database', label: `Databases (${files.filter((f) => f.kind === 'database').length})` },
              { value: 'folder', label: `Folders (${files.filter((f) => f.kind === 'folder').length})` }
            ]}
          />
          <Table<GdriveRemoteFile>
            size="small"
            rowKey="id"
            dataSource={shown}
            pagination={shown.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
            columns={[
              { title: 'File', dataIndex: 'name', render: (v: string) => <span className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{v}</span> },
              { title: 'Kind', dataIndex: 'kind', width: 110, render: (v: GdriveRemoteFile['kind']) => (v === 'database' ? 'Database' : 'Folder') },
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

/** Backups copied to Google Drive every hour: database backups and a daily archive of chosen folders. */
export default function GdriveCard({ project, canChange }: { project: Project; canChange: boolean }) {
  const { message, modal } = AntApp.useApp()
  const [status, setStatus] = useState<GdriveStatus | null>(null)
  const [browse, setBrowse] = useState(false)
  const [error, setError] = useState('')
  const [opts, setOpts] = useState<GdriveOptions>({ folder: '', keepDays: 30, includeDb: true, paths: [], everyHours: 1, dailyHour: 2 })
  const [sitePaths, setSitePaths] = useState<string[]>([])
  const [connecting, setConnecting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [bringing, setBringing] = useState(false)
  const job = useJob(`gdrive:${project.id}`)
  const defaultFolder = `Apsara Panel ${project.name}`.replace(/[^A-Za-z0-9 ._-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)

  const load = useCallback(async () => {
    try {
      const s = await window.api.gdrive.status(project.id)
      setStatus(s)
      setError('')
      setOpts(s.enabled ? { folder: s.folder, keepDays: s.keepDays, includeDb: s.includeDb, paths: s.paths, everyHours: s.everyHours ?? 1, dailyHour: s.dailyHour ?? 2 } : (o) => ({ ...o, folder: o.folder || defaultFolder }))
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id, defaultFolder])

  useEffect(() => void load(), [load])
  useEffect(() => {
    window.api.sites
      .list(project.id)
      .then((list) => setSitePaths([...new Set(list.map((s) => s.rootPath.replace(/\/+$/, '')).filter(Boolean))]))
      .catch(() => setSitePaths([]))
  }, [project.id])

  const enable = (email: string): void => {
    setConnecting(false)
    void job.run(`Connect Google Drive${email ? ` (${email})` : ''}`, () => window.api.gdrive.enable(project.id, opts)).then(load)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.gdrive.update(project.id, opts)
      message.success('Saved. It applies from the next upload.')
      await load()
    } catch (err) {
      message.error(errText(err), 8)
    } finally {
      setSaving(false)
    }
  }

  const disconnect = (): void => {
    modal.confirm({
      title: 'Stop copying backups to Google Drive?',
      content: 'The hourly upload stops and the Google sign-in is removed from this server. Files already in the Drive stay there.',
      okText: 'Disconnect',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.api.gdrive.disable(project.id)
          await load()
        } catch (err) {
          message.error(errText(err))
        }
      }
    })
  }

  const changed = !!status?.enabled && (opts.folder !== status.folder || opts.keepDays !== status.keepDays || opts.includeDb !== status.includeDb || (opts.everyHours ?? 1) !== (status.everyHours ?? 1) || (opts.dailyHour ?? 2) !== (status.dailyHour ?? 2) || opts.paths.join('\n') !== status.paths.join('\n'))
  const nothing = !opts.includeDb && opts.paths.length === 0
  const form = (
    <div className="gd-form">
      <div className="gd-field">
        <b>What to copy</b>
        <Checkbox checked={opts.includeDb} disabled={!canChange} onChange={(e) => setOpts({ ...opts, includeDb: e.target.checked })}>
          Every database, backed up once a day (and any backup made on the Databases page)
        </Checkbox>
        <label htmlFor="gd-paths" style={{ marginTop: 8 }}>
          Folders, packed once a day
        </label>
        <Select id="gd-paths" mode="tags" style={{ width: '100%' }} disabled={!canChange} value={opts.paths} onChange={(v) => setOpts({ ...opts, paths: v })} placeholder="Pick a website folder or type a path such as /www/wwwroot/shop" options={sitePaths.map((p) => ({ value: p, label: p }))} tokenSeparators={[',', '\n']} notFoundContent="Type a path and press Enter" />
        <div>
          <Button size="small" icon={<FolderOpenOutlined />} disabled={!canChange} onClick={() => setBrowse(true)}>
            Browse the server for a folder
          </Button>
        </div>
        <FolderPicker
          projectId={project.id}
          open={browse}
          start={opts.paths[opts.paths.length - 1]}
          onClose={() => setBrowse(false)}
          onPick={(p) => {
            if (!opts.paths.includes(p)) setOpts({ ...opts, paths: [...opts.paths, p] })
            setBrowse(false)
          }}
        />
      </div>
      <div className="gd-row">
        <div className="gd-field">
          <label htmlFor="gd-folder">
            <b>Folder in the Drive</b>
          </label>
          <Input id="gd-folder" value={opts.folder} disabled={!canChange} maxLength={80} onChange={(e) => setOpts({ ...opts, folder: e.target.value })} />
        </div>
        <div className="gd-field" style={{ flex: 'none' }}>
          <label htmlFor="gd-keep">
            <b>Keep copies for</b>
          </label>
          <InputNumber id="gd-keep" min={0} max={3650} value={opts.keepDays} disabled={!canChange} onChange={(v) => setOpts({ ...opts, keepDays: v ?? 30 })} addonAfter="days" style={{ width: 150 }} />
        </div>
      </div>
      <div className="gd-row">
        <div className="gd-field">
          <label htmlFor="gd-every">
            <b>Upload to the Drive</b>
          </label>
          <Select
            id="gd-every"
            value={opts.everyHours ?? 1}
            disabled={!canChange}
            onChange={(v: number) => setOpts({ ...opts, everyHours: v })}
            options={[
              { value: 1, label: 'Every hour' },
              { value: 6, label: 'Every 6 hours' },
              { value: 12, label: 'Every 12 hours' },
              { value: 24, label: 'Once a day' }
            ]}
          />
        </div>
        <div className="gd-field" style={{ flex: 'none' }}>
          <label htmlFor="gd-hour">
            <b>{(opts.everyHours ?? 1) === 24 ? 'At' : "Make the day's backups from"}</b>
          </label>
          <InputNumber id="gd-hour" min={0} max={23} value={opts.dailyHour ?? 2} disabled={!canChange} onChange={(v) => setOpts({ ...opts, dailyHour: v ?? 2 })} addonAfter=":00" style={{ width: 150 }} />
        </div>
      </div>
      <p className="db-hint" style={{ margin: 0 }}>
        The hour is the server's own time{status?.serverTime ? ` (it is ${status.serverTime} there now)` : ''}. Each database is backed up and each folder packed once a day, at the first upload from that hour on; "Upload now" does it straight away.
      </p>
      <p className="db-hint" style={{ margin: 0 }}>0 days keeps everything. A folder archive is a full copy each day, so large sites fill a Drive quickly; a free Google account holds 15 GB.</p>
    </div>
  )

  return (
    <div className="card">
      <div className="card-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 10 }}>
        <CloudUploadOutlined /> Copies on Google Drive
        {status?.enabled && <Tag color="green">On</Tag>}
      </div>
      {error && <Alert type="warning" showIcon message={error} style={{ marginBottom: 12 }} />}
      {!status && !error && <Spin />}
      {status && !status.enabled && (
        <>
          <p style={{ color: 'var(--muted)', maxWidth: 720, marginTop: 0 }}>Every hour this server uploads new backups to a folder in your Google Drive, so they survive even if every server is lost. You sign in to Google once; the server keeps uploading by itself.</p>
          {form}
          <Button type="primary" icon={<GoogleOutlined />} disabled={!canChange || nothing || !opts.folder.trim()} onClick={() => setConnecting(true)} style={{ marginTop: 14 }}>
            Connect Google Drive
          </Button>
          {!canChange && <span className="db-hint" style={{ marginLeft: 10 }}>An Admin or IT Support person can turn this on.</span>}
        </>
      )}
      {status?.enabled && (
        <>
          <dl className="kv" style={{ marginBottom: 14 }}>
            <dt>Google account</dt>
            <dd>{status.email || 'Connected'}</dd>
            <dt>In the Drive</dt>
            <dd>
              {status.uploaded} file{status.uploaded === 1 ? '' : 's'} in "{status.folder}"{status.newest ? `, newest ${status.newest.name}` : ''}
            </dd>
            <dt>Last upload run</dt>
            <dd>{status.last ? <span style={{ color: status.last.ok ? undefined : 'var(--bad)' }}>{ago(status.last.at)} · {status.last.message}</span> : 'Not run yet'}</dd>
          </dl>
          {status.last && !status.last.ok && <Alert type="error" showIcon style={{ marginBottom: 12 }} message="The last upload had a problem" description={<pre className="log-box" style={{ maxHeight: 180, margin: 0, whiteSpace: 'pre-wrap' }}>{status.recent.slice(-4).join('\n')}</pre>} />}
          {form}
          <Space wrap style={{ marginTop: 14 }}>
            <Button type="primary" disabled={!canChange || !changed || nothing || !opts.folder.trim()} loading={saving} onClick={() => void save()}>
              Save changes
            </Button>
            <Button disabled={!canChange || job.state === 'running'} onClick={() => void job.run('Upload to Google Drive', () => window.api.gdrive.run(project.id)).then(load)}>
              Upload now
            </Button>
            <Button icon={<CloudDownloadOutlined />} disabled={!canChange || job.state === 'running'} onClick={() => setBringing(true)}>
              Bring a copy back
            </Button>
            <Button disabled={!canChange} onClick={() => setConnecting(true)}>
              Use another Google account
            </Button>
            <Button danger disabled={!canChange} onClick={disconnect}>
              Disconnect
            </Button>
          </Space>
        </>
      )}
      <BringBack
        open={bringing}
        project={project}
        onClose={() => setBringing(false)}
        onFetch={(f) => {
          setBringing(false)
          void job.run(`Bring back ${f.name}`, () => window.api.gdrive.fetch(project.id, f.id, f.name))
        }}
      />
      <GoogleConnect open={connecting} onClose={() => setConnecting(false)} onConnected={enable} />
      <JobDrawer job={job} />
    </div>
  )
}
