import { contextBridge, ipcRenderer } from 'electron'
import type { ApprovalRequest, ApprovalWaiting, AuditPage, AuditQuery, GuardInput, GuardView, LoginStep, SessionState, TeamMember, TeamUser, TeamUserInput } from '@shared/team'
import type {
  AlertConfig,
  FileListing,
  FilePermInput,
  FileText,
  FileSearchResult,
  DbBrowseOptions,
  DbGridPage,
  DbRunResult,
  DbTableInfo,
  DbTableSummary,
  OffsiteStatus,
  AutoDeployStatus,
  SecurityFix,
  SecurityReport,
  CertInfo,
  HistoryPoint,
  HistoryRange,
  HistoryStatus,
  DbConnection,
  DbConnectionInput,
  DbConnectionTest,
  DbImportResult,
  DbTableDesign,
  BannedList,
  GdriveOptions,
  S3Options,
  DockerOverview,
  MongoOverview,
  VersionApp,
  UninstallApp,
  ProxyRule,
  NginxSettings,
  VersionChoice,
  DockerRunInput,
  S3RemoteFile,
  S3Status,
  GdriveRemoteFile,
  GdriveStatus,
  GitAccount,
  GoogleConnectPoll,
  GoogleConnectStart,
  GoogleStatus,
  PhpOptimizeInput,
  PhpOptimizePlan,
  ServiceInfo,
  GitAccountInput,
  GithubConnectPoll,
  GithubConnectStart,
  GithubRefs,
  GithubRepoInfo,
  GithubStatus,
  TrashEntry,
  BackendStatus,
  BackupCommit,
  BackupJob,
  ConnState,
  CronOverview,
  DeployRecord,
  CronTask,
  PhpConfig,
  PhpExtAction,
  PhpExtension,
  PhpOverview,
  Pm2Action,
  Pm2Overview,
  RedisOverview,
  RedisSettings,
  NodeOverview,
  ComposerOverview,
  SupervisorOverview,
  NfsOverview,
  NginxOverview,
  NginxTuning,
  NginxLoad,
  DeployTarget,
  ServerGroup,
  ServerGroupInput,
  NfsShare,
  NfsOwner,
  SupervisorProgramInput,
  PgOverview,
  DbRemoteStatus,
  DbRemoteWhen,
  PythonOverview,
  JavaOverview,
  Pm2StartInput,
  DbAccess,
  DbOverview,
  DbSchedule,
  FirewallRuleInput,
  FirewallStatus,
  LogSource,
  NginxFirewall,
  SslStatus,
  Threats,
  MonitorSample,
  Project,
  ProjectInput,
  ServerEnv,
  Site,
  SiteInput,
  UploadSource
} from '@shared/types'

/** Thrown for every failed call; `code` is "forbidden" when the role does not allow it. */
class ApiError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message)
  }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke('rpc', channel, args)) as { ok: boolean; data?: T; error?: string; code?: string }
  if (!res.ok) throw new ApiError(res.error || 'Something went wrong.', res.code ?? 'error')
  return res.data as T
}

function post(name: string, ...args: unknown[]): void {
  ipcRenderer.send('rpc-send', name, args)
}

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const fn = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, fn)
  return () => {
    ipcRenderer.removeListener(channel, fn)
  }
}

