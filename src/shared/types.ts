// Types shared by the main process, preload bridge and renderer.

export type AuthType = 'password' | 'key'
export type ConnState = 'disconnected' | 'connecting' | 'connected'

/** What the UI sends when creating or editing a project (server). */
export interface ProjectInput {
  id?: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  /** Leave empty when editing to keep the stored secret. */
  password?: string
  privateKey?: string
  passphrase?: string
  note?: string
  color?: string
  share?: ProjectShare
  /** Filled in by the app for a new server. */
  ownerId?: string
}

/** What the UI gets back. Secrets never leave the main process. */
export interface Project {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  note?: string
  color?: string
  hasPassword: boolean
  hasPrivateKey: boolean
  hasPassphrase: boolean
  hostFingerprint?: string
  /** Account that added the server. Servers from before sharing existed have none. */
  ownerId?: string
  share: ProjectShare
  createdAt: number
  updatedAt: number
}

/** Who may use a server: only its owner, the whole team, or chosen people. */
export interface ProjectShare {
  mode: 'private' | 'team' | 'members'
  /** Account ids, used when mode is "members". */
  members: string[]
}

export interface DiskInfo {
  fs: string
  mount: string
  total: number
  used: number
  pct: number
}

export interface ProcInfo {
  pid: number
  user: string
  cpu: number
  mem: number
  cmd: string
}

export interface MonitorSample {
  ts: number
  cpu: number
  cores: number
  load: [number, number, number]
  mem: { total: number; used: number; available: number; swapTotal: number; swapUsed: number }
  disks: DiskInfo[]
  net: { rxRate: number; txRate: number; rxTotal: number; txTotal: number }
  uptime: number
  hostname: string
  kernel: string
  os: string
  cpuModel: string
  procs: ProcInfo[]
  /** Graphics cards, only when the server has one (NVIDIA with its driver, or AMD). */
  gpus?: GpuInfo[]
  /** Programs using an NVIDIA card. */
  gpuProcs?: GpuProc[]
}

export interface GpuInfo {
  index: number
  vendor: 'nvidia' | 'amd'
  name: string
  /** Busy, 0 to 100. */
  util: number
  /** Bytes. */
  memUsed: number
  memTotal: number
  /** Celsius. */
  temp?: number
  /** Watts. */
  power?: number
  powerLimit?: number
  /** Percent. */
  fan?: number
}

export interface GpuProc {
  gpu: number
  pid: number
  name: string
  /** Bytes of the card's memory. */
  mem: number
}

export type AppType = 'php' | 'static' | 'proxy' | 'balancer'
export type LbMethod = 'round_robin' | 'least_conn' | 'ip_hash'

/** One server behind a load balancer. */
export interface Backend {
  /** host:port, e.g. 10.0.0.2:8080 */
  address: string
  weight: number
  /** Only receives traffic when all normal servers are down. */
  backup: boolean
}

export interface BackendStatus {
  address: string
  up: boolean
}
export type Framework =
  | 'none'
  | 'laravel'
  | 'wordpress'
  | 'thinkphp'
  | 'codeigniter'
  | 'yii2'
  | 'symfony'
  | 'spa'
export type SourceType = 'git' | 'upload'

/** Send one path of a site to another address, on this server or elsewhere. */
export interface ProxyRule {
  /** Path on the site, such as /api. Not "/": a whole site that is a proxy is the type "App on a port". */
  path: string
  /** Where requests go: http://127.0.0.1:3000 or https://api.example.com */
  target: string
  /** Remove the path from the request before passing it on: /api/users arrives as /users. */
  stripPath?: boolean
  /** Which name the target is told: the visitor's (default for a local target) or the target's own (default elsewhere). */
  hostHeader?: 'visitor' | 'target'
  /** Let WebSocket connections through. */
  websocket?: boolean
}

export interface NginxSettings {
  /** Largest upload accepted, in MB. Default 64. */
  maxBodyMb?: number
  /** Compress text answers. */
  gzip?: boolean
  /** Browsers keep pictures, styles and scripts this many days. 0 switches it off. Default 7 for static sites. */
  staticCacheDays?: number
  /** Send visitors of the bare name to www, or the other way round. Both names must be among the site's domains. */
  redirectWww?: 'none' | 'to-www' | 'to-bare'
  /** Tell browsers to use HTTPS only (HSTS). Only applied while HTTPS is on. */
  hsts?: boolean
  /** Extra response headers. */
  headers?: { name: string; value: string }[]
  /** Extra nginx directives placed inside this site's server block, for what the form does not cover. */
  extra?: string
}

