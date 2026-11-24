import { useCallback, useEffect, useMemo, useState, lazy, Suspense, type ReactNode } from 'react'
import { Alert, App as AntApp, Button, ConfigProvider, Dropdown, Form, Input, Modal, Select, Tooltip, theme as antTheme, Segmented, Spin } from 'antd'
import {
  ApiOutlined,
  AuditOutlined,
  LogoutOutlined,
  ConsoleSqlOutlined,
  SettingOutlined,
  ArrowLeftOutlined,
  SafetyCertificateOutlined,
  FundOutlined,
  LockOutlined,
  TeamOutlined,
  FolderOpenOutlined,
  UserOutlined,
  AppstoreOutlined,
  ClockCircleOutlined,
  BorderOutlined,
  BuildOutlined,
  CloseOutlined,
  CloudServerOutlined,
  CodeOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DisconnectOutlined,
  FileSearchOutlined,
  MinusOutlined,
  MoonOutlined,
  RocketOutlined,
  SafetyOutlined,
  SaveOutlined,
  SunOutlined,
  DesktopOutlined,
  SwapOutlined,
  ThunderboltOutlined,
  ToolOutlined
} from '@ant-design/icons'
import type { SelectProps } from 'antd'
import type { ConnState, Project, ServerGroup } from '@shared/types'
import { placesOf, roleText, sortMembers } from './groupRoles'
import type { SessionState, SessionUser } from '@shared/team'
import { PASSWORD_RULES, ROLE_LABELS, can } from '@shared/team'
import Login from './pages/Login'
import Audit from './pages/Audit'
import Servers from './pages/Servers'
import Overview from './pages/Overview'
import TerminalPage, { type TermTab } from './pages/TerminalPage'
import { TasksButton, setTaskOwner } from './components/JobLog'
import GdriveCard from './components/GdriveCard'
import LockScreen from './pages/LockScreen'
import Approvals from './components/Approvals'
import spotFiles from './assets/spot-files.png'
import spotDeploy from './assets/spot-deploy.png'
import spotDatabase from './assets/spot-database.png'
import spotSecurity from './assets/spot-security.png'
import spotCron from './assets/spot-cron.png'
import terminalBg from './assets/terminal-bg.jpg'
import { errText, cssUrl } from './util'
import iconUrl from './assets/icon.png'
import bannerUrl from './assets/banner.jpg'

