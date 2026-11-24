import { useEffect, useRef, useState } from 'react'
import { Alert, App as AntApp, Button, DatePicker, Dropdown, Input, Modal, Spin } from 'antd'
import { ClockCircleOutlined, DownOutlined, PoweroffOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import type { Project, ServiceInfo } from '@shared/types'
import { JobDrawer, useJob } from './JobLog'
import { errText } from '../util'

type Boot = { phase: 'down' | 'back' | 'late'; since: number; seconds: number } | null

/** "Restart" on the overview: one service, or the whole server with a wait until it answers again. */
export default function PowerMenu({ project, canOps, canReboot, onBack }: { project: Project; canOps: boolean; canReboot: boolean; onBack: () => void }) {
  const { modal, message } = AntApp.useApp()
  const [list, setList] = useState<ServiceInfo[] | null>(null)
  const [listError, setListError] = useState('')
  const [boot, setBoot] = useState<Boot>(null)
  const [planned, setPlanned] = useState<{ at: number; serverTime: string } | null>(null)
  const [planning, setPlanning] = useState(false)
  const [planAt, setPlanAt] = useState<Dayjs | null>(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [off, setOff] = useState(false)
  const [offName, setOffName] = useState('')
  const [isOff, setIsOff] = useState(false)
  const job = useJob(`power:${project.id}`)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearTimeout(timer.current)
    }
  }, [])

  const loadServices = (): void => {
    setListError('')
    window.api.server
      .services(project.id)
      .then((l) => alive.current && setList(l))
      .catch((err) => alive.current && setListError(errText(err)))
  }

  const loadPlan = (): void => {
    window.api.server
      .plannedReboot(project.id)
      .then((p) => alive.current && setPlanned(p))
      .catch(() => undefined)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadPlan, [project.id])

  const stopService = (s: ServiceInfo): void => {
    modal.confirm({
      title: `Stop ${s.name}?`,
      icon: <StopOutlined style={{ color: 'var(--bad)' }} />,
      content:
        s.unit === 'nginx' || /apache|httpd/.test(s.unit)
          ? 'Every site on this server goes offline until it is started again.'
          : /mysql|mariadb|postgres|redis/.test(s.unit)
            ? 'Sites that use it show errors until it is started again.'
            : /cron/.test(s.unit)
              ? 'Scheduled jobs stop running: backups, alerts, auto deploy and history recorded by this app included.'
              : s.unit === 'fail2ban'
                ? 'Attacking addresses are no longer blocked automatically.'
                : 'It stays stopped until someone starts it or the server restarts.',
      okText: 'Stop',
      okButtonProps: { danger: true },
      onOk: () => {
        void job.run(`Stop ${s.name}`, () => window.api.server.stopService(project.id, s.unit)).then(() => loadServices())
      }
    })
  }

  const savePlan = async (): Promise<void> => {
    if (!planAt) return
    setPlanBusy(true)
    try {
      await window.api.server.planReboot(project.id, planAt.second(0).valueOf())
      setPlanning(false)
      setPlanAt(null)
      loadPlan()
      message.success('The restart is planned. The server does it by itself, even with this app closed.')
    } catch (err) {
      message.error(errText(err), 8)
    } finally {
      setPlanBusy(false)
    }
  }

  const cancelPlan = async (): Promise<void> => {
    try {
      await window.api.server.planReboot(project.id, null)
      setPlanned(null)
      message.success('The planned restart was cancelled.')
    } catch (err) {
      message.error(errText(err), 8)
    }
  }

  const shutdown = async (): Promise<void> => {
    try {
      await window.api.server.shutdown(project.id)
      setOff(false)
      setOffName('')
      setIsOff(true)
    } catch (err) {
      message.error(errText(err), 8)
    }
  }

  const restartService = (s: ServiceInfo): void => {
    modal.confirm({
      title: `${s.running ? 'Restart' : 'Start'} ${s.name}?`,
      content: s.unit === 'nginx' ? 'Every site pauses for about a second. The configuration is checked first; with an error in it, nothing is restarted.' : /mysql|mariadb|postgres|redis/.test(s.unit) ? 'Sites that use it show errors for a few seconds, and running queries are cut off.' : 'It stops and starts again. This takes a few seconds.',
      okText: s.running ? 'Restart' : 'Start',
      onOk: () => {
        void job.run(`${s.running ? 'Restart' : 'Start'} ${s.name}`, () => window.api.server.restartService(project.id, s.unit)).then(() => loadServices())
      }
    })
  }

  const waitForServer = (since: number): void => {
    const tick = async (): Promise<void> => {
      if (!alive.current) return
      const seconds = Math.round((Date.now() - since) / 1000)
      try {
        await window.api.ssh.connect(project.id)
        if (!alive.current) return
        setBoot({ phase: 'back', since, seconds })
        onBack()
        return
      } catch {
        if (!alive.current) return
        setBoot({ phase: seconds > 300 ? 'late' : 'down', since, seconds })
        timer.current = setTimeout(() => void tick(), 5000)
      }
    }
    // Give the server time to actually go down before asking whether it is up.
    timer.current = setTimeout(() => void tick(), 15000)
  }

  const reboot = (): void => {
    modal.confirm({
      title: `Restart the server ${project.name}?`,
      icon: <PoweroffOutlined style={{ color: 'var(--bad)' }} />,
      content: (
        <div>
          <p style={{ marginTop: 0 }}>The whole machine restarts. Every site, database and terminal session on it stops for about a minute, sometimes longer.</p>
          <p style={{ marginBottom: 0 }}>Services set to start by themselves come back on their own. Anything started by hand in a terminal does not.</p>
        </div>
      ),
      okText: 'Restart the server',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.api.server.reboot(project.id)
          const since = Date.now()
          setBoot({ phase: 'down', since, seconds: 0 })
          waitForServer(since)
        } catch (err) {
          message.error(errText(err), 8)
        }
      }
    })
  }

  const closeBoot = (): void => {
    clearTimeout(timer.current)
    setBoot(null)
  }

  const items = [
    ...(list ?? []).map((s) =>
      s.running
        ? {
            key: `svc:${s.unit}`,
            disabled: !canOps,
            label: <span className="power-item"><i className="on" />{s.name}</span>,
            children: [
              { key: `restart:${s.unit}`, icon: <ReloadOutlined />, label: `Restart ${s.name}`, onClick: () => restartService(s) },
              { key: `stop:${s.unit}`, danger: true, icon: <StopOutlined />, label: `Stop ${s.name}`, onClick: () => stopService(s) }
            ]
          }
        : { key: `svc:${s.unit}`, disabled: !canOps, label: <span className="power-item"><i />Start {s.name} (stopped)</span>, onClick: () => restartService(s) }
    ),
    ...(list === null ? [{ key: 'loading', disabled: true, label: listError || 'Looking for services…' }] : list.length === 0 ? [{ key: 'none', disabled: true, label: 'No known services found' }] : []),
    { type: 'divider' as const },
    { key: 'reboot', danger: true, disabled: !canReboot, icon: <ReloadOutlined />, label: canReboot ? 'Restart the server…' : 'Restart the server (Admin or IT Support only)', onClick: reboot },
    planned
      ? { key: 'plan', disabled: !canReboot, icon: <ClockCircleOutlined />, label: `Cancel the restart planned for ${dayjs(planned.at).format('D MMM, HH:mm')}`, onClick: () => void cancelPlan() }
      : { key: 'plan', disabled: !canReboot, icon: <ClockCircleOutlined />, label: 'Restart at a set time…', onClick: () => { setPlanAt(dayjs().add(1, 'hour').minute(0).second(0)); setPlanning(true) } },
    { key: 'off', danger: true, disabled: !canReboot, icon: <PoweroffOutlined />, label: 'Shut the server down…', onClick: () => { setOffName(''); setOff(true) } }
  ]

  return (
    <>
      <Dropdown trigger={['click']} menu={{ items }} onOpenChange={(open) => open && loadServices()} placement="bottomRight">
        <Button className="hero-btn" icon={<ReloadOutlined />}>
          Restart <DownOutlined />
        </Button>
      </Dropdown>
      <JobDrawer job={job} />
      <Modal open={planning} title={`Restart ${project.name} at a set time`} okText="Plan the restart" okButtonProps={{ disabled: !planAt || planAt.valueOf() < Date.now() + 120000 }} confirmLoading={planBusy} onOk={() => void savePlan()} onCancel={() => setPlanning(false)} destroyOnClose>
        <p style={{ marginTop: 0 }}>The server restarts itself once at this moment, also when this app is closed. Every site and database on it stops for about a minute.</p>
        <DatePicker aria-label="When to restart" showTime={{ format: 'HH:mm' }} format="D MMM YYYY, HH:mm" value={planAt} onChange={setPlanAt} allowClear={false} disabledDate={(d) => d.isBefore(dayjs().startOf('day')) || d.isAfter(dayjs().add(30, 'day'))} style={{ width: '100%' }} />
        <p className="db-hint" style={{ marginBottom: 0 }}>This is the time on your computer. Choose at least two minutes from now, within 30 days. You can cancel it from this menu until it happens.</p>
      </Modal>
      <Modal open={off} title={`Shut down ${project.name}?`} okText="Shut the server down" okButtonProps={{ danger: true, disabled: offName.trim() !== project.name }} onOk={() => void shutdown()} onCancel={() => setOff(false)} destroyOnClose>
        <Alert type="error" showIcon style={{ marginBottom: 12 }} message="This app cannot switch the server on again" description="A server that is shut down stays off. It has to be started from your hosting provider's control panel. Every site and database on it is offline until then." />
        <label htmlFor="off-name">Type the name of the server, <b>{project.name}</b>, to go ahead</label>
        <Input id="off-name" value={offName} onChange={(e) => setOffName(e.target.value)} autoComplete="off" spellCheck={false} style={{ marginTop: 6 }} />
      </Modal>
      <Modal open={isOff} title="The server is shutting down" footer={<Button type="primary" onClick={() => setIsOff(false)}>Close</Button>} onCancel={() => setIsOff(false)}>
        <Alert type="warning" showIcon message={`${project.name} is switching off.`} description="Start it again from your hosting provider's control panel. Then press Reconnect here." />
      </Modal>
      <Modal open={!!boot} title={boot?.phase === 'back' ? 'The server is back' : 'The server is restarting'} closable={boot?.phase !== 'down'} maskClosable={false} onCancel={closeBoot} footer={boot?.phase === 'down' ? null : <Button type="primary" onClick={closeBoot}>{boot?.phase === 'back' ? 'Done' : 'Stop waiting'}</Button>}>
        {boot?.phase === 'down' && (
          <div className="power-wait">
            <Spin />
            <div>
              <b>Waiting for {project.host} to answer again…</b>
              <p>This usually takes one to two minutes. Leave this open; it closes the wait by itself.</p>
            </div>
          </div>
        )}
        {boot?.phase === 'back' && <Alert type="success" showIcon message={`Connected again after about ${boot.seconds} seconds.`} description="Check that your sites answer. Programs that were started by hand need to be started again." />}
        {boot?.phase === 'late' && (
          <Alert
            type="warning"
            showIcon
            message={`No answer after ${Math.round(boot.seconds / 60)} minutes.`}
            description="A restart can take longer after updates or a disk check, and this window keeps trying. If it stays like this, look at the server in your hosting provider's control panel (console or power controls)."
          />
        )}
      </Modal>
    </>
  )
}