export interface Site {
  id: string
  projectId: string
  /** Short identifier, used for the nginx file name and log names. */
  name: string
  /** One or more domains separated by spaces. */
  domain: string
  appType: AppType
  framework: Framework
  /** Absolute folder on the server that holds the code. */
  rootPath: string
  /** Sub-folder served by nginx, e.g. "public" for Laravel. */
  publicDir: string
  /** Empty = detect the PHP-FPM socket automatically. */
  phpUpstream: string
  proxyPort: number
  /** Proxy sites only: start the app on that port and keep it running (through Supervisor). Absent = the user starts it. */
  runner?: SiteRunner
  source: SourceType
  repoUrl: string
  branch: string
  /** Saved Git account whose token is used to fetch the code. Empty = the server's own access. */
  gitAccountId?: string
  /** The server checks the repository every two minutes and deploys new commits by itself. */
  autoDeploy?: boolean
  /** Shell commands run inside rootPath after the code is in place. */
  postDeploy: string
  /** Load balancer only. */
  lbMethod?: LbMethod
  backends?: Backend[]
  /** When on, visitors get a 503 page. */
  /** Paths of this site that are handed to another address (reverse proxy). */
  proxyRules?: ProxyRule[]
  /** Nginx settings of this site set from the app. */
  nginx?: NginxSettings
  /** Switched off from the app: every request gets a "site is stopped" page and the program the app starts for it is stopped. */
  stopped?: boolean
  /** A preview deploy waiting beside the live files: /preview shows it to that browser, and it can be pushed to production. */
  preview?: SitePreview
  maintenance?: boolean
  /** IP that still sees the real site during maintenance. */
  maintenanceAllowIp?: string
  /** Serve HTTPS with the Let's Encrypt certificate obtained for this site. */
  ssl?: boolean
  sslEmail?: string
  /** Redirect every HTTP request to HTTPS. */
  forceHttps?: boolean
  lastDeployAt?: number
  lastDeployStatus?: 'success' | 'failed' | 'rolled_back'
  /** Path requested after each deploy to see whether the site still answers. Default "/". */
  healthPath?: string
  /** Go back to the previous version when a deploy makes the site fail. Default on. */
  autoRollback?: boolean
  createdAt: number
  updatedAt: number
}

export type SiteInput = Omit<Site, 'id' | 'createdAt' | 'updatedAt' | 'lastDeployAt' | 'lastDeployStatus'> & {
  id?: string
}

export interface ServerEnv {
  os: string
  nginx: string
  php: string
  git: string
  unzip: boolean
  composer: boolean
  node: string
  confDir: string
  phpSockets: string[]
  webUser: string
  packageManager: string
  /** nginx can rewrite pages (sub_filter): used for the bar shown on previews. */
  subFilter?: boolean
}

export interface UploadSource {
  kind: 'folder' | 'archive'
  path: string
}

export const FRAMEWORKS: Record<
  Framework,
  { label: string; appTypes: AppType[]; publicDir: string; hint: string }
> = {
  none: { label: 'None (plain files)', appTypes: ['php', 'static'], publicDir: '', hint: 'No URL rewriting' },
  laravel: { label: 'Laravel', appTypes: ['php'], publicDir: 'public', hint: 'try_files → /index.php?$query_string' },
  thinkphp: { label: 'ThinkPHP', appTypes: ['php'], publicDir: 'public', hint: 'rewrite → /index.php?s=$1' },
  wordpress: { label: 'WordPress', appTypes: ['php'], publicDir: '', hint: 'try_files → /index.php?$args' },
  codeigniter: { label: 'CodeIgniter 4', appTypes: ['php'], publicDir: 'public', hint: 'try_files → /index.php?$query_string' },
  yii2: { label: 'Yii2', appTypes: ['php'], publicDir: 'web', hint: 'try_files → /index.php?$args' },
  symfony: { label: 'Symfony', appTypes: ['php'], publicDir: 'public', hint: 'try_files → /index.php$is_args$args' },
  spa: { label: 'SPA (Vue / React / Angular)', appTypes: ['static'], publicDir: '', hint: 'try_files → /index.html' }
}

// ---------------------------------------------------------------- firewall
export interface FirewallRule {
  /** Opaque id used to delete the rule. */
  id: string
  to: string
  action: string
  from: string
}

export interface FirewallStatus {
  kind: 'ufw' | 'firewalld' | 'none'
  active: boolean
  rules: FirewallRule[]
  /** Port of the SSH session this app is using. */
  sshPort: number
  packageManager: string
}

export interface FirewallRuleInput {
  action: 'allow' | 'deny'
  /** "80", "8000:8100" or empty for all ports. */
  port: string
  proto: 'tcp' | 'udp' | 'both'
  /** IP or CIDR, empty for anyone. */
  from: string
}

export interface NginxFirewall {
  available: boolean
  blocked: string[]
  rateLimit: boolean
  /** Requests per second per client IP. */
  rate: number
  burst: number
}

// ---------------------------------------------------------------- logs and alerts
export interface LogSource {
  id: string
  label: string
}

export interface ThreatRow {
  ip: string
  count: number
  errors?: number
}

export interface Threats {
  ssh: ThreatRow[]
  web: ThreatRow[]
}

export interface AlertConfig {
  enabled: boolean
  /** "team": send through the service with the bot set once under Team → Protection. "own": this server's own bot below. */
  via?: 'team' | 'own'
  /** The team's Telegram is set up on the service (read only). */
  teamReady?: boolean
  /** Empty when saving = keep the stored token. */
  token: string
  hasToken: boolean
  chatId: string
  diskPct: number
  memPct: number
  loadPct: number
  sshFails: number
  watchNginx: boolean
  cooldownMin: number
  /** Warn when an HTTPS certificate has fewer days left than this. 0 = off. */
  certDays: number
  /** Warn when a site on this server stops answering. */
  watchSites: boolean
  /** Warn when a backup that is switched on has produced nothing new for this many hours. 0 = off. */
  backupHours?: number
}

// ---------------------------------------------------------------- databases
export interface DbInfo {
  name: string
  size: number
  tables: number
}

export interface DbUser {
  user: string
  host: string
}