// Pages are loaded when first opened, so the window appears sooner and stays lighter.
const Users = lazy(() => import('./pages/Users'))
const Sites = lazy(() => import('./pages/Sites'))
const Transfer = lazy(() => import('./pages/Transfer'))
const Files = lazy(() => import('./pages/Files'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const AppStore = lazy(() => import('./pages/AppStore'))
const DbClient = lazy(() => import('./pages/DbClient'))
const Security = lazy(() => import('./pages/Security'))
const Firewall = lazy(() => import('./pages/Firewall'))
const Logs = lazy(() => import('./pages/Logs'))
const Databases = lazy(() => import('./pages/Databases'))
const Backups = lazy(() => import('./pages/Backups'))
const Php = lazy(() => import('./pages/Php'))
const Pm2 = lazy(() => import('./pages/Pm2'))
const Redis = lazy(() => import('./pages/Redis'))
const NodePage = lazy(() => import('./pages/Node'))
const PythonPage = lazy(() => import('./pages/Python'))
const JavaPage = lazy(() => import('./pages/Java'))
const DockerPage = lazy(() => import('./pages/Docker'))
const MongoPage = lazy(() => import('./pages/Mongo'))
const ComposerPage = lazy(() => import('./pages/Composer'))
const SupervisorPage = lazy(() => import('./pages/Supervisor'))
const NfsPage = lazy(() => import('./pages/Nfs'))
const NginxPage = lazy(() => import('./pages/Nginx'))
const Postgres = lazy(() => import('./pages/Postgres'))
const Cron = lazy(() => import('./pages/Cron'))
const ComingSoon = lazy(() => import('./pages/ComingSoon'))


type Page = 'servers' | 'dashboard' | 'security' | 'store' | 'dbclient' | 'overview' | 'terminal' | 'files' | 'sites' | 'transfer' | 'php' | 'pm2' | 'redis' | 'node' | 'python' | 'java' | 'docker' | 'mongo' | 'composer' | 'supervisor' | 'nfs' | 'nginx' | 'postgres' | 'cron' | 'firewall' | 'logs' | 'database' | 'backup' | 'roadmap' | 'team' | 'audit'

const NAV: { key: Page; label: string; icon: React.ReactNode; group: 'server' | 'protect' }[] = [
  { key: 'overview', label: 'Overview', icon: <DashboardOutlined />, group: 'server' },
  { key: 'sites', label: 'Sites & Deploy', icon: <RocketOutlined />, group: 'server' },
  { key: 'files', label: 'Files', icon: <FolderOpenOutlined />, group: 'server' },
  { key: 'terminal', label: 'Terminal', icon: <CodeOutlined />, group: 'server' },
  { key: 'store', label: 'App Store', icon: <AppstoreOutlined />, group: 'server' },
  { key: 'cron', label: 'Cron jobs', icon: <ClockCircleOutlined />, group: 'server' },
  { key: 'security', label: 'Settings', icon: <SettingOutlined />, group: 'protect' },
  { key: 'database', label: 'Databases', icon: <DatabaseOutlined />, group: 'protect' },
  { key: 'dbclient', label: 'Database Remote', icon: <ConsoleSqlOutlined />, group: 'protect' },
  { key: 'backup', label: 'Backups', icon: <SaveOutlined />, group: 'protect' },
]

const TITLES: Record<Page, string> = {
  servers: 'Projects',
  dashboard: 'Dashboard',
  overview: 'Overview',
  terminal: 'Terminal',
  files: 'Files',
  sites: 'Sites & Deploy',
  transfer: 'Server copy',
  store: 'App Store',
  dbclient: 'Database Remote',
  php: 'PHP',
  pm2: 'PM2 apps',
  redis: 'Redis',
  node: 'Node.js',
  python: 'Python',
  java: 'Java',
  docker: 'Docker',
  mongo: 'MongoDB',
  composer: 'Composer',
  supervisor: 'Supervisor',
  nfs: 'NFS shared folders',
  nginx: 'Nginx',
  postgres: 'PostgreSQL',
  cron: 'Cron jobs',
  security: 'Security check',
  firewall: 'Firewall',
  logs: 'Logs & Alerts',
  database: 'Databases',
  backup: 'Backups',
  roadmap: 'Roadmap',
  team: 'Team',
  audit: 'Audit log'
}

/** A short strip at the top of some pages: what the page is for, with its picture. */
const INTRO: Partial<Record<Page, { art: string; text: string }>> = {
  sites: { art: spotDeploy, text: 'Create a site, pick its framework, then deploy from git or from a folder on this computer. A failed deploy rolls back by itself.' },
  files: { art: spotFiles, text: 'Browse, edit, upload and download files on this server. Changes are made as root and take effect at once.' },
  database: { art: spotDatabase, text: 'MySQL and MariaDB databases on this server, with backups you can take now or on a schedule.' },
  backup: { art: spotDatabase, text: 'Keep folders safe by pushing them to a git repository on a schedule.' },
  cron: { art: spotCron, text: 'Run a script or call a URL on a schedule, like the scheduled tasks of a hosting panel. Each task keeps its own log.' },
  security: { art: spotSecurity, text: 'A check-up of the weak spots that most often get a server broken into, with a fix button where one click is safe.' },
  firewall: { art: spotSecurity, text: 'Open only the ports you need, block addresses, and limit how fast one visitor can send requests.' },
  logs: { art: spotSecurity, text: 'Read server logs, see who is attacking, and get a Telegram message when something needs attention.' },
  audit: { art: spotSecurity, text: 'Who did what, on which server, and when. Entries are chained, so edits and deletions are detected.' }
}

/** Asked in the app's own style when the window is closed while signed in. */
function CloseConfirm() {
  const [open, setOpen] = useState(false)
  useEffect(() => window.api.app.onConfirmClose(() => setOpen(true)), [])
  const cancel = (): void => {
    setOpen(false)
    void window.api.app.closeCancelled()
  }
  return (
    <Modal
      open={open}
      centered
      width={420}
      zIndex={4000}
      closable={false}
      onCancel={cancel}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button autoFocus onClick={cancel}>
            Stay
          </Button>
          <Button type="primary" danger onClick={() => void window.api.app.closeNow()}>
            Sign out and close
          </Button>
        </div>
      }
    >
      <div className="close-ask">
        <span className="close-ask-icon">
          <LogoutOutlined />
        </span>
        <div>
          <h3>Close Apsara Panel?</h3>
          <p>You will be signed out. Open terminals and tasks that are still running will stop.</p>
        </div>
      </div>
    </Modal>
  )
}

/** Pages that are opened from the App Store and no longer have their own menu entry. */
const STORE_PAGES: Page[] = ['php', 'pm2', 'transfer', 'redis', 'node', 'python', 'java', 'docker', 'mongo', 'composer', 'supervisor', 'nfs', 'nginx', 'postgres']

/** Three pages that share the "Settings" menu entry and are switched with tabs. */
const SETTINGS_PAGES: Page[] = ['security', 'firewall', 'logs']
/** The Databases menu entry: managing databases, and working with the data inside them. */

const IDLE_MINUTES = 15
/** Pages that are about the service, not about one server. */
const GLOBAL_PAGES: Page[] = ['servers', 'dashboard', 'roadmap', 'team', 'audit']

type ThemeMode = 'auto' | 'dark' | 'light'

function Shell({ me, biometric, dark, themeMode, setThemeMode }: { me: SessionUser; biometric: boolean; dark: boolean; themeMode: ThemeMode; setThemeMode: (v: ThemeMode) => void }) {
  const { message, notification } = AntApp.useApp()
  const [changingPassword, setChangingPassword] = useState(false)
  const [pwForm] = Form.useForm<{ current: string; next: string; repeat: string }>()

  // After a period without mouse or keyboard activity: lock when this computer has a fingerprint reader, otherwise sign out.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const rest = (): void => void (biometric ? window.api.app.lock().catch(() => window.api.auth.logout()) : window.api.auth.logout())
    const reset = (): void => {
      clearTimeout(timer)
      timer = setTimeout(rest, IDLE_MINUTES * 60000)
    }
    const keys = (e: KeyboardEvent): void => {
      if (biometric && (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        void window.api.app.lock()
      }
    }
    const events = ['mousemove', 'mousedown', 'keydown', 'wheel'] as const
    for (const e of events) window.addEventListener(e, reset, { passive: true })
    window.addEventListener('keydown', keys)
    reset()
    return () => {
      clearTimeout(timer)
      for (const e of events) window.removeEventListener(e, reset)
      window.removeEventListener('keydown', keys)
    }
  }, [biometric])

  const changePassword = async (): Promise<void> => {
    let v: { current: string; next: string }
    try {
      v = await pwForm.validateFields()
    } catch {
      return
    }
    try {
      await window.api.auth.changePassword(v.current, v.next)
      message.success('Password changed')
      setChangingPassword(false)
      pwForm.resetFields()
    } catch (err) {
      message.error(errText(err))
    }
  }

  const [projects, setProjects] = useState<Project[]>([])
  const [groups, setGroups] = useState<ServerGroup[]>([])
  const [filesStart, setFilesStart] = useState<{ path: string; at: number } | undefined>()
  const [groupFocus, setGroupFocus] = useState<string | undefined>(() => localStorage.getItem('groupFocus') || undefined)
  const [loaded, setLoaded] = useState(false)
  const [currentId, setCurrentId] = useState<string | null>(() => localStorage.getItem('currentProject'))
  const [page, setPage] = useState<Page>('servers')
  const [states, setStates] = useState<Record<string, ConnState>>({})
  const [tabs, setTabs] = useState<TermTab[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const isMac = window.api.platform === 'darwin'

  const reload = useCallback(async () => {
    try {
      const [list, grouped] = await Promise.all([window.api.projects.list(), window.api.groups.list().catch(() => [] as ServerGroup[])])
      setProjects(list)
      setGroups(grouped)
    } catch (err) {
      message.error(errText(err))
    } finally {
      setLoaded(true)
    }
  }, [message])

  // Projects can be changed from other pages (NFS); show them fresh when their pages open.
  useEffect(() => {
    if (page === 'servers' || page === 'dashboard') void reload()
  }, [page, reload])

  useEffect(() => {
    void reload()
    return window.api.ssh.onState(({ projectId, state }) => setStates((s) => ({ ...s, [projectId]: state })))
  }, [reload])

  useEffect(() => {
    const a = window.api.session.onStoreChanged(() => void reload())
    const b = window.api.session.onStoreError(({ message: text }) => message.error(`The change was not saved for the team: ${text}`, 6))
    return () => {
      a()
      b()
    }
  }, [reload, message])

  const current = useMemo(() => projects.find((p) => p.id === currentId) ?? null, [projects, currentId])

  useEffect(() => {
    if (currentId) localStorage.setItem('currentProject', currentId)
  }, [currentId])

  // If the selected project disappears, go back to the project list.
  useEffect(() => {
    if (loaded && !current && !GLOBAL_PAGES.includes(page)) setPage('servers')
  }, [loaded, current, page])

  const focusGroup = (id: string | undefined): void => {
    setGroupFocus(id)
    if (id) localStorage.setItem('groupFocus', id)
    else localStorage.removeItem('groupFocus')
  }
  const places = placesOf(groups)

  const openProject = (id: string, target: Page = 'overview'): void => {
    // Say clearly which server is now in front, so a command is never run on the wrong one.
    const next = projects.find((p) => p.id === id)
    if (next && id !== currentId) {
      notification.open({
        key: 'server-switch',
        placement: 'top',
        duration: 6,
        className: 'switch-note',
        icon: <CloudServerOutlined style={{ color: next.color || 'var(--primary)' }} />,
        message: `Now working on ${next.name}`,
        description: (
          <span>
            <span className="mono">{next.username}@{next.host}</span>
            {current ? <><br />You left {current.name}. Everything you do from here happens on {next.name}.</> : null}
          </span>
        )
      })
    }
    setCurrentId(id)
    setPage(target)
  }

  const newTerminal = (projectId: string): void => {
    const project = projects.find((p) => p.id === projectId)
    if (!project) return
    const count = tabs.filter((t) => t.projectId === projectId).length
    const tab: TermTab = {
      key: crypto.randomUUID(),
      projectId,
      title: count === 0 ? project.name : `${project.name} (${count + 1})`
    }
    setTabs((t) => [...t, tab])
    setActiveTab(tab.key)
  }

  const closeTerminal = (key: string): void => {
    setTabs((t) => {
      const next = t.filter((x) => x.key !== key)
      if (activeTab === key) setActiveTab(next[next.length - 1]?.key ?? null)
      return next
    })
  }

  const goto = (target: Page): void => {
    if (target === 'terminal' && current && !tabs.some((t) => t.projectId === current.id)) newTerminal(current.id)
    setPage(target)
  }

  const state: ConnState = current ? (states[current.id] ?? 'disconnected') : 'disconnected'
  const flush = page === 'terminal'

  return (
    <div className={`app ${isMac ? 'is-mac' : ''}`}>
      <aside className="sidebar" style={{ backgroundImage: `linear-gradient(180deg, rgba(15, 19, 66, 0.94) 0%, rgba(22, 18, 86, 0.9) 60%, rgba(40, 24, 110, 0.86) 100%), ${cssUrl(bannerUrl)}` }}>
        <div className="sidebar-top">
          <div className="brand">
            <img className="brand-icon" src={iconUrl} alt="" />
            Apsara Panel
          </div>
          <Select
            style={{ width: '100%', marginTop: 16 }}
            placeholder="Choose a server"
            value={current?.id}
            onChange={(id) => openProject(id, page === 'servers' || page === 'dashboard' ? 'overview' : page)}
            showSearch
            optionFilterProp="search"
            options={serverOptions(projects, groups, places)}
            notFoundContent="No servers yet"
            aria-label="Current server"
          />
        </div>

        <div className="side-scroll">
          <nav className="side-section" aria-label="Server tools">
            <div className="side-label">Server</div>
            {NAV.filter((n) => n.group === 'server' && (n.key !== 'terminal' || can(me.role, 'terminal')) && (n.key !== 'files' || can(me.role, ['files', 'webfiles']))).map((n) => (
              <button key={n.key} className={`nav-item ${page === n.key || (n.key === 'store' && STORE_PAGES.includes(page)) ? 'active' : ''}`} disabled={!current} onClick={() => goto(n.key)}>
                {n.icon}
                {n.label}
              </button>
            ))}
            <div className="side-label">Data and security</div>
            {NAV.filter((n) => n.group === 'protect').map((n) => (
              <button key={n.key} className={`nav-item ${page === n.key || (n.key === 'security' && SETTINGS_PAGES.includes(page)) ? 'active' : ''}`} disabled={!current} onClick={() => goto(n.key)}>
                {n.icon}
                {n.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="side-bottom">
          {can(me.role, 'admin') && (
            <>
              <button className={`nav-item ${page === 'team' ? 'active' : ''}`} onClick={() => setPage('team')}>
                <TeamOutlined />
                Team
              </button>
              <button className={`nav-item ${page === 'audit' ? 'active' : ''}`} onClick={() => setPage('audit')}>
                <AuditOutlined />
                Audit log
              </button>
            </>
          )}
          <button className={`nav-item ${page === 'dashboard' ? 'active' : ''}`} onClick={() => setPage('dashboard')}>
            <FundOutlined />
            Dashboard
          </button>
          <button className={`nav-item ${page === 'servers' ? 'active' : ''}`} onClick={() => setPage('servers')}>
            <CloudServerOutlined />
            Projects
          </button>
          <Dropdown
            trigger={['click']}
            placement="topLeft"
            menu={{
              items: [
                { key: 'roadmap', label: 'Roadmap' },
                { key: 'password', label: 'Change my password' },
                ...(biometric ? [{ key: 'lock', label: 'Lock now', icon: <LockOutlined /> }] : []),
                { type: 'divider' },
                { key: 'logout', label: 'Sign out', icon: <LogoutOutlined /> }
              ],
              onClick: ({ key }) => {
                if (key === 'roadmap') setPage('roadmap')
                if (key === 'password') setChangingPassword(true)
                if (key === 'lock') void window.api.app.lock().catch((err) => message.error(errText(err)))
                if (key === 'logout') void window.api.auth.logout()
              }
            }}
          >
            <button className="nav-item user-chip" aria-label="Account menu">
              <UserOutlined />
              <span className="user-chip-text">
                <span className="user-chip-name">{me.displayName}</span>
                <span className="user-chip-role">{ROLE_LABELS[me.role]}</span>
              </span>
            </button>
          </Dropdown>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          {current && !GLOBAL_PAGES.includes(page) && (
            <span className="crumb" title={places.get(current.id)?.map((x) => `${x.group.name}: ${roleText(x.member)}`).join('\n')}>
              <CloudServerOutlined />
              {places.get(current.id)?.[0] ? `${places.get(current.id)![0].group.name} / ` : ''}
              {current.name}
            </span>
          )}
          <h1>{TITLES[page]}</h1>
          {current && !GLOBAL_PAGES.includes(page) && (
            <>
              <span className={`status-pill ${state}`}>
                <i />
                {state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting' : 'Offline'}
              </span>
              {state === 'connected' ? (
                <Tooltip title="Disconnect">
                  <Button
                    type="text"
                    size="small"
                    icon={<DisconnectOutlined />}
                    aria-label="Disconnect"
                    onClick={() => void window.api.ssh.disconnect(current.id)}
                  />
                </Tooltip>
              ) : (
                <Tooltip title="Connect">
                  <Button
                    type="text"
                    size="small"
                    icon={<ApiOutlined />}
                    aria-label="Connect"
                    loading={state === 'connecting'}
                    onClick={() => window.api.ssh.connect(current.id).catch((e) => message.error(errText(e)))}
                  />
                </Tooltip>
              )}
            </>
          )}
          <span className="spacer" />
          <TasksButton />
          <Dropdown
            trigger={['click']}
            menu={{
              selectable: true,
              selectedKeys: [themeMode],
              onClick: ({ key }) => setThemeMode(key as ThemeMode),
              items: [
                { key: 'auto', icon: <DesktopOutlined />, label: 'Auto (follow this computer)' },
                { key: 'dark', icon: <MoonOutlined />, label: 'Dark' },
                { key: 'light', icon: <SunOutlined />, label: 'Light' }
              ]
            }}
          >
            <Button type="text" icon={themeMode === 'auto' ? <DesktopOutlined /> : dark ? <MoonOutlined /> : <SunOutlined />} aria-label="Theme" title="Theme" />
          </Dropdown>
          {!isMac && (
            <div className="win-btns">
              <button className="win-btn" aria-label="Minimize" onClick={() => window.api.window.minimize()}>
                <MinusOutlined />
              </button>
              <button className="win-btn" aria-label="Maximize" onClick={() => window.api.window.maximize()}>
                <BorderOutlined />
              </button>
              <button className="win-btn close" aria-label="Close" onClick={() => window.api.window.close()}>
                <CloseOutlined />
              </button>
            </div>
          )}
        </header>

        <section className={`content ${flush ? 'flush' : ''}`} style={page === 'terminal' ? ({ '--term-bg': cssUrl(terminalBg) } as React.CSSProperties) : undefined}>
          <Suspense fallback={<div className="empty"><Spin /></div>}>
          {SETTINGS_PAGES.includes(page) && current && (
            <Segmented
              className="settings-tabs"
              size="large"
              value={page}
              onChange={(v) => goto(v as Page)}
              options={[
                { value: 'security', label: 'Security check', icon: <SafetyCertificateOutlined /> },
                { value: 'firewall', label: 'Firewall', icon: <SafetyOutlined /> },
                { value: 'logs', label: 'Logs & Alerts', icon: <FileSearchOutlined /> }
              ]}
            />
          )}
          {STORE_PAGES.includes(page) && current && (
            <button type="button" className="store-back" onClick={() => goto('store')}>
              <ArrowLeftOutlined /> App Store
            </button>
          )}
          {INTRO[page] && (current || GLOBAL_PAGES.includes(page)) && (
            <div className="intro">
              <p>{INTRO[page]!.text}</p>
              <img src={INTRO[page]!.art} alt="" />
            </div>
          )}
          {page === 'servers' && (
            <Servers projects={projects} groups={groups} states={states} loaded={loaded} me={me} canAdd={can(me.role, 'projects')} onChanged={reload} onOpen={(id) => openProject(id)} onOpenGroup={(id) => { focusGroup(id); setPage('dashboard') }} />
          )}
          {page === 'overview' && current && <Overview key={current.id} project={current} canOps={can(me.role, 'ops')} canReboot={can(me.role, 'danger')} />}
          {page === 'dashboard' && <Dashboard projects={projects} groups={groups} states={states} focus={groups.some((g) => g.id === groupFocus) ? groupFocus : undefined} onFocus={focusGroup} onOpen={(id) => openProject(id)} />}
          {page === 'sites' && current && <Sites key={current.id} project={current} projects={projects} canOps={can(me.role, 'ops')} canDanger={can(me.role, 'danger')} onOpenFolder={can(me.role, ['files', 'webfiles']) ? (path) => { setFilesStart({ path, at: Date.now() }); setPage('files') } : undefined} />}
          {page === 'files' && current && can(me.role, ['files', 'webfiles']) && <Files key={current.id} project={current} projects={projects} canSend={can(me.role, 'ops')} full={can(me.role, 'files')} dark={dark} start={filesStart} />}
          {page === 'transfer' && current && <Transfer key={current.id} project={current} projects={projects} />}
          {/* Terminals stay mounted so sessions survive page switches. */}
          <TerminalPage
            visible={page === 'terminal'}
            tabs={tabs}
            active={activeTab}
            canAdd={!!current}
            onSelect={setActiveTab}
            onClose={closeTerminal}
            onAdd={() => current && newTerminal(current.id)}
          />
          {page === 'dbclient' && current && (can(me.role, 'data') ? <DbClient key={current.id} project={current} projects={projects} me={me} dark={dark} /> : <Alert type="info" showIcon message="Your role can see that databases exist, but not the data inside them." />)}
          {page === 'store' && current && <AppStore key={current.id} project={current} canRestart={can(me.role, 'ops')} canUninstall={can(me.role, 'danger')} onOpen={(target) => goto(target === 'sites' ? 'nginx' : target)} />}
          {page === 'php' && current && <Php key={current.id} project={current} canOps={can(me.role, 'ops')} />}
          {page === 'redis' && current && <Redis key={current.id} project={current} />}
          {page === 'node' && current && <NodePage key={current.id} project={current} canOps={can(me.role, 'ops')} />}
          {page === 'python' && current && <PythonPage key={current.id} project={current} canOps={can(me.role, 'ops')} />}
          {page === 'java' && current && <JavaPage key={current.id} project={current} canOps={can(me.role, 'ops')} />}
          {page === 'docker' && current && <DockerPage key={current.id} project={current} canOps={can(me.role, 'ops')} />}
          {page === 'composer' && current && <ComposerPage key={current.id} project={current} canOps={can(me.role, 'ops')} onOpenPhp={() => goto('php')} />}
          {page === 'supervisor' && current && <SupervisorPage key={current.id} project={current} canOps={can(me.role, 'ops')} />}
          {page === 'nfs' && current && <NfsPage key={current.id} project={current} projects={projects} canOps={can(me.role, 'ops')} />}
          {page === 'nginx' && current && <NginxPage key={current.id} project={current} canOps={can(me.role, 'ops')} dark={dark} onOpenSites={() => goto('sites')} />}
          {page === 'postgres' && current && <Postgres key={current.id} project={current} canOps={can(me.role, 'ops')} canData={can(me.role, 'data')} canDanger={can(me.role, 'danger')} />}
          {page === 'mongo' && current && <MongoPage key={current.id} project={current} canOps={can(me.role, 'ops')} canData={can(me.role, 'data')} canDanger={can(me.role, 'danger')} />}
          {page === 'pm2' && current && <Pm2 key={current.id} project={current} />}
          {page === 'cron' && current && <Cron key={current.id} project={current} />}
          {page === 'security' && current && <Security key={current.id} project={current} canFix={can(me.role, 'ops')} onOpenFirewall={() => goto('firewall')} onOpenLogs={() => goto('logs')} />}
          {page === 'firewall' && current && <Firewall key={current.id} project={current} />}
          {page === 'logs' && current && <Logs key={current.id} project={current} />}
          {page === 'database' && current && <Databases key={current.id} project={current} projects={projects} canOps={can(me.role, 'ops')} />}
          {page === 'backup' && current && (
            <>
              <Backups key={current.id} project={current} />
              <GdriveCard key={`gd-${current.id}`} project={current} canChange={can(me.role, 'ops')} />
            </>
          )}
          {page === 'roadmap' && <ComingSoon />}
          {page === 'team' && can(me.role, 'admin') && <Users me={me} projects={projects} />}
          {page === 'audit' && can(me.role, 'admin') && <Audit />}
        </Suspense>
        </section>
      </main>

      <Modal open={changingPassword} title="Change my password" okText="Change password" onOk={() => void changePassword()} onCancel={() => setChangingPassword(false)} destroyOnClose>
        <Form form={pwForm} layout="vertical" requiredMark={false}>
          <Form.Item name="current" label="Current password" rules={[{ required: true, message: 'Enter your current password' }]}>
            <Input.Password autoComplete="off" autoFocus />
          </Form.Item>
          <Form.Item name="next" label="New password" extra={PASSWORD_RULES} rules={[{ required: true, message: 'Enter a new password' }]}>
            <Input.Password autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="repeat"
            label="Repeat it"
            dependencies={['next']}
            rules={[
              { required: true, message: 'Repeat the new password' },
              ({ getFieldValue }) => ({ validator: (_r, value) => (!value || value === getFieldValue('next') ? Promise.resolve() : Promise.reject(new Error('The two passwords are different'))) })
            ]}
          >
            <Input.Password autoComplete="off" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default function App() {
  // Dark unless the person chose otherwise. "auto" follows the computer's own setting, also while the app is open.
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('theme')
    return saved === 'light' || saved === 'auto' ? saved : 'dark'
  })
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const dark = themeMode === 'auto' ? systemDark : themeMode === 'dark'

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [dark])

  const [session, setSession] = useState<SessionState | null>(null)
  useEffect(() => {
    void window.api.session.state().then(setSession)
    return window.api.session.onChange(setSession)
  }, [])
  // The Tasks list is kept per signed-in person on this computer.
  useEffect(() => {
    setTaskOwner(session?.user ? `${session.user.username}@${session.serverUrl}` : '')
  }, [session?.user?.username, session?.serverUrl, session?.user])

  const setThemeMode = (v: ThemeMode): void => {
    localStorage.setItem('theme', v)
    setThemeModeState(v)
  }

  return (
    <ConfigProvider
      theme={{
        algorithm: dark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
        token: {
          colorPrimary: dark ? '#5c86ff' : '#3366ff',
          colorSuccess: '#12b76a',
          colorWarning: '#f79009',
          colorError: '#f04438',
          colorTextBase: dark ? '#eceefb' : '#171c33',
          colorBgContainer: dark ? '#171b33' : '#ffffff',
          colorBgElevated: dark ? '#1d2240' : '#ffffff',
          colorBorder: dark ? '#2c3254' : '#dfe3ee',
          colorBorderSecondary: dark ? '#262b4a' : '#e7eaf3',
          borderRadius: 10,
          borderRadiusLG: 14,
          controlHeight: 36,
          fontSize: 14,
          fontFamily: 'inherit',
          colorBgLayout: 'transparent'
        }
      }}
    >
      <AntApp>{session === null ? null : session.user ? (
          <>
            <Shell key={session.user.id} me={session.user} biometric={session.biometric} dark={dark} themeMode={themeMode} setThemeMode={setThemeMode} />
            {!session.locked && <Approvals key={'a' + session.user.id} me={session.user} />}
            {session.locked && <LockScreen name={session.user.displayName} />}
            <CloseConfirm />
          </>
        ) : <Login session={session} />}</AntApp>
    </ConfigProvider>
  )
}

/** The server picker: grouped by project (role order), then servers in no project. A server in several projects is listed under the first. */
function serverOptions(projects: Project[], groups: ServerGroup[], places: ReturnType<typeof placesOf>): NonNullable<SelectProps['options']> {
  const listed = new Set<string>()
  const out: { label: string; title: string; options: { value: string; label: ReactNode; search: string }[] }[] = []
  for (const g of groups) {
    const opts: { value: string; label: ReactNode; search: string }[] = []
    for (const m of sortMembers(g.members)) {
      const p = projects.find((x) => x.id === m.projectId)
      if (!p || listed.has(p.id)) continue
      listed.add(p.id)
      const roles = (places.get(p.id) ?? []).filter((x) => x.group.id === g.id).map((x) => roleText(x.member))
      opts.push({ value: p.id, label: <span>{p.name} <small style={{ opacity: 0.6 }}>{roles.join(', ')}</small></span>, search: `${p.name} ${g.name} ${roles.join(' ')}` })
    }
    if (opts.length) out.push({ label: g.name, title: g.name, options: opts })
  }
  const rest = projects.filter((p) => !listed.has(p.id)).map((p) => ({ value: p.id, label: p.name as ReactNode, search: p.name }))
  if (!out.length) return rest
  if (rest.length) out.push({ label: 'Other servers', title: 'Other servers', options: rest })
  return out
}
