// Saved projects, sites and deploy history.
//
// The service keeps them in one JSON file (passwords and keys encrypted with
// its master key). The desktop app holds a copy in memory for the signed-in
// person and reports every change it makes back to the service.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DbConnection, DbConnectionInput, DeployRecord, GitAccount, GitAccountInput, GroupMember, GroupNfs, GroupRole, Project, ProjectInput, ProjectShare, ServerGroup, ServerGroupInput, Site, SiteInput } from '@shared/types'
import type { SshTarget } from './ssh'

export interface StoredProject {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  note?: string
  color?: string
  hostFingerprint?: string
  ownerId?: string
  share?: ProjectShare
  secrets: { password?: string; privateKey?: string; passphrase?: string }
  createdAt: number
  updatedAt: number
}

export interface StoredGit {
  id: string
  name: string
  username: string
  /** Encrypted on the service; readable in the app's memory. */
  token: string
  provider?: 'github' | 'other'
  login?: string
  ownerId?: string
  shared: boolean
  createdAt: number
}

export interface StoredDbConn {
  id: string
  name: string
  host: string
  port: number
  username: string
  database?: string
  useSsh: boolean
  sshProjectId?: string
  sshHost?: string
  sshPort?: number
  sshUsername?: string
  sshAuth?: 'password' | 'key'
  /** Host key seen the first time the tunnel was opened. */
  sshFingerprint?: string
  /** The managed server that makes this connection's scheduled backups, when that is switched on. */
  backupProjectId?: string
  /** Encrypted on the service; readable in the app's memory. */
  secrets: { password?: string; sshPassword?: string; sshKey?: string; sshPassphrase?: string }
  ownerId?: string
  shared: boolean
  createdAt: number
}

const DBCONN_SECRETS = ['password', 'sshPassword', 'sshKey', 'sshPassphrase'] as const

interface Data {
  version: 1
  projects: StoredProject[]
  sites: Site[]
  deploys: DeployRecord[]
  gits: StoredGit[]
  dbconns: StoredDbConn[]
  settings: TeamSettings
  dbsecrets: StoredDbSecret[]
  groups: ServerGroup[]
}

/** The password of a database user this app created, kept so it can be shown again after a fresh identity check. */
export interface StoredDbSecret {
  /** "<project id>:<user>" */
  id: string
  projectId: string
  database: string
  user: string
  /** Encrypted on the service. Never sent to an app in the snapshot: empty there. */
  password: string
  createdBy?: string
  createdAt: number
}

/** Settings the whole team shares. Nothing secret. */
export interface TeamSettings {
  /** Client ID of the team's GitHub OAuth App, for "Connect GitHub". */
  githubClientId?: string
  /** OAuth client (type "TVs and Limited Input devices") for Google Drive backups. Google does not treat this kind of secret as confidential. */
  googleClientId?: string
  googleClientSecret?: string
}

let data: Data | null = null

/** Everything one person may see, with secrets readable. Travels from the service to the app at sign-in. */
export interface Snapshot {
  projects: StoredProject[]
  sites: Site[]
  deploys: DeployRecord[]
  gits?: StoredGit[]
  dbconns?: StoredDbConn[]
  settings?: TeamSettings
  dbsecrets?: StoredDbSecret[]
  groups?: ServerGroup[]
}

/** One change made in the app, sent to the service to be saved for everyone. */
export type StoreChange =
  | { t: 'project'; record: StoredProject }
  | { t: 'project-del'; id: string }
  | { t: 'fingerprint'; id: string; fingerprint?: string }
  | { t: 'site'; record: Site }
  | { t: 'site-del'; id: string }
  | { t: 'deploy'; record: DeployRecord }
  | { t: 'git'; record: StoredGit }
  | { t: 'git-del'; id: string }
  | { t: 'dbconn'; record: StoredDbConn }
  | { t: 'dbconn-del'; id: string }
  | { t: 'settings'; record: TeamSettings }
  | { t: 'dbsecret'; record: StoredDbSecret }
  | { t: 'dbsecret-del'; projectId: string; database: string }
  | { t: 'group'; record: ServerGroup }
  | { t: 'group-del'; id: string }

export interface StoreBackend {
  /** Folder that holds superdevops.json. Without it the data lives in memory only. */
  dir?: string
  /** Starting data for a memory-only store. */
  initial?: Snapshot
  encrypt(value: string): string
  decrypt(value: string): string | undefined
  /** Called after every change made through this file's functions. */
  onChange?(change: StoreChange): void
}

let backend: StoreBackend | null = null

/** Must be called once before any other function in this file. */
export function configureStore(b: StoreBackend): void {
  backend = b
  data = null
}

function be(): StoreBackend {
  if (!backend) throw new Error('The store has not been configured.')
  return backend
}

function file(): string {
  return join(be().dir ?? '', 'superdevops.json')
}