/** Who may connect to a database as its user. */
export interface DbAccess {
  /** local = programs on the server itself; any = every address; list = the addresses in `hosts`. */
  mode: 'local' | 'any' | 'list'
  /** IPv4 or IPv6 addresses, or a range written like 192.168.1.% */
  hosts: string[]
}

export interface DbBackup {
  file: string
  db: string
  size: number
  time: number
}

export interface DbSchedule {
  enabled: boolean
  hour: number
  keepDays: number
}

export interface DbOverview {
  installed: boolean
  version: string
  error?: string
  databases: DbInfo[]
  users: DbUser[]
  backups: DbBackup[]
  schedule: DbSchedule
  packageManager: string
  /** How the database server listens: only on the server itself, or also for other computers. */
  listen?: { remote: boolean; port: number }
}

// ---------------------------------------------------------------- git backups
export type BackupSchedule = 'off' | 'hourly' | 'daily'

export interface BackupJob {
  name: string
  folder: string
  repo: string
  branch: string
  schedule: BackupSchedule
  hour: number
  lastTime?: number
  lastMessage?: string
}

export interface BackupCommit {
  hash: string
  time: number
  message: string
}

// ---------------------------------------------------------------- HTTPS
export interface SslStatus {
  certbot: boolean
  hasCert: boolean
  /** Certificate expiry, ms since epoch. */
  expires?: number
  domains: string[]
  /** Start of validity, ms since epoch. */
  starts?: number
  /** Who signed it, e.g. "Let's Encrypt (R11)". */
  issuer?: string
  fingerprint?: string
  /** The site's certificate (public), PEM. The private key is shown only after an authenticator code (ssl:privateKey). */
  pem?: string
  /** certbot renews it by itself (its timer or cron job is there). */
  autoRenew?: boolean
  /** Folder of the live files on the server. */
  path?: string
}

// ---------------------------------------------------------------- PM2
export interface Pm2Process {
  id: number
  name: string
  status: string
  pid: number
  cpu: number
  memory: number
  restarts: number
  /** When the process was last started, ms since epoch. */
  startedAt: number
  mode: string
  cwd: string
  script: string
}

export interface Pm2Overview {
  installed: boolean
  pm2Version: string
  nodeVersion: string
  /** The Linux user whose PM2 this is. */
  user: string
  /** Users on the server that already have a PM2 home. */
  users: string[]
  processes: Pm2Process[]
  packageManager: string
}

export interface Pm2StartInput {
  name: string
  cwd: string
  /** A script file ("app.js") or an npm command ("npm run start"). */
  command: string
}

export type Pm2Action = 'restart' | 'reload' | 'stop' | 'start' | 'delete'

// ---------------------------------------------------------------- cron
export type CronKind = 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'

export interface CronTask {
  /** Empty when creating. */
  id: string
  name: string
  type: 'shell' | 'url'
  /** Shell script text, or the URL to visit. */
  command: string
  kind: CronKind
  /** minutes: run every N minutes. */
  every: number
  minute: number
  hour: number
  /** 0 = Sunday. */
  weekday: number
  day: number
  /** custom: a 5-field cron expression. */
  expr: string
  enabled: boolean
  lastRun?: number
  lastExit?: number
}

export interface CronOverview {
  /** False when no cron daemon is running, so nothing scheduled will fire. */
  daemonRunning: boolean
  tasks: CronTask[]
  /** Other entries in root's crontab, shown read-only. */
  other: string[]
}

// ---------------------------------------------------------------- PHP
export interface PhpVersion {
  /** "8.3" */
  version: string
  /** "8.3.6" */
  full: string
  fpmInstalled: boolean
  running: boolean
  /** FPM socket path when it exists. */
  socket: string
}

export interface PhpOverview {
  /** False on systems this page cannot manage (it needs apt: Debian or Ubuntu). */
  supported: boolean
  os: string
  versions: PhpVersion[]
  /** Versions that can be installed with one click. */
  installable: string[]
}

export interface PhpConfig {
  /** Current values of the common settings, keyed by directive name. */
  values: Record<string, string>
  /** The whole php.ini used by PHP-FPM. */
  raw: string
}

export interface PhpExtension {
  /** Package suffix, e.g. "redis" for php8.3-redis. */
  name: string
  installed: boolean
  /** Loaded by PHP-FPM. Only meaningful when installed. */
  enabled: boolean
  /** PHP modules the package provides, e.g. mysqli, pdo_mysql. */
  modules: string[]
}

export type PhpExtAction = 'install' | 'enable' | 'disable' | 'remove'

/** The settings shown as a form. Everything else is reachable through the php.ini editor. */
export interface PhpOptimizeInput {
  /** Memory to plan for, in MB. Empty = what the server reports. */
  ramMb?: number
  cores?: number
  /** "php-only": this server runs websites only. "with-database": MySQL or another database shares it. */
  mix: 'php-only' | 'with-database'
}

export interface PhpOptimizePlan {
  detected: { ramMb: number; cores: number }
  ramMb: number
  cores: number
  mix: PhpOptimizeInput['mix']
  /** Memory one PHP worker is assumed to use. */
  workerMb: number
  /** False when this PHP has no worker settings file to tune. */
  hasPool: boolean
  changes: { file: 'php.ini' | 'pool'; key: string; current: string; value: string; why: string }[]
}

