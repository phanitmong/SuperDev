import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, App as AntApp, Button, Dropdown, Form, Input, Modal, Segmented, Select, Space, Spin, Switch, Table, Tabs, Tag, Typography } from 'antd'
import { DownOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { PhpConfig, PhpExtAction, PhpExtension, PhpOptimizeInput, PhpOptimizePlan, PhpOverview, Project } from '@shared/types'
import { PHP_SETTINGS } from '@shared/types'
import { JobDrawer, useJob, type Job } from '../components/JobLog'
import { errText } from '../util'

function Settings({ project, version, config, canEdit, onSaved }: { project: Project; version: string; config: PhpConfig; canEdit: boolean; onSaved: () => Promise<void> }) {
  const [optimizing, setOptimizing] = useState(false)
  const { message } = AntApp.useApp()
  const [form] = Form.useForm<Record<string, string>>()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    form.setFieldsValue(config.values)
  }, [config, form])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const { disable_functions: _unused, ...values } = form.getFieldsValue()
      await window.api.php.saveSettings(project.id, version, values)
      message.success(`PHP ${version} settings saved and PHP-FPM restarted`)
      await onSaved()
    } catch (err) {
      message.error(errText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Form form={form} layout="vertical" requiredMark={false}>
      <div className="opt-banner">
        <div>
          <b>Optimize for this server</b>
          <span>Fills in memory, upload, cache and worker settings from the server's RAM and CPU. You see every change before it is applied.</span>
        </div>
        <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => setOptimizing(true)}>
          Optimize
        </Button>
      </div>
      <Optimize open={optimizing} project={project} version={version} canEdit={canEdit} onClose={() => setOptimizing(false)} onSaved={onSaved} />
      <div className="grid cols-3" style={{ rowGap: 0 }}>
        {PHP_SETTINGS.filter((s) => s.key !== 'disable_functions').map((s) => (
          <Form.Item key={s.key} name={s.key} label={s.label} extra={<span className="mono">{s.key}</span>}>
            <Input placeholder={s.hint} spellCheck={false} />
          </Form.Item>
        ))}
      </div>
      <Space>
        <Button type="primary" loading={saving} onClick={() => void save()}>
          Save and restart PHP-FPM
        </Button>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>Applies to websites (PHP-FPM). Command-line PHP keeps its own php.ini.</span>
      </Space>
    </Form>
  )
}

const RISKY_FUNCTIONS: { name: string; what: string }[] = [
  { name: 'exec', what: 'Runs a program on the server' },
  { name: 'system', what: 'Runs a program and prints its output' },
  { name: 'passthru', what: 'Runs a program and passes its raw output through' },
  { name: 'shell_exec', what: 'Runs a command through the shell' },
  { name: 'popen', what: 'Opens a pipe to a program' },
  { name: 'proc_open', what: 'Starts a program with full control over it' },
  { name: 'pcntl_exec', what: 'Replaces the PHP process with another program' },
  { name: 'putenv', what: 'Changes environment variables' },
  { name: 'dl', what: 'Loads an extension while a script runs' },
  { name: 'symlink', what: 'Creates links to other files' },
  { name: 'link', what: 'Creates hard links to other files' },
  { name: 'chown', what: 'Changes who owns a file' },
  { name: 'chgrp', what: 'Changes the group of a file' },
  { name: 'show_source', what: 'Prints the source code of a PHP file' },
  { name: 'phpinfo', what: 'Shows the full server configuration' }
]
const RISKY_INFO = new Map(RISKY_FUNCTIONS.map((f) => [f.name, f.what]))