function load(): Data {
  if (data) return data
  if (!be().dir) {
    const i = be().initial
    data = { version: 1, projects: i?.projects ?? [], sites: i?.sites ?? [], deploys: i?.deploys ?? [], gits: i?.gits ?? [], dbconns: i?.dbconns ?? [], settings: i?.settings ?? {}, dbsecrets: i?.dbsecrets ?? [], groups: i?.groups ?? [] }
    return data
  }
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Data
    data = { version: 1, projects: parsed.projects ?? [], sites: parsed.sites ?? [], deploys: parsed.deploys ?? [], gits: parsed.gits ?? [], dbconns: parsed.dbconns ?? [], settings: parsed.settings ?? {}, dbsecrets: parsed.dbsecrets ?? [], groups: parsed.groups ?? [] }
  } catch {
    data = { version: 1, projects: [], sites: [], deploys: [], gits: [], dbconns: [], settings: {}, dbsecrets: [], groups: [] }
  }
  return data
}

function persist(): void {
  const dir = be().dir
  if (!dir) return
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify(load(), null, 2), { mode: 0o600 })
  renameSync(tmp, file())
}

function changed(change: StoreChange): void {
  be().onChange?.(change)
}

function encrypt(value: string): string {
  return be().encrypt(value)
}

function decrypt(value: string | undefined): string | undefined {
  return value ? be().decrypt(value) : undefined
}

/** Servers saved before sharing existed are open to the whole team, as they were. */
function shareOf(p: StoredProject): ProjectShare {
  return p.share ?? { mode: 'team', members: [] }
}

function cleanShare(input: ProjectShare | undefined): ProjectShare | undefined {
  if (!input) return undefined
  const mode = input.mode === 'team' || input.mode === 'members' ? input.mode : 'private'
  const members = mode === 'members' && Array.isArray(input.members) ? [...new Set(input.members.filter((m) => typeof m === 'string' && m.length <= 64))].slice(0, 500) : []
  return { mode, members }
}

/** May this person use the server? Private means the owner only, not even admins. */
export function canUse(projectId: string, userId: string, isAdmin: boolean): boolean {
  const p = load().projects.find((x) => x.id === projectId)
  if (!p) return false
  if (p.ownerId === userId) return true
  const share = shareOf(p)
  if (share.mode === 'private') return false
  return isAdmin || share.mode === 'team' || share.members.includes(userId)
}

/** May this person change, share or remove the server? Its owner, or an admin who can use it. */
export function canManage(projectId: string, userId: string, isAdmin: boolean): boolean {
  const p = load().projects.find((x) => x.id === projectId)
  if (!p) return false
  return p.ownerId === userId || (isAdmin && canUse(projectId, userId, true))
}

function toPublic(p: StoredProject): Project {
  return {
    id: p.id,
    name: p.name,
    host: p.host,
    port: p.port,
    username: p.username,
    authType: p.authType,
    note: p.note,
    color: p.color,
    hostFingerprint: p.hostFingerprint,
    ownerId: p.ownerId,
    share: shareOf(p),
    hasPassword: !!p.secrets.password,
    hasPrivateKey: !!p.secrets.privateKey,
    hasPassphrase: !!p.secrets.passphrase,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  }
}

function checkInput(input: ProjectInput): void {
  if (!input.name?.trim()) throw new Error('Give the project a name.')
  if (!input.host?.trim() || /\s/.test(input.host.trim())) throw new Error('Enter the server host or IP.')
  if (!input.username?.trim()) throw new Error('Enter the SSH username.')
  if (!(Number.isInteger(input.port) && input.port > 0 && input.port < 65536)) throw new Error('Port must be between 1 and 65535.')
}

export function listProjects(): Project[] {
  return load().projects.map(toPublic)
}

export function saveProject(input: ProjectInput): Project {
  checkInput(input)
  const d = load()
  const now = Date.now()
  let p = input.id ? d.projects.find((x) => x.id === input.id) : undefined
  if (!p) {
    p = {
      id: randomUUID(),
      name: '',
      host: '',
      port: 22,
      username: '',
      authType: 'password',
      secrets: {},
      ownerId: input.ownerId,
      share: { mode: 'private', members: [] },
      createdAt: now,
      updatedAt: now
    }
    d.projects.push(p)
  }
  p.share = cleanShare(input.share) ?? p.share
  const hostChanged = p.host !== input.host.trim() || p.port !== input.port
  p.name = input.name.trim()
  p.host = input.host.trim()
  p.port = input.port
  p.username = input.username.trim()
  p.authType = input.authType
  p.note = input.note?.trim() || undefined
  p.color = input.color
  p.updatedAt = now
  if (hostChanged) p.hostFingerprint = undefined
  // An empty secret field means "keep what is stored".
  if (input.password) p.secrets.password = encrypt(input.password)
  if (input.privateKey?.trim()) p.secrets.privateKey = encrypt(input.privateKey.trim() + '\n')
  if (input.passphrase) p.secrets.passphrase = encrypt(input.passphrase)
  if (p.authType === 'password') {
    p.secrets.privateKey = undefined
    p.secrets.passphrase = undefined
  }
  persist()
  changed({ t: 'project', record: p })
  return toPublic(p)
}

