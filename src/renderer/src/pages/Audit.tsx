import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Input, Modal, Select, Space, Switch, Table, Tag } from 'antd'
import { DownloadOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import type { AuditEntry, AuditPage, TeamUser } from '@shared/team'
import { ROLE_LABELS, type Role } from '@shared/team'
import { errText } from '../util'

const PAGE = 25

/** Plain names for the most common actions; anything else shows its technical name. */
export const LABELS: Record<string, string> = {
  'auth:login': 'Sign in',
  'auth:totp': 'Authenticator code',
  'auth:logout': 'Sign out',
  'auth:changePassword': 'Change own password',
  'projects:save': 'Save server',
  'projects:remove': 'Remove server',
  'projects:test': 'Test server connection',
  'projects:forgetHostKey': 'Forget host key',
  'ssh:disconnect': 'Disconnect server',
  'terminal:open': 'Open terminal',
  'security:fix': 'Apply security fix',
  'security:unban': 'Unblock an address',
  'security:ban': 'Block an address',
  'php:optimizeApply': 'Optimize PHP for the server size',
  'google:connect': 'Connect a Google account',
  'google:setup': 'Set up the Google connection',
  'gdrive:enable': 'Turn on backups to Google Drive',
  'gdrive:update': 'Change the Google Drive backup',
  'gdrive:run': 'Upload backups to Google Drive now',
  'gdrive:disable': 'Turn off backups to Google Drive',
  'gdrive:fetch': 'Bring a backup back from Google Drive',
  'apps:uninstall': 'Uninstall an app',
  'docker:install': 'Install Docker',
  'docker:service': 'Start, stop or restart Docker',
  'docker:container': 'Start, stop, restart or remove a container',
  'docker:run': 'Run a new container',
  'docker:pull': 'Fetch a Docker image',
  'docker:removeImage': 'Remove a Docker image',
  'docker:prune': 'Clean up Docker images',
  'docker:composeUp': 'Start a Compose project',
  'docker:composeDown': 'Stop a Compose project',
  's3:setup': 'Set up backups to S3 storage',
  's3:run': 'Upload backups to S3 storage now',
  's3:disable': 'Turn off backups to S3 storage',
  's3:fetch': 'Bring a backup back from S3 storage',
  'server:reboot': 'Restart the server',
  'server:stopService': 'Stop a service',
  'server:shutdown': 'Shut the server down',
  'server:planReboot': 'Plan or cancel a server restart',
  'server:restartService': 'Restart a service',
  'github:connect': 'Connect a GitHub account',
  'github:setup': 'Set up the GitHub connection',
  'dbconn:save': 'Save a database connection',
  'dbconn:remove': 'Delete a database connection',
  'dbc:query': 'Run SQL',
  'dbc:createDatabase': 'Create a database',
  'dbc:dropDatabase': 'Drop a database',
  'dbc:dropTable': 'Drop a table',
  'dbc:truncateTable': 'Empty a table',
  'dbc:renameTable': 'Rename a table',
  'dbc:duplicateTable': 'Duplicate a table',
  'dbc:designApply': 'Create or change a table',
  'dbc:dump': 'Export SQL',
  'dbc:importText': 'Run an SQL file',
  'dbc:backupTo': 'Back up a database to this computer',
  'dbc:update': 'Edit a table row',
  'dbc:insert': 'Add a table row',
  'dbc:delete': 'Delete table rows',
  'db:offsiteEnable': 'Set up backup copies on another server',
  'db:offsiteDisable': 'Stop backup copies to another server',
  'db:offsiteRun': 'Copy backups to the other server now',
  'sites:autoDeploy': 'Auto deploy on / off',
  'sites:autoRun': 'Check for new commits now',
  'monitor:historySet': 'Turn history on / off',
  'git:save': 'Save Git account',
  'git:remove': 'Remove Git account',
  'files:read': 'Open file',
  'files:write': 'Save file',
  'files:create': 'Create file / folder',
  'files:rename': 'Rename',
  'files:copy': 'Copy files',
  'files:move': 'Move files',
  'files:delete': 'Delete files',
  'files:trashRestore': 'Restore from trash',
  'files:trashPurge': 'Empty trash',
  'files:chmod': 'Change permissions',
  'files:compress': 'Compress',
  'files:extract': 'Unpack archive',
  'files:upload': 'Upload file',
  'files:download': 'Download file',
  'db:download': 'Download database backup',
  'store:apply': 'Refused change',
  'terminal:close': 'Close terminal',
  'sites:save': 'Save site',
  'sites:remove': 'Remove site',
  'sites:deploy': 'Deploy site',
  'sites:rollback': 'Roll back site',
  'sites:setMaintenance': 'Maintenance mode',
  'sites:setStopped': 'Stop or start a site',
  'sites:setNginx': 'Change reverse proxy or nginx settings',
  'sites:copyTo': 'Copy site to server',
  'sites:install': 'Install web tools',
  'transfer:copy': 'Copy folder to server',
  'ssl:enable': 'Turn on HTTPS',
  'ssl:disable': 'Turn off HTTPS',
  'firewall:addRule': 'Add firewall rule',
  'firewall:deleteRule': 'Delete firewall rule',
  'firewall:setEnabled': 'Firewall on / off',
  'firewall:nginxSet': 'Change nginx firewall',
  'firewall:blockIp': 'Block IP',
  'firewall:install': 'Install firewall',
  'alerts:save': 'Save alert settings',
  'alerts:test': 'Send test alert',
  'db:create': 'Create database',
  'db:setAccess': 'Change who can connect to a database',
  'db:drop': 'Delete database',
  'db:backup': 'Back up database',
  'db:restore': 'Restore database',
  'db:deleteBackup': 'Delete database backup',
  'db:setSchedule': 'Database backup schedule',
  'db:install': 'Install MariaDB',
  'node:install': 'Install Node.js',
  'node:use': 'Change the default Node.js version',
  'node:remove': 'Remove a Node.js version',
  'composer:install': 'Install or update Composer',
  'composer:remove': 'Remove Composer',
  'dbr:setup': 'Schedule backups of a remote database',
  'dbr:run': 'Back up a remote database now',
  'dbr:remove': 'Stop scheduled backups of a remote database',
  'sites:setDomains': 'Change the domains of a site',
  'python:install': 'Install Python',
  'java:install': 'Install Java',
  'java:use': 'Change the default Java',
  'java:remove': 'Remove a Java version',
  'supervisor:install': 'Install Supervisor',
  'supervisor:save': 'Save a Supervisor program',
  'supervisor:action': 'Start, stop or restart a Supervisor program',
  'supervisor:remove': 'Remove a Supervisor program',
  'mongo:install': 'Install MongoDB',
  'mongo:service': 'Start, stop or restart MongoDB',
  'mongo:create': 'Create MongoDB database',
  'mongo:drop': 'Delete MongoDB database',
  'mongo:backup': 'Back up MongoDB database',
  'mongo:restore': 'Restore MongoDB database',
  'mongo:deleteBackup': 'Delete MongoDB backup',
  'pg:install': 'Install PostgreSQL',
  'pg:service': 'Start, stop or restart PostgreSQL',
  'pg:create': 'Create PostgreSQL database',
  'pg:drop': 'Delete PostgreSQL database',
  'pg:backup': 'Back up PostgreSQL database',
  'pg:restore': 'Restore PostgreSQL database',
  'pg:deleteBackup': 'Delete PostgreSQL backup',
  'backup:save': 'Save folder backup',
  'backup:remove': 'Remove folder backup',
  'backup:run': 'Run folder backup',
  'backup:restore': 'Restore folder backup',
  'backup:serverKey': 'Show server SSH key',
  'pm2:action': 'PM2 app action',
  'pm2:start': 'Start PM2 app',
  'pm2:startOnBoot': 'PM2 start on boot',
  'pm2:install': 'Install PM2',
  'cron:save': 'Save cron task',
  'cron:remove': 'Delete cron task',
  'cron:run': 'Run cron task',
  'php:install': 'Install PHP version',
  'php:restart': 'Restart PHP-FPM',
  'php:saveSettings': 'Change PHP settings',
  'php:saveRaw': 'Edit php.ini',
  'php:extension': 'PHP extension',
  'redis:service': 'Redis start / stop',
  'redis:saveSettings': 'Change Redis settings',
  'redis:saveRaw': 'Edit redis.conf',
  'redis:flush': 'Empty Redis',
  'redis:install': 'Install Redis',
  'users:create': 'Create account',
  'users:update': 'Change account',
  'users:remove': 'Delete account',
  'users:resetPassword': 'Reset password',
  'users:resetTwoFactor': 'Reset authenticator',
  'users:unlock': 'Unlock account',
  'guard:save': 'Change protection settings',
  'guard:test': 'Send a Telegram test message',
  'guard:reset': 'Reset protection from the console',
  'audit:prune': 'Remove old terminal recordings',
  'approval:ask': 'Ask for approval',
  'approval:decide': 'Answer an approval request',
  'audit:verify': 'Verify audit log',
  'audit:transcript': 'View terminal recording'
}

export default function Audit() {
  const { message } = AntApp.useApp()
  const [page, setPage] = useState<AuditPage | null>(null)
  const [users, setUsers] = useState<TeamUser[]>([])
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [user, setUser] = useState<string>()
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [check, setCheck] = useState<{ ok: boolean; entries: number; brokenAt?: number } | null>(null)
  const [recording, setRecording] = useState<{ id: string; text: string | null } | null>(null)

  const [exporting, setExporting] = useState(false)
  /** Everything the current filters match, as a spreadsheet file (CSV). */
  const exportCsv = async (): Promise<void> => {
    setExporting(true)
    try {
      const rows: AuditEntry[] = []
      for (let at = 0; at < 200000; at += 200) {
        const part = await window.api.audit.query({ text, user, onlyFailed, limit: 200, offset: at })
        rows.push(...part.entries)
        if (part.entries.length < 200 || rows.length >= part.total) break
      }
      // A cell that a spreadsheet would run as a formula gets a leading apostrophe.
      const cell = (v: unknown): string => {
        let t = v === undefined || v === null ? '' : String(v)
        if (/^[=+\-@\t\r]/.test(t)) t = "'" + t
        return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
      }
      const pad = (n: number): string => String(n).padStart(2, '0')
      const when = (ms: number): string => {
        const d = new Date(ms)
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      }
      const lines = [['No.', 'Time', 'User', 'Role', 'From address', 'Action', 'Action code', 'Server', 'What', 'Result', 'Error', 'Took (ms)'].join(',')]
      for (const e of rows) lines.push([e.seq, when(e.time), e.user, ROLE_LABELS[e.role as Role] ?? e.role, e.ip, LABELS[e.action] ?? e.action, e.action, e.project, e.target, e.ok ? 'Done' : 'Failed', e.error, e.ms].map(cell).join(','))
      const d = new Date()
      // The first character tells spreadsheet programs the file is UTF-8, so Khmer text shows correctly.
      const saved = await window.api.dbc.saveText(`superdevops-audit-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.csv`, '\uFEFF' + lines.join('\r\n') + '\r\n')
      if (saved) message.success(`${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} saved to ${saved}`, 6)
    } catch (err) {
      message.error(errText(err), 8)
    } finally {
      setExporting(false)
    }
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setPage(await window.api.audit.query({ text, user, onlyFailed, limit: PAGE, offset }))
      setError(null)
    } catch (err) {
      setError(errText(err))
    } finally {
      setLoading(false)
    }
  }, [text, user, onlyFailed, offset])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    window.api.users
      .list()
      .then(setUsers)
      .catch(() => setUsers([]))
  }, [])

  const verify = async (): Promise<void> => {
    try {
      setCheck(await window.api.audit.verify())
    } catch (err) {
      message.error(errText(err))
    }
  }

  const openRecording = async (id: string): Promise<void> => {
    setRecording({ id, text: null })
    try {
      const r = await window.api.audit.transcript(id)
      setRecording({ id, text: r.text })
    } catch (err) {
      setRecording(null)
      message.error(errText(err))
    }
  }

  if (error && !page) {
    return (
      <div className="card">
        <Alert type="error" showIcon message="Could not read the audit log" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
      </div>
    )
  }

  return (
    <div className="grid">
      {check && (
        <Alert
          type={check.ok ? 'success' : 'error'}
          showIcon
          closable
          onClose={() => setCheck(null)}
          message={check.ok ? `The audit log is intact: all ${check.entries} entries link correctly.` : `The audit log has been altered. The chain breaks at entry ${check.brokenAt} of ${check.entries}.`}
          description={check.ok ? undefined : 'Someone changed or removed entries directly on the service machine. Treat everything from that entry on as unreliable.'}
        />
      )}
      <div className="card">
        <div className="card-title">
          Audit log
          <Space>
            <Button icon={<SafetyCertificateOutlined />} onClick={() => void verify()}>
              Check it has not been altered
            </Button>
            <Button icon={<DownloadOutlined />} loading={exporting} onClick={() => void exportCsv()}>
              Export
            </Button>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              Refresh
            </Button>
          </Space>
        </div>
        <Space wrap style={{ marginBottom: 12 }}>
          <Input.Search
            style={{ width: 280 }}
            placeholder="Search action, server, target, IP…"
            allowClear
            onSearch={(v) => {
              setOffset(0)
              setText(v)
            }}
            aria-label="Search the audit log"
          />
          <Select
            style={{ width: 190 }}
            allowClear
            placeholder="Everyone"
            value={user}
            onChange={(v) => {
              setOffset(0)
              setUser(v)
            }}
            options={users.map((u) => ({ value: u.username, label: `${u.displayName} (${u.username})` }))}
            aria-label="Person"
          />
          <Space>
            <Switch
              checked={onlyFailed}
              onChange={(v) => {
                setOffset(0)
                setOnlyFailed(v)
              }}
              aria-label="Only failed or refused"
            />
            Only failed or refused
          </Space>
        </Space>
        <Table<AuditEntry>
          rowKey="seq"
          size="small"
          loading={loading && !page}
          dataSource={page?.entries ?? []}
          pagination={{ current: offset / PAGE + 1, pageSize: PAGE, total: page?.total ?? 0, showSizeChanger: false, onChange: (p) => setOffset((p - 1) * PAGE) }}
          locale={{ emptyText: 'Nothing matches' }}
          columns={[
            { title: 'When', width: 176, render: (_, e) => <span style={{ whiteSpace: 'nowrap' }}>{new Date(e.time).toLocaleString()}</span> },
            {
              title: 'Who',
              render: (_, e) => (
                <div>
                  <span style={{ fontWeight: 600 }}>{e.user}</span>
                  {e.role && <span style={{ color: 'var(--muted)', fontSize: 12 }}> · {ROLE_LABELS[e.role as Role] ?? e.role}</span>}
                </div>
              )
            },
            {
              title: 'Action',
              render: (_, e) => (
                <span title={e.action}>
                  {LABELS[e.action] ?? e.action}
                </span>
              )
            },
            { title: 'Server', dataIndex: 'project', render: (v?: string) => v ?? '' },
            {
              title: 'Details',
              render: (_, e) => {
                const session = /^session ([0-9a-f-]{36})$/.exec(e.target ?? '')
                if (session) {
                  return (
                    <Button size="small" onClick={() => void openRecording(session[1])}>
                      View recording
                    </Button>
                  )
                }
                return (
                  <div style={{ maxWidth: 320, fontSize: 12 }}>
                    <span className="mono" style={{ wordBreak: 'break-all' }}>
                      {e.target}
                    </span>
                    {e.error && <div style={{ color: 'var(--bad)' }}>{e.error}</div>}
                  </div>
                )
              }
            },
            { title: 'Result', width: 90, render: (_, e) => <Tag color={e.ok ? 'green' : 'red'}>{e.ok ? 'OK' : 'Failed'}</Tag> },
            { title: 'From', width: 120, render: (_, e) => <span className="mono" style={{ fontSize: 12 }}>{e.ip}</span> }
          ]}
        />
        <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>
          Sign-ins, refused attempts and every change are recorded. Routine status refreshes are not. Entries cannot be edited or deleted from the app.
        </div>
      </div>

      <Modal open={!!recording} title="Terminal recording" footer={null} width={860} onCancel={() => setRecording(null)}>
        <pre className="log-box" style={{ height: 460 }}>
          {recording?.text === null ? 'Loading…' : recording?.text}
        </pre>
      </Modal>
    </div>
  )
}
