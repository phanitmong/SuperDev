import { useCallback, useEffect, useState } from 'react'
import { App as AntApp, Button, Dropdown, Input, Modal, Segmented, Tag } from 'antd'
import { ContainerOutlined, EllipsisOutlined, ReloadOutlined, AppstoreOutlined, BuildOutlined, CodeOutlined, CoffeeOutlined, ControlOutlined, FunctionOutlined, GiftOutlined, HddOutlined, GlobalOutlined, DatabaseOutlined, SearchOutlined, ShareAltOutlined, SwapOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { Project, ServiceInfo, UninstallApp } from '@shared/types'
import ConfirmIdentity from '../components/ConfirmIdentity'
import { JobDrawer, useJob } from '../components/JobLog'

type Target = 'sites' | 'php' | 'pm2' | 'transfer' | 'redis' | 'database' | 'node' | 'python' | 'java' | 'docker' | 'mongo' | 'composer' | 'supervisor' | 'nfs' | 'postgres'

interface Item {
  key: Target
  name: string
  kind: 'Web server' | 'Runtime' | 'Database' | 'Tool'
  about: string
  icon: React.ReactNode
  color: string
}

// Official logos dropped into assets/apps (see the README there). A tile without one keeps its plain icon.
const LOGOS = Object.fromEntries(
  Object.entries(import.meta.glob('../assets/apps/*.{png,svg,jpg,jpeg,webp}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>).map(([path, url]) => [path.split('/').pop()!.replace(/\.\w+$/, '').toLowerCase(), url])
)
const LOGO_FILE: Record<string, string> = { php: 'php', pm2: 'pm2', database: 'mysql', redis: 'redis', transfer: 'server-copy', sites: 'nginx', node: 'nodejs', python: 'python', java: 'java', docker: 'docker', mongo: 'mongodb', composer: 'composer', supervisor: 'supervisor', postgres: 'postgresql' }

const ITEMS: Item[] = [
  { key: 'sites', name: 'Nginx', kind: 'Web server', about: 'The web server every site runs on. Installed together with git and unzip, which deploys need. Sites, HTTPS and URL rewrites are set up on the Sites page.', icon: <GlobalOutlined />, color: '#0f9d58' },
  { key: 'php', name: 'PHP', kind: 'Runtime', about: 'Install PHP versions side by side, edit php.ini settings, and switch extensions on and off.', icon: <BuildOutlined />, color: '#7b5cff' },
  { key: 'node', name: 'Node.js', kind: 'Runtime', about: 'Install Node.js versions side by side from nodejs.org and choose which one the node and npm commands run.', icon: <CodeOutlined />, color: '#3c873a' },
  { key: 'python', name: 'Python', kind: 'Runtime', about: 'Python 3 with pip and virtual environments, which Python sites (Django, Flask, FastAPI) need to deploy.', icon: <FunctionOutlined />, color: '#3776ab' },
  { key: 'java', name: 'Java', kind: 'Runtime', about: 'Install OpenJDK versions side by side and choose which one the java command runs, for Spring Boot and other Java apps.', icon: <CoffeeOutlined />, color: '#e76f00' },
  { key: 'docker', name: 'Docker', kind: 'Runtime', about: 'Run apps in containers: start one from an image, see output, stop, restart and remove, manage images, and bring Compose projects up.', icon: <ContainerOutlined />, color: '#1d63ed' },
  { key: 'composer', name: 'Composer', kind: 'Runtime', about: 'The package manager PHP projects use. Laravel and Symfony deploys need it. Install, update or remove it.', icon: <GiftOutlined />, color: '#8a5a2b' },
  { key: 'pm2', name: 'PM2 Manager', kind: 'Runtime', about: 'Keep Node.js apps running: start, stop, restart, read logs, and start them again after a reboot.', icon: <AppstoreOutlined />, color: '#12b76a' },
  { key: 'database', name: 'MySQL / MariaDB', kind: 'Database', about: 'Create databases and users, back them up on a schedule, restore, and keep copies on another server.', icon: <DatabaseOutlined />, color: '#3366ff' },
  { key: 'postgres', name: 'PostgreSQL', kind: 'Database', about: 'Install PostgreSQL, create databases each with a user of their own, back them up and restore.', icon: <HddOutlined />, color: '#336791' },
  { key: 'mongo', name: 'MongoDB', kind: 'Database', about: 'Install MongoDB in the version you choose, with sign-in on. Create databases each with a user of their own, back them up and restore.', icon: <HddOutlined />, color: '#00684a' },
  { key: 'redis', name: 'Redis', kind: 'Database', about: 'Install Redis, set its password, memory limit and persistence, and watch how it is doing.', icon: <ThunderboltOutlined />, color: '#f04438' },
  { key: 'supervisor', name: 'Supervisor', kind: 'Tool', about: 'Keep queue workers and other background programs running, and start them again when they stop or the server restarts.', icon: <ControlOutlined />, color: '#475467' },
  { key: 'nfs', name: 'NFS', kind: 'Tool', about: 'Share a folder from one server so other servers mount it and use the same files, such as uploads behind a load balancer.', icon: <ShareAltOutlined />, color: '#0e7490' },
  { key: 'transfer', name: 'Server copy', kind: 'Tool', about: 'Copy a folder from this server straight to another of your servers, for moving a site or seeding a new machine.', icon: <SwapOutlined />, color: '#f79009' }
]

/** What is known about one app on this server. `null` while it is being looked up. */
type State = { installed: boolean; note: string } | null

/** The services behind each app. Node.js, Python, Java and Composer are tools, not services: their apps restart from PM2, Supervisor or the site. */
const SERVICE_OF: Partial<Record<Target, RegExp>> = {
  sites: /^nginx$/,
  php: /^php[\d.]*-fpm$/,
  database: /^(mariadb|mysql|mysqld)$/,
  postgres: /^postgresql$/,
  redis: /^redis(-server)?$/,
  supervisor: /^supervisor(d)?$/,
  nfs: /^nfs-(server|kernel-server)$/,
  docker: /^docker$/,
  mongo: /^mongod$/,
  pm2: /^pm2-/
}

/** What uninstalling each app means for the person: what stops, and what stays on the server. */
const UNINSTALL: Record<UninstallApp, { stops: string; kept: string }> = {
  sites: { stops: 'Every site on this server goes offline until Nginx is installed again.', kept: 'Site folders and the Nginx settings stay.' },
  php: { stops: 'Every PHP version is removed. PHP sites show an error until PHP is installed again.', kept: 'The php.ini settings stay.' },
  pm2: { stops: 'Every app PM2 runs is stopped and no longer starts with the server.', kept: 'The apps\' folders, the saved app lists and Node.js stay.' },
  database: { stops: 'Sites that use a database on this server show errors until it is installed again.', kept: 'The databases themselves, the settings and the backups stay. Installing the same or a newer version opens them again.' },
  postgres: { stops: 'Apps that use PostgreSQL on this server show errors until it is installed again.', kept: 'The databases, the settings and the backups stay. Installing the same version opens them again.' },
  mongo: { stops: 'Apps that use MongoDB on this server show errors until it is installed again.', kept: 'The databases, the settings and the sign-in stay. Installing MongoDB again opens them.' },
  redis: { stops: 'Caches, sessions and queues kept in Redis stop working until it is installed again.', kept: 'The settings and the data file stay.' },
  supervisor: { stops: 'Every program it runs is stopped, including sites the app starts (Python, Java, other commands).', kept: 'The program settings stay and work again after installing Supervisor.' },
  docker: { stops: 'Every container is stopped until Docker is installed again.', kept: 'Containers, images and volumes stay on the disk.' }
}

/** Software and tools for this server in one place, the way a hosting panel's app store lists them. */
export default function AppStore({ project, canRestart, canUninstall, onOpen }: { project: Project; canRestart: boolean; canUninstall: boolean; onOpen: (page: Target) => void }) {
  const [round, setRound] = useState(0)
  const [removing, setRemoving] = useState<Item | null>(null)
  const [typed, setTyped] = useState('')
  const [proving, setProving] = useState<Item | null>(null)
  const { modal } = AntApp.useApp()
  const job = useJob(`power:${project.id}`)
  const [services, setServices] = useState<ServiceInfo[]>([])
  const loadServices = useCallback(() => {
    window.api.server
      .services(project.id)
      .then(setServices)
      .catch(() => setServices([]))
  }, [project.id])
  useEffect(loadServices, [loadServices])

  const restart = (s: ServiceInfo): void => {
    modal.confirm({
      title: `${s.running ? 'Restart' : 'Start'} ${s.name}?`,
      content:
        s.unit === 'nginx'
          ? 'Every site pauses for about a second. The configuration is checked first; with an error in it, nothing is restarted.'
          : /mysql|mariadb|postgres|redis/.test(s.unit)
            ? 'Sites that use it show errors for a few seconds until it is back.'
            : /fpm/.test(s.unit)
              ? 'PHP sites on this version pause for a moment.'
              : 'It stops and starts again. Programs it runs are started again with it.',
      okText: s.running ? 'Restart' : 'Start',
      onOk: () => {
        void job.run(`${s.running ? 'Restart' : 'Start'} ${s.name}`, () => window.api.server.restartService(project.id, s.unit)).then(loadServices, loadServices)
      }
    })
  }

  const [filter, setFilter] = useState<'All' | 'Installed' | Item['kind']>('All')
  const [query, setQuery] = useState('')
  const [state, setState] = useState<Partial<Record<Target, State>>>({ transfer: { installed: true, note: 'Built in' } })

  useEffect(() => {
    let stale = false
    const put = (key: Target, value: State): void => {
      if (!stale) setState((s) => ({ ...s, [key]: value }))
    }
    const unknown = { installed: false, note: 'Could not check' }
    window.api.sites
      .preflight(project.id)
      .then((e) => put('sites', e.nginx ? { installed: true, note: `${e.nginx}${e.git ? '' : ' · git missing'}` } : { installed: false, note: 'Not installed' }))
      .catch(() => put('sites', unknown))
    window.api.php
      .overview(project.id)
      .then((o) => put('php', o.versions.length ? { installed: true, note: o.versions.map((v) => v.version).join(', ') } : { installed: false, note: o.supported ? 'Not installed' : 'Needs Debian or Ubuntu' }))
      .catch(() => put('php', unknown))
    window.api.pm2
      .overview(project.id, project.username)
      .then((o) => put('pm2', o.installed ? { installed: true, note: `${o.pm2Version}${o.processes.length ? ` · ${o.processes.length} app${o.processes.length === 1 ? '' : 's'}` : ''}` } : { installed: false, note: 'Not installed' }))
      .catch(() => put('pm2', unknown))
    window.api.redis
      .overview(project.id)
      .then((o) => put('redis', o.installed ? { installed: true, note: `${o.version}${o.running ? '' : ' · stopped'}` } : { installed: false, note: 'Not installed' }))
      .catch(() => put('redis', unknown))
    window.api.node
      .overview(project.id)
      .then((o) => put('node', o.running ? { installed: true, note: `${o.running}${o.versions.length > 1 ? ` · ${o.versions.length} versions` : ''}` } : { installed: false, note: o.supported ? 'Not installed' : 'No build for this processor' }))
      .catch(() => put('node', unknown))
    window.api.python
      .overview(project.id)
      .then((o) => put('python', o.installed && o.venv ? { installed: true, note: o.version } : { installed: false, note: o.installed ? `${o.version} · no virtual environments` : 'Not installed' }))
      .catch(() => put('python', unknown))
    window.api.java
      .overview(project.id)
      .then((o) => put('java', o.installed ? { installed: true, note: `${o.version}${o.jdks.length > 1 ? ` · ${o.jdks.length} versions` : ''}` } : { installed: false, note: 'Not installed' }))
      .catch(() => put('java', unknown))
    window.api.docker
      .overview(project.id)
      .then((o) => put('docker', o.installed ? { installed: true, note: `${o.version}${o.running ? (o.containers.length ? ` · ${o.containers.filter((c) => c.state === 'running').length} running` : '') : ' · stopped'}` } : { installed: false, note: 'Not installed' }))
      .catch(() => put('docker', unknown))
    window.api.composer
      .overview(project.id)
      .then((o) => put('composer', o.installed ? { installed: true, note: o.version } : { installed: false, note: 'Not installed' }))
      .catch(() => put('composer', unknown))
    window.api.supervisor
      .overview(project.id)
      .then((o) => put('supervisor', o.installed ? { installed: true, note: `${o.version}${o.running ? '' : ' · stopped'}${o.programs.length ? ` · ${o.programs.length} program${o.programs.length === 1 ? '' : 's'}` : ''}` } : { installed: false, note: 'Not installed' }))
      .catch(() => put('supervisor', unknown))
    window.api.nfs
      .overview(project.id)
      .then((o) => put('nfs', o.serverInstalled || o.mounts.length ? { installed: true, note: [o.serverInstalled ? `${o.shares.length} shared` : '', o.mounts.length ? `${o.mounts.length} mounted` : ''].filter(Boolean).join(' · ') || 'Installed' } : { installed: false, note: o.clientInstalled ? 'Client only' : 'Not installed' }))
      .catch(() => put('nfs', unknown))
    window.api.pg
      .overview(project.id)
      .then((o) => put('postgres', o.installed ? { installed: true, note: `${o.version}${o.running ? '' : ' · stopped'}` } : { installed: false, note: 'Not installed' }))
      .catch(() => put('postgres', unknown))
    window.api.mongo
      .overview(project.id)
      .then((o) => put('mongo', o.installed ? { installed: true, note: `${o.version}${o.running ? '' : ' · stopped'}` } : { installed: false, note: 'Not installed' }))
      .catch(() => put('mongo', unknown))
    window.api.db
      .overview(project.id)
      .then((o) => put('database', o.installed ? { installed: true, note: o.version.split('-')[0] } : { installed: false, note: 'Not installed' }))
      .catch(() => put('database', unknown))
    return () => {
      stale = true
    }
  }, [project.id, project.username, round])

  const q = query.trim().toLowerCase()
  // "Installed" lists what was installed on this server; the built-in server copy is not an install.
  const isInstalled = (i: Item): boolean => !!state[i.key]?.installed && state[i.key]?.note !== 'Built in'
  const installedCount = ITEMS.filter(isInstalled).length
  const shown = ITEMS.filter((i) => (filter === 'All' || (filter === 'Installed' ? isInstalled(i) : i.kind === filter)) && (!q || i.name.toLowerCase().includes(q) || i.about.toLowerCase().includes(q)))

  return (
    <div className="card">
      <div className="store-bar">
        <Segmented
          value={filter}
          onChange={(v) => setFilter(v as typeof filter)}
          options={[
            { value: 'All', label: 'All' },
            { value: 'Installed', label: `Installed${installedCount ? ` (${installedCount})` : ''}` },
            ...(['Web server', 'Runtime', 'Database', 'Tool'] as const).map((k) => ({ value: k, label: k }))
          ]}
        />
        <Input allowClear prefix={<SearchOutlined />} placeholder="Search apps" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 240 }} />
      </div>
      <div className="store-grid">
        {shown.map((i) => {
          const s = state[i.key]
          const re = SERVICE_OF[i.key]
          const mine = re && s?.installed ? services.filter((x) => re.test(x.unit)) : []
          return (
            <div key={i.key} className="store-item" onClick={() => onOpen(i.key)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(i.key)}>
              <span className={`store-icon ${LOGOS[LOGO_FILE[i.key]] ? 'has-logo' : ''}`} style={LOGOS[LOGO_FILE[i.key]] ? undefined : { background: i.color }}>
                {LOGOS[LOGO_FILE[i.key]] ? <img src={LOGOS[LOGO_FILE[i.key]]} alt="" /> : i.icon}
              </span>
              <div className="store-text">
                <div className="store-name">
                  {i.name}
                  <span className="store-kind">{i.kind}</span>
                </div>
                <p>{i.about}</p>
                <div className="store-foot">
                  {s === undefined || s === null ? <Tag>Checking...</Tag> : <Tag color={s.installed ? 'green' : undefined}>{s.installed && i.key !== 'transfer' ? (s.note ? `Installed · ${s.note}` : 'Installed') : s.note}</Tag>}
                  {mine.length === 1 && (
                    <Button
                      size="small"
                      icon={<ReloadOutlined />}
                      disabled={!canRestart}
                      aria-label={`${mine[0].running ? 'Restart' : 'Start'} ${i.name}`}
                      title={canRestart ? `${mine[0].running ? 'Restart' : 'Start'} ${i.name}` : 'Your role cannot restart services'}
                      onClick={(e) => (e.stopPropagation(), restart(mine[0]))}
                    >
                      {mine[0].running ? null : 'Start'}
                    </Button>
                  )}
                  {mine.length > 1 && (
                    <span onClick={(e) => e.stopPropagation()}>
                      <Dropdown trigger={['click']} disabled={!canRestart} menu={{ items: mine.map((m) => ({ key: m.unit, label: `${m.running ? 'Restart' : 'Start'} ${m.name}` })), onClick: ({ key }) => restart(mine.find((m) => m.unit === key)!) }}>
                        <Button size="small" icon={<ReloadOutlined />} aria-label={`Restart ${i.name}`} title={`Restart ${i.name}`} />
                      </Dropdown>
                    </span>
                  )}
                  {s?.installed && i.key in UNINSTALL && (
                    <span onClick={(e) => e.stopPropagation()}>
                      <Dropdown
                        trigger={['click']}
                        menu={{
                          items: [{ key: 'uninstall', danger: true, disabled: !canUninstall, label: canUninstall ? `Uninstall ${i.name}...` : 'Uninstall (Admin or IT Support only)' }],
                          onClick: () => {
                            setTyped('')
                            setRemoving(i)
                          }
                        }}
                      >
                        <Button size="small" icon={<EllipsisOutlined />} aria-label={`More for ${i.name}`} />
                      </Dropdown>
                    </span>
                  )}
                  <Button type={s?.installed ? 'default' : 'primary'} size="small">
                    {s && !s.installed && (s.note === 'Not installed' || s.note.endsWith('no virtual environments')) ? 'Install' : i.kind === 'Tool' ? 'Open' : 'Manage'}
                  </Button>
                </div>
              </div>
            </div>
          )
        })}
        {shown.length === 0 && <p style={{ color: 'var(--muted)' }}>{filter === 'Installed' && !q ? 'Nothing is installed from the App Store on this server yet.' : 'No app matches.'}</p>}
      </div>
      <Modal
        open={!!removing}
        title={removing ? `Uninstall ${removing.name} from ${project.name}?` : ''}
        okText="Uninstall"
        okButtonProps={{ danger: true, disabled: !removing || typed.trim().toLowerCase() !== removing.name.toLowerCase() }}
        onCancel={() => setRemoving(null)}
        onOk={() => {
          setProving(removing)
          setRemoving(null)
        }}
        destroyOnClose
      >
        {removing && (
          <>
            <p style={{ marginTop: 0 }}>{UNINSTALL[removing.key as UninstallApp].stops}</p>
            <p style={{ color: 'var(--muted)' }}>{UNINSTALL[removing.key as UninstallApp].kept} Nothing you stored is deleted.</p>
            <label htmlFor="uninstall-name">
              Type <b>{removing.name}</b> to go ahead
            </label>
            <Input id="uninstall-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} style={{ marginTop: 6 }} />
          </>
        )}
      </Modal>
      <ConfirmIdentity
        open={!!proving}
        title="Confirm it is you"
        about={proving ? `Uninstalling ${proving.name} stops what depends on it on ${project.name}. Enter a fresh code to go ahead.` : ''}
        okText="Uninstall"
        danger
        onCancel={() => setProving(null)}
        onProof={async (proof) => {
          if (!proving) return
          const item = proving
          await window.api.session.confirm(proof, `uninstall ${item.name}`)
          setProving(null)
          const again = (): void => {
            setRound((n) => n + 1)
            loadServices()
          }
          void job.run(`Uninstall ${item.name}`, () => window.api.apps.uninstall(project.id, item.key as UninstallApp)).then(again, again)
        }}
      />
      <JobDrawer job={job} />
    </div>
  )
}