export function removeProject(id: string): void {
  const d = load()
  const gone = new Set(d.sites.filter((s) => s.projectId === id).map((s) => s.id))
  d.projects = d.projects.filter((p) => p.id !== id)
  d.sites = d.sites.filter((s) => s.projectId !== id)
  d.deploys = d.deploys.filter((r) => !gone.has(r.siteId))
  for (const g of d.groups) {
    g.members = g.members.filter((m) => m.projectId !== id)
    if (g.nfs) g.nfs = g.nfs.filter((n) => n.serverId !== id)
  }
  persist()
  changed({ t: 'project-del', id })
}

export function hasProject(id: string): boolean {
  return load().projects.some((p) => p.id === id)
}

export function getProject(id: string): Project {
  const p = load().projects.find((x) => x.id === id)
  if (!p) throw new Error('Project not found.')
  return toPublic(p)
}

/** Build connection details, including decrypted secrets. Main process only. */
export function getTarget(id: string): SshTarget {
  const p = load().projects.find((x) => x.id === id)
  if (!p) throw new Error('Project not found.')
  return {
    host: p.host,
    port: p.port,
    username: p.username,
    password: decrypt(p.secrets.password),
    privateKey: p.authType === 'key' ? decrypt(p.secrets.privateKey) : undefined,
    passphrase: p.authType === 'key' ? decrypt(p.secrets.passphrase) : undefined,
    hostFingerprint: p.hostFingerprint
  }
}

/** Connection details for a form that has not been saved yet (used by "Test"). */
export function targetFromInput(input: ProjectInput): SshTarget {
  checkInput(input)
  const stored = input.id ? getTarget(input.id) : undefined
  const sameHost = stored && stored.host === input.host.trim() && stored.port === input.port
  return {
    host: input.host.trim(),
    port: input.port,
    username: input.username.trim(),
    password: input.password || stored?.password,
    privateKey: input.authType === 'key' ? (input.privateKey?.trim() ? input.privateKey.trim() + '\n' : stored?.privateKey) : undefined,
    passphrase: input.authType === 'key' ? input.passphrase || stored?.passphrase : undefined,
    hostFingerprint: sameHost ? stored?.hostFingerprint : undefined
  }
}

export function setFingerprint(id: string, fingerprint: string | undefined): void {
  const p = load().projects.find((x) => x.id === id)
  if (!p) return
  p.hostFingerprint = fingerprint
  persist()
  changed({ t: 'fingerprint', id, fingerprint })
}

export function listSites(projectId: string): Site[] {
  return load().sites.filter((s) => s.projectId === projectId)
}

export function getSite(id: string): Site {
  const s = load().sites.find((x) => x.id === id)
  if (!s) throw new Error('Site not found.')
  return s
}

