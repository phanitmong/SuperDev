import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  App as AntApp,
  AutoComplete,
  Button,
  Checkbox,
  Drawer,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Popover,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import { DeleteOutlined, DownOutlined, ExportOutlined, FolderOpenOutlined, GithubOutlined, LockOutlined, PlusOutlined, ReloadOutlined, RocketOutlined } from '@ant-design/icons'
import ConfirmIdentity from '../components/ConfirmIdentity'
import type {
  GitAccount,
  GithubRefs,
  GithubRepoInfo,
  AppType,
  RunnerKind,
  Backend,
  BackendStatus,
  DeployRecord,
  Framework,
  LbMethod,
  Project,
  ServerEnv,
  Site,
  SiteInput,
  SourceType,
  SslStatus,
  UploadSource,
  DeployTarget
} from '@shared/types'
import { FRAMEWORKS } from '@shared/types'
import { ago, errText } from '../util'
import GitAccounts from '../components/GitAccounts'
import GithubConnect from '../components/GithubConnect'
import FolderInput from '../components/FolderPicker'
import AutoDeploy from '../components/AutoDeploy'
import SiteLogs from '../components/SiteLogs'
import SiteNginx from '../components/SiteNginx'

const APP_TYPES: { value: AppType; label: string }[] = [
  { value: 'php', label: 'PHP' },
  { value: 'static', label: 'Static / SPA' },
  { value: 'proxy', label: 'App on a port' },
  { value: 'balancer', label: 'Load balancer' }
]

type RunnerChoice = 'none' | RunnerKind
const RUNNERS: { value: RunnerChoice; label: string }[] = [
  { value: 'none', label: 'I start it myself (PM2, systemd…)' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'command', label: 'Another command' }
]
const RUNNER_DEFAULT: Record<RunnerKind, string> = {
  python: 'gunicorn app:app --bind 127.0.0.1:{port}',
  java: 'java -jar target/app.jar --server.port={port}',
  command: ''
}
const RUNNER_HINT: Record<RunnerKind, string> = {
  python: 'Runs inside the site\'s own environment (.venv), made at deploy time with the packages from requirements.txt. Put gunicorn or uvicorn in requirements.txt. Django: gunicorn myproject.wsgi --bind 127.0.0.1:{port}. FastAPI: uvicorn main:app --host 127.0.0.1 --port {port}.',
  java: 'Give the path of the jar inside the root path. Build it in the commands after deploy, for example ./mvnw -q package -DskipTests.',
  command: 'Any program that keeps running in the foreground and listens on the port.'
}

const LB_METHODS: { value: LbMethod; label: string }[] = [
  { value: 'round_robin', label: 'Round robin (take turns)' },
  { value: 'least_conn', label: 'Least connections' },
  { value: 'ip_hash', label: 'Sticky by client IP' }
]

interface Job {
  id: string
  title: string
  running: boolean
  failed?: boolean
}

const DAY = 86400000

/** "HTTPS · 64 days": green, orange under 21 days, red under 7 or ended. */
function httpsTag(expires?: number) {
  if (!expires) return <Tag color="green">HTTPS</Tag>
  const days = Math.floor((expires - Date.now()) / DAY)
  const color = days < 7 ? 'red' : days < 21 ? 'orange' : 'green'
  return (
    <Tooltip title={`Certificate valid until ${new Date(expires).toLocaleDateString()}`}>
      <Tag color={color}>{days < 0 ? 'HTTPS · certificate ended' : `HTTPS · ${days} day${days === 1 ? '' : 's'}`}</Tag>
    </Tooltip>
  )
}

/** The certificate as a hosting panel shows it: who issued it, for which names, how long, renewal, and the certificate itself. */
function CertDetails({ status, on, canRenew, onRenew, siteId, canKey }: { status: SslStatus; on: boolean; canRenew: boolean; onRenew: () => void; siteId: string; canKey: boolean }) {
  const [asking, setAsking] = useState(false)
  const [key, setKey] = useState<string | null>(null)
  const days = status.expires ? Math.floor((status.expires - Date.now()) / DAY) : null
  const state = days === null ? 'default' : days < 0 ? 'bad' : days < 21 ? 'warn' : 'ok'
  return (
    <div className="cert">
      <div className={`cert-head cert-${state}`}>
        <b>{days === null ? 'Certificate installed' : days < 0 ? 'Certificate has ended' : `Valid · ${days} day${days === 1 ? '' : 's'} left`}</b>
        <span>{on ? 'HTTPS is on for this site.' : 'HTTPS is off: the certificate is installed but not used yet.'}</span>
      </div>
      <dl className="cert-kv">
        <dt>Issued by</dt>
        <dd>{status.issuer ?? 'Unknown'}</dd>
        <dt>Domains</dt>
        <dd>
          {status.domains.map((d) => (
            <Tag key={d}>{d}</Tag>
          ))}
        </dd>
        <dt>Valid from</dt>
        <dd>{status.starts ? new Date(status.starts).toLocaleString() : 'Unknown'}</dd>
        <dt>Valid until</dt>
        <dd>{status.expires ? new Date(status.expires).toLocaleString() : 'Unknown'}</dd>
        <dt>Renewal</dt>
        <dd>
          {status.autoRenew ? (
            <>Automatic, about 30 days before it ends</>
          ) : (
            <span style={{ color: 'var(--warn)' }}>The automatic renewal of certbot is not set up on this server. Renew by hand before it ends.</span>
          )}
          {canRenew && (
            <Button size="small" style={{ marginLeft: 10 }} onClick={onRenew}>
              Renew now
            </Button>
          )}
        </dd>
        {status.fingerprint && (
          <>
            <dt>Fingerprint</dt>
            <dd className="mono cert-fp">SHA-256 {status.fingerprint}</dd>
          </>
        )}
        {status.path && (
          <>
            <dt>Files</dt>
            <dd className="mono cert-fp">{status.path}/fullchain.pem · privkey.pem</dd>
          </>
        )}
      </dl>
      {status.pem && (
        <div className="cert-pem">
          <div className="cert-pem-head">
            <span>Certificate (PEM)</span>
            <Typography.Text copyable={{ text: status.pem, tooltips: ['Copy certificate', 'Copied'] }} />
          </div>
          <Input.TextArea className="mono" value={status.pem} readOnly autoSize={{ minRows: 4, maxRows: 8 }} aria-label="Certificate (PEM)" />
          {key === null && <div className="cert-note">The private key stays on the server.{canKey ? ' It can be shown after an authenticator code.' : ' Admins and IT Support can show it with an authenticator code.'}</div>}
        </div>
      )}
      {status.pem && canKey && (
        <div className="cert-pem">
          <div className="cert-pem-head">
            <span>Private key</span>
            {key ? (
              <Space size={8}>
                <Typography.Text copyable={{ text: key, tooltips: ['Copy private key', 'Copied'] }} />
                <Button size="small" onClick={() => setKey(null)}>
                  Hide
                </Button>
              </Space>
            ) : (
              <Button size="small" icon={<LockOutlined />} onClick={() => setAsking(true)}>
                Show private key
              </Button>
            )}
          </div>
          {key && (
            <>
              <Input.TextArea className="mono" value={key} readOnly autoSize={{ minRows: 4, maxRows: 8 }} aria-label="Private key (PEM)" />
              <div className="cert-note" style={{ color: '#f79009' }}>Anyone with this key can pretend to be this site. Paste it only into a server or service you control, and never into chat or email.</div>
            </>
          )}
        </div>
      )}
      <ConfirmIdentity
        open={asking}
        title="Confirm it is you"
        about="The private key lets anyone pretend to be this site. Enter a fresh code to show it. Showing it is written to the audit log."
        okText="Show key"
        onCancel={() => setAsking(false)}
        onProof={async (proof) => {
          await window.api.session.confirm(proof, `show the private key of ${status.domains[0] ?? 'a site'}`)
          setKey(await window.api.ssl.privateKey(siteId))
          setAsking(false)
        }}
      />
    </div>
  )
}