export const PHP_SETTINGS: { key: string; label: string; hint: string }[] = [
  { key: 'memory_limit', label: 'Memory limit', hint: 'e.g. 256M' },
  { key: 'upload_max_filesize', label: 'Max upload file size', hint: 'e.g. 64M' },
  { key: 'post_max_size', label: 'Max POST size', hint: 'At least the upload size' },
  { key: 'max_execution_time', label: 'Max execution time', hint: 'Seconds' },
  { key: 'max_input_time', label: 'Max input time', hint: 'Seconds' },
  { key: 'max_input_vars', label: 'Max input variables', hint: 'e.g. 3000' },
  { key: 'max_file_uploads', label: 'Max files per upload', hint: 'e.g. 20' },
  { key: 'display_errors', label: 'Show errors to visitors', hint: 'Off on live sites' },
  { key: 'date.timezone', label: 'Time zone', hint: 'e.g. Asia/Phnom_Penh' },
  { key: 'session.gc_maxlifetime', label: 'Session lifetime', hint: 'Seconds' },
  { key: 'disable_functions', label: 'Disabled functions', hint: 'Comma separated, e.g. exec,system,passthru' }
]

// ---------------------------------------------------------------- Redis
export interface RedisSettings {
  /** Addresses Redis listens on, space separated. */
  bind: string
  port: number
  /** 0 = no limit. */
  maxmemoryMb: number
  policy: string
  /** Append-only file: every write is logged. */
  appendonly: boolean
  /** Periodic snapshots (RDB). */
  rdb: boolean
  /** New password. Empty = keep the current one. */
  password: string
  /** Remove the password altogether. */
  removePassword: boolean
}

export interface RedisStats {
  usedMemory: number
  clients: number
  uptime: number
  hits: number
  misses: number
  role: string
  databases: { db: number; keys: number }[]
}

export interface RedisOverview {
  installed: boolean
  running: boolean
  version: string
  confPath: string
  packageManager: string
  hasPassword: boolean
  /** Reachable from other machines with no password. */
  exposed: boolean
  settings: RedisSettings
  stats?: RedisStats
  raw: string
}

export const REDIS_POLICIES: { value: string; label: string }[] = [
  { value: 'noeviction', label: 'Refuse new writes when full (noeviction)' },
  { value: 'allkeys-lru', label: 'Drop least recently used keys (allkeys-lru)' },
  { value: 'allkeys-lfu', label: 'Drop least frequently used keys (allkeys-lfu)' },
  { value: 'volatile-lru', label: 'Drop least recently used keys that expire (volatile-lru)' },
  { value: 'volatile-lfu', label: 'Drop least frequently used keys that expire (volatile-lfu)' },
  { value: 'volatile-ttl', label: 'Drop keys closest to expiry (volatile-ttl)' },
  { value: 'allkeys-random', label: 'Drop random keys (allkeys-random)' },
  { value: 'volatile-random', label: 'Drop random keys that expire (volatile-random)' }
]

// ---------------------------------------------------------------- deploy history
export interface DeployRecord {
  id: string
  siteId: string
  time: number
  kind: 'deploy' | 'rollback' | 'preview' | 'promote'
  status: 'success' | 'failed' | 'rolled_back'
  /** Git sites: the commit that was live after this deploy. */
  commit?: string
  commitMessage?: string
  /** Git sites: the commit that was live before it. */
  prevCommit?: string
  /** Upload sites: archive of the files as they were before this deploy. */
  snapshot?: string
  /** HTTP status the site answered with afterwards (0 = no answer). */
  health?: number
  note?: string
}

// ---------------------------------------------------------------- file manager
/** Largest text file the built-in editor opens. */
export const MAX_EDIT_BYTES = 2 * 1024 * 1024

export interface FileEntry {
  name: string
  type: 'file' | 'dir' | 'link' | 'other'
  /** True for folders and for links that point at a folder. */
  isDir: boolean
  size: number
  mtime: number
  /** Octal permissions, e.g. "644". */
  mode: string
  owner: string
  group: string
}

export interface FileListing {
  /** The folder's real path on the server. */
  path: string
  entries: FileEntry[]
  truncated: boolean
  diskTotal: number
  diskFree: number
  /** Set when the signed-in person can only work inside this folder. */
  root: string | null
}

export interface FileText {
  path: string
  content: string
  /** Opaque marker of the version that was read; pass it back when saving. */
  version: string
  mode: string
  owner: string
  group: string
}

// ---------------------------------------------------------------- NFS (shared folders between servers)
/** How files written by the other servers are owned here. */
export type NfsOwner = 'keep' | 'web' | 'root'

/** A folder this server shares with other servers. */
export interface NfsShare {
  path: string
  /** Addresses or ranges that may mount it (IPv4 or IPv4/CIDR). */
  clients: string[]
  readOnly: boolean
  /** keep: their users stay their users, root becomes nobody. web: everything written is owned by the web server's user. root: their root is root here. */
  owner: NfsOwner
}

/** A folder of another server mounted here. */
export interface NfsMount {
  server: string
  remote: string
  local: string
  readOnly: boolean
  mounted: boolean
  /** Bytes, when mounted. */
  size?: number
  used?: number
}