export function saveSite(input: SiteInput): Site {
  const d = load()
  const now = Date.now()
  const existing = input.id ? d.sites.find((s) => s.id === input.id) : undefined
  const clash = d.sites.find((s) => s.projectId === input.projectId && s.name === input.name && s.id !== input.id)
  if (clash) throw new Error(`A site named "${input.name}" already exists on this server.`)
  const site: Site = {
    ...(existing ?? { createdAt: now }),
    ...input,
    id: existing?.id ?? randomUUID(),
    rootPath: input.rootPath.trim().replace(/\/+$/, ''),
    publicDir: input.publicDir.trim().replace(/^\/+|\/+$/g, ''),
    domain: input.domain.trim().replace(/[,\s]+/g, ' '),
    repoUrl: input.repoUrl.trim(),
    branch: input.branch.trim() || 'main',
    phpUpstream: input.phpUpstream.trim(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  if (existing) d.sites[d.sites.indexOf(existing)] = site
  else d.sites.push(site)
  persist()
  changed({ t: 'site', record: site })
  return site
}

export function markDeploy(id: string, status: 'success' | 'failed' | 'rolled_back'): Site | undefined {
  const s = load().sites.find((x) => x.id === id)
  if (!s) return undefined
  s.lastDeployAt = Date.now()
  s.lastDeployStatus = status
  persist()
  changed({ t: 'site', record: s })
  return s
}

export function removeSite(id: string): void {
  const d = load()
  d.sites = d.sites.filter((s) => s.id !== id)
  d.deploys = d.deploys.filter((r) => r.siteId !== id)
  persist()
  changed({ t: 'site-del', id })
}

/** Newest first. */
export function listDeploys(siteId: string): DeployRecord[] {
  return load()
    .deploys.filter((r) => r.siteId === siteId)
    .sort((a, b) => b.time - a.time)
}

export function getDeploy(id: string): DeployRecord {
  const r = load().deploys.find((x) => x.id === id)
  if (!r) throw new Error('That deploy is no longer in the history.')
  return r
}

export function addDeploy(siteId: string, record: Omit<DeployRecord, 'id' | 'siteId' | 'time'>): DeployRecord {
  const d = load()
  const full: DeployRecord = { ...record, id: randomUUID(), siteId, time: Date.now() }
  d.deploys.push(full)
  // Keep the last 30 per site.
  const mine = d.deploys.filter((r) => r.siteId === siteId).sort((a, b) => b.time - a.time)
  const drop = new Set(mine.slice(30).map((r) => r.id))
  d.deploys = d.deploys.filter((r) => !drop.has(r.id))
  persist()
  changed({ t: 'deploy', record: full })
  return full
}

// ---------------------------------------------------------------- service side: hand out and take in
const SECRET_FIELDS = ['password', 'privateKey', 'passphrase'] as const

/** What a person may see (null = every server), with secrets decrypted for the app to connect with. */
export function snapshot(userId: string, isAdmin: boolean): Snapshot {
  const d = load()
  const projects = d.projects
    .filter((p) => canUse(p.id, userId, isAdmin))
    .map((p) => {
      const secrets: StoredProject['secrets'] = {}
      for (const f of SECRET_FIELDS) if (p.secrets[f]) secrets[f] = decrypt(p.secrets[f])
      return { ...p, secrets }
    })
  const ids = new Set(projects.map((p) => p.id))
  const sites = d.sites.filter((s) => ids.has(s.projectId))
  const siteIds = new Set(sites.map((s) => s.id))
  const gits = d.gits.filter((g) => g.shared || g.ownerId === userId).map((g) => ({ ...g, token: decrypt(g.token) ?? '' }))
  const dbconns = d.dbconns.filter((c) => c.shared || c.ownerId === userId).map((c) => ({ ...c, secrets: openSecrets(c.secrets) }))
  // A project shows only the servers this person may use; the others stay in it on the service.
  const groups = d.groups.filter((g) => g.shared || g.ownerId === userId).map((g) => ({ ...g, members: g.members.filter((m) => ids.has(m.projectId)), nfs: g.nfs?.filter((n) => ids.has(n.serverId)) }))
  return { projects, sites, deploys: d.deploys.filter((r) => siteIds.has(r.siteId)), gits, dbconns, settings: { ...d.settings }, dbsecrets: d.dbsecrets.filter((x) => ids.has(x.projectId)).map((x) => ({ ...x, password: '' })), groups }
}

function text(v: unknown, max: number): string {
  if (typeof v !== 'string' || v.length > max) throw new Error('The change sent by the app is not valid.')
  return v
}

/** Save a change reported by an app. The caller has already checked that this person may make it. */
export function apply(change: StoreChange): void {
  const d = load()
  const now = Date.now()
  if (change.t === 'project') {
    const r = change.record
    checkInput({ name: r.name, host: r.host, port: r.port, username: r.username, authType: r.authType })
    const id = text(r.id, 64)
    const old = d.projects.find((p) => p.id === id)
    const secrets: StoredProject['secrets'] = {}
    for (const f of SECRET_FIELDS) {
      const v = r.secrets?.[f]
      if (v) secrets[f] = encrypt(text(v, 64 * 1024))
    }
    const next: StoredProject = {
      id,
      name: r.name.trim(),
      host: r.host.trim(),
      port: r.port,
      username: r.username.trim(),
      authType: r.authType === 'key' ? 'key' : 'password',
      note: r.note ? text(r.note, 2000) : undefined,
      color: r.color ? text(r.color, 32) : undefined,
      hostFingerprint: r.hostFingerprint ? text(r.hostFingerprint, 200) : undefined,
      // The owner never changes once set; the service fills it in for a new server.
      ownerId: old ? old.ownerId : r.ownerId ? text(r.ownerId, 64) : undefined,
      share: cleanShare(r.share) ?? old?.share,
      secrets,
      createdAt: old?.createdAt ?? now,
      updatedAt: now
    }
    if (old) d.projects[d.projects.indexOf(old)] = next
    else d.projects.push(next)
  } else if (change.t === 'project-del') {
    for (const g of d.groups) {
      g.members = g.members.filter((m) => m.projectId !== change.id)
      if (g.nfs) g.nfs = g.nfs.filter((n) => n.serverId !== change.id)
    }
    const gone = new Set(d.sites.filter((s) => s.projectId === change.id).map((s) => s.id))
    d.projects = d.projects.filter((p) => p.id !== change.id)
    d.sites = d.sites.filter((s) => s.projectId !== change.id)
    d.deploys = d.deploys.filter((r) => !gone.has(r.siteId))
  } else if (change.t === 'fingerprint') {
    const p = d.projects.find((x) => x.id === change.id)
    if (p) p.hostFingerprint = change.fingerprint ? text(change.fingerprint, 200) : undefined
  } else if (change.t === 'site') {
    const r = change.record
    text(r.id, 64)
    text(r.name, 100)
    if (JSON.stringify(r).length > 100000) throw new Error('The change sent by the app is not valid.')
    if (d.sites.some((s) => s.projectId === r.projectId && s.name === r.name && s.id !== r.id)) throw new Error(`A site named "${r.name}" already exists on this server.`)
    const old = d.sites.find((s) => s.id === r.id)
    const next: Site = { ...r, createdAt: old?.createdAt ?? now, updatedAt: now }
    if (old) d.sites[d.sites.indexOf(old)] = next
    else d.sites.push(next)
  } else if (change.t === 'site-del') {
    d.sites = d.sites.filter((s) => s.id !== change.id)
    d.deploys = d.deploys.filter((r) => r.siteId !== change.id)
  } else if (change.t === 'deploy') {
    const r = change.record
    text(r.id, 64)
    if (JSON.stringify(r).length > 20000) throw new Error('The change sent by the app is not valid.')
    if (!d.deploys.some((x) => x.id === r.id)) d.deploys.push({ ...r, time: now })
    const mine = d.deploys.filter((x) => x.siteId === r.siteId).sort((a, b) => b.time - a.time)
    const drop = new Set(mine.slice(30).map((x) => x.id))
    d.deploys = d.deploys.filter((x) => !drop.has(x.id))
  } else if (change.t === 'git') {
    const r = change.record
    const id = text(r.id, 64)
    const old = d.gits.find((g) => g.id === id)
    if (!text(r.name, 80).trim()) throw new Error('Give the Git account a name.')
    if (!r.token) throw new Error('Enter the access token.')
    const next: StoredGit = { id, name: r.name.trim(), username: text(r.username || 'git', 100), token: encrypt(text(r.token, 4000)), provider: r.provider === 'github' ? 'github' : 'other', login: r.login ? text(r.login, 100) : undefined, ownerId: old ? old.ownerId : r.ownerId, shared: r.shared === true, createdAt: old?.createdAt ?? now }
    if (old) d.gits[d.gits.indexOf(old)] = next
    else d.gits.push(next)
  } else if (change.t === 'git-del') {
    d.gits = d.gits.filter((g) => g.id !== change.id)
  } else if (change.t === 'dbconn') {
    const r = change.record
    const id = text(r.id, 64)
    const old = d.dbconns.find((c) => c.id === id)
    if (!text(r.name, 80).trim()) throw new Error('Give the connection a name.')
    const secrets: StoredDbConn['secrets'] = {}
    for (const f of DBCONN_SECRETS) if (r.secrets?.[f]) secrets[f] = encrypt(text(r.secrets[f], 20000))
    const next: StoredDbConn = {
      id,
      name: r.name.trim(),
      host: text(r.host, 255),
      port: Number(r.port) || 3306,
      username: text(r.username, 100),
      database: r.database ? text(r.database, 64) : undefined,
      useSsh: r.useSsh === true,
      sshProjectId: r.sshProjectId ? text(r.sshProjectId, 64) : undefined,
      sshHost: r.sshHost ? text(r.sshHost, 255) : undefined,
      sshPort: r.sshPort ? Number(r.sshPort) || 22 : undefined,
      sshUsername: r.sshUsername ? text(r.sshUsername, 100) : undefined,
      sshAuth: r.sshAuth === 'key' ? 'key' : 'password',
      sshFingerprint: r.sshFingerprint ? text(r.sshFingerprint, 100) : undefined,
      backupProjectId: r.backupProjectId ? text(r.backupProjectId, 64) : undefined,
      secrets,
      ownerId: old ? old.ownerId : r.ownerId,
      shared: r.shared === true,
      createdAt: old?.createdAt ?? now
    }
    if (old) d.dbconns[d.dbconns.indexOf(old)] = next
    else d.dbconns.push(next)
  } else if (change.t === 'dbconn-del') {
    d.dbconns = d.dbconns.filter((c) => c.id !== change.id)
  } else if (change.t === 'settings') {
    d.settings = cleanSettings(change.record)
  } else if (change.t === 'dbsecret') {
    const r = change.record
    const projectId = text(r.projectId, 64)
    const user = text(r.user, 64)
    const id = `${projectId}:${user}`
    const old = d.dbsecrets.find((x) => x.id === id)
    // An app only holds the password at the moment it is set; without one, what is stored stays.
    const password = r.password ? encrypt(text(r.password, 500)) : (old?.password ?? '')
    const next: StoredDbSecret = { id, projectId, database: text(r.database, 64), user, password, createdBy: r.createdBy ? text(r.createdBy, 100) : old?.createdBy, createdAt: old?.createdAt ?? now }
    if (old) d.dbsecrets[d.dbsecrets.indexOf(old)] = next
    else d.dbsecrets.push(next)
  } else if (change.t === 'dbsecret-del') {
    d.dbsecrets = d.dbsecrets.filter((x) => !(x.projectId === change.projectId && x.database === change.database))
  } else if (change.t === 'group') {
    const r = change.record
    const id = text(r.id, 64)
    const old = d.groups.find((g) => g.id === id)
    const known = new Set(d.projects.map((p) => p.id))
    const next = cleanGroup({ ...r, id, ownerId: old ? old.ownerId : r.ownerId, createdAt: old?.createdAt ?? now }, known)
    if (old) d.groups[d.groups.indexOf(old)] = next
    else d.groups.push(next)
  } else if (change.t === 'group-del') {
    d.groups = d.groups.filter((g) => g.id !== change.id)
  } else {
    throw new Error('The change sent by the app is not valid.')
  }
  persist()
}

/** Who added a Git account, for the service's check on changes. */
export function gitOwner(id: string): { exists: boolean; ownerId?: string } {
  const g = load().gits.find((x) => x.id === id)
  return { exists: !!g, ownerId: g?.ownerId }
}

// ---------------------------------------------------------------- Git accounts (app side)
function gitPublic(g: StoredGit): GitAccount {
  return { id: g.id, name: g.name, username: g.username, hasToken: !!g.token, provider: g.provider === 'github' ? 'github' : 'other', login: g.login, ownerId: g.ownerId, shared: g.shared, createdAt: g.createdAt }
}

export function listGits(): GitAccount[] {
  return load().gits.map(gitPublic)
}

export function saveGit(input: GitAccountInput): GitAccount {
  const d = load()
  if (!input.name?.trim()) throw new Error('Give the Git account a name.')
  let g = input.id ? d.gits.find((x) => x.id === input.id) : undefined
  if (!g) {
    if (!input.token?.trim()) throw new Error('Enter the access token.')
    g = { id: randomUUID(), name: '', username: 'git', token: '', ownerId: input.ownerId, shared: false, createdAt: Date.now() }
    d.gits.push(g)
  }
  g.name = input.name.trim()
  g.username = input.username?.trim() || 'git'
  g.shared = input.shared === true
  if (input.provider) g.provider = input.provider
  if (input.login !== undefined) g.login = input.login || undefined
  if (input.token?.trim()) g.token = encrypt(input.token.trim())
  persist()
  changed({ t: 'git', record: { ...g, token: decrypt(g.token) ?? '' } })
  return gitPublic(g)
}

export function removeGit(id: string): void {
  const d = load()
  d.gits = d.gits.filter((g) => g.id !== id)
  persist()
  changed({ t: 'git-del', id })
}

/** The sign-in to hand to git for one deploy. Undefined when this person was not given that account. */
export function gitSecret(id: string): { name: string; username: string; token: string } | undefined {
  const g = load().gits.find((x) => x.id === id)
  const token = g ? decrypt(g.token) : undefined
  return g && token ? { name: g.name, username: g.username, token } : undefined
}

/** Which server a site or deploy record belongs to, for the service's access check. */
export function projectOfSite(siteId: string): string | undefined {
  return load().sites.find((s) => s.id === siteId)?.projectId
}

// ---------------------------------------------------------------- database connections
function openSecrets(sec: StoredDbConn['secrets']): StoredDbConn['secrets'] {
  const out: StoredDbConn['secrets'] = {}
  for (const f of DBCONN_SECRETS) if (sec?.[f]) out[f] = decrypt(sec[f])
  return out
}

/** Who added a database connection, for the service's check on changes. */
export function dbConnOwner(id: string): { exists: boolean; ownerId?: string } {
  const c = load().dbconns.find((x) => x.id === id)
  return { exists: !!c, ownerId: c?.ownerId }
}

function dbConnPublic(c: StoredDbConn): DbConnection {
  return {
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port,
    username: c.username,
    hasPassword: !!c.secrets.password,
    database: c.database,
    useSsh: c.useSsh,
    sshProjectId: c.sshProjectId,
    sshHost: c.sshHost,
    sshPort: c.sshPort,
    sshUsername: c.sshUsername,
    sshAuth: c.sshAuth,
    hasSshPassword: !!c.secrets.sshPassword,
    hasSshKey: !!c.secrets.sshKey,
    ownerId: c.ownerId,
    shared: c.shared,
    backupProjectId: c.backupProjectId,
    createdAt: c.createdAt
  }
}

export function listDbConns(): DbConnection[] {
  return load().dbconns.map(dbConnPublic)
}

/** A connection with its secrets readable, as typed in the form merged over what is stored. Nothing is saved. */
export function draftDbConn(input: DbConnectionInput): StoredDbConn {
  const old = input.id ? load().dbconns.find((x) => x.id === input.id) : undefined
  if (input.id && !old) throw new Error('That connection no longer exists.')
  const had = old ? openSecrets(old.secrets) : {}
  const name = input.name?.trim()
  const host = input.host?.trim()
  const username = input.username?.trim()
  if (!name) throw new Error('Give the connection a name.')
  if (!host) throw new Error('Enter the database host.')
  if (!username) throw new Error('Enter the database user name.')
  const port = Math.floor(Number(input.port)) || 3306
  if (port < 1 || port > 65535) throw new Error('The port must be between 1 and 65535.')
  const c: StoredDbConn = { id: old?.id ?? randomUUID(), name, host, port, username, database: input.database?.trim() || undefined, useSsh: input.useSsh === true, secrets: { password: input.password || had.password }, ownerId: old ? old.ownerId : input.ownerId, shared: input.shared === true, backupProjectId: old?.backupProjectId, createdAt: old?.createdAt ?? Date.now() }
  if (c.useSsh) {
    if (input.sshProjectId) {
      c.sshProjectId = input.sshProjectId
    } else {
      c.sshHost = input.sshHost?.trim()
      c.sshPort = Math.floor(Number(input.sshPort)) || 22
      c.sshUsername = input.sshUsername?.trim()
      c.sshAuth = input.sshAuth === 'key' ? 'key' : 'password'
      if (!c.sshHost) throw new Error('Enter the SSH host.')
      if (!c.sshUsername) throw new Error('Enter the SSH user name.')
      if (c.sshAuth === 'key') {
        c.secrets.sshKey = input.sshKey?.trim() ? input.sshKey.trim() + '\n' : had.sshKey
        c.secrets.sshPassphrase = input.sshPassphrase || (input.sshKey?.trim() ? undefined : had.sshPassphrase)
        if (!c.secrets.sshKey) throw new Error('Paste the SSH private key.')
      } else {
        c.secrets.sshPassword = input.sshPassword || had.sshPassword
        if (!c.secrets.sshPassword) throw new Error('Enter the SSH password.')
      }
      // Kept only while the tunnel still goes to the same place.
      if (old && old.sshHost === c.sshHost && old.sshPort === c.sshPort && !old.sshProjectId) c.sshFingerprint = old.sshFingerprint
    }
  }
  return c
}

function putDbConn(c: StoredDbConn): void {
  const d = load()
  const secrets: StoredDbConn['secrets'] = {}
  for (const f of DBCONN_SECRETS) if (c.secrets[f]) secrets[f] = encrypt(c.secrets[f] as string)
  const stored = { ...c, secrets }
  const i = d.dbconns.findIndex((x) => x.id === c.id)
  if (i >= 0) d.dbconns[i] = stored
  else d.dbconns.push(stored)
  persist()
  changed({ t: 'dbconn', record: c })
}

/** Remember (or forget) which server makes a connection's scheduled backups. */
export function setDbConnBackup(id: string, projectId: string | undefined): void {
  const old = load().dbconns.find((x) => x.id === id)
  if (!old) throw new Error('That connection no longer exists.')
  putDbConn({ ...old, secrets: openSecrets(old.secrets), backupProjectId: projectId })
}

export function saveDbConn(input: DbConnectionInput): DbConnection {
  const c = draftDbConn(input)
  putDbConn(c)
  return dbConnPublic(c)
}

export function removeDbConn(id: string): void {
  const d = load()
  d.dbconns = d.dbconns.filter((c) => c.id !== id)
  persist()
  changed({ t: 'dbconn-del', id })
}

/** A saved connection with its secrets readable. Throws when this person was not given it. */
export function dbConnSecret(id: string): StoredDbConn {
  const c = load().dbconns.find((x) => x.id === id)
  if (!c) throw new Error('That connection is not available to you.')
  return { ...c, secrets: openSecrets(c.secrets) }
}

/** Remember the SSH server's host key after the first tunnel. */
export function setDbConnFingerprint(id: string, fingerprint: string): void {
  const c = load().dbconns.find((x) => x.id === id)
  if (!c || c.sshFingerprint === fingerprint) return
  putDbConn({ ...c, secrets: openSecrets(c.secrets), sshFingerprint: fingerprint })
}

// ---------------------------------------------------------------- team settings
function cleanSettings(r: TeamSettings | undefined): TeamSettings {
  const id = typeof r?.githubClientId === 'string' ? r.githubClientId.trim() : ''
  if (id && !/^[A-Za-z0-9._-]{8,80}$/.test(id)) throw new Error('That does not look like a GitHub Client ID. It is a short code such as Ov23li... shown on the OAuth App page.')
  const gid = typeof r?.googleClientId === 'string' ? r.googleClientId.trim() : ''
  const gsecret = typeof r?.googleClientSecret === 'string' ? r.googleClientSecret.trim() : ''
  if (gid && !/^[A-Za-z0-9._-]{20,200}$/.test(gid)) throw new Error('That does not look like a Google Client ID. It ends in .apps.googleusercontent.com.')
  if (gsecret && !/^[A-Za-z0-9._-]{8,200}$/.test(gsecret)) throw new Error('That does not look like a Google client secret.')
  return { githubClientId: id || undefined, googleClientId: gid || undefined, googleClientSecret: gsecret || undefined }
}

export function getSettings(): TeamSettings {
  return { ...load().settings }
}

export function saveSettings(next: TeamSettings): TeamSettings {
  const d = load()
  d.settings = cleanSettings({ ...d.settings, ...next })
  persist()
  changed({ t: 'settings', record: d.settings })
  return { ...d.settings }
}

// ---------------------------------------------------------------- database passwords that can be shown again
/** App side: which database users have a stored password. The passwords themselves stay on the service. */
export function listDbSecrets(projectId: string): { id: string; database: string; user: string; createdBy?: string; createdAt: number }[] {
  return load().dbsecrets.filter((x) => x.projectId === projectId).map(({ id, database, user, createdBy, createdAt }) => ({ id, database, user, createdBy, createdAt }))
}

/** App side: hand a password that was just set to the service for safe keeping. */
export function saveDbSecret(projectId: string, database: string, user: string, password: string, createdBy?: string): void {
  const d = load()
  const id = `${projectId}:${user}`
  const record: StoredDbSecret = { id, projectId, database, user, password: '', createdBy, createdAt: Date.now() }
  const i = d.dbsecrets.findIndex((x) => x.id === id)
  if (i >= 0) d.dbsecrets[i] = { ...record, createdAt: d.dbsecrets[i].createdAt }
  else d.dbsecrets.push(record)
  persist()
  changed({ t: 'dbsecret', record: { ...record, password } })
}

export function removeDbSecrets(projectId: string, database: string): void {
  const d = load()
  if (!d.dbsecrets.some((x) => x.projectId === projectId && x.database === database)) return
  d.dbsecrets = d.dbsecrets.filter((x) => !(x.projectId === projectId && x.database === database))
  persist()
  changed({ t: 'dbsecret-del', projectId, database })
}

/** Service side: the stored password in the clear. The caller has already checked who is asking. */
export function revealDbSecret(id: string): { projectId: string; database: string; user: string; password: string } | undefined {
  const x = load().dbsecrets.find((s) => s.id === id)
  const password = x?.password ? decrypt(x.password) : undefined
  return x && password ? { projectId: x.projectId, database: x.database, user: x.user, password } : undefined
}

export function dbSecretProject(id: string): string | undefined {
  return load().dbsecrets.find((s) => s.id === id)?.projectId
}

// ---------------------------------------------------------------- projects (groups of servers)
const GROUP_ROLES: GroupRole[] = ['frontend', 'api', 'lb', 'database', 'cache', 'worker', 'storage', 'other']

/** Check and tidy a project as sent by an app. Servers that do not exist are dropped; one server may hold several roles. */
function cleanGroup(r: ServerGroup, known: Set<string>): ServerGroup {
  const name = String(r.name ?? '').trim()
  if (!name || name.length > 80) throw new Error('Give the project a name of up to 80 characters.')
  if (!Array.isArray(r.members) || r.members.length > 100) throw new Error('A project holds up to 100 servers.')
  const seen = new Set<string>()
  const members: GroupMember[] = []
  for (const m of r.members) {
    const projectId = String(m?.projectId ?? '')
    if (!known.has(projectId)) continue
    const role: GroupRole = GROUP_ROLES.includes(m.role) ? m.role : 'other'
    const label = typeof m.label === 'string' && m.label.trim() ? m.label.trim().slice(0, 40) : undefined
    const key = `${projectId}:${role}`
    if (seen.has(key)) continue
    seen.add(key)
    members.push({ projectId, role, label })
  }
  const nfs: GroupNfs[] = []
  for (const n of Array.isArray(r.nfs) ? r.nfs.slice(0, 20) : []) {
    const path = String(n?.path ?? '')
    const local = String(n?.local ?? '')
    if (!known.has(String(n?.serverId)) || !/^\/[\w./-]{1,250}$/.test(path) || !/^\/[\w./-]{1,250}$/.test(local)) continue
    nfs.push({
      id: typeof n.id === 'string' && /^[\w-]{1,64}$/.test(n.id) ? n.id : randomUUID(),
      serverId: n.serverId,
      path,
      local,
      readOnly: n.readOnly === true,
      owner: n.owner === 'web' || n.owner === 'root' ? n.owner : 'keep',
      roles: Array.isArray(n.roles) ? [...new Set(n.roles.filter((x) => GROUP_ROLES.includes(x)))] : [],
      allowPublic: n.allowPublic === true
    })
  }
  return {
    id: r.id,
    name,
    nfs: nfs.length ? nfs : undefined,
    note: typeof r.note === 'string' && r.note.trim() ? r.note.trim().slice(0, 500) : undefined,
    color: typeof r.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(r.color) ? r.color : undefined,
    members,
    ownerId: r.ownerId,
    shared: r.shared === true,
    createdAt: r.createdAt
  }
}

/** Who made a project and which servers it holds, for the service's check on changes. */
export function groupInfo(id: string): { exists: boolean; ownerId?: string; members: GroupMember[]; nfs: GroupNfs[] } {
  const g = load().groups.find((x) => x.id === id)
  return { exists: !!g, ownerId: g?.ownerId, members: g ? g.members.map((m) => ({ ...m })) : [], nfs: g?.nfs ? g.nfs.map((n) => ({ ...n, roles: [...n.roles] })) : [] }
}

export function listGroups(): ServerGroup[] {
  return load().groups.map((g) => ({ ...g, members: g.members.map((m) => ({ ...m })), nfs: g.nfs?.map((n) => ({ ...n, roles: [...n.roles] })) }))
}

export function saveGroup(input: ServerGroupInput, ownerId: string): ServerGroup {
  const d = load()
  const old = input.id ? d.groups.find((g) => g.id === input.id) : undefined
  if (input.id && !old) throw new Error('That project no longer exists.')
  const next = cleanGroup({ ...input, id: old?.id ?? randomUUID(), ownerId: old ? old.ownerId : ownerId, createdAt: old?.createdAt ?? Date.now() } as ServerGroup, new Set(d.projects.map((p) => p.id)))
  if (old) d.groups[d.groups.indexOf(old)] = next
  else d.groups.push(next)
  persist()
  changed({ t: 'group', record: next })
  return { ...next, members: next.members.map((m) => ({ ...m })) }
}

export function removeGroup(id: string): void {
  const d = load()
  d.groups = d.groups.filter((g) => g.id !== id)
  persist()
  changed({ t: 'group-del', id })
}