const api = {
  platform: process.platform,
  tasks: {
    load: (owner: string) => invoke<unknown[]>('tasks:load', owner),
    save: (owner: string, tasks: unknown[]) => invoke<void>('tasks:save', owner, tasks)
  },
  session: {
    /** What a fresh identity check asks for: an authenticator code, or the account password for accounts without an authenticator. */
    proofKind: () => invoke<'totp' | 'password'>('stepup:need'),
    /** Have the service check a fresh code. `what` is written to the audit log. */
    confirm: (proof: string, what: string) => invoke<void>('session:confirm', proof, what),
    state: () => invoke<SessionState>('session:state'),
    connect: (url: string) => invoke<SessionState>('session:connect', url),
    onChange: (cb: (s: SessionState) => void) => listen('session:changed', cb),
    /** A colleague (or a refused change) altered the shared servers or sites. */
    onStoreChanged: (cb: () => void) => listen('store:changed', cb),
    onStoreError: (cb: (p: { message: string }) => void) => listen('store:error', cb)
  },
  auth: {
    login: (username: string, password: string) => invoke<LoginStep>('auth:login', username, password),
    totp: (code: string) => invoke<LoginStep>('auth:totp', code),
    setPassword: (password: string) => invoke<LoginStep>('auth:setPassword', password),
    changePassword: (current: string, next: string) => invoke<null>('auth:changePassword', current, next),
    logout: () => invoke<null>('auth:logout')
  },
  users: {
    list: () => invoke<TeamUser[]>('users:list'),
    directory: () => invoke<TeamMember[]>('users:directory'),
    create: (input: TeamUserInput) => invoke<{ user: TeamUser; password: string }>('users:create', input),
    update: (input: TeamUserInput) => invoke<TeamUser>('users:update', input),
    remove: (id: string) => invoke<string>('users:remove', id),
    resetPassword: (id: string) => invoke<{ username: string; password: string }>('users:resetPassword', id),
    resetTwoFactor: (id: string) => invoke<string>('users:resetTwoFactor', id),
    unlock: (id: string) => invoke<string>('users:unlock', id)
  },
  guard: {
    get: () => invoke<GuardView>('guard:get'),
    /** `proof` is a fresh authenticator code. */
    save: (input: GuardInput, proof: string) => invoke<GuardView>('guard:save', input, proof),
    test: () => invoke<void>('guard:test')
  },
  approval: {
    list: () => invoke<ApprovalRequest[]>('approval:list'),
    decide: (id: string, approve: boolean) => invoke<void>('approval:decide', id, approve),
    cancel: (id: string) => invoke<boolean>('approval:cancel', id),
    /** Requests from other admins waiting for an answer. */
    onPending: (cb: (list: ApprovalRequest[]) => void) => listen('approval:pending', cb),
    /** This app's own request is waiting (null: no longer). */
    onWaiting: (cb: (w: ApprovalWaiting | null) => void) => listen('approval:waiting', cb)
  },
  audit: {
    query: (q: AuditQuery) => invoke<AuditPage>('audit:query', q),
    verify: () => invoke<{ ok: boolean; entries: number; brokenAt?: number }>('audit:verify'),
    transcript: (sessionId: string) => invoke<{ size: number; text: string }>('audit:transcript', sessionId)
  },
  projects: {
    list: () => invoke<Project[]>('projects:list'),
    save: (input: ProjectInput) => invoke<Project>('projects:save', input),
    remove: (id: string) => invoke<void>('projects:remove', id),
    test: (input: ProjectInput) => invoke<{ system: string; user: string; fingerprint: string }>('projects:test', input),
    forgetHostKey: (id: string) => invoke<Project>('projects:forgetHostKey', id),
    readKeyFile: () => invoke<string | null>('projects:readKeyFile')
  },
  ssh: {
    connect: (id: string) => invoke<ConnState>('ssh:connect', id),
    disconnect: (id: string) => invoke<void>('ssh:disconnect', id),
    state: (id: string) => invoke<ConnState>('ssh:state', id),
    onState: (cb: (p: { projectId: string; state: ConnState }) => void) => listen('ssh:state', cb)
  },
  server: {
    services: (id: string) => invoke<ServiceInfo[]>('server:services', id),
    restartService: (id: string, unit: string) => invoke<void>('server:restartService', id, unit),
    reboot: (id: string) => invoke<void>('server:reboot', id),
    stopService: (id: string, unit: string) => invoke<void>('server:stopService', id, unit),
    shutdown: (id: string) => invoke<void>('server:shutdown', id),
    plannedReboot: (id: string) => invoke<{ at: number; serverTime: string } | null>('server:plannedReboot', id),
    planReboot: (id: string, at: number | null) => invoke<void>('server:planReboot', id, at)
  },
  monitor: {
    sample: (id: string, allowConnect: boolean) => invoke<MonitorSample>('monitor:sample', id, allowConnect),
    historyStatus: (id: string) => invoke<HistoryStatus>('monitor:historyStatus', id),
    historySet: (id: string, on: boolean) => invoke<void>('monitor:historySet', id, on),
    history: (id: string, range: HistoryRange) => invoke<HistoryPoint[]>('monitor:history', id, range),
    certs: (id: string) => invoke<CertInfo[]>('monitor:certs', id)
  },
  terminal: {
    open: (projectId: string, cols: number, rows: number) => invoke<string>('terminal:open', projectId, cols, rows),
    close: (id: string) => invoke<void>('terminal:close', id),
    write: (id: string, data: string) => post('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) => post('terminal:resize', id, cols, rows),
    onData: (cb: (p: { id: string; data: string }) => void) => listen('terminal:data', cb),
    onExit: (cb: (p: { id: string }) => void) => listen('terminal:exit', cb)
  },
  sites: {
    list: (projectId: string) => invoke<Site[]>('sites:list', projectId),
    autoDeploy: (id: string, on: boolean) => invoke<Site>('sites:autoDeploy', id, on),
    autoStatus: (id: string) => invoke<AutoDeployStatus>('sites:autoStatus', id),
    autoRun: (id: string) => invoke<void>('sites:autoRun', id),
    save: (input: SiteInput) => invoke<Site>('sites:save', input),
    remove: (id: string, removeConfig: boolean) => invoke<void>('sites:remove', id, removeConfig),
    preflight: (projectId: string) => invoke<ServerEnv>('sites:preflight', projectId),
    previewNginx: (id: string) => invoke<string>('sites:previewNginx', id),
    checkBackends: (id: string) => invoke<BackendStatus[]>('sites:checkBackends', id),
    pickUpload: (kind: 'folder' | 'archive') => invoke<string | null>('sites:pickUpload', kind),
    deploy: (id: string, upload?: UploadSource, target?: DeployTarget) => invoke<Site>('sites:deploy', id, upload, target),
    promote: (id: string) => invoke<void>('sites:promote', id),
    discardPreview: (id: string) => invoke<Site>('sites:discardPreview', id),
    log: (id: string, kind: 'access' | 'error', lines: number, filter: string) => invoke<{ path: string; exists: boolean; size: number; text: string }>('sites:log', id, kind, lines, filter),
    logStats: (id: string) =>
      invoke<{ requests: number; bytes: number; status: { s2: number; s3: number; s4: number; s5: number }; first: string; last: string; ips: { ip: string; count: number; errors: number }[]; paths: { path: string; count: number }[] }>('sites:logStats', id),
    logClear: (id: string, kind: 'access' | 'error') => invoke<void>('sites:logClear', id, kind),
    logDownload: (id: string, siteName: string, kind: 'access' | 'error') => invoke<string | null>('sites:logDownload', id, siteName, kind),
    history: (id: string) => invoke<DeployRecord[]>('sites:history', id),
    rollback: (id: string, recordId: string) => invoke<void>('sites:rollback', id, recordId),
    install: (projectId: string, group: 'base' | 'php') => invoke<void>('sites:install', projectId, group),
    /** Change the names a site answers to, apply it, and widen its certificate when HTTPS is on. */
    setDomains: (id: string, domains: string[]) => invoke<void>('sites:setDomains', id, domains),
    setMaintenance: (id: string, enabled: boolean, allowIp: string) => invoke<Site>('sites:setMaintenance', id, enabled, allowIp),
    setStopped: (id: string, stopped: boolean) => invoke<Site>('sites:setStopped', id, stopped),
    /** Reverse proxy rules and nginx settings; nginx checks the result and a refused config is put back. */
    setNginx: (id: string, input: { proxyRules: ProxyRule[]; nginx: NginxSettings }) => invoke<Site>('sites:setNginx', id, input),
    copyTo: (id: string, toProjectId: string, withFiles: boolean) => invoke<void>('sites:copyTo', id, toProjectId, withFiles),
    onLog: (cb: (p: { jobId: string; chunk: string }) => void) => listen('job:log', cb),
    /** A task started or ended. `method`, `project` and `target` come with "running". */
    onJobState: (cb: (p: { jobId: string; state: 'running' | 'done' | 'failed'; method?: string; project?: string; target?: string }) => void) => listen('job:state', cb)
  },
  transfer: {
    copy: (fromId: string, fromPath: string, toId: string, toPath: string) =>
      invoke<void>('transfer:copy', fromId, fromPath, toId, toPath)
  },
  pm2: {
    overview: (id: string, user: string) => invoke<Pm2Overview>('pm2:overview', id, user),
    action: (id: string, user: string, procId: number, what: Pm2Action) => invoke<void>('pm2:action', id, user, procId, what),
    logs: (id: string, user: string, procId: number, lines: number) => invoke<string>('pm2:logs', id, user, procId, lines),
    start: (id: string, user: string, input: Pm2StartInput) => invoke<void>('pm2:start', id, user, input),
    startOnBoot: (id: string, user: string) => invoke<void>('pm2:startOnBoot', id, user),
    install: (id: string) => invoke<void>('pm2:install', id)
  },
  php: {
    overview: (id: string) => invoke<PhpOverview>('php:overview', id),
    install: (id: string, version: string) => invoke<void>('php:install', id, version),
    restart: (id: string, version: string) => invoke<void>('php:restart', id, version),
    getConfig: (id: string, version: string) => invoke<PhpConfig>('php:getConfig', id, version),
    saveSettings: (id: string, version: string, values: Record<string, string>) => invoke<void>('php:saveSettings', id, version, values),
    saveRaw: (id: string, version: string, raw: string) => invoke<void>('php:saveRaw', id, version, raw),
    optimizePlan: (id: string, version: string, input: PhpOptimizeInput) => invoke<PhpOptimizePlan>('php:optimizePlan', id, version, input),
    optimizeApply: (id: string, version: string, input: PhpOptimizeInput) => invoke<void>('php:optimizeApply', id, version, input),
    extensions: (id: string, version: string) => invoke<PhpExtension[]>('php:extensions', id, version),
    extension: (id: string, version: string, name: string, action: PhpExtAction) => invoke<void>('php:extension', id, version, name, action)
  },
  dbconn: {
    list: () => invoke<(DbConnection & { open: boolean })[]>('dbconn:list'),
    save: (input: DbConnectionInput) => invoke<DbConnection>('dbconn:save', input),
    test: (input: DbConnectionInput) => invoke<DbConnectionTest>('dbconn:test', input),
    remove: (id: string) => invoke<void>('dbconn:remove', id),
    close: (id: string) => invoke<void>('dbconn:close', id)
  },
  dbc: {
    databases: (target: string) => invoke<string[]>('dbc:databases', target),
    tables: (target: string, database: string) => invoke<DbTableSummary[]>('dbc:tables', target, database),
    tableInfo: (target: string, database: string, table: string) => invoke<DbTableInfo>('dbc:tableInfo', target, database, table),
    browse: (target: string, database: string, table: string, o: DbBrowseOptions) => invoke<DbGridPage>('dbc:browse', target, database, table, o),
    query: (target: string, database: string | null, sql: string) => invoke<DbRunResult>('dbc:query', target, database, sql),
    update: (target: string, database: string, table: string, key: Record<string, string | null>, changes: Record<string, string | null>) => invoke<number>('dbc:update', target, database, table, key, changes),
    insert: (target: string, database: string, table: string, values: Record<string, string | null>) => invoke<number>('dbc:insert', target, database, table, values),
    remove: (target: string, database: string, table: string, keys: Record<string, string | null>[]) => invoke<number>('dbc:delete', target, database, table, keys),
    createDatabase: (target: string, name: string, charset?: string) => invoke<void>('dbc:createDatabase', target, name, charset),
    dropDatabase: (target: string, name: string) => invoke<void>('dbc:dropDatabase', target, name),
    dropTable: (target: string, database: string, table: string, view: boolean) => invoke<void>('dbc:dropTable', target, database, table, view),
    truncateTable: (target: string, database: string, table: string) => invoke<void>('dbc:truncateTable', target, database, table),
    renameTable: (target: string, database: string, table: string, to: string) => invoke<void>('dbc:renameTable', target, database, table, to),
    duplicateTable: (target: string, database: string, table: string, to: string, withData: boolean) => invoke<void>('dbc:duplicateTable', target, database, table, to, withData),
    designSql: (target: string, database: string, original: string | null, design: DbTableDesign) => invoke<string>('dbc:designSql', target, database, original, design),
    designApply: (target: string, database: string, original: string | null, design: DbTableDesign) => invoke<string>('dbc:designApply', target, database, original, design),
    /** Asks where to save, then writes the SQL there. Null when cancelled. */
    exportSql: (target: string, database: string, table: string | null, withData: boolean) => invoke<string | null>('dbc:exportSql', target, database, table, withData),
    /** Asks for a .sql file and runs it. Null when cancelled. */
    importSql: (target: string, database: string) => invoke<DbImportResult | null>('dbc:importSql', target, database),
    /** A full backup of one database into a file on this computer. Resolves with the file's path. */
    backup: (target: string, connName: string, database: string) => invoke<string>('dbc:backup', target, connName, database),
    backups: (target: string, connName: string) => invoke<{ folder: string; files: { file: string; database: string; size: number; time: number }[] }>('dbc:backups', target, connName),
    backupShow: (target: string, connName: string, file?: string) => invoke<void>('dbc:backupShow', target, connName, file),
    backupDelete: (target: string, connName: string, file: string) => invoke<void>('dbc:backupDelete', target, connName, file),
    /** Only runs within a minute of session.confirm(). */
    backupRestore: (target: string, connName: string, file: string, intoDb: string) => invoke<DbImportResult>('dbc:backupRestore', target, connName, file, intoDb),
    saveText: (name: string, text: string) => invoke<string | null>('dbc:saveText', name, text)
  },
  security: {
    report: (id: string) => invoke<SecurityReport>('security:report', id),
    fix: (id: string, what: SecurityFix) => invoke<void>('security:fix', id, what),
    banned: (id: string) => invoke<BannedList>('security:banned', id),
    unban: (id: string, jail: string, address: string) => invoke<void>('security:unban', id, jail, address),
    ban: (id: string, jail: string, address: string) => invoke<void>('security:ban', id, jail, address)
  },
  git: {
    list: () => invoke<GitAccount[]>('git:list'),
    save: (input: GitAccountInput) => invoke<GitAccount>('git:save', input),
    remove: (id: string) => invoke<void>('git:remove', id),
    repos: (accountId: string) => invoke<GithubRepoInfo[]>('git:repos', accountId),
    branches: (accountId: string, repoUrl: string) => invoke<string[]>('git:branches', accountId, repoUrl),
    refs: (accountId: string, repoUrl: string) => invoke<GithubRefs>('git:refs', accountId, repoUrl)
  },
  google: {
    status: () => invoke<GoogleStatus>('google:status'),
    setup: (clientId: string, clientSecret: string) => invoke<void>('google:setup', clientId, clientSecret),
    connectStart: () => invoke<GoogleConnectStart>('google:connectStart'),
    connectPoll: () => invoke<GoogleConnectPoll>('google:connectPoll')
  },
  s3: {
    status: (id: string) => invoke<S3Status>('s3:status', id),
    setup: (id: string, options: S3Options) => invoke<void>('s3:setup', id, options),
    run: (id: string) => invoke<void>('s3:run', id),
    remote: (id: string) => invoke<S3RemoteFile[]>('s3:remote', id),
    fetch: (id: string, fileId: string) => invoke<void>('s3:fetch', id, fileId),
    disable: (id: string) => invoke<void>('s3:disable', id)
  },
  gdrive: {
    status: (id: string) => invoke<GdriveStatus>('gdrive:status', id),
    /** Uses the Google sign-in approved a moment ago in this app. */
    enable: (id: string, options: GdriveOptions) => invoke<void>('gdrive:enable', id, options),
    update: (id: string, options: GdriveOptions) => invoke<void>('gdrive:update', id, options),
    run: (id: string) => invoke<void>('gdrive:run', id),
    remote: (id: string) => invoke<GdriveRemoteFile[]>('gdrive:remote', id),
    fetch: (id: string, fileId: string, name: string) => invoke<void>('gdrive:fetch', id, fileId, name),
    disable: (id: string) => invoke<void>('gdrive:disable', id)
  },
  github: {
    status: () => invoke<GithubStatus>('github:status'),
    setup: (clientId: string) => invoke<void>('github:setup', clientId),
    connectStart: () => invoke<GithubConnectStart>('github:connectStart'),
    connectPoll: () => invoke<GithubConnectPoll>('github:connectPoll')
  },
  files: {
    list: (id: string, dir: string) => invoke<FileListing>('files:list', id, dir),
    size: (id: string, path: string) => invoke<number>('files:size', id, path),
    read: (id: string, path: string) => invoke<FileText>('files:read', id, path),
    search: (id: string, dir: string, query: string, opts?: { caseSensitive?: boolean; include?: string; everything?: boolean }) => invoke<FileSearchResult>('files:search', id, dir, query, opts),
    write: (id: string, path: string, content: string, version?: string) => invoke<string>('files:write', id, path, content, version),
    create: (id: string, dir: string, name: string, what: 'file' | 'dir') => invoke<void>('files:create', id, dir, name, what),
    rename: (id: string, path: string, name: string) => invoke<void>('files:rename', id, path, name),
    copy: (id: string, paths: string[], dest: string, overwrite?: boolean) => invoke<void>('files:copy', id, paths, dest, overwrite),
    move: (id: string, paths: string[], dest: string, overwrite?: boolean) => invoke<void>('files:move', id, paths, dest, overwrite),
    remove: (id: string, paths: string[], permanent?: boolean) => invoke<void>('files:delete', id, paths, permanent),
    trashList: (id: string) => invoke<TrashEntry[]>('files:trashList', id),
    trashRestore: (id: string, ids: string[]) => invoke<void>('files:trashRestore', id, ids),
    trashPurge: (id: string, ids?: string[]) => invoke<void>('files:trashPurge', id, ids),
    chmod: (id: string, paths: string[], input: FilePermInput) => invoke<void>('files:chmod', id, paths, input),
    compress: (id: string, paths: string[], name: string, format: 'tar.gz' | 'zip') => invoke<void>('files:compress', id, paths, name, format),
    extract: (id: string, path: string, dest: string) => invoke<void>('files:extract', id, path, dest),
    pickUpload: (kind: 'files' | 'folder') => invoke<string[]>('files:pickUpload', kind),
    upload: (id: string, dir: string, localPath: string, packed: boolean, overwrite: boolean) => invoke<void>('files:upload', id, dir, localPath, packed, overwrite),
    download: (id: string, path: string, isDir: boolean) => invoke<string | null>('files:download', id, path, isDir)
  },
  node: {
    overview: (id: string) => invoke<NodeOverview>('node:overview', id),
    install: (id: string, line: number) => invoke<void>('node:install', id, line),
    use: (id: string, version: string) => invoke<void>('node:use', id, version),
    remove: (id: string, version: string) => invoke<void>('node:remove', id, version)
  },
  composer: {
    overview: (id: string) => invoke<ComposerOverview>('composer:overview', id),
    install: (id: string) => invoke<void>('composer:install', id),
    remove: (id: string) => invoke<void>('composer:remove', id)
  },
  /** Scheduled backups of a saved database connection, made by a managed server. */
  dbr: {
    status: (projectId: string) => invoke<DbRemoteStatus>('dbr:status', projectId),
    setup: (projectId: string, connId: string, databases: string[], when: DbRemoteWhen) => invoke<void>('dbr:setup', projectId, connId, databases, when),
    run: (projectId: string, connId: string) => invoke<void>('dbr:run', projectId, connId),
    remove: (projectId: string, connId: string) => invoke<void>('dbr:remove', projectId, connId),
    /** Copies one scheduled backup into this connection's backup folder on this computer; returns its path. */
    pull: (projectId: string, connId: string, connName: string, label: string, file: string) => invoke<string>('dbr:pull', projectId, connId, connName, label, file)
  },
  python: {
    overview: (id: string) => invoke<PythonOverview>('python:overview', id),
    install: (id: string) => invoke<void>('python:install', id)
  },
  docker: {
    overview: (id: string) => invoke<DockerOverview>('docker:overview', id),
    install: (id: string) => invoke<void>('docker:install', id),
    service: (id: string, action: 'start' | 'stop' | 'restart') => invoke<void>('docker:service', id, action),
    container: (id: string, container: string, action: 'start' | 'stop' | 'restart' | 'remove') => invoke<void>('docker:container', id, container, action),
    logs: (id: string, container: string, count?: number) => invoke<string>('docker:logs', id, container, count),
    run: (id: string, input: DockerRunInput) => invoke<void>('docker:run', id, input),
    pull: (id: string, image: string) => invoke<void>('docker:pull', id, image),
    removeImage: (id: string, image: string) => invoke<void>('docker:removeImage', id, image),
    prune: (id: string) => invoke<void>('docker:prune', id),
    composeUp: (id: string, dir: string) => invoke<void>('docker:composeUp', id, dir),
    composeDown: (id: string, dir: string) => invoke<void>('docker:composeDown', id, dir)
  },
  java: {
    overview: (id: string) => invoke<JavaOverview>('java:overview', id),
    install: (id: string, line: number) => invoke<void>('java:install', id, line),
    use: (id: string, home: string) => invoke<void>('java:use', id, home),
    remove: (id: string, line: number) => invoke<void>('java:remove', id, line)
  },
  groups: {
    list: () => invoke<ServerGroup[]>('groups:list'),
    save: (input: ServerGroupInput) => invoke<ServerGroup>('groups:save', input),
    remove: (id: string) => invoke<void>('groups:remove', id)
  },
  nginx: {
    overview: (id: string) => invoke<NginxOverview>('nginx:overview', id),
    tuning: (id: string) => invoke<NginxTuning>('nginx:tuning', id),
    saveTuning: (id: string, t: NginxTuning) => invoke<void>('nginx:saveTuning', id, t),
    control: (id: string, action: 'reload' | 'start' | 'stop' | 'test') => invoke<void>('nginx:control', id, action),
    config: (id: string) => invoke<string>('nginx:config', id),
    saveConfig: (id: string, text: string) => invoke<void>('nginx:saveConfig', id, text),
    load: (id: string) => invoke<NginxLoad>('nginx:load', id),
    errorLog: (id: string, lines: number) => invoke<{ path: string; text: string }>('nginx:errorLog', id, lines),
    clearErrorLog: (id: string) => invoke<void>('nginx:clearErrorLog', id)
  },
  nfs: {
    overview: (id: string) => invoke<NfsOverview>('nfs:overview', id),
    install: (id: string, role: 'server' | 'client') => invoke<void>('nfs:install', id, role),
    saveShares: (id: string, shares: NfsShare[]) => invoke<void>('nfs:saveShares', id, shares),
    addMount: (id: string, m: { server: string; remote: string; local: string; readOnly: boolean }) => invoke<void>('nfs:addMount', id, m),
    removeMount: (id: string, local: string) => invoke<void>('nfs:removeMount', id, local),
    remount: (id: string, local: string) => invoke<void>('nfs:remount', id, local),
    join: (id: string, path: string, userId: string, local: string, readOnly: boolean, owner: NfsOwner, allowPublic: boolean) => invoke<void>('nfs:join', id, path, userId, local, readOnly, owner, allowPublic),
    groupSync: (groupId: string, ruleId?: string) => invoke<void>('nfs:groupSync', groupId, ruleId)
  },
  supervisor: {
    overview: (id: string) => invoke<SupervisorOverview>('supervisor:overview', id),
    install: (id: string) => invoke<void>('supervisor:install', id),
    save: (id: string, program: SupervisorProgramInput) => invoke<void>('supervisor:save', id, program),
    action: (id: string, name: string, what: 'start' | 'stop' | 'restart') => invoke<void>('supervisor:action', id, name, what),
    remove: (id: string, name: string) => invoke<void>('supervisor:remove', id, name),
    logs: (id: string, name: string) => invoke<string>('supervisor:logs', id, name)
  },
  apps: {
    /** Only runs right after session.confirm. The program is removed; data and settings stay. */
    uninstall: (id: string, app: UninstallApp) => invoke<void>('apps:uninstall', id, app)
  },
  versions: {
    /** What can be installed on this server: the system's package and releases from the project's own repository. */
    list: (id: string, app: VersionApp) => invoke<VersionChoice[]>('versions:list', id, app)
  },
  mongo: {
    overview: (id: string) => invoke<MongoOverview>('mongo:overview', id),
    install: (id: string, line: string) => invoke<void>('mongo:install', id, line),
    service: (id: string, what: 'start' | 'stop' | 'restart') => invoke<void>('mongo:service', id, what),
    create: (id: string, name: string, user: string, password: string) => invoke<{ name: string; user: string; password: string }>('mongo:create', id, name, user, password),
    drop: (id: string, name: string) => invoke<void>('mongo:drop', id, name),
    backup: (id: string, name: string) => invoke<void>('mongo:backup', id, name),
    /** Only runs right after session.confirm. */
    restore: (id: string, file: string) => invoke<void>('mongo:restore', id, file),
    deleteBackup: (id: string, file: string) => invoke<void>('mongo:deleteBackup', id, file)
  },
  pg: {
    overview: (id: string) => invoke<PgOverview>('pg:overview', id),
    install: (id: string, version?: string) => invoke<void>('pg:install', id, version),
    service: (id: string, what: 'start' | 'stop' | 'restart') => invoke<void>('pg:service', id, what),
    create: (id: string, name: string, user: string, password: string) => invoke<{ name: string; user: string; password: string }>('pg:create', id, name, user, password),
    drop: (id: string, name: string, dropUser: string) => invoke<void>('pg:drop', id, name, dropUser),
    backup: (id: string, name: string) => invoke<void>('pg:backup', id, name),
    /** Only runs right after session.confirm. */
    restore: (id: string, file: string) => invoke<void>('pg:restore', id, file),
    deleteBackup: (id: string, file: string) => invoke<void>('pg:deleteBackup', id, file)
  },
  redis: {
    overview: (id: string) => invoke<RedisOverview>('redis:overview', id),
    service: (id: string, action: 'start' | 'stop' | 'restart') => invoke<void>('redis:service', id, action),
    saveSettings: (id: string, settings: RedisSettings) => invoke<void>('redis:saveSettings', id, settings),
    saveRaw: (id: string, raw: string) => invoke<void>('redis:saveRaw', id, raw),
    flush: (id: string, db: number | null) => invoke<void>('redis:flush', id, db),
    install: (id: string, version?: string) => invoke<void>('redis:install', id, version)
  },
  cron: {
    list: (id: string) => invoke<CronOverview>('cron:list', id),
    save: (id: string, task: CronTask) => invoke<string>('cron:save', id, task),
    remove: (id: string, taskId: string) => invoke<void>('cron:remove', id, taskId),
    run: (id: string, taskId: string) => invoke<void>('cron:run', id, taskId),
    log: (id: string, taskId: string) => invoke<string>('cron:log', id, taskId)
  },
  ssl: {
    status: (siteId: string) => invoke<SslStatus>('ssl:status', siteId),
    enable: (siteId: string, email: string, forceHttps: boolean) => invoke<void>('ssl:enable', siteId, email, forceHttps),
    disable: (siteId: string) => invoke<void>('ssl:disable', siteId),
    renew: (siteId: string) => invoke<void>('ssl:renew', siteId),
    /** Only runs right after session.confirm. */
    privateKey: (siteId: string) => invoke<string>('ssl:privateKey', siteId),
    expiries: (projectId: string) => invoke<Record<string, number>>('ssl:expiries', projectId)
  },
  firewall: {
    status: (id: string) => invoke<FirewallStatus>('firewall:status', id),
    addRule: (id: string, kind: FirewallStatus['kind'], rule: FirewallRuleInput) => invoke<void>('firewall:addRule', id, kind, rule),
    deleteRule: (id: string, ruleId: string) => invoke<void>('firewall:deleteRule', id, ruleId),
    setEnabled: (id: string, kind: FirewallStatus['kind'], enabled: boolean) => invoke<void>('firewall:setEnabled', id, kind, enabled),
    install: (id: string) => invoke<void>('firewall:install', id),
    nginxGet: (id: string) => invoke<NginxFirewall>('firewall:nginxGet', id),
    nginxSet: (id: string, cfg: NginxFirewall) => invoke<void>('firewall:nginxSet', id, cfg),
    blockIp: (id: string, ip: string) => invoke<string[]>('firewall:blockIp', id, ip)
  },
  logs: {
    sources: (id: string) => invoke<LogSource[]>('logs:sources', id),
    read: (id: string, source: string, lines: number, filter: string, tidy?: boolean) => invoke<string>('logs:read', id, source, lines, filter, tidy),
    threats: (id: string) => invoke<Threats>('logs:threats', id)
  },
  alerts: {
    get: (id: string) => invoke<AlertConfig>('alerts:get', id),
    save: (id: string, cfg: AlertConfig) => invoke<void>('alerts:save', id, cfg),
    test: (id: string) => invoke<void>('alerts:test', id)
  },
  db: {
    secrets: (id: string) => invoke<{ id: string; database: string; user: string; createdBy?: string; createdAt: number }[]>('db:secrets', id),
    revealSecret: (secretId: string, proof: string) => invoke<{ database: string; user: string; password: string }>('dbsecret:reveal', secretId, proof),
    overview: (id: string) => invoke<DbOverview>('db:overview', id),
    create: (id: string, name: string, user: string, password: string, access?: DbAccess) =>
      invoke<{ name: string; user: string; password: string; hosts: string[]; notes: string[] }>('db:create', id, name, user, password, access),
    setAccess: (id: string, name: string, user: string, access: DbAccess) => invoke<void>('db:setAccess', id, name, user, access),
    drop: (id: string, name: string, dropUser: string) => invoke<void>('db:drop', id, name, dropUser),
    backup: (id: string, name: string) => invoke<void>('db:backup', id, name),
    /** Only runs within a minute of session.confirm(). */
    restore: (id: string, file: string, intoDb: string) => invoke<void>('db:restore', id, file, intoDb),
    deleteBackup: (id: string, file: string) => invoke<void>('db:deleteBackup', id, file),
    download: (id: string, file: string) => invoke<string | null>('db:download', id, file),
    setSchedule: (id: string, schedule: DbSchedule) => invoke<void>('db:setSchedule', id, schedule),
    offsiteStatus: (id: string) => invoke<OffsiteStatus>('db:offsiteStatus', id),
    offsiteEnable: (id: string, toId: string, keepDays: number, address?: string) => invoke<void>('db:offsiteEnable', id, toId, keepDays, address),
    offsiteDisable: (id: string) => invoke<void>('db:offsiteDisable', id),
    offsiteRun: (id: string) => invoke<void>('db:offsiteRun', id),
    install: (id: string, version?: string) => invoke<void>('db:install', id, version)
  },
  backup: {
    list: (id: string) => invoke<BackupJob[]>('backup:list', id),
    save: (id: string, job: BackupJob) => invoke<void>('backup:save', id, job),
    remove: (id: string, name: string) => invoke<void>('backup:remove', id, name),
    run: (id: string, name: string) => invoke<void>('backup:run', id, name),
    history: (id: string, name: string) => invoke<BackupCommit[]>('backup:history', id, name),
    restore: (id: string, name: string, hash: string) => invoke<void>('backup:restore', id, name, hash),
    serverKey: (id: string) => invoke<string>('backup:serverKey', id)
  },
  app: {
    lock: () => invoke<SessionState>('app:lock'),
    unlock: () => invoke<SessionState>('app:unlock'),
    /** The person tried to close the window while signed in. */
    onConfirmClose: (cb: () => void) => listen('app:confirmClose', cb),
    closeNow: () => invoke<null>('app:closeNow'),
    closeCancelled: () => invoke<null>('app:closeCancelled')
  },
  window: {
    minimize: () => post('window:minimize'),
    maximize: () => post('window:maximize'),
    close: () => post('window:close')
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