export interface NfsOverview {
  /** nfs-kernel-server (or nfs-utils) is there: this server can share. */
  serverInstalled: boolean
  serverRunning: boolean
  /** nfs-common (or nfs-utils) is there: this server can mount. */
  clientInstalled: boolean
  shares: NfsShare[]
  /** Lines in /etc/exports made another way. Shown, not changed. */
  otherExports: string[]
  mounts: NfsMount[]
  /** This server's own IPv4 addresses, private ones first, for the other servers to connect to. */
  addresses: string[]
  /** The firewall that will be opened for the clients: ufw, firewalld or none. */
  firewall: 'ufw' | 'firewalld' | 'none'
}

/** One line that matched a search across files. */
export interface FileSearchHit {
  path: string
  line: number
  text: string
}

export interface FileSearchResult {
  hits: FileSearchHit[]
  /** More matched than are shown, or the search stopped at its time limit. */
  truncated: boolean
}

export interface FilePermInput {
  mode: string
  owner?: string
  group?: string
  recursive: boolean
}

/** Something deleted in the file manager that can still be restored. */
export interface TrashEntry {
  id: string
  name: string
  /** Where it was, and where a restore puts it back. */
  path: string
  deletedAt: number
  /** Who deleted it. */
  by: string
  isDir: boolean
  size: number
}

/** A saved sign-in for a Git host, so private repositories deploy without typing a token each time. */
export interface GitAccount {
  id: string
  /** Shown in lists, e.g. "Company GitHub". */
  name: string
  /** Sign-in name sent with the token. GitHub accepts any; GitLab wants "oauth2"; Bitbucket wants your username. */
  username: string
  hasToken: boolean
  /** "github": checked against GitHub, with repository and branch lists. "other": any Git host over https. */
  provider: 'github' | 'other'
  /** GitHub user the token belongs to. */
  login?: string
  ownerId?: string
  /** True = everyone on the team may deploy with it. False = only the person who added it. */
  shared: boolean
  createdAt: number
}

export interface GitAccountInput {
  id?: string
  name: string
  username: string
  /** Leave empty when editing to keep the stored token. */
  token?: string
  shared: boolean
  ownerId?: string
  provider?: 'github' | 'other'
  login?: string
}

// ---------------------------------------------------------------- Google Drive backups
export interface GdriveOptions {
  /** Name of the folder made in the Drive. */
  folder: string
  /** Copies older than this leave the Drive. 0 = keep for ever. */
  keepDays: number
  /** Back up every database once a day and send it, along with backups made on the Databases page. */
  includeDb: boolean
  /** Internal: false sends only backups that already exist. Default true. */
  dumpDb?: boolean
  /** How often the server uploads, in hours: 1, 6, 12 or 24. Default 1. */
  everyHours?: number
  /** Server-time hour (0-23) from which the day's database backups and folder archives are made; with 24 it is also when the upload runs. Default 2. */
  dailyHour?: number
  /** Folders packed once a day and sent. */
  paths: string[]
}

export interface GdriveStatus extends GdriveOptions {
  enabled: boolean
  /** The Google account it uploads to. */
  email?: string
  /** Files in the Drive folder that this server put there. */
  uploaded: number
  newest?: { name: string; at: number }
  last?: { at: number; ok: boolean; message: string }
  /** Last lines of the server's own log. */
  recent: string[]
  /** The server's clock, for reading the schedule: for example "14:05 UTC". */
  serverTime?: string
}

export interface DockerContainer {
  id: string
  name: string
  image: string
  /** running, exited, created, paused, restarting, dead */
  state: string
  status: string
  ports: string
  created: string
  cpu?: string
  memory?: string
  /** Compose project it belongs to, if any. */
  project?: string
}

export interface DockerImage {
  id: string
  /** "repository:tag"; empty for an image without a name. */
  name: string
  size: string
  created: string
  /** A container (running or stopped) was made from it. */
  used: boolean
}

export interface DockerOverview {
  installed: boolean
  /** The Docker service answers. */
  running: boolean
  version: string
  /** Version of the Compose plugin, empty when missing. */
  compose: string
  packageManager: string
  containers: DockerContainer[]
  images: DockerImage[]
  projects: { name: string; status: string; files: string }[]
  disk: { type: string; size: string; reclaimable: string }[]
}

export interface DockerRunInput {
  image: string
  name: string
  /** `public` false (default) publishes on 127.0.0.1 only. */
  ports: { host: number; container: number; public?: boolean }[]
  /** `host` is a folder on the server or the name of a Docker volume. */
  volumes: { host: string; container: string }[]
  env: { key: string; value: string }[]
  restart?: 'no' | 'always' | 'unless-stopped' | 'on-failure'
  /** Optional command instead of the image's own. */
  command?: string
}

/** Copies of backups in S3-compatible storage. */
export interface S3Options {
  /** Address of the storage, e.g. https://s3.ap-southeast-1.amazonaws.com or https://<account>.r2.cloudflarestorage.com */
  endpoint: string
  region: string
  bucket: string
  /** Folder inside the bucket. May be empty. */
  prefix: string
  accessKey: string
  /** Empty when changing settings: keep the key already on the server. Never read back. */
  secretKey?: string
  keepDays: number
  /** Back up every MySQL / MariaDB and PostgreSQL database once a day and send it, with backups made by hand. */
  includeDb: boolean
  everyHours?: number
  dailyHour?: number
  paths: string[]
}

export interface S3Status extends S3Options {
  enabled: boolean
  uploaded: number
  newest?: { name: string; at: number }
  last?: { at: number; ok: boolean; message: string }
  recent: string[]
  serverTime?: string
}