/** The disable_functions list as switches: turn a function off for websites, or back on. */
function DisabledFunctions({ project, version, config, canEdit, onSaved }: { project: Project; version: string; config: PhpConfig; canEdit: boolean; onSaved: () => Promise<void> }) {
  const { message, modal } = AntApp.useApp()
  const disabled = useMemo(() => (config.values.disable_functions ?? '').split(',').map((f) => f.trim()).filter(Boolean), [config])
  const [busy, setBusy] = useState('')
  const [adding, setAdding] = useState('')

  const write = async (next: string[], what: string, key: string): Promise<void> => {
    setBusy(key)
    try {
      await window.api.php.saveSettings(project.id, version, { disable_functions: [...new Set(next)].join(',') })
      message.success(`${what}. PHP-FPM restarted.`)
      await onSaved()
    } catch (err) {
      message.error(errText(err), 8)
    } finally {
      setBusy('')
    }
  }

  const disable = (names: string[]): void => {
    const clean = names.map((n) => n.trim().replace(/\(\)$/, '')).filter(Boolean)
    const bad = clean.find((n) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
    if (bad) return void message.error(`"${bad}" is not a function name. Use names such as exec or shell_exec, separated by commas.`)
    const fresh = clean.filter((n) => !disabled.includes(n))
    if (fresh.length === 0) return void message.info('Already disabled.')
    setAdding('')
    void write([...disabled, ...fresh], `${fresh.join(', ')} disabled`, `add:${fresh.join(',')}`)
  }

  const enable = (name: string): void => {
    modal.confirm({
      title: `Enable ${name}() again?`,
      content: RISKY_INFO.has(name) ? `${RISKY_INFO.get(name)}. Websites on this PHP version will be able to use it, including a site that has been broken into.` : 'Websites on this PHP version will be able to use it again.',
      okText: 'Enable',
      onOk: () => write(disabled.filter((f) => f !== name), `${name} enabled`, `enable:${name}`)
    })
  }

  const missing = RISKY_FUNCTIONS.filter((f) => !disabled.includes(f.name))
  const shell = ['exec', 'system', 'passthru', 'shell_exec', 'popen', 'proc_open', 'pcntl_exec'].filter((n) => !disabled.includes(n))
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <p className="db-hint" style={{ margin: 0 }}>
        A disabled function cannot be called by any website on PHP {version}. Blocking the ones that run programs limits what an attacker can do through a hacked site. Some apps need them: Laravel queues and schedulers, Composer scripts and backup plugins use <span className="mono">proc_open</span> or <span className="mono">exec</span>. Command-line PHP is not affected.
      </p>
      {canEdit && (
        <div className="fn-add">
          <Input className="mono" placeholder="Function name, or several separated by commas: exec, shell_exec" value={adding} onChange={(e) => setAdding(e.target.value)} onPressEnter={() => adding.trim() && disable(adding.split(','))} spellCheck={false} aria-label="Function to disable" />
          <Button type="primary" disabled={!adding.trim()} loading={busy.startsWith('add:')} onClick={() => disable(adding.split(','))}>
            Disable
          </Button>
          {shell.length > 0 && (
            <Button loading={busy.startsWith('add:')} onClick={() => modal.confirm({ title: 'Disable the functions that run programs?', content: `${shell.join(', ')} will stop working for websites on PHP ${version}. Sites that rely on them (queues, some plugins) will show errors until you enable the one they need again.`, okText: 'Disable them', onOk: () => disable(shell) })}>
              Disable the ones that run programs ({shell.length})
            </Button>
          )}
        </div>
      )}
      <div>
        <div className="fn-title">Disabled now ({disabled.length})</div>
        {disabled.length === 0 ? (
          <div className="db-hint">Nothing is disabled. Every PHP function can be used by websites.</div>
        ) : (
          <div className="fn-list">
            {disabled.map((f) => (
              <div key={f} className="fn-row">
                <span className="fn-dot off" />
                <b className="mono">{f}</b>
                <span className="db-hint">{RISKY_INFO.get(f) ?? ''}</span>
                <span style={{ flex: 1 }} />
                <Tag>Disabled</Tag>
                <Button size="small" disabled={!canEdit} loading={busy === `enable:${f}`} onClick={() => enable(f)}>
                  Enable
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
      {missing.length > 0 && (
        <div>
          <div className="fn-title">Often disabled on shared servers, still enabled here</div>
          <div className="fn-list">
            {missing.map((f) => (
              <div key={f.name} className="fn-row">
                <span className="fn-dot" />
                <b className="mono">{f.name}</b>
                <span className="db-hint">{f.what}</span>
                <span style={{ flex: 1 }} />
                <Tag color="green">Enabled</Tag>
                <Button size="small" danger disabled={!canEdit} loading={busy === `add:${f.name}`} onClick={() => disable([f.name])}>
                  Disable
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const RAM_CHOICES = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]
const CPU_CHOICES = [1, 2, 4, 6, 8, 12, 16, 24, 32]
const gb = (mb: number): string => (mb < 1024 ? `${mb} MB` : `${Math.round((mb / 1024) * 10) / 10} GB`)
const nearest = (list: number[], n: number): number => list.reduce((best, x) => (Math.abs(x - n) < Math.abs(best - n) ? x : best), list[0])

/** Pick the server's memory and CPU, see what would change, apply it. */
function Optimize({ open, project, version, canEdit, onClose, onSaved }: { open: boolean; project: Project; version: string; canEdit: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const { message } = AntApp.useApp()
  const [input, setInput] = useState<PhpOptimizeInput>({ mix: 'with-database' })
  const [plan, setPlan] = useState<PhpOptimizePlan | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setPlan(null)
    setInput({ mix: 'with-database' })
  }, [open])

  useEffect(() => {
    if (!open) return
    let stale = false
    setLoading(true)
    window.api.php
      .optimizePlan(project.id, version, input)
      .then((p) => {
        if (stale) return
        setPlan(p)
        setError('')
      })
      .catch((err) => !stale && setError(errText(err)))
      .finally(() => !stale && setLoading(false))
    return () => {
      stale = true
    }
  }, [open, project.id, version, input])

  const apply = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.php.optimizeApply(project.id, version, input)
      message.success(`PHP ${version} optimized and PHP-FPM restarted`)
      await onSaved()
      onClose()
    } catch (err) {
      setError(errText(err))
    } finally {
      setSaving(false)
    }
  }

  const toChange = plan?.changes.filter((c) => c.current !== c.value) ?? []
  const ramOptions = plan ? [...new Set([...RAM_CHOICES, plan.detected.ramMb])].sort((a, b) => a - b) : RAM_CHOICES
  const cpuOptions = plan ? [...new Set([...CPU_CHOICES, plan.detected.cores])].sort((a, b) => a - b) : CPU_CHOICES
  return (
    <Modal open={open} onCancel={onClose} width={860} title={`Optimize PHP ${version} for this server`} maskClosable={false} destroyOnClose okText={toChange.length ? `Apply ${toChange.length} change${toChange.length === 1 ? '' : 's'} and restart PHP-FPM` : 'Nothing to change'} okButtonProps={{ disabled: !canEdit || toChange.length === 0 || loading }} confirmLoading={saving} onOk={() => void apply()}>
      <div className="opt-pick">
        <label>
          <span>Memory (RAM)</span>
          <Select style={{ width: 190 }} value={plan?.ramMb} loading={!plan} aria-label="Memory" onChange={(v) => setInput({ ...input, ramMb: v })} options={ramOptions.map((m) => ({ value: m, label: `${gb(m)}${plan && m === plan.detected.ramMb ? ' (this server)' : ''}` }))} />
        </label>
        <label>
          <span>CPU cores</span>
          <Select style={{ width: 170 }} value={plan?.cores} loading={!plan} aria-label="CPU cores" onChange={(v) => setInput({ ...input, cores: v })} options={cpuOptions.map((n) => ({ value: n, label: `${n}${plan && n === plan.detected.cores ? ' (this server)' : ''}` }))} />
        </label>
        <label>
          <span>What runs on this server</span>
          <Select style={{ width: 290 }} value={input.mix} aria-label="What runs on this server" onChange={(v) => setInput({ ...input, mix: v })} options={[{ value: 'with-database', label: 'Websites and their database' }, { value: 'php-only', label: 'Websites only (database is elsewhere)' }]} />
        </label>
      </div>
      {plan && (
        <p className="db-hint" style={{ margin: '0 0 10px' }}>
          Detected: {gb(plan.detected.ramMb)} memory, {plan.detected.cores} core{plan.detected.cores === 1 ? '' : 's'}
          {nearest(RAM_CHOICES, plan.detected.ramMb) !== plan.detected.ramMb ? ` (sold as about ${gb(nearest(RAM_CHOICES, plan.detected.ramMb))})` : ''}. Pick other values only to plan for an upgrade. The worker numbers assume about {plan.workerMb} MB per PHP worker; an unusually heavy app needs fewer workers.
        </p>
      )}
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 10 }} />}
      {plan && !plan.hasPool && <Alert type="info" showIcon style={{ marginBottom: 10 }} message="This PHP has no standard worker settings file (pool.d/www.conf), so only php.ini is tuned." />}
      <Table
        size="small"
        loading={loading}
        rowKey={(c) => `${c.file}:${c.key}`}
        pagination={false}
        scroll={{ y: '46vh' }}
        dataSource={plan?.changes ?? []}
        columns={[
          { title: 'Setting', width: 250, render: (_, c) => <span><b className="mono">{c.key}</b><div className="db-hint">{c.file === 'pool' ? 'PHP-FPM workers' : 'php.ini'}</div></span> },
          { title: 'Now', width: 100, render: (_, c) => <span className="mono">{c.current || <span className="db-null">not set</span>}</span> },
          { title: 'Recommended', width: 130, render: (_, c) => (c.current === c.value ? <span className="mono">{c.value} <Tag color="green">same</Tag></span> : <b className="mono" style={{ color: 'var(--primary)' }}>{c.value}</b>) },
          { title: 'Why', render: (_, c) => <span className="db-hint">{c.why}</span> }
        ]}
      />
      <p className="db-hint" style={{ margin: '10px 0 0' }}>PHP-FPM checks the new settings before they are used; if it refuses them, the old files are put back. Websites pause for about a second while it restarts.</p>
    </Modal>
  )
}

function Extensions({ project, version, job }: { project: Project; version: string; job: Job }) {
  const [list, setList] = useState<PhpExtension[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [onlyInstalled, setOnlyInstalled] = useState(false)

  const load = useCallback(async () => {
    try {
      setList(await window.api.php.extensions(project.id, version))
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id, version])

  useEffect(() => {
    setList(null)
    void load()
  }, [load])

  const run = (ext: PhpExtension, action: PhpExtAction): void => {
    const verb = { install: 'Install', enable: 'Enable', disable: 'Disable', remove: 'Remove' }[action]
    void job.run(`${verb} ${ext.name} (PHP ${version})`, () => window.api.php.extension(project.id, version, ext.name, action)).then(load)
  }

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (list ?? []).filter((e) => (!onlyInstalled || e.installed) && (!q || e.name.includes(q) || e.modules.some((m) => m.includes(q))))
  }, [list, search, onlyInstalled])

  if (error) return <Alert type="error" showIcon message="Could not list the extensions" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
  if (!list) return <Spin />

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Space wrap>
        <Input.Search style={{ width: 260 }} placeholder="Search, e.g. redis, imagick, swoole" allowClear onChange={(e) => setSearch(e.target.value)} aria-label="Search extensions" />
        <Space>
          <Switch checked={onlyInstalled} onChange={setOnlyInstalled} aria-label="Installed only" />
          Installed only
        </Space>
        <span style={{ color: 'var(--muted)' }}>
          {list.filter((e) => e.installed).length} installed · {list.length} available
        </span>
      </Space>
      <Table<PhpExtension>
        rowKey="name"
        size="small"
        pagination={{ pageSize: 12, showSizeChanger: false }}
        dataSource={shown}
        locale={{ emptyText: 'No extension matches' }}
        columns={[
          { title: 'Extension', dataIndex: 'name', render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span> },
          {
            title: 'Provides',
            render: (_, e) => <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>{e.modules.join(', ') || (e.installed ? 'built in' : '')}</span>
          },
          {
            title: 'Status',
            render: (_, e) => (!e.installed ? <Tag>Not installed</Tag> : e.enabled ? <Tag color="green">Enabled</Tag> : <Tag color="orange">Disabled</Tag>)
          },
          {
            title: '',
            align: 'right',
            render: (_, e) => {
              const busy = job.state === 'running'
              if (!e.installed) {
                return (
                  <Button size="small" type="primary" ghost disabled={busy} onClick={() => run(e, 'install')}>
                    Install
                  </Button>
                )
              }
              return (
                <Space>
                  {e.modules.length > 0 && (
                    <Button size="small" disabled={busy} onClick={() => run(e, e.enabled ? 'disable' : 'enable')}>
                      {e.enabled ? 'Disable' : 'Enable'}
                    </Button>
                  )}
                  <Button size="small" danger disabled={busy} onClick={() => run(e, 'remove')}>
                    Remove
                  </Button>
                </Space>
              )
            }
          }
        ]}
      />
    </div>
  )
}

function IniEditor({ project, version, config, onSaved }: { project: Project; version: string; config: PhpConfig; onSaved: () => Promise<void> }) {
  const { message } = AntApp.useApp()
  const [text, setText] = useState(config.raw)
  const [saving, setSaving] = useState(false)

  useEffect(() => setText(config.raw), [config])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.php.saveRaw(project.id, version, text)
      message.success('php.ini saved and PHP-FPM restarted')
      await onSaved()
    } catch (err) {
      message.error(errText(err), 8)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Input.TextArea
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="mono"
        spellCheck={false}
        aria-label="php.ini"
        style={{ height: 'calc(100vh - 330px)', minHeight: 280, fontSize: 12.5, resize: 'none' }}
      />
      <Space>
        <Button type="primary" disabled={text === config.raw} loading={saving} onClick={() => void save()}>
          Save and restart PHP-FPM
        </Button>
        <Button disabled={text === config.raw} onClick={() => setText(config.raw)}>
          Undo changes
        </Button>
        <span className="mono" style={{ color: 'var(--muted)', fontSize: 12 }}>
          /etc/php/{version}/fpm/php.ini
        </span>
      </Space>
    </div>
  )
}

export default function Php({ project, canOps }: { project: Project; canOps: boolean }) {
  const { message } = AntApp.useApp()
  const [data, setData] = useState<PhpOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [config, setConfig] = useState<PhpConfig | null>(null)
  const [restarting, setRestarting] = useState(false)
  const job = useJob(`php:${project.id}`)

  const load = useCallback(async () => {
    try {
      const d = await window.api.php.overview(project.id)
      setData(d)
      setError(null)
      const usable = d.versions.filter((v) => v.fpmInstalled)
      setVersion((cur) => (cur && usable.some((v) => v.version === cur) ? cur : (usable[0]?.version ?? null)))
    } catch (err) {
      setError(errText(err))
    }
  }, [project.id])

  const loadConfig = useCallback(async () => {
    if (!version) return
    try {
      setConfig(await window.api.php.getConfig(project.id, version))
    } catch (err) {
      message.error(errText(err))
    }
  }, [project.id, version, message])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setConfig(null)
    void loadConfig()
  }, [loadConfig])

  const install = (v: string): void => {
    void job.run(`Install PHP ${v}`, () => window.api.php.install(project.id, v)).then(async (ok) => {
      await load()
      if (ok) setVersion(v)
    })
  }

  const restart = async (): Promise<void> => {
    if (!version) return
    setRestarting(true)
    try {
      await window.api.php.restart(project.id, version)
      message.success(`PHP-FPM ${version} restarted`)
    } catch (err) {
      message.error(errText(err))
    }
    await load()
    setRestarting(false)
  }

  if (error) {
    return (
      <div className="card">
        <Alert type="error" showIcon message="Could not read the PHP setup" description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
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
  if (!data.supported) {
    return (
      <div className="card">
        <Alert type="info" showIcon message="PHP management works on Debian and Ubuntu servers for now." description={`This server runs ${data.os || 'another system'}.`} />
      </div>
    )
  }

  const usable = data.versions.filter((v) => v.fpmInstalled)
  const current = usable.find((v) => v.version === version)
  const installMenu = (
    <Dropdown trigger={['click']} disabled={job.state === 'running' || data.installable.length === 0} menu={{ items: data.installable.map((v) => ({ key: v, label: `PHP ${v}` })), onClick: ({ key }) => install(key) }}>
      <Button type={usable.length === 0 ? 'primary' : 'default'}>
        Install a version <DownOutlined />
      </Button>
    </Dropdown>
  )

  return (
    <div className="grid">
      <div className="card">
        <div className="card-title" style={{ marginBottom: current ? 14 : 0 }}>
          <Space wrap>
            PHP versions
            {usable.length > 0 && <Segmented value={version ?? undefined} onChange={(v) => setVersion(String(v))} options={usable.map((v) => ({ value: v.version, label: `PHP ${v.version}` }))} />}
          </Space>
          <Space>
            <Button size="small" type="text" icon={<ReloadOutlined />} aria-label="Refresh" onClick={() => void load()} />
            {installMenu}
          </Space>
        </div>
        {usable.length === 0 && <div style={{ color: 'var(--muted)', marginTop: 12 }}>No PHP-FPM is installed yet. Install a version to run PHP sites.</div>}
        {current && (
          <Space wrap size={12}>
            <Tag>{current.full}</Tag>
            <Tag color={current.running ? 'green' : 'red'}>{current.running ? 'PHP-FPM running' : 'PHP-FPM stopped'}</Tag>
            {current.socket && (
              <Typography.Text className="mono" copyable={{ text: `unix:${current.socket}` }} style={{ fontSize: 12 }}>
                unix:{current.socket}
              </Typography.Text>
            )}
            <Button size="small" loading={restarting} onClick={() => void restart()}>
              {current.running ? 'Restart' : 'Start'}
            </Button>
          </Space>
        )}
      </div>

      {current && version && (
        <div className="card">
          <Tabs
            destroyInactiveTabPane
            items={[
              { key: 'settings', label: 'Settings', children: config ? <Settings project={project} version={version} config={config} canEdit={canOps} onSaved={loadConfig} /> : <Spin /> },
              { key: 'functions', label: 'Disabled functions', children: config ? <DisabledFunctions project={project} version={version} config={config} canEdit={canOps} onSaved={loadConfig} /> : <Spin /> },
              { key: 'ext', label: 'Extensions', children: <Extensions project={project} version={version} job={job} /> },
              { key: 'ini', label: 'php.ini', children: config ? <IniEditor project={project} version={version} config={config} onSaved={loadConfig} /> : <Spin /> }
            ]}
          />
        </div>
      )}
      <JobDrawer job={job} />
    </div>
  )
}