export default function Sites({ project, projects, canOps = false, canDanger = false, onOpenFolder }: { project: Project; projects: Project[]; canOps?: boolean; canDanger?: boolean; /** Open the file manager at a folder; missing when this person has no file access. */ onOpenFolder?: (path: string) => void }) {
  const { message, modal } = AntApp.useApp()
  const [sites, setSites] = useState<Site[]>([])
  const [env, setEnv] = useState<ServerEnv | null>(null)
  const [envError, setEnvError] = useState<string | null>(null)
  const [envLoading, setEnvLoading] = useState(true)
  const [editing, setEditing] = useState<Site | 'new' | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [logText, setLogText] = useState('')
  const [preview, setPreview] = useState<{ name: string; conf: string } | null>(null)
  const [history, setHistory] = useState<{ site: Site; rows: DeployRecord[] | null } | null>(null)
  const [auto, setAuto] = useState<Site | null>(null)
  const [https, setHttps] = useState<{ site: Site; status: SslStatus | null; email: string; force: boolean } | null>(null)
  const [nginxFor, setNginxFor] = useState<Site | null>(null)
  const [logsFor, setLogsFor] = useState<Site | null>(null)
  /** Certificate expiry per site certificate name, for the HTTPS tag in the list. */
  const [expiry, setExpiry] = useState<Record<string, number>>({})
  const [domainsFor, setDomainsFor] = useState<{ site: Site; list: string[]; text: string } | null>(null)
  const httpsIsIp = !!https && https.site.domain.split(/\s+/).some((d) => /^\d{1,3}(\.\d{1,3}){3}$/.test(d) || (d.includes(':') && /^[0-9a-f:.]+$/i.test(d)))
  const [health, setHealth] = useState<{ name: string; rows: BackendStatus[] | null } | null>(null)
  const jobRef = useRef<string | null>(null)
  const logEnd = useRef<HTMLDivElement>(null)

  const loadSites = useCallback(async () => {
    // Newest site first.
    setSites([...(await window.api.sites.list(project.id))].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)))
    window.api.ssl
      .expiries(project.id)
      .then(setExpiry)
      .catch(() => undefined)
  }, [project.id])

  const loadEnv = useCallback(async () => {
    setEnvLoading(true)
    setEnvError(null)
    try {
      setEnv(await window.api.sites.preflight(project.id))
    } catch (err) {
      setEnvError(errText(err))
    } finally {
      setEnvLoading(false)
    }
  }, [project.id])

  useEffect(() => {
    void loadSites()
    void loadEnv()
    return window.api.sites.onLog(({ jobId, chunk }) => {
      if (jobId === jobRef.current) setLogText((t) => t + chunk)
    })
  }, [loadSites, loadEnv])

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'end' })
  }, [logText])

  const startJob = (id: string, title: string): void => {
    jobRef.current = id
    setLogText('')
    setJob({ id, title, running: true })
  }

  /** A refusal before the task started (a check of the settings, permissions, a lost connection) never reached the log: add it, so a failed task always says why. */
  const finishJob = (failed: boolean, err?: unknown): void => {
    if (failed && err !== undefined) {
      const why = errText(err)
      setLogText((t) => (t.includes(why) ? t : `${t}${t ? '\n' : ''}[failed] ${why}\n`))
    }
    setJob((j) => (j ? { ...j, running: false, failed } : j))
  }

  const deploy = async (site: Site, upload?: UploadSource, target: DeployTarget = 'production'): Promise<void> => {
    startJob(site.id, target === 'preview' ? `Preview ${site.name}` : `Deploy ${site.name}`)
    try {
      await window.api.sites.deploy(site.id, upload, target)
      finishJob(false)
      message.success(target === 'preview' ? `Preview of ${site.name} is ready at /preview` : `${site.name} deployed`)
    } catch (err) {
      finishJob(true, err)
    }
    await loadSites()
  }

  const deployUpload = async (site: Site, kind: 'folder' | 'archive', target: DeployTarget = 'production'): Promise<void> => {
    const path = await window.api.sites.pickUpload(kind)
    if (path) await deploy(site, { kind, path }, target)
  }

  const promote = (site: Site): void => {
    modal.confirm({
      title: `Push the preview of ${site.name} to production?`,
      content: (
        <div>
          The live files are replaced by the preview's files (files that are not in the preview are removed). The live files are saved first, and if the site stops answering they are put back.
          {site.postDeploy.trim() ? ' Post-deploy commands run now.' : ''}
        </div>
      ),
      okText: 'Push to production',
      onOk: () => {
        startJob(site.id, `Push preview of ${site.name} to production`)
        window.api.sites
          .promote(site.id)
          .then(() => {
            finishJob(false)
            message.success(`${site.name}: the preview is live`)
          })
          .catch((err) => finishJob(true, err))
          .finally(() => void loadSites())
      }
    })
  }

  const discardPreview = (site: Site): void => {
    modal.confirm({
      title: `Discard the preview of ${site.name}?`,
      content: 'The preview files are deleted and /preview stops working. The live site is not touched.',
      okText: 'Discard preview',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.api.sites.discardPreview(site.id)
          message.success('Preview discarded')
        } catch (err) {
          message.error(errText(err))
        }
        await loadSites()
      }
    })
  }

  const install = (group: 'base' | 'php'): void => {
    const what = group === 'base' ? 'nginx, git, unzip and curl' : 'PHP-FPM with common extensions'
    modal.confirm({
      title: `Install ${what}?`,
      content: `This runs the system package manager on ${project.host} with administrator rights.`,
      okText: 'Install',
      onOk: () => {
        startJob(`install:${project.id}`, `Install ${group === 'base' ? 'web tools' : 'PHP'}`)
        window.api.sites
          .install(project.id, group)
          .then(() => finishJob(false))
          .catch((err) => finishJob(true, err))
          .finally(() => void loadEnv())
      }
    })
  }

  const remove = (site: Site): void => {
    let removeConfig = true
    modal.confirm({
      title: `Remove site "${site.name}"?`,
      content: (
        <div>
          {site.appType !== 'balancer' && <p>The site's files in {site.rootPath} stay on the server.</p>}
          <Checkbox defaultChecked onChange={(e) => (removeConfig = e.target.checked)}>
            Also remove its nginx config (takes the site offline)
          </Checkbox>
        </div>
      ),
      okText: 'Remove site',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.api.sites.remove(site.id, removeConfig)
          await loadSites()
        } catch (err) {
          message.error(errText(err))
          throw err
        }
      }
    })
  }

  const showConfig = async (site: Site): Promise<void> => {
    try {
      setPreview({ name: site.name, conf: await window.api.sites.previewNginx(site.id) })
    } catch (err) {
      message.error(errText(err))
    }
  }

  const showHistory = async (site: Site): Promise<void> => {
    setHistory({ site, rows: null })
    try {
      const rows = await window.api.sites.history(site.id)
      setHistory({ site, rows })
    } catch (err) {
      setHistory(null)
      message.error(errText(err))
    }
  }

  const rollback = (site: Site, rec: DeployRecord): void => {
    const what = rec.commit ? `"${rec.commitMessage ?? rec.commit.slice(0, 7)}" (${rec.commit.slice(0, 7)})` : 'the files saved before that deploy'
    modal.confirm({
      title: `Roll ${site.name} back?`,
      content:
        site.source === 'git'
          ? `The site's code goes back to ${what}. Post-deploy commands run again. Files that are not in git (uploads, .env) are not touched.`
          : `${what} are unpacked over the site. Files created since then are kept.`,
      okText: 'Roll back',
      okButtonProps: { danger: true },
      onOk: () => {
        setHistory(null)
        startJob(site.id, `Roll back ${site.name}`)
        window.api.sites
          .rollback(site.id, rec.id)
          .then(() => finishJob(false))
          .catch((err) => finishJob(true, err))
          .finally(() => void loadSites())
      }
    })
  }

  const openHttps = async (site: Site): Promise<void> => {
    setHttps({ site, status: null, email: site.sslEmail ?? '', force: site.forceHttps ?? true })
    try {
      const status = await window.api.ssl.status(site.id)
      setHttps((h) => (h && h.site.id === site.id ? { ...h, status } : h))
    } catch (err) {
      setHttps(null)
      message.error(errText(err))
    }
  }

  const renewHttps = (): void => {
    if (!https) return
    const { site } = https
    modal.confirm({
      title: `Renew the certificate of ${site.name} now?`,
      content: "It renews by itself about 30 days before it ends, so this is only needed after a change. Let's Encrypt allows 5 renewals of the same names per week.",
      okText: 'Renew now',
      onOk: () => {
        setHttps(null)
        startJob(`ssl:${site.id}`, `Renew certificate of ${site.name}`)
        window.api.ssl
          .renew(site.id)
          .then(() => finishJob(false))
          .catch((err) => finishJob(true, err))
          .finally(() => void loadSites())
      }
    })
  }

  const applyHttps = (turnOn: boolean): void => {
    if (!https) return
    const { site, email, force } = https
    setHttps(null)
    startJob(`ssl:${site.id}`, turnOn ? `HTTPS for ${site.name}` : `Turn off HTTPS for ${site.name}`)
    const task = turnOn ? window.api.ssl.enable(site.id, email, force) : window.api.ssl.disable(site.id)
    task
      .then(() => finishJob(false))
      .catch((err) => finishJob(true, err))
      .finally(() => void loadSites())
  }

  const RE_DOMAIN_UI = /^(_|(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*)$/
  /** Add what is typed in the Domains window: one name, or several separated by spaces, commas or new lines. */
  const addDomains = (): void => {
    if (!domainsFor) return
    const typed = domainsFor.text.split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean)
    if (typed.length === 0) return
    const bad = typed.find((d) => !RE_DOMAIN_UI.test(d))
    if (bad) return void message.error(`"${bad}" is not a valid domain.`)
    setDomainsFor({ ...domainsFor, list: [...new Set([...domainsFor.list, ...typed])], text: '' })
  }
  const saveDomains = (): void => {
    if (!domainsFor) return
    const { site, list } = domainsFor
    setDomainsFor(null)
    startJob(`domains:${site.id}`, `Domains of ${site.name}`)
    window.api.sites
      .setDomains(site.id, list)
      .then(() => finishJob(false))
      .catch((err) => finishJob(true, err))
      .finally(() => void loadSites())
  }

  const saveNginx = (site: Site, input: Parameters<typeof window.api.sites.setNginx>[1]): void => {
    setNginxFor(null)
    startJob(`nginx:${site.id}`, `Reverse proxy and Nginx of ${site.name}`)
    window.api.sites
      .setNginx(site.id, input)
      .then(() => finishJob(false))
      .catch((err) => finishJob(true, err))
      .finally(() => void loadSites())
  }

  const stopStart = (site: Site): void => {
    const go = async (): Promise<void> => {
      try {
        await window.api.sites.setStopped(site.id, !site.stopped)
        message.success(site.stopped ? `${site.name} is running again` : `${site.name} is stopped`)
        await loadSites()
      } catch (err) {
        message.error(errText(err), 8)
      }
    }
    if (site.stopped) return void go()
    modal.confirm({
      title: `Stop ${site.name}?`,
      content: `Visitors of ${site.domain.split(/\s+/)[0]} see a "This site is stopped" page until you start it again.${site.runner ? ' The program the app runs for it is stopped too.' : ''} Files, database, certificate and settings are not touched, and other sites on the server keep running.`,
      okText: 'Stop site',
      okButtonProps: { danger: true },
      onOk: go
    })
  }

  const maintenance = (site: Site): void => {
    let enabled = !site.maintenance
    let allowIp = site.maintenanceAllowIp ?? ''
    modal.confirm({
      title: `Maintenance mode · ${site.name}`,
      width: 480,
      content: (
        <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
          <Checkbox defaultChecked={enabled} onChange={(e) => (enabled = e.target.checked)}>
            Show visitors a "We will be back soon" page (error 503)
          </Checkbox>
          <Input addonBefore="Let this IP through" placeholder="Your own IP (optional)" defaultValue={allowIp} onChange={(e) => (allowIp = e.target.value)} spellCheck={false} />
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>That IP keeps seeing the real site, so you can test while everyone else waits.</div>
        </div>
      ),
      okText: 'Apply',
      onOk: async () => {
        try {
          await window.api.sites.setMaintenance(site.id, enabled, allowIp)
          message.success(enabled ? `${site.name} is in maintenance mode` : `${site.name} is live again`)
          await loadSites()
        } catch (err) {
          message.error(errText(err))
          throw err
        }
      }
    })
  }

  const copySite = (site: Site): void => {
    const others = projects.filter((p) => p.id !== project.id)
    if (others.length === 0) {
      message.info('Add a second server under "Projects" first.')
      return
    }
    let toId = others[0].id
    let withFiles = site.appType !== 'balancer'
    modal.confirm({
      title: `Copy "${site.name}" to another server`,
      width: 480,
      content: (
        <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
          <Select
            defaultValue={toId}
            onChange={(v) => (toId = v)}
            options={others.map((p) => ({ value: p.id, label: `${p.name} (${p.host})` }))}
            aria-label="Destination server"
          />
          {site.appType !== 'balancer' && (
            <Checkbox defaultChecked onChange={(e) => (withFiles = e.target.checked)}>
              Copy the files in {site.rootPath} too
            </Checkbox>
          )}
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>
            Creates the same site there and applies its nginx config. Files with the same name at the destination are overwritten.
            Databases are not copied.
          </div>
        </div>
      ),
      okText: 'Copy site',
      onOk: () => {
        startJob(`sitecopy:${site.id}`, `Copy ${site.name}`)
        window.api.sites
          .copyTo(site.id, toId, withFiles)
          .then(() => finishJob(false))
          .catch((err) => finishJob(true, err))
      }
    })
  }

  const checkBackends = async (site: Site): Promise<void> => {
    setHealth({ name: site.name, rows: null })
    try {
      const rows = await window.api.sites.checkBackends(site.id)
      setHealth({ name: site.name, rows })
    } catch (err) {
      setHealth(null)
      message.error(errText(err))
    }
  }

  const envTag = (label: string, value: string | boolean): React.ReactNode => (
    <Tag color={value ? 'green' : 'default'} style={{ marginInlineEnd: 0 }}>
      {label}
      {typeof value === 'string' && value ? ` ${value}` : value ? '' : ' · not installed'}
    </Tag>
  )

  return (
    <div className="grid">
      <div className="card">
        <div className="card-title">
          Server environment
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => void loadEnv()} aria-label="Refresh environment" />
        </div>
        {envLoading ? (
          <Spin size="small" />
        ) : envError ? (
          <Alert type="error" showIcon message="Could not inspect the server" description={envError} />
        ) : env ? (
          <div className="env-row">
            {env.os && <Tag style={{ marginInlineEnd: 0 }}>{env.os}</Tag>}
            {envTag('nginx', env.nginx)}
            {envTag('PHP', env.php)}
            {envTag('git', env.git)}
            {envTag('unzip', env.unzip)}
            {env.node && envTag('Node', env.node)}
            {env.composer && envTag('Composer', true)}
            <span style={{ flex: 1 }} />
            {(!env.nginx || !env.git || !env.unzip) && (
              <Button size="small" onClick={() => install('base')} disabled={!env.packageManager || job?.running}>
                Install nginx, git, unzip
              </Button>
            )}
            {!env.php && env.phpSockets.length === 0 && (
              <Button size="small" onClick={() => install('php')} disabled={!env.packageManager || job?.running}>
                Install PHP
              </Button>
            )}
          </div>
        ) : null}
      </div>

      <div className="card">
        <div className="card-title">
          Sites
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
            New site
          </Button>
        </div>
        <Table<Site>
          rowKey="id"
          dataSource={sites}
          pagination={false}
          size="middle"
          locale={{
            emptyText: (
              <div style={{ padding: '28px 0' }}>
                No sites yet. Create one, then deploy it from git or by uploading files.
              </div>
            )
          }}
          columns={[
            {
              title: 'Site',
              render: (_, s) => (
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {s.name} {s.ssl && httpsTag(expiry[`superdevops-${s.name}`])}
                    {s.stopped && <Tag color="red">Stopped</Tag>}
                    {s.maintenance && <Tag color="orange">Maintenance</Tag>}
                    {s.preview && <PreviewTag site={s} busy={!!job?.running} onPromote={() => promote(s)} onDiscard={() => discardPreview(s)} />}
                  </div>
                  {/* Each address can be selected, copied with its scheme, or opened in the browser. */}
                  {s.domain
                    .split(/\s+/)
                    .filter(Boolean)
                    .map((d) => {
                      const url = `${s.ssl ? 'https' : 'http'}://${d}`
                      return (
                        <div key={d} className="site-url">
                          <Typography.Text copyable={{ text: url, tooltips: [`Copy ${url}`, 'Copied'] }} style={{ color: 'var(--muted)', fontSize: 12 }}>
                            {d}
                          </Typography.Text>
                          <Tooltip title={`Open ${url}`}>
                            <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${url}`} className="site-url-open">
                              <ExportOutlined />
                            </a>
                          </Tooltip>
                        </div>
                      )
                    })}
                  {s.appType !== 'balancer' && (
                    <div className="site-root">
                      {onOpenFolder ? (
                        <Tooltip title="Open this folder in Files">
                          <button type="button" className="site-root-link" onClick={() => onOpenFolder(s.rootPath)}>
                            <FolderOpenOutlined /> <span className="mono">{s.rootPath}</span>
                          </button>
                        </Tooltip>
                      ) : (
                        <span className="site-root-link">
                          <FolderOpenOutlined /> <span className="mono">{s.rootPath}</span>
                        </span>
                      )}
                      {s.preview && onOpenFolder && (
                        <Tooltip title="Open the preview's folder in Files">
                          <button type="button" className="site-root-link" onClick={() => onOpenFolder(`${s.rootPath}.preview`)}>
                            preview
                          </button>
                        </Tooltip>
                      )}
                    </div>
                  )}
                </div>
              )
            },
            {
              title: 'Type',
              render: (_, s) => (
                <Space size={4} wrap>
                  {s.appType === 'balancer' ? (
                    <>
                      <Tag color="purple">Load balancer</Tag>
                      <Tag>
                        {s.backends?.length ?? 0} server{(s.backends?.length ?? 0) === 1 ? '' : 's'}
                      </Tag>
                    </>
                  ) : (
                    <Tag color="blue">{s.appType === 'proxy' ? `${s.runner?.kind === 'python' ? 'Python' : s.runner?.kind === 'java' ? 'Java' : s.runner ? 'App' : 'Proxy'} :${s.proxyPort}` : s.appType === 'php' ? 'PHP' : 'Static'}</Tag>
                  )}
                  {(s.appType === 'php' || s.appType === 'static') && s.framework !== 'none' && <Tag>{FRAMEWORKS[s.framework].label}</Tag>}
                </Space>
              )
            },
            {
              title: 'Source',
              render: (_, s) =>
                s.appType === 'balancer' ? (
                  <span style={{ color: 'var(--muted)' }}>{LB_METHODS.find((m) => m.value === (s.lbMethod ?? 'round_robin'))?.label}</span>
                ) : s.source === 'git' ? (
                  <span>
                    <span className="mono" style={{ fontSize: 12 }}>
                      git · {s.branch}
                    </span>
                    {s.autoDeploy && (
                      <Tooltip title="The server checks the repository every 2 minutes and deploys new commits by itself.">
                        <Tag color="blue" style={{ marginLeft: 8 }}>
                          Auto
                        </Tag>
                      </Tooltip>
                    )}
                  </span>
                ) : (
                  'Manual upload'
                )
            },
            {
              title: 'Last deploy',
              render: (_, s) =>
                s.lastDeployAt ? (
                  <Space size={6}>
                    <Tag color={s.lastDeployStatus === 'success' ? 'green' : s.lastDeployStatus === 'rolled_back' ? 'orange' : 'red'} style={{ marginInlineEnd: 0 }}>
                      {s.lastDeployStatus === 'success' ? 'Success' : s.lastDeployStatus === 'rolled_back' ? 'Rolled back' : 'Failed'}
                    </Tag>
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>{ago(s.lastDeployAt)}</span>
                  </Space>
                ) : (
                  <span style={{ color: 'var(--muted)' }}>Never</span>
                )
            },
            {
              title: '',
              align: 'right',
              render: (_, s) => (
                <Space>
                  {s.appType === 'balancer' || s.source === 'git' ? (
                    <Button type="primary" ghost icon={<RocketOutlined />} disabled={job?.running || s.stopped} title={s.stopped ? 'Start the site first' : undefined} onClick={() => void deploy(s)}>
                      {s.appType === 'balancer' ? 'Apply' : 'Deploy'}
                    </Button>
                  ) : (
                    <Dropdown
                      trigger={['click']}
                      disabled={job?.running || s.stopped}
                      menu={{
                        items: [
                          {
                            type: 'group',
                            label: 'Production',
                            children: [
                              { key: 'folder', label: 'Upload a folder…' },
                              { key: 'archive', label: 'Upload a .zip or .tar.gz…' }
                            ]
                          },
                          ...(s.appType === 'static' || s.appType === 'php'
                            ? [
                                { type: 'divider' as const },
                                {
                                  type: 'group' as const,
                                  label: 'Preview at /preview (live site unchanged)',
                                  children: [
                                    { key: 'pfolder', label: 'Upload a folder to preview…' },
                                    { key: 'parchive', label: 'Upload a .zip or .tar.gz to preview…' },
                                    ...(s.preview ? [{ key: 'promote', label: 'Push preview to production…' }, { key: 'discard', label: 'Discard preview…', danger: true }] : [])
                                  ]
                                }
                              ]
                            : []),
                          { type: 'divider' },
                          { key: 'config', label: 'Apply nginx config only' }
                        ],
                        onClick: ({ key }) => {
                          if (key === 'config') void deploy(s)
                          else if (key === 'pfolder') void deployUpload(s, 'folder', 'preview')
                          else if (key === 'parchive') void deployUpload(s, 'archive', 'preview')
                          else if (key === 'promote') promote(s)
                          else if (key === 'discard') discardPreview(s)
                          else void deployUpload(s, key as 'folder' | 'archive')
                        }
                      }}
                    >
                      <Button type="primary" ghost icon={<RocketOutlined />}>
                        Deploy <DownOutlined />
                      </Button>
                    </Dropdown>
                  )}
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: [
                        { key: 'edit', label: 'Edit site' },
                        ...(s.appType !== 'balancer' ? [{ key: 'history', label: 'Deploy history and rollback' }] : []),
                        ...(s.appType !== 'balancer' && s.source === 'git' ? [{ key: 'auto', label: s.autoDeploy ? 'Auto deploy (on)' : 'Auto deploy on push' }] : []),
                        ...(onOpenFolder && s.appType !== 'balancer' ? [{ key: 'folder', label: 'Open site folder' }] : []),
                        { key: 'logs', label: 'Logs' },
                        { key: 'domains', label: `Domains (${s.domain.split(/\s+/).filter(Boolean).length})…` },
                        { key: 'nginx', label: `Reverse proxy & Nginx${(s.proxyRules ?? []).length ? ` (${(s.proxyRules ?? []).length})` : ''}…` },
                        { key: 'conf', label: 'View nginx config' },
                        ...(s.appType === 'balancer' ? [{ key: 'health', label: 'Check backends' }] : []),
                        { key: 'https', label: s.ssl ? 'HTTPS (on)…' : 'HTTPS certificate…' },
                        { key: 'maint', label: s.maintenance ? 'Maintenance mode (on)…' : 'Maintenance mode…' },
                        { key: 'stop', label: s.stopped ? 'Start site' : 'Stop site…' },
                        { key: 'copy', label: 'Copy to another server…' },
                        { type: 'divider' as const },
                        { key: 'remove', label: 'Remove site', danger: true }
                      ],
                      onClick: ({ key }) => {
                        if (key === 'edit') setEditing(s)
                        if (key === 'domains') setDomainsFor({ site: s, list: s.domain.split(/\s+/).filter(Boolean), text: '' })
                        if (key === 'conf') void showConfig(s)
                        if (key === 'history') void showHistory(s)
                        if (key === 'auto') setAuto(s)
                        if (key === 'health') void checkBackends(s)
                        if (key === 'copy') copySite(s)
                        if (key === 'nginx') setNginxFor(s)
                        if (key === 'logs') setLogsFor(s)
                        if (key === 'folder') onOpenFolder?.(s.rootPath)
                        if (key === 'maint') maintenance(s)
                        if (key === 'stop') stopStart(s)
                        if (key === 'https') void openHttps(s)
                        if (key === 'remove') remove(s)
                      }
                    }}
                  >
                    <Button>More</Button>
                  </Dropdown>
                </Space>
              )
            }
          ]}
        />
      </div>

      {auto && <AutoDeploy site={sites.find((x) => x.id === auto.id) ?? auto} onClose={() => setAuto(null)} onChanged={loadSites} />}
      {editing && (
        <SiteModal
          projectId={project.id}
          site={editing === 'new' ? null : editing}
          env={env}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await loadSites()
          }}
        />
      )}

      <Drawer
        open={!!job}
        title={
          <Space>
            {job?.title}
            {job?.running ? <Tag color="processing">Running</Tag> : job?.failed ? <Tag color="red">Failed</Tag> : <Tag color="green">Done</Tag>}
          </Space>
        }
        width={640}
        onClose={() => setJob(null)}
        styles={{ body: { padding: 16 } }}
      >
        <pre className="log-box">
          {logText || 'Starting…'}
          <div ref={logEnd} />
        </pre>
      </Drawer>

      <Modal open={!!preview} title={`nginx config · ${preview?.name ?? ''}`} footer={null} width={720} onCancel={() => setPreview(null)}>
        <pre className="log-box" style={{ maxHeight: 460 }}>
          {preview?.conf}
        </pre>
      </Modal>

      <Modal open={!!history} title={`Deploy history · ${history?.site.name ?? ''}`} footer={null} width={760} onCancel={() => setHistory(null)}>
        {!history?.rows ? (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : history.rows.length === 0 ? (
          <div style={{ color: 'var(--muted)' }}>Nothing has been deployed from this app yet.</div>
        ) : (
          <Table<DeployRecord>
            rowKey="id"
            size="small"
            pagination={history.rows.length > 8 ? { pageSize: 8, showSizeChanger: false } : false}
            dataSource={history.rows}
            columns={[
              { title: 'When', render: (_, d) => <span title={new Date(d.time).toLocaleString()}>{ago(d.time)}</span> },
              {
                title: 'Result',
                render: (_, d) => (
                  <Space size={4}>
                    {d.kind === 'preview' && <Tag color="purple" style={{ marginInlineEnd: 0 }}>Preview</Tag>}
                    {d.kind === 'promote' && <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>Preview pushed</Tag>}
                    <Tag color={d.status === 'success' ? 'green' : d.status === 'rolled_back' ? 'orange' : 'red'} style={{ marginInlineEnd: 0 }}>
                      {d.kind === 'rollback' ? 'Rollback' : d.kind === 'preview' ? (d.status === 'success' ? 'Ready' : 'Not answering') : d.status === 'success' ? 'Deployed' : d.status === 'rolled_back' ? 'Rolled back' : 'Failed'}
                    </Tag>
                    {d.health !== undefined && <span style={{ color: 'var(--muted)', fontSize: 12 }}>{d.health ? `HTTP ${d.health}` : 'no answer'}</span>}
                  </Space>
                )
              },
              {
                title: 'Version',
                render: (_, d) => (
                  <div style={{ maxWidth: 300 }}>
                    {d.commit ? (
                      <>
                        <span className="mono">{d.commit.slice(0, 7)}</span> {d.commitMessage}
                      </>
                    ) : d.snapshot ? (
                      'Previous files saved'
                    ) : (
                      <span style={{ color: 'var(--muted)' }}>-</span>
                    )}
                    {d.note && <div style={{ color: 'var(--muted)', fontSize: 12 }}>{d.note}</div>}
                  </div>
                )
              },
              {
                title: '',
                align: 'right',
                render: (_, d, index) => {
                  const target = history.site.source === 'git' ? d.commit : d.snapshot
                  // The newest successful entry is what is live now; going "back" to it does nothing.
                  const isCurrent = index === 0 && d.status === 'success' && history.site.source === 'git'
                  if (!target || d.status === 'failed' || isCurrent) return null
                  return (
                    <Button size="small" disabled={job?.running} onClick={() => rollback(history.site, d)}>
                      {history.site.source === 'git' ? 'Roll back to this' : 'Undo this deploy'}
                    </Button>
                  )
                }
              }
            ]}
          />
        )}
      </Modal>

      <SiteNginx site={nginxFor} onClose={() => setNginxFor(null)} onApply={saveNginx} />
      <SiteLogs site={logsFor} canClear={canOps} onClose={() => setLogsFor(null)} />

      <Modal
        open={!!domainsFor}
        title={domainsFor ? `Domains · ${domainsFor.site.name}` : ''}
        width={560}
        onCancel={() => setDomainsFor(null)}
        okText="Save and apply"
        okButtonProps={{ disabled: !domainsFor || domainsFor.list.length === 0 || domainsFor.list.join(' ') === domainsFor.site.domain.trim().split(/\s+/).join(' ') }}
        onOk={saveDomains}
        destroyOnClose
      >
        {domainsFor && (
          <div style={{ display: 'grid', gap: 12 }}>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                className="mono"
                placeholder="shop.example.com www.shop.example.com"
                value={domainsFor.text}
                onChange={(e) => setDomainsFor({ ...domainsFor, text: e.target.value })}
                onPressEnter={addDomains}
                spellCheck={false}
                autoFocus
                aria-label="Domains to add"
              />
              <Button type="primary" onClick={addDomains} disabled={!domainsFor.text.trim()}>
                Add
              </Button>
            </Space.Compact>
            <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: -4 }}>Several at once: separate them with spaces or commas. Each name must point to this server in DNS.</div>
            <Table
              size="small"
              rowKey={(d) => d}
              pagination={domainsFor.list.length > 10 ? { pageSize: 10 } : false}
              dataSource={domainsFor.list}
              locale={{ emptyText: 'A site needs at least one domain' }}
              columns={[
                { title: 'Domain', render: (_, d) => <span className="mono">{d}</span> },
                { title: '', width: 90, render: (_, d) => (domainsFor.site.domain.split(/\s+/).includes(d) ? null : <Tag color="blue">New</Tag>) },
                {
                  title: '',
                  align: 'right',
                  width: 90,
                  render: (_, d) => (
                    <Button size="small" danger disabled={domainsFor.list.length === 1} onClick={() => setDomainsFor({ ...domainsFor, list: domainsFor.list.filter((x) => x !== d) })}>
                      Remove
                    </Button>
                  )
                }
              ]}
            />
            {domainsFor.site.ssl && (
              <Alert
                type="info"
                showIcon
                message="This site has HTTPS on."
                description="After saving, the certificate is widened to cover the new names. A name that does not point to this server yet cannot be added to it and would show a certificate warning."
              />
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={!!https}
        title={`HTTPS · ${https?.site.name ?? ''}`}
        width={https?.status?.hasCert ? 720 : 520}
        onCancel={() => setHttps(null)}
        footer={
          https?.status ? (
            <Space>
              {https.site.ssl && (
                <Button danger onClick={() => applyHttps(false)}>
                  Turn off HTTPS
                </Button>
              )}
              <Button type="primary" disabled={!https.status.hasCert && httpsIsIp} onClick={() => applyHttps(true)}>
                {https.site.ssl ? 'Apply' : https.status.hasCert ? 'Turn on HTTPS' : 'Get certificate and turn on HTTPS'}
              </Button>
            </Space>
          ) : null
        }
      >
        {!https?.status ? (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 14 }}>
            {https.status.hasCert ? (
              <CertDetails status={https.status} on={!!https.site.ssl} canRenew={!!https.site.ssl} onRenew={renewHttps} siteId={https.site.id} canKey={canDanger} />
            ) : (
              httpsIsIp ? (
                <Alert
                  type="warning"
                  showIcon
                  message="This site's address is an IP address, not a domain name."
                  description={`A free certificate from here needs a domain name. Point a domain (for example app.example.com) at ${https.site.domain.split(/\s+/)[0]}, put it in the site's Domain field, then come back.`}
                />
              ) : (
              <Alert
                type="info"
                showIcon
                message="A free Let's Encrypt certificate will be requested."
                description={`Before you start: ${https.site.domain.split(/\s+/).join(', ')} must already point to this server. Ports 80 and 443 are opened in the server's own firewall for you; a cloud provider's firewall (security group) must allow them too.`}
              />
              )
            )}
            <Checkbox checked={https.force} onChange={(e) => setHttps({ ...https, force: e.target.checked })}>
              Send all HTTP visitors to HTTPS
            </Checkbox>
            {!https.status.hasCert && <div style={{ color: 'var(--muted)', fontSize: 12 }}>The certificate renews by itself. If the request fails, the site keeps working over HTTP.</div>}
          </div>
        )}
      </Modal>

      <Modal open={!!health} title={`Backends · ${health?.name ?? ''}`} footer={null} width={460} onCancel={() => setHealth(null)}>
        {!health?.rows ? (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : (
          <>
            <table className="plain">
              <tbody>
                {health.rows.map((r) => (
                  <tr key={r.address}>
                    <td className="mono">{r.address}</td>
                    <td style={{ textAlign: 'right' }}>
                      <Tag color={r.up ? 'green' : 'red'} style={{ marginInlineEnd: 0 }}>
                        {r.up ? 'Reachable' : 'Not reachable'}
                      </Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 12 }}>
              Tested from the load balancer server by opening a TCP connection to each backend.
            </div>
          </>
        )}
      </Modal>
    </div>
  )
}

interface SiteForm {
  name: string
  domain: string
  appType: AppType
  framework: Framework
  rootPath: string
  publicDir: string
  phpUpstream: string
  proxyPort: number
  runnerKind: RunnerChoice
  runnerCommand: string
  runnerUser: string
  source: SourceType
  repoUrl: string
  branch: string
  gitAccountId: string
  postDeploy: string
  lbMethod: LbMethod
  backends: Backend[]
  healthPath: string
  autoRollback: boolean
}

function SiteModal({
  projectId,
  site,
  env,
  onClose,
  onSaved
}: {
  projectId: string
  site: Site | null
  env: ServerEnv | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { message } = AntApp.useApp()
  const [form] = Form.useForm<SiteForm>()
  const appType = Form.useWatch('appType', form) ?? site?.appType ?? 'php'
  const source = Form.useWatch('source', form) ?? site?.source ?? 'git'
  const runnerKind: RunnerChoice = Form.useWatch('runnerKind', form) ?? site?.runner?.kind ?? 'none'
  const framework = Form.useWatch('framework', form) ?? site?.framework ?? 'none'
  const [saving, setSaving] = useState(false)
  const gitAccountId = Form.useWatch('gitAccountId', form) ?? site?.gitAccountId ?? ''
  const [gits, setGits] = useState<GitAccount[]>([])
  const [gitOpen, setGitOpen] = useState(false)
  const loadGits = useCallback(async () => {
    try {
      setGits(await window.api.git.list())
    } catch {
      setGits([])
    }
  }, [])
  useEffect(() => void loadGits(), [loadGits])
  const isGithub = gits.find((g) => g.id === gitAccountId)?.provider === 'github'
  const repoUrl = Form.useWatch('repoUrl', form) ?? site?.repoUrl ?? ''
  const [repos, setRepos] = useState<GithubRepoInfo[]>([])
  const [reposState, setReposState] = useState('')
  const [branchList, setBranchList] = useState<string[]>([])
  const [refs, setRefs] = useState<GithubRefs>({ branches: [], tags: [] })
  const [refsLoading, setRefsLoading] = useState(false)
  const [refsTick, setRefsTick] = useState(0)
  const [ghOpen, setGhOpen] = useState(false)
  // "github": connect an account and pick from lists. "manual": type an address, for other hosts or the server's own key.
  const [gitMode, setGitMode] = useState<'github' | 'manual'>(site && site.source === 'git' && site.repoUrl && !site.gitAccountId ? 'manual' : 'github')
  const githubAccounts = useMemo(() => gits.filter((g) => g.provider === 'github'), [gits])
  const ghAccount = githubAccounts.find((g) => g.id === gitAccountId)
  useEffect(() => {
    if (gitMode !== 'github' || gits.length === 0) return
    const chosen = gits.find((g) => g.id === gitAccountId)
    // A site saved with another Git host keeps its typed address.
    if (chosen && chosen.provider !== 'github') setGitMode('manual')
    else if (!chosen && githubAccounts.length > 0) form.setFieldValue('gitAccountId', githubAccounts[0].id)
  }, [gitMode, gits, githubAccounts, gitAccountId, form])
  // A GitHub account: offer its repositories, then the branches of the chosen one.
  useEffect(() => {
    setRepos([])
    if (!isGithub) return
    let stale = false
    setReposState('loading')
    window.api.git
      .repos(gitAccountId)
      .then((list) => {
        if (stale) return
        setRepos(list)
        setReposState(list.length ? '' : 'This token cannot see any repository.')
      })
      .catch((err) => !stale && setReposState(errText(err)))
    return () => {
      stale = true
    }
  }, [isGithub, gitAccountId])
  useEffect(() => {
    setBranchList([])
    setRefs({ branches: [], tags: [] })
    if (!isGithub || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/i.test(repoUrl)) return
    let stale = false
    setRefsLoading(true)
    const timer = setTimeout(() => {
      window.api.git
        .refs(gitAccountId, repoUrl)
        .then((r) => {
          if (stale) return
          setRefs(r)
          setBranchList(r.branches)
        })
        .catch(() => undefined)
        .finally(() => !stale && setRefsLoading(false))
    }, 300)
    return () => {
      stale = true
      clearTimeout(timer)
      setRefsLoading(false)
    }
  }, [isGithub, gitAccountId, repoUrl, refsTick])
  // Until the user edits the root path, keep it in step with the site name.
  const rootTouched = useRef(!!site)

  const frameworkOptions = (Object.keys(FRAMEWORKS) as Framework[])
    .filter((f) => FRAMEWORKS[f].appTypes.includes(appType))
    .map((f) => ({ value: f, label: FRAMEWORKS[f].label }))

  const save = async (): Promise<void> => {
    let v: SiteForm
    try {
      v = await form.validateFields()
    } catch {
      return
    }
    const isLb = v.appType === 'balancer'
    const hasFiles = v.appType === 'php' || v.appType === 'static'
    const input: SiteInput = {
      id: site?.id,
      projectId,
      name: v.name.trim(),
      domain: v.domain,
      appType: v.appType,
      framework: hasFiles ? v.framework : 'none',
      rootPath: v.rootPath || `/www/wwwroot/${v.name.trim()}`,
      publicDir: hasFiles ? (v.publicDir ?? '') : '',
      phpUpstream: v.appType === 'php' ? (v.phpUpstream ?? '') : '',
      proxyPort: v.proxyPort ?? 3000,
      runner: v.appType === 'proxy' && v.runnerKind && v.runnerKind !== 'none' ? { kind: v.runnerKind, command: (v.runnerCommand ?? '').trim(), user: (v.runnerUser ?? '').trim() || undefined } : undefined,
      source: isLb ? 'upload' : v.source,
      repoUrl: !isLb && v.source === 'git' ? (v.repoUrl ?? '') : '',
      branch: v.branch || 'main',
      gitAccountId: !isLb && v.source === 'git' && v.gitAccountId ? v.gitAccountId : undefined,
      postDeploy: isLb ? '' : (v.postDeploy ?? ''),
      healthPath: isLb ? undefined : (v.healthPath ?? '').trim() || '/',
      autoRollback: isLb ? undefined : v.autoRollback !== false,
      lbMethod: isLb ? v.lbMethod : undefined,
      backends: isLb
        ? (v.backends ?? []).map((b) => ({ address: (b.address ?? '').trim(), weight: b.weight || 1, backup: !!b.backup }))
        : undefined
    }
    setSaving(true)
    try {
      await window.api.sites.save(input)
      await onSaved()
    } catch (err) {
      message.error(errText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
    <Modal
      open
      title={site ? `Edit ${site.name}` : 'New site'}
      width={620}
      centered
      styles={{ body: { maxHeight: 'calc(100vh - 210px)', overflowY: 'auto', paddingRight: 6 } }}
      maskClosable={false}
      onCancel={onClose}
      okText={site ? 'Save changes' : 'Create site'}
      confirmLoading={saving}
      onOk={save}
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{
          name: site?.name ?? '',
          domain: site?.domain ?? '',
          appType: site?.appType ?? 'php',
          framework: site?.framework ?? 'none',
          rootPath: site?.rootPath ?? '/www/wwwroot/',
          publicDir: site?.publicDir ?? '',
          phpUpstream: site?.phpUpstream ?? '',
          proxyPort: site?.proxyPort ?? 3000,
          runnerKind: site?.runner?.kind ?? 'none',
          runnerCommand: site?.runner?.command ?? '',
          runnerUser: site?.runner?.user ?? '',
          source: site?.source ?? 'git',
          repoUrl: site?.repoUrl ?? '',
          gitAccountId: site?.gitAccountId ?? '',
          branch: site?.branch ?? 'main',
          postDeploy: site?.postDeploy ?? '',
          healthPath: site?.healthPath ?? '/',
          autoRollback: site?.autoRollback !== false,
          lbMethod: site?.lbMethod ?? 'round_robin',
          backends: site?.backends?.length ? site.backends : [{ address: '', weight: 1, backup: false }]
        }}
        onValuesChange={(changed: Partial<SiteForm>) => {
          // A fresh choice of Python or Java fills in the usual start command, unless one was typed.
          if (changed.runnerKind && changed.runnerKind !== 'none') {
            const now = String(form.getFieldValue('runnerCommand') ?? '').trim()
            if (!now || Object.values(RUNNER_DEFAULT).includes(now)) form.setFieldValue('runnerCommand', RUNNER_DEFAULT[changed.runnerKind])
          }
          if (changed.rootPath !== undefined) rootTouched.current = true
          if (changed.name !== undefined && !rootTouched.current) {
            form.setFieldValue('rootPath', `/www/wwwroot/${changed.name.trim()}`)
          }
          if (changed.appType !== undefined) {
            const current = form.getFieldValue('framework') as Framework
            if (!FRAMEWORKS[current]?.appTypes.includes(changed.appType)) {
              form.setFieldsValue({ framework: 'none', publicDir: '' })
            }
          }
          if (changed.framework !== undefined) {
            form.setFieldValue('publicDir', FRAMEWORKS[changed.framework].publicDir)
          }
        }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 12 }}>
          <Form.Item
            name="name"
            label="Site name"
            rules={[
              { required: true, message: 'Give the site a short name' },
              { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/, message: 'Letters, numbers, dot, dash, underscore' }
            ]}
          >
            <Input placeholder="shop" spellCheck={false} disabled={!!site} />
          </Form.Item>
          <Form.Item
            name="domain"
            label="Domain(s)"
            rules={[{ required: true, message: 'Enter a domain or the server IP' }]}
            extra="One site can answer to several domains: separate them with spaces. Later, add or remove them under More, Domains."
          >
            <Input placeholder="example.com www.example.com" spellCheck={false} />
          </Form.Item>
        </div>

        <Form.Item name="appType" label="Application type">
          <Segmented options={APP_TYPES} block />
        </Form.Item>

        {appType === 'balancer' ? (
          <>
            <Form.Item name="lbMethod" label="How to spread requests">
              <Select options={LB_METHODS} />
            </Form.Item>
            <Form.Item
              label="Backend servers"
              extra="Use host:port, for example 10.0.0.2:8080. A backup server only gets traffic when all the others are down. A server that fails 3 times is skipped for 15 seconds."
            >
              <Form.List name="backends">
                {(fields, { add, remove }) => (
                  <>
                    {fields.map((field) => (
                      <div key={field.key} style={{ display: 'grid', gridTemplateColumns: '1fr 96px 86px 32px', gap: 8, marginBottom: 8, alignItems: 'start' }}>
                        <Form.Item
                          name={[field.name, 'address']}
                          noStyle
                          rules={[
                            { required: true, message: 'Enter host:port' },
                            { pattern: /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?:\d{1,5}$/, message: 'Use host:port' }
                          ]}
                        >
                          <Input className="mono" placeholder="10.0.0.2:8080" spellCheck={false} aria-label="Backend address" />
                        </Form.Item>
                        <Form.Item name={[field.name, 'weight']} noStyle>
                          <InputNumber min={1} max={100} addonBefore="×" style={{ width: '100%' }} aria-label="Weight" />
                        </Form.Item>
                        <Form.Item name={[field.name, 'backup']} valuePropName="checked" noStyle>
                          <Checkbox style={{ paddingTop: 5 }}>Backup</Checkbox>
                        </Form.Item>
                        <Button
                          type="text"
                          icon={<DeleteOutlined />}
                          aria-label="Remove backend"
                          disabled={fields.length === 1}
                          onClick={() => remove(field.name)}
                        />
                      </div>
                    ))}
                    <Button size="small" icon={<PlusOutlined />} onClick={() => add({ address: '', weight: 1, backup: false })}>
                      Add server
                    </Button>
                  </>
                )}
              </Form.List>
            </Form.Item>
          </>
        ) : appType === 'proxy' ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: 12, alignItems: 'start' }}>
              <Form.Item name="proxyPort" label="Port the app listens on" rules={[{ required: true, message: 'Enter the port' }]} extra="nginx sends the domain to 127.0.0.1 on this port.">
                <InputNumber min={1} max={65535} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="runnerKind" label="How the app is started" extra={runnerKind === 'none' ? 'The app is not started or restarted by deploys.' : 'Kept running by Supervisor and restarted after every deploy.'}>
                <Select options={RUNNERS} />
              </Form.Item>
            </div>
            {runnerKind !== 'none' && (
              <div style={{ display: 'grid', gridTemplateColumns: '2.4fr 1fr', gap: 12, alignItems: 'start' }}>
                <Form.Item name="runnerCommand" label="Start command" rules={[{ required: true, whitespace: true, message: 'Type the command that starts the app' }]} extra={`${RUNNER_HINT[runnerKind]} {port} becomes the port above; it is also given to the app as PORT.`}>
                  <Input className="mono" spellCheck={false} autoComplete="off" />
                </Form.Item>
                <Form.Item name="runnerUser" label="Run as user" rules={[{ pattern: /^[a-z_][a-z0-9_-]{0,31}$/, message: 'Not a valid user name' }]} extra="Empty = the web server's user. The site folder is given to this user.">
                  <Input className="mono" placeholder="www-data" spellCheck={false} autoComplete="off" />
                </Form.Item>
              </div>
            )}
          </>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 12 }}>
            <Form.Item name="framework" label="Framework (URL rewrite)" extra={FRAMEWORKS[framework]?.hint}>
              <Select options={frameworkOptions} />
            </Form.Item>
            <Form.Item name="publicDir" label="Public folder" extra="Inside the root path. Empty = root.">
              <Input placeholder="public" spellCheck={false} />
            </Form.Item>
          </div>
        )}

        {appType !== 'balancer' && (
          <Form.Item name="rootPath" label="Root path on the server" rules={[{ required: true, message: 'Enter the folder for the code' }]}>
            <FolderInput projectId={projectId} />
          </Form.Item>
        )}

        {appType === 'php' && (
          <Form.Item
            name="phpUpstream"
            label="PHP version"
            extra="Versions come from the PHP page. Automatic uses the newest one installed."
          >
            <Select
              options={[
                { value: '', label: env?.phpSockets.length ? `Automatic (${env.phpSockets[env.phpSockets.length - 1].replace(/^.*php([0-9.]+)-fpm\.sock$/, 'PHP $1')})` : 'Automatic' },
                ...(env?.phpSockets ?? []).map((sock) => ({ value: `unix:${sock}`, label: sock.replace(/^.*php([0-9.]+)-fpm\.sock$/, 'PHP $1') })),
                ...(site?.phpUpstream && !(env?.phpSockets ?? []).some((sock) => `unix:${sock}` === site.phpUpstream)
                  ? [{ value: site.phpUpstream, label: site.phpUpstream }]
                  : [])
              ]}
            />
          </Form.Item>
        )}

        {appType !== 'balancer' && (
          <>
        <Form.Item name="source" label="Code source">
          <Segmented
            options={[
              { value: 'git', label: 'Git repository' },
              { value: 'upload', label: 'Manual upload' }
            ]}
          />
        </Form.Item>

        {source === 'git' && gitMode === 'github' ? (
          <>
            <Form.Item label="GitHub account">
              <div className={`gh-card ${ghAccount ? 'on' : ''}`}>
                <span className="gh-logo">
                  <GithubOutlined />
                </span>
                <div className="gh-card-text">
                  <b>{ghAccount ? `Connected as ${ghAccount.login ?? ghAccount.name}` : 'Not connected'}</b>
                  <small>{ghAccount ? 'Deploys sign in with this account. Nobody has to type a token.' : 'Authorize once to access your GitHub repositories.'}</small>
                </div>
                {githubAccounts.length > 1 && (
                  <Select
                    size="small"
                    style={{ width: 150 }}
                    aria-label="GitHub account"
                    value={ghAccount?.id}
                    options={githubAccounts.map((g) => ({ value: g.id, label: g.login ?? g.name }))}
                    onChange={(v) => form.setFieldsValue({ gitAccountId: v, repoUrl: '' })}
                  />
                )}
                <Button className={ghAccount ? undefined : 'gh-connect'} type={ghAccount ? 'default' : 'primary'} icon={<GithubOutlined />} onClick={() => setGhOpen(true)}>
                  {ghAccount ? 'Connect another' : 'Connect GitHub'}
                </Button>
              </div>
            </Form.Item>
            <Form.Item name="gitAccountId" hidden>
              <Input />
            </Form.Item>
            <Form.Item name="repoUrl" label="Repository" getValueProps={(v: string) => ({ value: v || undefined })} rules={[{ required: true, message: 'Select a repository' }]} extra={ghAccount ? (reposState && reposState !== 'loading' ? reposState : 'Your public and private repositories, most recently pushed first.') : undefined}>
              <Select
                showSearch
                disabled={!ghAccount}
                loading={reposState === 'loading'}
                placeholder={ghAccount ? 'Select a repository' : 'Connect GitHub first'}
                optionFilterProp="label"
                options={repos.map((r) => ({ value: r.cloneUrl, label: `${r.fullName}${r.private ? '  (private)' : ''}` }))}
                notFoundContent={reposState === 'loading' ? 'Loading your repositories from GitHub...' : 'No repository matches.'}
                onChange={(value: string) => {
                  const r = repos.find((x) => x.cloneUrl === value)
                  if (r) form.setFieldValue('branch', r.defaultBranch)
                }}
              />
            </Form.Item>
            <Form.Item label="Branch or tag" extra={!ghAccount ? 'Connect GitHub and select a repository to continue.' : 'A branch moves on with every push; a tag stays on one version. Auto deploy follows branches only.'}>
              <Space.Compact style={{ width: '100%' }}>
                <Form.Item name="branch" noStyle getValueProps={(v: string) => ({ value: v || undefined })} rules={[{ required: true, message: 'Select a branch or tag' }]}>
                  <Select
                    showSearch
                    disabled={!ghAccount || !repoUrl}
                    loading={refsLoading}
                    placeholder={repoUrl ? 'Select a branch or tag' : 'Select a repository first'}
                    options={[
                      ...(refs.branches.length ? [{ label: 'Branches', options: refs.branches.map((b) => ({ value: b, label: b })) }] : []),
                      ...(refs.tags.length ? [{ label: 'Tags', options: refs.tags.map((t) => ({ value: t, label: t })) }] : [])
                    ]}
                  />
                </Form.Item>
                <Tooltip title="Reload branches and tags">
                  <Button icon={<ReloadOutlined />} aria-label="Reload branches and tags" disabled={!ghAccount || !repoUrl} onClick={() => setRefsTick((n) => n + 1)} />
                </Tooltip>
              </Space.Compact>
            </Form.Item>
            <button type="button" className="link-btn" style={{ marginBottom: 18 }} onClick={() => setGitMode('manual')}>
              Not on GitHub? Type a repository address instead
            </button>
          </>
        ) : source === 'git' ? (
          <>
            <button type="button" className="link-btn" style={{ marginBottom: 10 }} onClick={() => { form.setFieldsValue({ repoUrl: '' }); setGitMode('github') }}>
              <GithubOutlined /> Pick a repository from GitHub instead
            </button>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 150px', gap: 12 }}>
              <Form.Item
                name="repoUrl"
                label="Repository URL"
                rules={[
                  { required: true, message: 'Enter the repository URL' },
                  { validator: (_, v: string) => (gitAccountId && v && !/^https?:\/\//i.test(v) ? Promise.reject(new Error('With a Git account, use the https:// address of the repository')) : Promise.resolve()) }
                ]}
              >
                {isGithub ? (
                  <AutoComplete
                    className="mono"
                    placeholder="Pick a repository or paste its https:// address"
                    options={repos.map((r) => ({ value: r.cloneUrl, label: `${r.fullName}${r.private ? '  (private)' : ''}` }))}
                    filterOption={(text, o) => String(o?.label ?? '').toLowerCase().includes(text.toLowerCase()) || String(o?.value ?? '').toLowerCase().includes(text.toLowerCase())}
                    notFoundContent={reposState === 'loading' ? 'Loading your repositories from GitHub...' : reposState || undefined}
                    onSelect={(value: string) => {
                      const r = repos.find((x) => x.cloneUrl === value)
                      if (r) form.setFieldValue('branch', r.defaultBranch)
                    }}
                  />
                ) : (
                  <Input className="mono" placeholder={gitAccountId ? 'https://gitlab.com/you/app.git' : 'git@github.com:you/app.git'} spellCheck={false} />
                )}
              </Form.Item>
              <Form.Item name="branch" label="Branch">
                {isGithub && branchList.length > 0 ? <AutoComplete className="mono" options={branchList.map((b) => ({ value: b }))} filterOption={(text, o) => String(o?.value ?? '').includes(text)} /> : <Input className="mono" spellCheck={false} />}
              </Form.Item>
            </div>
            <Form.Item
              label="Sign in to the repository with"
              extra={gitAccountId ? 'The saved token is used on every deploy. Nobody has to type it, and it is not stored on the server.' : "Public repositories need nothing. For a private one, pick a Git account, or add the server's SSH key to the repository as a deploy key."}
            >
              <Space.Compact style={{ width: '100%' }}>
                <Form.Item name="gitAccountId" noStyle>
                  <Select
                    options={[{ value: '', label: "Server's own access (public repo or deploy key)" }, ...gits.map((g) => ({ value: g.id, label: `${g.provider === 'github' ? `GitHub: ${g.login ?? g.name}` : g.name}${g.shared ? '' : ' (only its owner)'}` }))]}
                    onChange={() => setTimeout(() => void form.validateFields(['repoUrl']).catch(() => undefined), 0)}
                  />
                </Form.Item>
                <Button onClick={() => setGitOpen(true)}>Git accounts</Button>
              </Space.Compact>
            </Form.Item>
          </>
        ) : (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 20 }}
            message="You choose a folder or a .zip / .tar.gz each time you deploy. Folders skip .git and node_modules."
          />
        )}

        <Form.Item
          name="postDeploy"
          label="Commands after deploy (optional)"
          extra="Run inside the root path with administrator rights, one per line."
        >
          <Input.TextArea
            rows={3}
            className="mono"
            spellCheck={false}
            placeholder={appType === 'php' ? 'composer install --no-dev --optimize-autoloader\nphp artisan migrate --force' : appType === 'proxy' && runnerKind === 'python' ? 'python manage.py migrate --noinput\npython manage.py collectstatic --noinput' : appType === 'proxy' && runnerKind === 'java' ? './mvnw -q package -DskipTests' : 'npm ci\nnpm run build'}
            style={{ fontSize: 12.5 }}
          />
        </Form.Item>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 12, alignItems: 'start' }}>
          <Form.Item name="healthPath" label="Health check path" extra="Requested after every deploy to see that the site still answers.">
            <Input className="mono" placeholder="/" spellCheck={false} />
          </Form.Item>
          <Form.Item name="autoRollback" valuePropName="checked" label="If a deploy breaks the site">
            <Checkbox>Go back to the previous version automatically</Checkbox>
          </Form.Item>
        </div>
          </>
        )}
      </Form>
    </Modal>
    <GithubConnect
      open={ghOpen}
      onClose={() => setGhOpen(false)}
      onConnected={(account) => {
        setGhOpen(false)
        void loadGits().then(() => form.setFieldsValue({ gitAccountId: account.id, repoUrl: '' }))
      }}
    />
    <GitAccounts open={gitOpen} accounts={gits} onClose={() => setGitOpen(false)} onChanged={loadGits} />
    </>
  )
}