export interface S3RemoteFile {
  /** "<kind>/<file name>" inside this server's folder of the bucket. */
  id: string
  name: string
  size: number
  at: number
  kind: 'mysql' | 'postgres' | 'remote-db' | 'folders'
}

/** A backup this app put in the Drive folder. */
export interface GdriveRemoteFile {
  id: string
  name: string
  size: number
  at: number
  kind: 'database' | 'folder'
}

export interface GoogleStatus {
  configured: boolean
  clientId?: string
  canSetup: boolean
  /** A Google sign-in approved in this session is waiting to be used. */
  ready?: { email: string }
  /** A client secret is stored (it is never sent back). */
  secretSet?: boolean
  /** The team's own Google account, connected once by an admin. */
  team?: { email: string; by?: string; at: number }
}

export interface GoogleConnectStart {
  userCode: string
  verificationUrl: string
  expiresIn: number
  interval: number
}

export interface GoogleConnectPoll {
  state: 'pending' | 'done' | 'expired' | 'denied'
  interval?: number
  email?: string
}

/** Where "Connect GitHub" stands for this app. */
export interface GithubStatus {
  /** The team's OAuth App Client ID has been entered. */
  configured: boolean
  clientId?: string
  /** This person may enter or change the Client ID. */
  canSetup: boolean
}

