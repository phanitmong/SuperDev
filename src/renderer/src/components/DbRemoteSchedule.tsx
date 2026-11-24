import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, App as AntApp, Button, InputNumber, Modal, Select, Space, Spin, Table, Tag } from 'antd'
import type { DbConnection, DbRemoteStatus, DbRemoteWhen, Project } from '@shared/types'
import { JobDrawer, useJob } from './JobLog'
import { ago, bytes, errText } from '../util'

const DEFAULT_WHEN: DbRemoteWhen = { kind: 'daily', every: 30, minute: 30, hour: 2, weekday: 0, day: 1 }
const KINDS: { value: DbRemoteWhen['kind']; label: string }[] = [
  { value: 'minutes', label: 'Every N minutes' },
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' }
]
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const SYSTEM = new Set(['information_schema', 'performance_schema', 'mysql', 'sys'])

/**
 * Scheduled backups of a saved connection. One of the managed servers does the
 * work, so it runs with the app closed: its Google Drive job dumps the chosen
 * databases once a day and uploads them.
 */
export default function DbRemoteSchedule({ open, conn, projects, databases, canOps, onClose, onChanged }: { open: boolean; conn: DbConnection | null; projects: Project[]; databases: string[]; canOps: boolean; onClose: () => void; onChanged: () => void }) {
  const { message, modal } = AntApp.useApp()
  const [projectId, setProjectId] = useState<string>('')
  const [status, setStatus] = useState<DbRemoteStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [when, setWhen] = useState<DbRemoteWhen>(DEFAULT_WHEN)
  const [touched, setTouched] = useState(false)
  const [pulling, setPulling] = useState('')
  const setupJob = useJob(`dbr:${conn?.id ?? ''}`)

  // A tunnelled connection can only be reached by the tunnel's server.
  const fixed = conn?.useSsh ? conn.sshProjectId : undefined
  useEffect(() => {
    if (!open || !conn) return
    setProjectId(fixed ?? conn.backupProjectId ?? projects[0]?.id ?? '')
    setStatus(null)
    setPicked([])
    setWhen(DEFAULT_WHEN)
    setTouched(false)
  }, [open, conn?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const mine = useMemo(() => status?.schedules.find((s) => s.id === conn?.id), [status, conn?.id])

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const s = await window.api.dbr.status(projectId)
      setStatus(s)
      setError(null)
      const found = s.schedules.find((x) => x.id === conn?.id)
      setPicked((p) => (p.length ? p : found?.databases ?? []))
      if (found && !touched) setWhen(found.when)
    } catch (err) {
      setStatus(null)
      setError(errText(err))
    }
    setLoading(false)
  }, [projectId, conn?.id, touched])

  useEffect(() => {
    if (open && projectId) void load()
  }, [open, projectId, load])

  if (!conn) return null
  const server = projects.find((p) => p.id === projectId)
  const options = [...new Set([...databases.filter((d) => !SYSTEM.has(d)), ...(mine?.databases ?? [])])].map((d) => ({ value: d, label: d, disabled: !/^[A-Za-z0-9_]{1,64}$/.test(d) }))
  const typedSsh = conn.useSsh && !conn.sshProjectId

  const save = (): void =>
    void setupJob
      .run(`Schedule backups of ${conn.name}`, () => window.api.dbr.setup(projectId, conn.id, picked, when))
      .then(() => {
        onChanged()
        return load()
      })
  const runNow = (): void => void setupJob.run(`Back up ${conn.name} now`, () => window.api.dbr.run(projectId, conn.id)).then(load, load)
  const stop = (): void => {
    modal.confirm({
      title: `Stop the scheduled backups of ${conn.name}?`,
      content: `${server?.name ?? 'The server'} forgets how to reach this database. Backups already made stay on the server and in Google Drive.`,
      okText: 'Stop',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.api.dbr.remove(projectId, conn.id)
          message.success('Scheduled backups stopped')
          setPicked([])
          onChanged()
        } catch (err) {
          message.error(errText(err), 8)
        }
        await load()
      }
    })
  }
  const pull = async (file: string): Promise<void> => {
    if (!mine) return
    setPulling(file)
    try {
      await window.api.dbr.pull(projectId, conn.id, conn.name, mine.label, file)
      message.success('Copied to this computer. Restore it from Backup, "Backups and restore…".', 6)
    } catch (err) {
      message.error(errText(err), 8)
    }
    setPulling('')
  }

  return (
    <Modal open={open} title={`Scheduled backups to Google Drive: ${conn.name}`} onCancel={onClose} footer={<Button onClick={onClose}>Close</Button>} width={760} destroyOnClose>
      <p style={{ marginTop: 0, color: 'var(--muted)' }}>
        One of your servers connects to this database on the schedule you set, backs up the databases you choose and uploads them with its own Google Drive copies. It runs with this app closed. That server keeps the database password (readable by root only).
      </p>
      {typedSsh ? (
        <Alert type="info" showIcon message="This connection goes through an SSH server that was typed in by hand." description="Add that server as a project, edit the connection to use it for the tunnel, and come back: scheduled backups have to run on the server that can reach the database." />
      ) : projects.length === 0 ? (
        <Alert type="info" showIcon message="There is no server to run the backups on yet." />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: '12px 12px', alignItems: 'center', marginBottom: 14 }}>
            <span>Server that runs it</span>
            <Select value={projectId || undefined} onChange={(v) => { setProjectId(v); setStatus(null); setPicked([]) }} disabled={!!fixed} options={projects.map((p) => ({ value: p.id, label: `${p.name} (${p.host})` }))} />
            {fixed && <><span /><span style={{ color: 'var(--muted)', fontSize: 12, marginTop: -8 }}>Fixed: this connection goes through that server, so only it can reach the database.</span></>}
            <span>Databases</span>
            <Select mode="multiple" value={picked} onChange={setPicked} options={options} placeholder={databases.length ? 'Choose the databases to back up' : 'Open the connection to choose from its databases'} disabled={!canOps} notFoundContent="Open the connection first to see its databases" />
            <span>When</span>
            <Space wrap size={8}>
              <Select style={{ width: 170 }} value={when.kind} disabled={!canOps} options={KINDS} onChange={(kind) => { setTouched(true); setWhen({ ...when, kind }) }} />
              {when.kind === 'minutes' && <InputNumber min={5} max={59} value={when.every} disabled={!canOps} addonAfter="min" style={{ width: 120 }} onChange={(v) => { setTouched(true); setWhen({ ...when, every: Number(v) || 30 }) }} />}
              {when.kind === 'weekly' && <Select style={{ width: 130 }} value={when.weekday} disabled={!canOps} options={DAYS.map((d, i) => ({ value: i, label: d }))} onChange={(weekday) => { setTouched(true); setWhen({ ...when, weekday }) }} />}
              {when.kind === 'monthly' && <InputNumber min={1} max={28} value={when.day} disabled={!canOps} addonBefore="day" style={{ width: 120 }} onChange={(v) => { setTouched(true); setWhen({ ...when, day: Number(v) || 1 }) }} />}
              {(when.kind === 'daily' || when.kind === 'weekly' || when.kind === 'monthly') && <InputNumber min={0} max={23} value={when.hour} disabled={!canOps} addonBefore="hour" style={{ width: 120 }} onChange={(v) => { setTouched(true); setWhen({ ...when, hour: Number(v) || 0 }) }} />}
              {when.kind !== 'minutes' && <InputNumber min={0} max={59} value={when.minute} disabled={!canOps} addonBefore="min" style={{ width: 120 }} onChange={(v) => { setTouched(true); setWhen({ ...when, minute: Number(v) || 0 }) }} />}
              {status?.serverTime && <span style={{ color: 'var(--muted)', fontSize: 12 }}>Server time, now {status.serverTime}</span>}
            </Space>
          </div>
          {error && <Alert style={{ marginBottom: 12 }} type="error" showIcon message={`Could not ask ${server?.name ?? 'the server'}`} description={error} action={<Button onClick={() => void load()}>Try again</Button>} />}
          {loading && !status && <Spin />}
          {status && !status.driveConnected && <Alert style={{ marginBottom: 12 }} type="warning" showIcon message={`Google Drive is not connected on ${server?.name ?? 'that server'} yet.`} description="Switch to that server, open Backups, and connect Google Drive there. Then come back to this window." />}
          {status && status.driveConnected && (
            <>
              <Space wrap style={{ marginBottom: 12 }}>
                <Button type="primary" disabled={!canOps || picked.length === 0} onClick={save}>
                  {mine ? 'Save changes' : 'Turn on'}
                </Button>
                <Button disabled={!canOps || !mine} onClick={runNow}>
                  Back up and upload now
                </Button>
                {mine && (
                  <Button danger disabled={!canOps} onClick={stop}>
                    Stop
                  </Button>
                )}
                {mine ? <Tag color="green">On</Tag> : <Tag>Off</Tag>}
                {mine?.last && <Tag color={mine.last.ok ? 'green' : 'red'}>{`${mine.last.ok ? 'Last run fine' : 'Last run failed'} · ${ago(mine.last.at)}`}</Tag>}
              </Space>
              {mine?.last && !mine.last.ok && <Alert style={{ marginBottom: 12 }} type="error" showIcon message="The last backup did not work" description={mine.last.message} />}
              <p style={{ color: 'var(--muted)', fontSize: 12, margin: '0 0 12px' }}>
                Each run makes a full backup of the chosen databases and uploads it to that server's Google Drive folder. On the server the newest 30 backups of each database are kept, for at most 7 days; Drive keeps them as long as that server's Drive setting says. Triggers and stored procedures are not included.{when.kind === 'minutes' || when.kind === 'hourly' ? ' Backing up this often suits small databases; a large one may still be running when the next run is due.' : ''}
                {!canOps && ' Your role can look at this but not change it.'}
              </p>
              {mine && (
                <Table
                  size="small"
                  rowKey="name"
                  pagination={mine.files.length > 8 ? { pageSize: 8 } : false}
                  dataSource={mine.files}
                  locale={{ emptyText: 'No backup yet. The first one is made at the next scheduled run, or press "Back up and upload now".' }}
                  columns={[
                    { title: 'Database', render: (_, f) => f.name.slice(`remote-${mine.label}-`.length).replace(/-\d{8}-\d{6}\.sql\.gz$/, '') },
                    { title: 'Made', render: (_, f) => ago(f.at) },
                    { title: 'Size', render: (_, f) => bytes(f.size) },
                    { title: '', render: (_, f) => (f.inDrive ? <Tag color="green">In Drive</Tag> : <Tag>Not uploaded yet</Tag>) },
                    {
                      title: '',
                      align: 'right',
                      render: (_, f) => (
                        <Button size="small" loading={pulling === f.name} onClick={() => void pull(f.name)}>
                          Copy to this computer
                        </Button>
                      )
                    }
                  ]}
                />
              )}
            </>
          )}
        </>
      )}
      <JobDrawer job={setupJob} />
    </Modal>
  )
}