/** Beside the site's name: a Preview tag; its popover has the link, who made it, and the two ways out of it. */
function PreviewTag({ site, busy, onPromote, onDiscard }: { site: Site; busy: boolean; onPromote: () => void; onDiscard: () => void }) {
  const [open, setOpen] = useState(false)
  const p = site.preview!
  const host = site.domain.split(/\s+/).find((d) => d && d !== '_' && !d.includes('*'))
  const url = host ? `${site.ssl ? 'https' : 'http'}://${host}/preview` : ''
  const failing = !(p.health && p.health < 500)
  const content = (
    <div className="preview-pop">
      {url && (
        <div className="preview-pop-link">
          <Typography.Text className="mono" copyable={{ text: url, tooltips: ['Copy link', 'Copied'] }}>
            {url.replace(/^https?:\/\//, '')}
          </Typography.Text>
          <a href={url} target="_blank" rel="noreferrer" className="site-url-open" aria-label={`Open ${url}`}>
            <ExportOutlined />
          </a>
        </div>
      )}
      <div className="preview-pop-note">
        Uploaded {ago(p.at).toLowerCase()}
        {p.by ? ` by ${p.by}` : ''}
        {failing ? ` · answers with ${p.health ? `HTTP ${p.health}` : 'nothing'}` : ''}.
        <br />
        Opening the link switches your browser to the preview on the site's own address, with a bar at the bottom. "Exit preview" in that bar goes back to the live site.
      </div>
      <Space>
        <Button
          type="primary"
          size="small"
          disabled={busy || site.stopped}
          onClick={() => {
            setOpen(false)
            onPromote()
          }}
        >
          Push to production
        </Button>
        <Button
          size="small"
          danger
          disabled={busy}
          onClick={() => {
            setOpen(false)
            onDiscard()
          }}
        >
          Discard
        </Button>
      </Space>
    </div>
  )
  return (
    <Popover trigger="click" open={open} onOpenChange={setOpen} content={content} title="Preview waiting" placement="bottomLeft">
      <Tag color={failing ? 'red' : 'purple'} className="preview-tag" role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(true)}>
        Preview
      </Tag>
    </Popover>
  )
}