export interface GithubConnectStart {
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export interface GithubConnectPoll {
  state: 'pending' | 'done' | 'expired' | 'denied'
  /** Seconds to wait before the next check. */
  interval?: number
  account?: GitAccount
}

export interface GithubRefs {
  branches: string[]
  tags: string[]
}

export interface GithubRepoInfo {
  fullName: string
  cloneUrl: string
  private: boolean
  defaultBranch: string
  pushedAt: number
}

// ---------------------------------------------------------------- long-term monitor history
export type HistoryRange = '1h' | '24h' | '7d'

export interface HistoryStatus {
  /** The server is recording one line per minute. */
  enabled: boolean
  /** Time of the oldest record. */
  since?: number
  points: number
}

export interface HistoryPoint {
  ts: number
  cpu: number
  mem: number
  disk: number
  load: number
  rx: number
  tx: number
}

export interface CertInfo {
  domain: string
  daysLeft: number
}

// ---------------------------------------------------------------- security check-up
export type SecurityFix = 'root-login' | 'fail2ban' | 'auto-updates' | 'upgrade'

export interface SecurityCheck {
  id: string
  title: string
  /** How much of the score this check carries. */
  weight: number
  ok: boolean
  detail: string
  action?: { kind: 'fix'; fix: SecurityFix; label: string; confirm: string } | { kind: 'page'; page: 'firewall'; label: string } | { kind: 'note'; label: string }
}

/** A service on the server that can be restarted from the overview. */
export interface ServiceInfo {
  /** systemd unit (or init script) name, e.g. "php8.3-fpm". */
  unit: string
  name: string
  running: boolean
}

/** Addresses Fail2ban is blocking, grouped by the rule that caught them. */
export interface BannedList {
  state: 'running' | 'stopped' | 'missing'
  jails: { name: string; /** How long a block lasts, in seconds. */ banSeconds: number; addresses: string[] }[]
}

/** One line of the "Protection status" panel. */
export interface SecurityProtection {
  id: string
  name: string
  on: boolean
  detail: string
  /** How to turn it on or adjust it: a one-click fix, or the page that manages it. */
  action?: { kind: 'fix'; fix: SecurityFix; label: string; confirm: string } | { kind: 'page'; page: 'firewall' | 'logs'; label: string }
}

export interface SecurityReport {
  /** 0 to 100. */
  score: number
  checks: SecurityCheck[]
  sshPort: number
  protections: SecurityProtection[]
  stats: {
    /** Failed SSH sign-ins in the last 24 hours; null when the server's log cannot say. */
    failedLogins: number | null
    /** Addresses Fail2ban is blocking right now; null when it is not running. */
    banned: number | null
    pendingUpdates: number | null
    restartNeeded: boolean
  }
  scannedAt: number
}

// ---------------------------------------------------------------- auto deploy
export interface AutoDeployStatus {
  /** Set up on the server and scheduled. */
  enabled: boolean
  /** An access token for this site is stored on the server. */
  tokenOnServer: boolean
  /** The last check could not read the repository. */
  unreachable: boolean
  last?: { time: string; result: 'ok' | 'rolled-back' | 'failed'; commit: string; note: string }
  /** Tail of the server's own log of automatic deploys. */
  log: string
}

// ---------------------------------------------------------------- database backups on another server
export interface OffsiteStatus {
  enabled: boolean
  /** Address of the receiving server, as the database server reaches it. */
  host: string
  port: number
  /** Name of the receiving server in the app. */
  label: string
  folder: string
  keepDays: number
  /** Backups that exist here and have been copied. */
  copied: number
  /** Backups that exist here. */
  local: number
  /** The last run could not copy everything. */
  failing: boolean
  /** Last result line of the server's own log. */
  last: string
}

// ---------------------------------------------------------------- database client
export interface DbResultSet {
  /** The statement that produced it, shortened. */
  statement: string
  columns: string[]
  /** null = SQL NULL. Everything else arrives as text. */
  rows: (string | null)[][]
  /** Rows the statement returned; `rows` may hold fewer. */
  total: number
  truncated: boolean
  /** Set for a statement that returns no rows (INSERT, UPDATE, CREATE...): how many rows it changed. */
  affected?: number
}

/** A saved way to reach a MySQL / MariaDB database from this computer, as in a desktop database tool. */
export interface DbConnection {
  id: string
  name: string
  /** As seen from this computer, or from the SSH server when `useSsh` is on. */
  host: string
  port: number
  username: string
  hasPassword: boolean
  /** Opened first, when given. */
  database?: string
  /** Reach the database through an SSH server (a tunnel), so its port does not have to be open. */
  useSsh: boolean
  /** One of the saved servers supplies the SSH sign-in. Empty = the SSH fields below. */
  sshProjectId?: string
  sshHost?: string
  sshPort?: number
  sshUsername?: string
  sshAuth?: 'password' | 'key'
  hasSshPassword: boolean
  hasSshKey: boolean
  ownerId?: string
  /** True = everyone on the team with access to data may use it. */
  shared: boolean
  /** The managed server that makes this connection's scheduled backups to Google Drive, when switched on. */
  backupProjectId?: string
  createdAt: number
}

export interface DbConnectionInput {
  id?: string
  name: string
  host: string
  port: number
  username: string
  /** Leave empty when editing to keep the stored one. The same goes for the SSH secrets. */
  password?: string
  database?: string
  useSsh: boolean
  sshProjectId?: string
  sshHost?: string
  sshPort?: number
  sshUsername?: string
  sshAuth?: 'password' | 'key'
  sshPassword?: string
  sshKey?: string
  sshPassphrase?: string
  shared: boolean
  ownerId?: string
}

export interface DbConnectionTest {
  /** e.g. "11.4.2-MariaDB" */
  version: string
  ms: number
}

export interface DbRunResult {
  sets: DbResultSet[]
  /** The database's own error message, when a statement failed. Earlier statements still ran. */
  error?: string
  ms: number
}

export interface DbTableSummary {
  name: string
  view: boolean
  /** The database's estimate, not an exact count. */
  rows: number
  size: number
  engine: string
}

export interface DbColumn {
  name: string
  type: string
  nullable: boolean
  /** "PRI", "UNI", "MUL" or "". */
  key: string
  default: string | null
  extra: string
  comment: string
}

export interface DbTableInfo {
  columns: DbColumn[]
  primaryKey: string[]
  indexes: { name: string; unique: boolean; columns: string[] }[]
  createSql: string
}

/** One column as edited in the table designer. */
export interface DbDesignColumn {
  /** Its name in the database now; absent for a column being added. */
  original?: string
  name: string
  /** As MySQL writes it: int, varchar(255), decimal(10,2), enum('a','b')... */
  type: string
  nullable: boolean
  /** Empty = no default. NULL, CURRENT_TIMESTAMP and numbers are taken as they are; '' (two quote marks) = empty text; anything else is text. */
  default?: string
  autoIncrement: boolean
  primary: boolean
  comment?: string
}

export interface DbTableDesign {
  name: string
  columns: DbDesignColumn[]
  comment?: string
}

export interface DbImportResult {
  file: string
  statements: number
  /** Set when a statement failed; the ones before it were run. */
  error?: string
}

export interface DbGridPage {
  total: number
  columns: string[]
  rows: (string | null)[][]
  page: number
  pageSize: number
}

export interface DbBrowseOptions {
  page: number
  pageSize: number
  orderBy?: string
  descending?: boolean
  where?: string
}

// ---------------------------------------------------------------- Node.js and Composer
export interface NodeOverview {
  /** False when the server's processor has no official Node.js build. */
  supported: boolean
  arch: string
  /** Versions installed by this app, newest first, such as "v22.11.0". */
  versions: string[]
  /** The version the node command points at, when it is one of ours. */
  current: string
  /** What `node -v` answers on the server right now. */
  running: string
  npm: string
  /** Path of a node that was installed some other way and is the one that answers. */
  foreign: string
  /** Release lines offered for install. */
  lines: number[]
}

export interface ComposerOverview {
  installed: boolean
  path: string
  version: string
  /** PHP version Composer runs with; empty when there is no PHP. */
  php: string
}

// ---------------------------------------------------------------- Supervisor
export interface SupervisorProgramInput {
  name: string
  command: string
  directory?: string
  user?: string
  numprocs?: number
  autostart?: boolean
}

export interface SupervisorProgram {
  name: string
  /** Made in this app, so it can be changed and removed here. */
  managed: boolean
  command: string
  directory: string
  user: string
  numprocs: number
  autostart: boolean
  logfile: string
  /** RUNNING, STOPPED, FATAL, BACKOFF, STARTING, EXITED, PARTLY or UNKNOWN. */
  state: string
  detail: string
}

export interface SupervisorOverview {
  installed: boolean
  running: boolean
  version: string
  programs: SupervisorProgram[]
}

// ---------------------------------------------------------------- PostgreSQL
export interface PgOverview {
  installed: boolean
  packageManager: boolean
  running: boolean
  version: string
  listen: string
  port: number
  databases: { name: string; size: number; owner: string }[]
  backups: { file: string; database: string; size: number; at: number }[]
}

/** Apps the App Store can uninstall. The key is the tile's. */
export type UninstallApp = 'sites' | 'php' | 'pm2' | 'database' | 'postgres' | 'mongo' | 'redis' | 'supervisor' | 'docker'

/** Apps whose version can be chosen at install. */
export type VersionApp = 'postgres' | 'mariadb' | 'redis'

export interface VersionChoice {
  /** "system", or the release line. */
  id: string
  label: string
  note: string
}

export interface MongoOverview {
  installed: boolean
  running: boolean
  version: string
  /** The app made its own admin user here and can manage databases. */
  managed: boolean
  bind: string
  port: number
  /** mongodump / mongorestore are there. */
  tools: boolean
  /** "ubuntu noble 24.04", when not installed. */
  os: string
  /** Release lines MongoDB publishes for this system, newest first (when not installed). */
  lines: string[]
  /** Why the databases could not be read, when MongoDB refused. */
  denied?: string
  databases: { name: string; size: number; collections: number; users: string[] }[]
  backups: { file: string; database: string; size: number; at: number }[]
}

// ---------------------------------------------------------------- Python and Java
export interface PythonOverview {
  installed: boolean
  packageManager: string
  path: string
  version: string
  /** Can make virtual environments (what a Python site needs). */
  venv: boolean
  pip: string
  /** Every python3.x found on the server. */
  others: { path: string; version: string }[]
}

export interface JavaOverview {
  installed: boolean
  packageManager: string
  /** What the java command answers. */
  version: string
  current: string
  jdks: { home: string; version: string; line: number; compiler: boolean; isDefault: boolean }[]
  lines: number[]
}

/** How a site of type "app on a port" is kept running. */
export type RunnerKind = 'python' | 'java' | 'command'
export interface SiteRunner {
  kind: RunnerKind
  /** Start command, run in the site's folder. {port} stands for the site's port. */
  command: string
  /** System user the app runs as. Empty = the web server's user. */
  user?: string
}

// ---------------------------------------------------------------- Database Remote: scheduled backups run by a server
/** When a scheduled backup of a remote database runs (server time). */
export interface DbRemoteWhen {
  kind: 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly'
  /** minutes: every N minutes (5 to 59). */
  every: number
  minute: number
  hour: number
  /** 0 = Sunday. */
  weekday: number
  /** Day of the month, 1 to 28. */
  day: number
}

export interface DbRemoteSchedule {
  when: DbRemoteWhen
  /** The connection's id. */
  id: string
  /** The connection's name as used in file names. */
  label: string
  name: string
  host: string
  databases: string[]
  last?: { at: number; ok: boolean; message: string }
  files: { name: string; size: number; at: number; inDrive: boolean }[]
}

export interface DbRemoteStatus {
  driveConnected: boolean
  serverTime: string
  schedules: DbRemoteSchedule[]
}

// ---------------------------------------------------------------- projects: servers that work together
/** What a server does inside a project. */
export type GroupRole = 'frontend' | 'api' | 'lb' | 'database' | 'cache' | 'worker' | 'storage' | 'other'
export interface GroupMember {
  projectId: string
  role: GroupRole
  /** Free text shown beside the role, such as "api-1" or "primary". */
  label?: string
}
/** A project: several saved servers that run one system together (frontend, APIs behind a load balancer, database). A server may be in several projects. */
export interface ServerGroup {
  id: string
  name: string
  note?: string
  color?: string
  members: GroupMember[]
  ownerId?: string
  /** Whole team, or only the person who made it. Who can use each server is still set on the server. */
  shared: boolean
  /** NFS folders mounted on the project's servers, also on servers added later. */
  nfs?: GroupNfs[]
  createdAt: number
}
/** One server's shared folder, mounted on the other servers of a project (all of them, or those with the given roles). */
export interface GroupNfs {
  id: string
  /** The server that shares the folder. */
  serverId: string
  path: string
  /** Where it is mounted on the others. */
  local: string
  readOnly: boolean
  owner: NfsOwner
  /** Empty: every other server of the project. */
  roles: GroupRole[]
  allowPublic: boolean
}
export interface ServerGroupInput {
  id?: string
  name: string
  note?: string
  color?: string
  members: GroupMember[]
  shared: boolean
  nfs?: GroupNfs[]
}

/** A preview of an upload site (static or PHP), kept in "<root>.preview" until it is pushed live or discarded. */
export interface SitePreview {
  at: number
  by?: string
  /** Value of the cookie /preview sets; a browser without it sees the live site. */
  token: string
  /** HTTP status the preview answered with after the upload (0 = no answer). */
  health?: number
}
export type DeployTarget = 'production' | 'preview'

// ---------------------------------------------------------------- nginx itself (App Store → Nginx)
export interface NginxOverview {
  installed: boolean
  version: string
  running: boolean
  workers: number
  memoryKb: number
  /** Seconds since the main process started. */
  upSeconds: number
  configOk: boolean
  /** The last lines of "nginx -t". */
  testOutput: string
  hasStubStatus: boolean
}

/** Performance settings kept in nginx.conf, in the units the form shows. */
export interface NginxTuning {
  /** "auto" or a number. */
  workerProcesses: string
  workerConnections: number
  /** Seconds. */
  keepaliveTimeout: number
  gzip: boolean
  gzipMinLengthKb: number
  gzipCompLevel: number
  /** 0 = no limit. Sites set their own, which wins. */
  clientMaxBodyMb: number
  serverNamesHashBucketSize: number
  clientHeaderBufferKb: number
  clientBodyBufferKb: number
}

export interface NginxLoad {
  active: number
  accepts: number
  handled: number
  requests: number
  reading: number
  writing: number
  waiting: number
  workers: number
  memoryKb: number
  at: number
}
