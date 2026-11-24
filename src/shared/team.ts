// Accounts, roles and audit types shared by the service and the desktop app.

export type Role = 'admin' | 'developer' | 'it_support' | 'viewer'

export type Permission =
  /** Read status, lists, logs and settings. */
  | 'view'
  /** Create and change sites, deploy, roll back, manage PM2 apps and cron tasks. */
  | 'deploy'
  /** Server operations: firewall, PHP, Redis, backups, alerts, certificates, installs. */
  | 'ops'
  /** Create databases and take backups. */
  | 'data'
  /** Destructive data actions: drop a database, restore over one, empty Redis. */
  | 'danger'
  /** File manager anywhere on a server, as root. */
  | 'files'
  /** File manager limited to the websites folder. */
  | 'webfiles'
  /** Open a root shell on a server. */
  | 'terminal'
  /** Add servers, and change, share or remove the ones you own (admins: any server they can use). */
  | 'projects'
  /** Manage accounts and read the audit log. */
  | 'admin'

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  developer: 'Developer',
  it_support: 'IT Support',
  viewer: 'Viewer'
}

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ['view', 'deploy', 'ops', 'data', 'danger', 'files', 'terminal', 'projects', 'admin'],
  developer: ['view', 'deploy', 'data', 'webfiles', 'projects'],
  it_support: ['view', 'deploy', 'ops', 'data', 'danger', 'files', 'terminal', 'projects'],
  viewer: ['view']
}

export const ROLE_SUMMARY: Record<Role, string> = {
  admin: 'Everything on every server shared with the team or with chosen people, plus accounts and the audit log. Private servers of other people stay hidden.',
  developer: 'Add own servers and share them. Sites: create, deploy, roll back, maintenance, HTTPS. PM2 apps and cron tasks. Create databases and back them up. File manager inside /www/wwwroot only. No terminal, firewall or server settings.',
  it_support: 'Add own servers and share them. Server operations: firewall, PHP, Redis, backups, alerts, HTTPS, installs, database backup / restore / delete, PM2 and cron, the file manager on the whole server, and the terminal. Sites: create, deploy, preview, roll back, maintenance.',
  viewer: 'Read only on servers shared with them: status, monitoring, lists and logs.'
}

export function can(role: Role, perm: Permission | Permission[]): boolean {
  const have = ROLE_PERMISSIONS[role] ?? []
  return (Array.isArray(perm) ? perm : [perm]).some((p) => have.includes(p))
}

/** What the app knows about the signed-in person. */
export interface SessionUser {
  id: string
  username: string
  displayName: string
  role: Role
}

export interface TeamUser extends SessionUser {
  disabled: boolean
  twoFactor: boolean
  locked: boolean
  mustChangePassword: boolean
  /** Server ids this person may use. null = all servers. */
  projects: string[] | null
  createdAt: number
  lastLoginAt?: number
}

export interface TeamUserInput {
  id?: string
  username: string
  displayName: string
  role: Role
  disabled: boolean
  projects: string[] | null
}

/** Result of each login step: what the app must ask for next. */
export type LoginStep =
  | { next: 'totp' }
  | { next: 'enroll'; secret: string; uri: string }
  | { next: 'password'; reason: string }
  | { next: 'done'; user: SessionUser; token: string }

export interface AuditEntry {
  seq: number
  time: number
  user: string
  role: string
  ip: string
  action: string
  /** Server name, when the action targets one. */
  project?: string
  /** Short human summary of what was targeted (site, database, rule...). */
  target?: string
  ok: boolean
  error?: string
  ms?: number
}

export interface AuditQuery {
  text?: string
  user?: string
  onlyFailed?: boolean
  limit: number
  offset: number
}

export interface AuditPage {
  total: number
  entries: AuditEntry[]
}

export interface SessionState {
  serverUrl: string
  lastUsername: string
  connected: boolean
  /** The connection dropped and the app is connecting again; the session is kept. */
  reconnecting?: boolean
  user: SessionUser | null
  /** The app is locked and waits for the fingerprint. */
  locked: boolean
  /** This computer can unlock with a fingerprint (Touch ID on a Mac). */
  biometric: boolean
}

export const PASSWORD_RULES = 'At least 6 characters. Longer is safer: the authenticator code protects the account, but a short password is easier to guess.'

/** Where people with the limited file permission may work. */
export const WEB_ROOT = '/www/wwwroot'

/** What every signed-in person may know about a colleague, for choosing who to share a server with. */
export interface TeamMember {
  id: string
  username: string
  displayName: string
  role: Role
}

// ---------------------------------------------------------------- protection of the service
/** Heavy actions that wait for a second admin when approval is switched on. Switching a firewall off counts too. */
export const APPROVAL_ACTIONS = ['db:drop', 'pg:drop', 'mongo:drop', 'dbc:dropDatabase', 'db:restore', 'pg:restore', 'mongo:restore', 'backup:restore', 'server:shutdown', 'server:reboot', 'sites:remove', 'projects:remove', 'firewall:setEnabled', 'apps:uninstall'] as const
/** How long a request waits for an answer. */
export const APPROVAL_MINUTES = 10

export interface GuardView {
  /** Addresses and ranges that may sign in. Empty: anyone. */
  allowedIps: string[]
  /** The address the service sees for the admin who is looking. */
  yourAddress: string
  /** A bot token is stored. The token itself is never sent back. */
  telegramSet: boolean
  telegramChat: string
  alertSignIn: boolean
  alertDanger: boolean
  approvals: boolean
  /** Terminal recordings older than this many days are removed. 0 keeps them for ever. */
  recordingDays: number
  /** A session ends after this many hours without use (1-168). */
  sessionIdleHours: number
  /** Everyone signs in again at least this often, in days (1-90). */
  sessionMaxDays: number
  /** Why the last alert could not be delivered, if it could not. */
  telegramError?: string
}

export interface GuardInput {
  allowedIps: string[]
  /** Left out: keep the stored token. Empty: remove it. */
  telegramToken?: string
  telegramChat: string
  alertSignIn: boolean
  alertDanger: boolean
  approvals: boolean
  /** Left out: unchanged. */
  recordingDays?: number
  sessionIdleHours?: number
  sessionMaxDays?: number
}

export interface ApprovalRequest {
  id: string
  /** Who asks. */
  user: string
  ip: string
  action: string
  project?: string
  target?: string
  time: number
}

/** What the app shows while its own request waits. */
export interface ApprovalWaiting {
  id: string
  action: string
  project?: string
  target?: string
}

/** The desktop app's own update, offered by the team service. */
export interface UpdateState {
  /** Version of this app. */
  current: string
  /** A newer version the service offers. */
  available?: string
  notes?: string
  /** 0-100 while downloading. */
  progress?: number
  /** Downloaded and checked: "Restart to update" can be offered. */
  ready?: boolean
  error?: string
}
