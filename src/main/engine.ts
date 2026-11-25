// The engine: every operation on a managed server. It runs inside the desktop
// app, which connects to the servers over SSH itself. The service is asked only
// for sign-in, the shared list of servers and sites, and to keep the audit log.
import { createWriteStream, existsSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { createGzip } from 'node:zlib'
import { randomBytes, randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { Client, ClientChannel } from 'ssh2'
import type { Permission, SessionUser } from '@shared/team'
import { APPROVAL_ACTIONS, can, WEB_ROOT } from '@shared/team'
import type {
  AlertConfig,
  DbBrowseOptions,
  DbConnectionInput,
  DbImportResult,
  DbTableDesign,
  GdriveOptions,
  S3Options,
  DockerRunInput,
  VersionApp,
  UninstallApp,
  ProxyRule,
  NginxSettings,
  PhpOptimizeInput,
  HistoryRange,
  SecurityFix,
  FilePermInput,
  GitAccountInput,
  BackupJob,
  ConnState,
  CronTask,
  DbSchedule,
  FirewallRuleInput,
  FirewallStatus,
  NginxFirewall,
  PhpExtAction,
  Pm2Action,
  Pm2StartInput,
  ProjectInput,
  RedisSettings, SupervisorProgramInput, NfsShare, NfsOwner, NginxTuning, ServerGroupInput, Site, DeployTarget, DbRemoteWhen,
  SiteInput,
  UploadSource, DbAccess } from '@shared/types'
import * as store from './store'
import * as monitor from './monitor'
import * as deploy from './deploy'
import * as firewall from './firewall'
import * as logs from './logs'
import * as database from './database'
import * as backup from './backup'
import * as ssl from './ssl'
import * as pm2 from './pm2'
import * as cron from './cron'
import * as php from './php'
import * as redis from './redis'
import * as runtimes from './runtimes'
import * as langs from './langs'
import * as dbremote from './dbremote'
import * as supervisor from './supervisor'
import * as nfs from './nfs'
import * as ngx from './nginxconf'
import * as postgres from './postgres'
import * as files from './files'
import * as github from './github'
import * as history from './history'
import * as security from './security'
import * as autodeploy from './autodeploy'
import * as offsite from './offsite'
import * as dbclient from './dbclient'
import * as dbconn from './dbconn'
import * as power from './power'
import * as gdrive from './gdrive'
import * as s3 from './s3'
import * as docker from './docker'
import * as mongo from './mongo'
import * as versions from './versions'
import * as uninstaller from './uninstall'
import * as google from './google'
import { copyFolder } from './transfer'
import { connect, exec, shq } from './ssh'

export class RpcError extends Error {
  constructor(
    message: string,
    public code: 'unauthorized' | 'forbidden' | 'error' = 'error'
  ) {
    super(message)
  }
}

type Actor = SessionUser

/** One line for the service's audit log. The service adds who and from where. */
export interface Report {
  action: string
  project?: string
  target?: string
  ok: boolean
  error?: string
  ms?: number
}

export interface EngineDeps {
  /** The signed-in person, or null. */
  user(): Actor | null
  /** Send an event to the window. */
  emit(event: string, payload: unknown): void
  /** Hand an audit line to the service. */
  report(entry: Report): void
  /** Hand terminal output to the service, which keeps the recording. */
  record(sessionId: string, text: string): void
  /** Where and with which key a managed server sends its alerts through the service. */
  relay?(projectId: string): Promise<{ url: string; key: string; ready: boolean }>
  /** Ask the service whether this action waits for a second admin; resolves once it may run. */
  approve?(ask: { action: string; project?: string; target?: string }): Promise<void>
}

let deps: EngineDeps = { user: () => null, emit: () => undefined, report: () => undefined, record: () => undefined }

export function configureEngine(d: EngineDeps): void {
  deps = d
}

interface Call {
  user: Actor
  /** Run a long task whose output streams to the window under jobId. */
  job(jobId: string, fn: (log: (chunk: string) => void) => Promise<void>): Promise<void>
}

interface Def {
  perm: Permission | Permission[]
  /** What the first argument identifies, for the access check and the audit entry. */
  scope?: 'project' | 'site'
  /** Read-only calls made constantly by the UI are not written to the audit log. */
  quiet?: boolean
  run: (c: Call, ...args: any[]) => unknown
}

function broadcast(_projectId: string, event: string, payload: unknown): void {
  deps.emit(event, payload)
}

// ---------------------------------------------------------------- SSH connections (from this computer)
const clients = new Map<string, Client>()
const pending = new Map<string, Promise<Client>>()

function connState(projectId: string): ConnState {
  if (clients.has(projectId)) return 'connected'
  if (pending.has(projectId)) return 'connecting'
  return 'disconnected'
}

function getClient(projectId: string): Promise<Client> {
  const ready = clients.get(projectId)
  if (ready) return Promise.resolve(ready)
  const waiting = pending.get(projectId)
  if (waiting) return waiting
  broadcast(projectId, 'ssh:state', { projectId, state: 'connecting' })
  const attempt = (async () => {
    try {
      const target = store.getTarget(projectId)
      const { client, fingerprint } = await connect(target)
      if (!target.hostFingerprint && fingerprint) store.setFingerprint(projectId, fingerprint)
      clients.set(projectId, client)
      client.on('close', () => {
        if (clients.get(projectId) === client) {
          clients.delete(projectId)
          monitor.forget(projectId)
          for (const [id, t] of terminals) if (t.projectId === projectId) closeTerminal(id, 'server disconnected')
          broadcast(projectId, 'ssh:state', { projectId, state: 'disconnected' })
        }
      })
      broadcast(projectId, 'ssh:state', { projectId, state: 'connected' })
      return client
    } catch (err) {
      broadcast(projectId, 'ssh:state', { projectId, state: 'disconnected' })
      throw err
    } finally {
      pending.delete(projectId)
    }
  })()
  pending.set(projectId, attempt)
  return attempt
}

function disconnect(projectId: string): void {
  clients.get(projectId)?.end()
}

function sudoFor(projectId: string): deploy.Sudo {
  const target = store.getTarget(projectId)
  if (target.username === 'root') return { mode: 'none' }
  if (target.password) return { mode: 'password', stdin: target.password + '\n' }
  return { mode: 'nopasswd' }
}

async function on(id: string): Promise<{ client: Client; sudo: deploy.Sudo; port: number }> {
  return { client: await getClient(id), sudo: sudoFor(id), port: store.getProject(id).port }
}
// ---------------------------------------------------------------- terminals (output is recorded by the service)
interface Term {
  projectId: string
  stream: ClientChannel
  written: number
}
const terminals = new Map<string, Term>()
const TRANSCRIPT_LIMIT = 5 * 1024 * 1024

function closeTerminal(id: string, why: string): void {
  const t = terminals.get(id)
  if (!t) return
  terminals.delete(id)
  try {
    t.stream.close()
  } catch {
    /* already closed */
  }
  deps.record(id, `\n[session ended: ${why}]\n`)
  deps.emit('terminal:exit', { id })
  deps.report({ action: 'terminal:close', project: projectName(t.projectId), target: `session ${id}`, ok: true })
}

async function openTerminal(c: Call, projectId: string, cols: number, rows: number): Promise<string> {
  const client = await getClient(projectId)
  const stream = await new Promise<ClientChannel>((resolve, reject) => {
    client.shell({ term: 'xterm-256color', cols: Math.min(500, cols || 80), rows: Math.min(300, rows || 24) }, (err, s) => (err ? reject(err) : resolve(s)))
  })
  const id = randomUUID()
  const term: Term = { projectId, stream, written: 0 }
  terminals.set(id, term)
  deps.record(id, `[${new Date().toISOString()}] ${c.user.username} opened a terminal on ${projectName(projectId)}\n`)
  deps.report({ action: 'terminal:open', project: projectName(projectId), target: `session ${id}`, ok: true })
  const decoder = new StringDecoder('utf8')
  const out = (b: Buffer): void => {
    const text = decoder.write(b)
    deps.emit('terminal:data', { id, data: text })
    if (term.written < TRANSCRIPT_LIMIT) {
      term.written += b.length
      deps.record(id, text)
      if (term.written >= TRANSCRIPT_LIMIT) deps.record(id, '\n[recording stopped: 5 MB limit reached]\n')
    }
  }
  stream.on('data', out)
  stream.stderr.on('data', out)
  stream.on('close', () => closeTerminal(id, 'shell exited'))
  return id
}

/** Keystrokes and resizes arrive as one-way messages. */
export function terminalInput(kind: 'write' | 'resize', id: string, a: unknown, b?: unknown): void {
  const t = terminals.get(id)
  if (!t || !deps.user()) return
  if (kind === 'write' && typeof a === 'string') t.stream.write(a)
  if (kind === 'resize') t.stream.setWindow(Number(b) || 24, Number(a) || 80, 0, 0)
}

// ---------------------------------------------------------------- helpers
const busy = new Set<string>()

function projectName(id: string): string {
  try {
    return store.getProject(id).name
  } catch {
    return id
  }
}

function tellTelegram(projectId: string, text: string): void {
  void (async () => {
    try {
      const c = await getClient(projectId)
      await deploy.runPrivileged(c, `[ -x /usr/local/bin/superdevops-alert.sh ] && /usr/local/bin/superdevops-alert.sh say ${shq(text)} >/dev/null 2>&1; true`, sudoFor(projectId), undefined, 30000)
    } catch {
      /* alerts are optional */
    }
  })()
}

/** How this app signs in to a server, so a security fix never locks the app out. */
function loginOf(projectId: string): { username: string; usesPassword: boolean } {
  const t = store.getTarget(projectId)
  return { username: t.username, usesPassword: !t.privateKey }
}

/** The saved Git account a site fetches its code with, if it has one. */
function gitFor(site: { source: string; gitAccountId?: string }): deploy.GitSignIn | undefined {
  if (site.source !== 'git' || !site.gitAccountId) return undefined
  const git = store.gitSecret(site.gitAccountId)
  if (!git) throw new Error('This site fetches its code with a saved Git account that is not shared with you. Ask its owner to share it, or choose another account in the site settings.')
  return git
}

/** Google sign-ins: one waiting for approval in the browser, and one approved and waiting to be given to a server. Per signed-in user, memory only. */
const pendingGoogle = new Map<string, { clientId: string; clientSecret: string; deviceCode: string; interval: number; expires: number; team?: boolean }>()
const googleGrants = new Map<string, gdrive.GoogleGrant & { until: number }>()

/** A GitHub sign-in waiting for the person to approve it in their browser, per signed-in user. */
const pendingGithub = new Map<string, { clientId: string; deviceCode: string; interval: number; expires: number }>()

/** Where a database client request runs. Checks that this person may use it. */
async function execFor(target: unknown): Promise<dbclient.Exec> {
  const t = String(target ?? '')
  if (t.startsWith('server:')) {
    const id = t.slice(7)
    needAccess(id)
    return dbclient.serverExec(await getClient(id), sudoFor(id))
  }
  if (t.startsWith('conn:')) {
    const c = store.dbConnSecret(t.slice(5))
    if (c.useSsh && c.sshProjectId) needAccess(c.sshProjectId)
    return dbconn.connExec(c, { borrow: getClient, seen: (fp) => store.setDbConnFingerprint(c.id, fp) })
  }
  throw new Error('Pick a connection first.')
}

/** Upload files as the site's preview (job id = site id, like a deploy). */
async function previewSite(c: Call, site: Site, upload?: UploadSource): Promise<Site> {
  if (!deploy.canPreview(site)) throw new Error('Previews are for uploaded static and PHP sites.')
  if (!upload) throw new Error('Choose the files for the preview.')
  const id = site.id
  const log = (chunk: string): void => deps.emit('job:log', { jobId: id, chunk })
  busy.add(id)
  deps.emit('job:state', { jobId: id, state: 'running', method: 'sites:deploy', project: projectName(site.projectId), target: `site ${site.name} · preview` })
  let failed = false
  try {
    const next: Site = { ...site, preview: { at: Date.now(), by: c.user.username, token: site.preview?.token ?? randomBytes(16).toString('hex') } }
    const result = await deploy.previewDeploy({ client: await getClient(site.projectId), sudo: sudoFor(site.projectId), site: next, upload, log })
    store.addDeploy(id, result)
    const saved = store.saveSite({ ...next, preview: { ...next.preview!, health: result.health } })
    if (result.status !== 'success') throw new Error(result.note ?? 'The preview does not answer.')
    return saved
  } catch (err) {
    failed = true
    log(`\n[failed] ${err instanceof Error ? err.message : String(err)}\n`)
    throw err
  } finally {
    busy.delete(id)
    deps.emit('job:state', { jobId: id, state: failed ? 'failed' : 'done' })
  }
}

/**
 * Mount a project's shared folders (all rules, or one) on its servers: every other server, or those with the rule's roles.
 * `only` limits it to some servers (those just added). A server that already has the folder is left alone; one failing does not stop the rest.
 */
async function syncGroupNfs(groupId: string, ruleId: string | undefined, only: string[] | undefined, log: (s: string) => void): Promise<void> {
  const g = store.listGroups().find((x) => x.id === groupId)
  if (!g) throw new Error('That project no longer exists.')
  const rules = (g.nfs ?? []).filter((n) => !ruleId || n.id === ruleId)
  if (!rules.length) throw new Error('This project has no shared folders to mount.')
  const failed: string[] = []
  let done = 0
  for (const rule of rules) {
    if (!store.hasProject(rule.serverId)) continue
    const share = store.getProject(rule.serverId)
    const targets = [...new Set(g.members.filter((m) => m.projectId !== rule.serverId && (rule.roles.length === 0 || rule.roles.includes(m.role)) && (!only || only.includes(m.projectId)) && store.hasProject(m.projectId)).map((m) => m.projectId))]
    log(`\n=== ${share.name}:${rule.path} → ${rule.local} on ${targets.length} server${targets.length === 1 ? '' : 's'} ===\n`)
    for (const id of targets) {
      const user = store.getProject(id)
      log(`\n--- ${user.name} ---\n`)
      try {
        const [sc, uc] = await Promise.all([getClient(rule.serverId), getClient(id)])
        const o = await nfs.overview(uc, sudoFor(id))
        const there = o.mounts.find((m) => m.local === rule.local)
        if (there) {
          if (there.remote !== rule.path) {
            log(`${rule.local} is already used for ${there.server}:${there.remote}. Skipped.\n`)
            failed.push(`${user.name}: ${rule.local} is used for another folder`)
            continue
          }
          if (!there.mounted) await nfs.remount(uc, sudoFor(id), rule.local, log)
          else log('Already mounted.\n')
          done++
          continue
        }
        await nfs.join({ share: { client: sc, sudo: sudoFor(rule.serverId), name: share.name, host: share.host }, user: { client: uc, sudo: sudoFor(id), name: user.name, host: user.host }, path: rule.path, local: rule.local, readOnly: rule.readOnly, owner: rule.owner, allowPublic: rule.allowPublic, log })
        done++
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        log(`[failed] ${why}\n`)
        failed.push(`${user.name}: ${why}`)
      }
    }
  }
  log(`\n${done} mounted or already there${failed.length ? `, ${failed.length} failed` : ''}.\n`)
  if (failed.length) throw new Error(`Not mounted on ${failed.length} server${failed.length === 1 ? '' : 's'}: ${failed.join('; ')}`)
}

function mayEditGroup(user: Actor, id: string): void {
  const g = store.listGroups().find((x) => x.id === id)
  if (!g) throw new Error('That project no longer exists.')
  if (g.ownerId !== user.id && user.role !== 'admin') throw new RpcError('Only the person who made this project, or an admin, can change it.', 'forbidden')
}

function mayEditConn(user: Actor, id?: string): void {
  if (!id) return
  const c = store.listDbConns().find((x) => x.id === id)
  if (!c) throw new Error('That connection no longer exists.')
  if (c.ownerId !== user.id && user.role !== 'admin') throw new RpcError('Only the person who added this connection, or an admin, can change it.', 'forbidden')
}

function needManage(user: Actor, projectId: string): void {
  if (!store.canManage(projectId, user.id, user.role === 'admin')) throw new RpcError('Only the person who added this server, or an admin it is shared with, can change or remove it.', 'forbidden')
}

function needAccess(projectId: string): void {
  if (!store.hasProject(projectId)) throw new RpcError('You do not have access to that server.', 'forbidden')
}

/** File manager calls run as root; people without the full permission are kept inside the websites folder. */
async function fileCtx(user: Actor, projectId: string): Promise<files.FileCtx> {
  const s = await on(projectId)
  return { client: s.client, sudo: s.sudo, root: can(user.role, 'files') ? undefined : WEB_ROOT }
}
const FILES: Permission[] = ['files', 'webfiles']

// ---------------------------------------------------------------- the operations
const M: Record<string, Def> = {
  // Servers
  'projects:list': { perm: 'view', quiet: true, run: () => store.listProjects() },
  // Projects: saved servers grouped by the system they run together, each with its role.
  'groups:list': { perm: 'view', quiet: true, run: () => store.listGroups() },
  'groups:save': {
    perm: 'projects',
    run: (c, input: ServerGroupInput) => {
      if (input?.id) mayEditGroup(c.user, input.id)
      for (const m of input?.members ?? []) needAccess(String(m?.projectId))
      const before = new Set(input?.id ? (store.listGroups().find((g) => g.id === input.id)?.members ?? []).map((m) => m.projectId) : [])
      const saved = store.saveGroup(input, c.user.id)
      // Servers that just joined get the project's shared folders mounted, as a task of its own.
      const added = [...new Set(saved.members.map((m) => m.projectId))].filter((id) => !before.has(id))
      if (saved.nfs?.length && added.length && can(c.user.role, 'ops')) {
        void c.job(`nfsgroup:${saved.id}`, (log) => syncGroupNfs(saved.id, undefined, added, log)).catch(() => undefined)
      }
      return saved
    }
  },
  // Mount a project's shared folders on every server of it that does not have them yet.
  'nfs:groupSync': { perm: 'ops', run: (c, groupId: string, ruleId?: string) => c.job(`nfsgroup:${groupId}`, (log) => syncGroupNfs(String(groupId), ruleId ? String(ruleId) : undefined, undefined, log)) },
  'groups:remove': {
    perm: 'projects',
    run: (c, id: string) => {
      mayEditGroup(c.user, id)
      store.removeGroup(id)
    }
  },
  'projects:save': {
    perm: 'projects',
    run: (c, input: ProjectInput) => {
      if (input.id) needManage(c.user, input.id)
      const saved = store.saveProject(input.id ? { ...input, ownerId: undefined } : { ...input, ownerId: c.user.id })
      disconnect(saved.id)
      return saved
    }
  },
  'projects:remove': {
    perm: 'projects',
    scope: 'project',
    run: (c, id: string) => {
      needManage(c.user, id)
      disconnect(id)
      store.removeProject(id)
    }
  },
  'projects:test': {
    perm: 'projects',
    run: async (_c, input: ProjectInput) => {
      const { client, fingerprint } = await connect(store.targetFromInput(input))
      try {
        const res = await exec(client, 'uname -sr; whoami', { timeoutMs: 10000 })
        const [system, user] = res.stdout.trim().split('\n')
        return { system: system ?? '', user: user ?? '', fingerprint }
      } finally {
        client.end()
      }
    }
  },
  'projects:forgetHostKey': {
    perm: 'projects',
    scope: 'project',
    run: (_c, id: string) => {
      disconnect(id)
      store.setFingerprint(id, undefined)
      return store.getProject(id)
    }
  },
  'ssh:connect': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => (await getClient(id), connState(id)) },
  'ssh:disconnect': { perm: ['ops', 'projects'], scope: 'project', run: (_c, id: string) => disconnect(id) },
  // Restarting services and the server itself
  'server:services': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => power.services(await getClient(id)) },
  'server:restartService': { perm: 'ops', scope: 'project', run: (c, id: string, unit: string) => c.job(`power:${id}`, async (log) => power.restartService(await getClient(id), sudoFor(id), unit, log)) },
  'server:stopService': { perm: 'ops', scope: 'project', run: (c, id: string, unit: string) => c.job(`power:${id}`, async (log) => power.stopService(await getClient(id), sudoFor(id), unit, log)) },
  'server:shutdown': {
    perm: 'danger',
    scope: 'project',
    run: async (_c, id: string) => {
      await power.shutdown(await getClient(id), sudoFor(id))
      setTimeout(() => disconnect(id), 1500)
    }
  },
  'server:plannedReboot': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => power.plannedReboot(await getClient(id)) },
  'server:planReboot': { perm: 'danger', scope: 'project', run: async (_c, id: string, at: number | null) => power.planReboot(await getClient(id), sudoFor(id), at) },
  'server:reboot': {
    perm: 'danger',
    scope: 'project',
    run: async (_c, id: string) => {
      await power.reboot(await getClient(id), sudoFor(id))
      // The connection is about to die; drop it now so the next request opens a fresh one.
      setTimeout(() => disconnect(id), 1500)
    }
  },
  'ssh:state': { perm: 'view', scope: 'project', quiet: true, run: (_c, id: string) => connState(id) },
  'monitor:sample': {
    perm: 'view',
    scope: 'project',
    quiet: true,
    run: async (_c, id: string, allowConnect: boolean) => {
      if (!allowConnect && !clients.has(id)) throw new Error('The connection to the server was closed.')
      return monitor.sample(id, await getClient(id))
    }
  },
  'monitor:historyStatus': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => history.status(await getClient(id)) },
  'monitor:historySet': { perm: 'ops', scope: 'project', run: async (_c, id: string, enable: boolean) => history.setEnabled(await getClient(id), sudoFor(id), enable === true) },
  'monitor:history': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string, range: HistoryRange) => history.read(await getClient(id), range) },
  'monitor:certs': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => history.certs(await getClient(id), sudoFor(id)) },

  // Security check-up
  'security:report': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => security.report(await getClient(id), sudoFor(id), loginOf(id)) },
  'security:fix': { perm: 'ops', scope: 'project', run: (c, id: string, what: SecurityFix) => c.job(`security:${id}`, async (log) => security.fix(await getClient(id), sudoFor(id), what, loginOf(id), log)) },

  'security:banned': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => security.banned(await getClient(id), sudoFor(id)) },
  'security:unban': { perm: 'ops', scope: 'project', run: async (_c, id: string, jail: string, address: string) => security.unban(await getClient(id), sudoFor(id), jail, address) },
  'security:ban': { perm: 'ops', scope: 'project', run: async (_c, id: string, jail: string, address: string) => security.ban(await getClient(id), sudoFor(id), jail, address) },

  // Backups to Google Drive
  'google:status': {
    perm: 'view',
    quiet: true,
    run: (c) => {
      const st = store.getSettings()
      const g = googleGrants.get(c.user.id)
      return {
        configured: !!(st.googleClientId && st.googleClientSecret),
        clientId: st.googleClientId,
        secretSet: !!st.googleClientSecret,
        canSetup: c.user.role === 'admin',
        ready: g && Date.now() < g.until ? { email: g.email } : undefined,
        team: st.googleTeam ? { email: st.googleTeam.email, by: st.googleTeam.by, at: st.googleTeam.at } : undefined
      }
    }
  },
  'google:setup': {
    perm: 'view',
    run: async (c, clientId: string, clientSecret: string) => {
      if (c.user.role !== 'admin') throw new RpcError('Only an admin can set up the Google connection for the team.', 'forbidden')
      const before = store.getSettings()
      const id = String(clientId ?? '').trim()
      // An empty secret keeps the stored one (the settings page never shows it).
      const secret = String(clientSecret ?? '').trim() || (id === before.googleClientId ? before.googleClientSecret ?? '' : '')
      if (!id || !secret) throw new Error('Paste both the Client ID and the client secret.')
      // Asking Google for a code proves the client exists and may use this kind of sign-in.
      await google.deviceStart(id)
      // A team account signed in through another client cannot be refreshed with this one.
      store.saveSettings({ googleClientId: id, googleClientSecret: secret, ...(id !== before.googleClientId ? { googleTeam: undefined } : {}) })
    }
  },
  'google:clear': {
    perm: 'view',
    run: (c) => {
      if (c.user.role !== 'admin') throw new RpcError('Only an admin can change the Google connection for the team.', 'forbidden')
      store.saveSettings({ googleClientId: undefined, googleClientSecret: undefined, googleTeam: undefined })
    }
  },
  'google:teamRemove': {
    perm: 'view',
    run: (c) => {
      if (c.user.role !== 'admin') throw new RpcError('Only an admin can change the team Google account.', 'forbidden')
      store.saveSettings({ googleTeam: undefined })
    }
  },
  // Use the team's Google account for the next Drive set-up, instead of signing in to Google again.
  'google:useTeam': {
    perm: 'ops',
    run: (c) => {
      const st = store.getSettings()
      const t = st.googleTeam
      if (!t || !st.googleClientId || !st.googleClientSecret) throw new Error('The team has no Google account connected. An admin connects one under Team → Integrations.')
      if (!t.token) throw new Error('Your role cannot use the team Google account.')
      googleGrants.set(c.user.id, { clientId: st.googleClientId, clientSecret: st.googleClientSecret, refreshToken: t.token, email: t.email, until: Date.now() + 30 * 60 * 1000 })
      return { email: t.email }
    }
  },
  'google:connectStart': {
    perm: 'ops',
    quiet: true,
    run: async (c, team?: boolean) => {
      if (team === true && c.user.role !== 'admin') throw new RpcError('Only an admin can connect the team Google account.', 'forbidden')
      const st = store.getSettings()
      if (!st.googleClientId || !st.googleClientSecret) throw new Error('The Google connection has not been set up for this team yet.')
      const d = await google.deviceStart(st.googleClientId)
      pendingGoogle.set(c.user.id, { clientId: st.googleClientId, clientSecret: st.googleClientSecret, deviceCode: d.deviceCode, interval: d.interval, expires: Date.now() + d.expiresIn * 1000, team: team === true })
      return { userCode: d.userCode, verificationUrl: d.verificationUrl, expiresIn: d.expiresIn, interval: d.interval }
    }
  },
  'google:connectPoll': {
    perm: 'ops',
    quiet: true,
    run: async (c) => {
      const p = pendingGoogle.get(c.user.id)
      if (!p || Date.now() > p.expires) {
        pendingGoogle.delete(c.user.id)
        return { state: 'expired' }
      }
      const r = await google.devicePoll(p.clientId, p.clientSecret, p.deviceCode)
      if (r.state === 'pending') {
        if (r.slower) p.interval += 5
        return { state: 'pending', interval: p.interval }
      }
      pendingGoogle.delete(c.user.id)
      if (r.state !== 'done') return { state: r.state }
      if (p.team) {
        // Kept by the service (encrypted) for every server's Drive set-up. It never goes to the window.
        store.saveSettings({ googleTeam: { email: r.email, token: r.refreshToken, by: c.user.username, at: Date.now() } })
        deps.report({ action: 'google:teamConnect', target: `team Google account ${r.email || '(address not given)'}`, ok: true })
        return { state: 'done', email: r.email }
      }
      // Held in this app's memory for a short while, then handed to the server being set up. It never goes to the window.
      googleGrants.set(c.user.id, { clientId: p.clientId, clientSecret: p.clientSecret, refreshToken: r.refreshToken, email: r.email, until: Date.now() + 30 * 60 * 1000 })
      deps.report({ action: 'google:connect', target: `Google account ${r.email || '(address not given)'}`, ok: true })
      return { state: 'done', email: r.email }
    }
  },
  'gdrive:status': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => gdrive.status(await getClient(id), sudoFor(id)) },
  'gdrive:enable': {
    perm: 'ops',
    scope: 'project',
    run: (c, id: string, options: GdriveOptions) =>
      c.job(`gdrive:${id}`, async (log) => {
        const g = googleGrants.get(c.user.id)
        if (!g || Date.now() > g.until) throw new Error('Connect a Google account first.')
        await gdrive.enable(await getClient(id), sudoFor(id), options, g, log)
      })
  },
  'gdrive:update': { perm: 'ops', scope: 'project', run: async (_c, id: string, options: GdriveOptions) => gdrive.update(await getClient(id), sudoFor(id), options) },
  'gdrive:run': { perm: 'ops', scope: 'project', run: (c, id: string) => c.job(`gdrive:${id}`, async (log) => gdrive.runNow(await getClient(id), sudoFor(id), log)) },
  'gdrive:remote': { perm: 'ops', scope: 'project', quiet: true, run: async (_c, id: string) => gdrive.remoteFiles(await getClient(id), sudoFor(id)) },
  'gdrive:fetch': { perm: 'ops', scope: 'project', run: (c, id: string, fileId: string, name: string) => c.job(`gdrive:${id}`, async (log) => gdrive.fetchRemote(await getClient(id), sudoFor(id), fileId, name, log)) },
  'gdrive:disable': { perm: 'ops', scope: 'project', run: async (_c, id: string) => gdrive.disable(await getClient(id), sudoFor(id)) },
  's3:status': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => s3.status(await getClient(id), sudoFor(id)) },
  's3:setup': { perm: 'ops', scope: 'project', run: (c, id: string, options: S3Options) => c.job(`s3:${id}`, async (log) => s3.setup(await getClient(id), sudoFor(id), options, log)) },
  's3:run': { perm: 'ops', scope: 'project', run: (c, id: string) => c.job(`s3:${id}`, async (log) => s3.runNow(await getClient(id), sudoFor(id), log)) },
  's3:remote': { perm: 'ops', scope: 'project', quiet: true, run: async (_c, id: string) => s3.remoteFiles(await getClient(id), sudoFor(id)) },
  's3:fetch': { perm: 'ops', scope: 'project', run: (c, id: string, fileId: string) => c.job(`s3:${id}`, async (log) => s3.fetchRemote(await getClient(id), sudoFor(id), fileId, log)) },
  's3:disable': { perm: 'ops', scope: 'project', run: async (_c, id: string) => s3.disable(await getClient(id), sudoFor(id)) },

  // Saved Git accounts
  'git:list': { perm: 'view', quiet: true, run: () => store.listGits() },
  'git:save': {
    perm: 'deploy',
    run: async (c, input: GitAccountInput) => {
      const existing = input.id ? store.listGits().find((x) => x.id === input.id) : undefined
      if (input.id) {
        if (!existing) throw new Error('That Git account no longer exists.')
        if (existing.ownerId !== c.user.id && c.user.role !== 'admin') throw new RpcError('Only the person who added this Git account, or an admin, can change it.', 'forbidden')
      }
      const provider = input.provider ?? existing?.provider ?? 'other'
      let login = existing?.login
      let username = input.username
      if (provider === 'github') {
        // Ask GitHub who the token belongs to, so a wrong token is caught now and not at the next deploy.
        const token = input.token?.trim() || (input.id ? store.gitSecret(input.id)?.token : undefined)
        if (!token) throw new Error('Paste the GitHub access token.')
        login = await github.whoAmI(token)
        username = login
      }
      return store.saveGit({ ...input, username, provider, login: provider === 'github' ? login : '', ownerId: input.id ? undefined : c.user.id })
    }
  },
  'git:repos': {
    perm: 'deploy',
    quiet: true,
    run: async (_c, accountId: string) => {
      const secret = store.gitSecret(accountId)
      if (!secret) throw new Error('That Git account is not available to you.')
      return github.repos(secret.token)
    }
  },
  'git:branches': {
    perm: 'deploy',
    quiet: true,
    run: async (_c, accountId: string, repoUrl: string) => {
      const secret = store.gitSecret(accountId)
      if (!secret) throw new Error('That Git account is not available to you.')
      const name = github.repoName(repoUrl)
      if (!name) throw new Error('That is not a GitHub repository address.')
      return github.branches(secret.token, name)
    }
  },
  'git:refs': {
    perm: 'deploy',
    quiet: true,
    run: async (_c, accountId: string, repoUrl: string) => {
      const secret = store.gitSecret(accountId)
      if (!secret) throw new Error('That Git account is not available to you.')
      const name = github.repoName(repoUrl)
      if (!name) throw new Error('That is not a GitHub repository address.')
      const [branches, tags] = await Promise.all([github.branches(secret.token, name), github.tags(secret.token, name).catch(() => [] as string[])])
      return { branches, tags }
    }
  },

  // "Connect GitHub": approve this app on github.com once, instead of pasting a token.
  'github:status': { perm: 'view', quiet: true, run: (c) => ({ configured: !!store.getSettings().githubClientId, clientId: store.getSettings().githubClientId, canSetup: c.user.role === 'admin' }) },
  'github:setup': {
    perm: 'view',
    run: async (c, clientId: string) => {
      if (c.user.role !== 'admin') throw new RpcError('Only an admin can set up the GitHub connection for the team.', 'forbidden')
      const id = String(clientId ?? '').trim()
      if (!id) throw new Error('Paste the Client ID of the OAuth App.')
      // Asking GitHub for a code proves the ID exists and that Device Flow is on.
      await github.deviceStart(id)
      store.saveSettings({ githubClientId: id })
    }
  },
  'github:connectStart': {
    perm: 'deploy',
    quiet: true,
    run: async (c) => {
      const clientId = store.getSettings().githubClientId
      if (!clientId) throw new Error('The GitHub connection has not been set up for this team yet.')
      const d = await github.deviceStart(clientId)
      pendingGithub.set(c.user.id, { clientId, deviceCode: d.deviceCode, interval: d.interval, expires: Date.now() + d.expiresIn * 1000 })
      return { userCode: d.userCode, verificationUri: d.verificationUri, expiresIn: d.expiresIn, interval: d.interval }
    }
  },
  'github:connectPoll': {
    perm: 'deploy',
    quiet: true,
    run: async (c) => {
      const p = pendingGithub.get(c.user.id)
      if (!p || Date.now() > p.expires) {
        pendingGithub.delete(c.user.id)
        return { state: 'expired' }
      }
      const r = await github.devicePoll(p.clientId, p.deviceCode)
      if (r.state === 'pending') {
        if (r.slower) p.interval += 5
        return { state: 'pending', interval: p.interval }
      }
      pendingGithub.delete(c.user.id)
      if (r.state !== 'done') return { state: r.state }
      const login = await github.whoAmI(r.token)
      // Connecting the same GitHub user again replaces the old token instead of adding a second account.
      const mine = store.listGits().find((g) => g.provider === 'github' && g.login === login && g.ownerId === c.user.id)
      const account = store.saveGit({ id: mine?.id, name: mine?.name ?? `GitHub: ${login}`, username: login, token: r.token, shared: mine?.shared ?? false, provider: 'github', login, ownerId: mine ? undefined : c.user.id })
      deps.report({ action: 'github:connect', target: `GitHub account ${login}`, ok: true })
      return { state: 'done', account }
    }
  },
  'git:remove': {
    perm: 'deploy',
    run: (c, id: string) => {
      const g = store.listGits().find((x) => x.id === id)
      if (g && g.ownerId !== c.user.id && c.user.role !== 'admin') throw new RpcError('Only the person who added this Git account, or an admin, can remove it.', 'forbidden')
      store.removeGit(id)
    }
  },

  // Terminal
  // Opening is logged by openTerminal itself, so the entry can carry the recording's id.
  'terminal:open': { perm: 'terminal', scope: 'project', quiet: true, run: (c, id: string, cols: number, rows: number) => openTerminal(c, id, cols, rows) },
  'terminal:close': {
    perm: 'terminal',
    quiet: true,
    run: (_c, id: string) => closeTerminal(id, 'closed by user')
  },

  // Sites and deploy
  'sites:list': { perm: 'view', scope: 'project', quiet: true, run: (_c, id: string) => store.listSites(id) },
  'sites:save': {
    perm: 'deploy',
    run: async (c, input: SiteInput) => {
      needAccess(input.projectId)
      if (input.id) needAccess(store.getSite(input.id).projectId)
      deploy.validateSite({ ...input, id: input.id ?? 'new', createdAt: 0, updatedAt: 0 })
      const before = input.id ? store.getSite(input.id) : undefined
      // Auto deploy is switched with its own action; a normal save keeps it as it was.
      const saved = store.saveSite({ ...input, autoDeploy: before?.autoDeploy })
      if (saved.autoDeploy) {
        // The server holds its own copy of the deploy steps; keep it in step with the new settings.
        try {
          if (saved.source !== 'git') {
            await autodeploy.disable(await getClient(saved.projectId), sudoFor(saved.projectId), before ?? saved)
            return store.saveSite({ ...saved, autoDeploy: false })
          }
          if (before && before.name !== saved.name) await autodeploy.disable(await getClient(saved.projectId), sudoFor(saved.projectId), before)
          await autodeploy.enable(await getClient(saved.projectId), sudoFor(saved.projectId), saved, gitFor(saved))
        } catch (err) {
          throw new Error(`The site was saved, but auto deploy on the server could not be updated: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return saved
    }
  },
  'sites:autoDeploy': {
    perm: 'deploy',
    scope: 'site',
    run: async (_c, id: string, enable: boolean) => {
      const site = store.getSite(id)
      const s = await on(site.projectId)
      if (enable) await autodeploy.enable(s.client, s.sudo, site, gitFor(site))
      else await autodeploy.disable(s.client, s.sudo, site)
      return store.saveSite({ ...site, autoDeploy: enable === true })
    }
  },
  'sites:autoStatus': {
    perm: 'view',
    scope: 'site',
    quiet: true,
    run: async (_c, id: string) => {
      const site = store.getSite(id)
      const s = await on(site.projectId)
      return autodeploy.status(s.client, s.sudo, site)
    }
  },
  'sites:autoRun': {
    perm: 'deploy',
    scope: 'site',
    run: async (_c, id: string) => {
      const s = await on(store.getSite(id).projectId)
      await autodeploy.runNow(s.client, s.sudo)
    }
  },
  'sites:remove': {
    perm: 'deploy',
    scope: 'site',
    run: async (_c, id: string, removeConfig: boolean) => {
      const site = store.getSite(id)
      if (site.autoDeploy) await autodeploy.disable(await getClient(site.projectId), sudoFor(site.projectId), site).catch(() => undefined)
      if (removeConfig) await deploy.removeSiteConfig(await getClient(site.projectId), sudoFor(site.projectId), site, () => {})
      store.removeSite(id)
    }
  },
  'sites:preflight': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => deploy.preflight(await getClient(id)) },
  'sites:previewNginx': {
    perm: 'view',
    scope: 'site',
    quiet: true,
    run: async (_c, id: string) => {
      const site = store.getSite(id)
      deploy.validateSite(site)
      const env = await deploy.preflight(await getClient(site.projectId))
      return deploy.buildNginxConf(site, deploy.resolvePhpUpstream(site, env), env)
    }
  },
  'sites:checkBackends': {
    perm: 'view',
    scope: 'site',
    quiet: true,
    run: async (_c, id: string) => {
      const site = store.getSite(id)
      return deploy.checkBackends(await getClient(site.projectId), site)
    }
  },
  'sites:deploy': {
    perm: 'deploy',
    scope: 'site',
    run: async (c, id: string, upload?: UploadSource, target?: DeployTarget) => {
      if (busy.has(id)) throw new Error('A deploy for this site is already running.')
      const site = store.getSite(id)
      if (site.stopped) throw new Error('This site is stopped. Start it first, then deploy.')
      if (target === 'preview') return previewSite(c, site, upload)
      const log = (chunk: string): void => deps.emit('job:log', { jobId: id, chunk })
      busy.add(id)
      deps.emit('job:state', { jobId: id, state: 'running', method: 'sites:deploy', project: projectName(site.projectId), target: `site ${site.name}` })
      let recorded = false
      let deployFailed = false
      try {
        const client = await getClient(site.projectId)
        let git: deploy.GitSignIn | undefined
        if (site.source === 'git' && site.gitAccountId && !upload) {
          git = store.gitSecret(site.gitAccountId)
          if (!git) throw new Error('This site fetches its code with a saved Git account that is not shared with you. Ask its owner to share it, or choose another account in the site settings.')
        }
        const result = await deploy.safeDeploy({ client, sudo: sudoFor(site.projectId), site, upload, git, log })
        store.addDeploy(id, result)
        recorded = true
        store.markDeploy(id, result.status)
        if (result.status !== 'success') {
          tellTelegram(site.projectId, `Deploy of ${site.name} by ${c.user.username}: ${result.note ?? result.status}`)
          throw new Error(result.note ?? 'The deploy did not succeed.')
        }
        return store.getSite(id)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!recorded) {
          store.addDeploy(id, { kind: 'deploy', status: 'failed', note: message })
          store.markDeploy(id, 'failed')
          tellTelegram(site.projectId, `Deploy of ${site.name} by ${c.user.username} failed: ${message}`)
        }
        log(`\n[failed] ${message}\n`)
        deployFailed = true
        throw err
      } finally {
        busy.delete(id)
        deps.emit('job:state', { jobId: id, state: deployFailed ? 'failed' : 'done' })
      }
    }
  },
  'sites:history': { perm: 'view', scope: 'site', quiet: true, run: (_c, id: string) => store.listDeploys(id) },
  // A preview becomes the live site: the live files are saved for rollback first, and a broken result is put back.
  'sites:promote': {
    perm: 'deploy',
    scope: 'site',
    run: (c, id: string) => {
      if (busy.has(id)) throw new Error('A deploy for this site is already running.')
      const site = store.getSite(id)
      if (!site.preview) throw new Error('This site has no preview to push to production.')
      if (site.stopped) throw new Error('This site is stopped. Start it first, then push the preview.')
      return c.job(id, async (log) => {
        const s = await on(site.projectId)
        const live = { ...site, preview: undefined }
        const result = await deploy.safeDeploy({ client: s.client, sudo: s.sudo, site: live, mode: 'promote', log })
        store.addDeploy(id, { ...result, note: result.note ?? `Preview from ${new Date(site.preview!.at).toISOString().slice(0, 16).replace('T', ' ')} UTC pushed to production.` })
        store.markDeploy(id, result.status)
        if (result.status === 'success') {
          await deploy.removePreviewFiles(s.client, s.sudo, site)
          store.saveSite(live)
          log('Preview folder removed; /preview now shows the live site.\n')
          return
        }
        // The live files are back; keep the preview so it can be fixed and pushed again.
        await deploy.runDeploy({ client: s.client, sudo: s.sudo, site, configOnly: true, log: () => {} }).catch(() => undefined)
        tellTelegram(site.projectId, `Preview of ${site.name} pushed by ${c.user.username}: ${result.note ?? result.status}`)
        throw new Error(result.note ?? 'Pushing the preview did not succeed.')
      })
    }
  },
  'sites:discardPreview': {
    perm: 'deploy',
    scope: 'site',
    run: async (_c, id: string) => {
      if (busy.has(id)) throw new Error('A deploy for this site is running.')
      const site = store.getSite(id)
      if (!site.preview) return site
      const s = await on(site.projectId)
      const live = { ...site, preview: undefined }
      await deploy.runDeploy({ client: s.client, sudo: s.sudo, site: live, configOnly: true, log: () => {} })
      await deploy.removePreviewFiles(s.client, s.sudo, site)
      return store.saveSite(live)
    }
  },
  'sites:rollback': {
    perm: 'deploy',
    scope: 'site',
    run: (c, id: string, recordId: string) =>
      c.job(id, async (log) => {
        const site = store.getSite(id)
        const record = store.getDeploy(recordId)
        if (record.siteId !== id) throw new Error('That deploy belongs to another site.')
        const s = await on(site.projectId)
        const result = await deploy.rollbackTo({ client: s.client, sudo: s.sudo, site, record, log })
        store.addDeploy(id, result)
        store.markDeploy(id, result.status)
        if (result.status !== 'success') throw new Error(result.note ?? 'The rollback did not succeed.')
      })
  },
  'sites:install': {
    perm: 'ops',
    scope: 'project',
    run: (c, id: string, group: 'base' | 'php') =>
      c.job(`install:${id}`, async (log) => {
        const s = await on(id)
        await deploy.installPackages(s.client, s.sudo, group, log)
      })
  },
  // Reverse proxy rules and nginx settings of one site. nginx checks the result; a refused config is put back.
  'sites:setNginx': {
    perm: ['deploy', 'ops'],
    scope: 'site',
    run: async (c, id: string, input: { proxyRules?: ProxyRule[]; nginx?: NginxSettings }) => {
      const site = store.getSite(id)
      const rules = (input?.proxyRules ?? []).map((r) => ({ path: String(r.path ?? '').trim().replace(/\/+$/, '') || (String(r.path ?? '').trim() ? '/' : ''), target: String(r.target ?? '').trim(), stripPath: r.stripPath === true, hostHeader: r.hostHeader, websocket: r.websocket === true }))
      const n = input?.nginx ?? {}
      const nginx: NginxSettings = {
        maxBodyMb: n.maxBodyMb === undefined || n.maxBodyMb === null ? undefined : Number(n.maxBodyMb),
        gzip: n.gzip === true,
        staticCacheDays: n.staticCacheDays === undefined || n.staticCacheDays === null ? undefined : Number(n.staticCacheDays),
        redirectWww: n.redirectWww ?? 'none',
        hsts: n.hsts === true,
        headers: (n.headers ?? []).filter((h) => h && (h.name || h.value)).map((h) => ({ name: String(h.name ?? '').trim(), value: String(h.value ?? '').trim() })),
        extra: String(n.extra ?? '').replace(/\r/g, '')
      }
      const next = { ...site, proxyRules: rules, nginx }
      deploy.validateSite(next)
      await c.job(`nginx:${id}`, async (log) => {
        const s = await on(site.projectId)
        await deploy.runDeploy({ client: s.client, sudo: s.sudo, site: next, configOnly: true, log })
        store.saveSite(next)
      })
      return store.getSite(id)
    }
  },
  // Stop or start one site, as in a hosting panel: the others on the server are not touched.
  'sites:setStopped': {
    perm: ['deploy', 'ops'],
    scope: 'site',
    run: async (_c, id: string, stopped: boolean) => {
      const site = store.getSite(id)
      if (stopped === true && site.autoDeploy) throw new Error('Auto deploy is on for this site and would bring it back at the next push. Turn auto deploy off first, then stop the site.')
      const next = { ...site, stopped: stopped === true }
      deploy.validateSite(next)
      const s = await on(site.projectId)
      await deploy.runDeploy({ client: s.client, sudo: s.sudo, site: next, configOnly: true, log: () => {} })
      // The program the app starts for this site (Python, Java, another command) goes down and comes up with it.
      if (site.runner && site.runner.kind) {
        const prog = deploy.runnerProgram(site)
        await deploy.runPrivileged(s.client, `command -v supervisorctl >/dev/null 2>&1 || exit 0\nsupervisorctl ${stopped === true ? 'stop' : 'start'} ${JSON.stringify(prog + ':*')} 2>&1 | tail -3\ntrue`, s.sudo, undefined, 120000)
      }
      return store.saveSite(next)
    }
  },
  'sites:setMaintenance': {
    perm: ['deploy', 'ops'],
    scope: 'site',
    run: async (_c, id: string, enabled: boolean, allowIp: string) => {
      const site = store.getSite(id)
      const next = { ...site, maintenance: enabled, maintenanceAllowIp: String(allowIp ?? '').trim() }
      deploy.validateSite(next)
      const s = await on(site.projectId)
      await deploy.runDeploy({ client: s.client, sudo: s.sudo, site: next, configOnly: true, log: () => {} })
      return store.saveSite(next)
    }
  },
  // The names a site answers to, changed on their own (as in a hosting panel's "Domains" window).
  'sites:setDomains': {
    perm: ['deploy', 'ops'],
    scope: 'site',
    run: (c, id: string, domains: string[]) => {
      const site = store.getSite(id)
      const list = [...new Set((Array.isArray(domains) ? domains : []).map((d) => String(d).trim().toLowerCase()).filter(Boolean))]
      if (list.length === 0) throw new Error('A site needs at least one domain (or the server IP).')
      if (list.length > 100) throw new Error('A site can have up to 100 domains.')
      const next = { ...site, domain: list.join(' ') }
      deploy.validateSite(next)
      const taken = store.listSites(site.projectId).filter((x) => x.id !== id)
      for (const d of list) {
        const other = taken.find((x) => x.domain.split(/\s+/).includes(d))
        if (other && d !== '_') throw new Error(`${d} already belongs to the site "${other.name}" on this server.`)
      }
      return c.job(`domains:${id}`, async (log) => {
        const s = await on(site.projectId)
        log(`==> Domains of ${site.name}: ${list.join(', ')}\n`)
        await deploy.runDeploy({ client: s.client, sudo: s.sudo, site: next, configOnly: true, log })
        store.saveSite(next)
        if (next.ssl) {
          const added = list.filter((d) => !site.domain.split(/\s+/).includes(d))
          if (added.length) {
            const r = await ssl.extend({ client: s.client, sudo: s.sudo, site: next, log })
            if (!r.ok) throw new Error(r.message ?? 'The certificate could not be widened to the new names.')
          }
        }
      })
    }
  },
  'sites:copyTo': {
    perm: ['deploy', 'ops'],
    scope: 'site',
    run: (c, id: string, toId: string, withFiles: boolean) => {
      needAccess(toId)
      return c.job(`sitecopy:${id}`, async (log) => {
        const site = store.getSite(id)
        if (site.projectId === toId) throw new Error('Choose a different server as the destination.')
        let created: string | undefined
        try {
          log(`==> Creating site "${site.name}" on ${store.getProject(toId).name}\n`)
          const { id: _id, createdAt: _c, updatedAt: _u, lastDeployAt: _l, lastDeployStatus: _s, ...rest } = site
          const copy = store.saveSite({ ...rest, projectId: toId, ssl: false, forceHttps: false })
          created = copy.id
          const [src, dst] = await Promise.all([getClient(site.projectId), getClient(toId)])
          if (withFiles && site.appType !== 'balancer') {
            log('\n')
            await copyFolder({ src, srcSudo: sudoFor(site.projectId), dst, dstSudo: sudoFor(toId), srcPath: site.rootPath, dstPath: site.rootPath, log })
          }
          log('\n')
          await deploy.runDeploy({ client: dst, sudo: sudoFor(toId), site: copy, configOnly: true, log })
          store.markDeploy(copy.id, 'success')
        } catch (err) {
          if (created) store.markDeploy(created, 'failed')
          throw err
        }
      })
    }
  },
  'transfer:copy': {
    perm: 'ops',
    scope: 'project',
    run: (c, fromId: string, fromPath: string, toId: string, toPath: string) => {
      needAccess(toId)
      if (fromId === toId) throw new Error('Choose a different server as the destination.')
      return c.job(`copy:${fromId}`, async (log) => {
        const [src, dst] = await Promise.all([getClient(fromId), getClient(toId)])
        await copyFolder({ src, srcSudo: sudoFor(fromId), dst, dstSudo: sudoFor(toId), srcPath: fromPath, dstPath: toPath, log })
      })
    }
  },

  // HTTPS
  'ssl:status': {
    perm: 'view',
    scope: 'site',
    quiet: true,
    run: async (_c, id: string) => {
      const site = store.getSite(id)
      const s = await on(site.projectId)
      return ssl.status(s.client, s.sudo, site)
    }
  },
  // Shown in the HTTPS window after an authenticator code (the service checks it), for moving the certificate elsewhere.
  'ssl:privateKey': {
    perm: 'danger',
    scope: 'site',
    run: async (_c, id: string) => {
      const site = store.getSite(id)
      const s = await on(site.projectId)
      return ssl.privateKey(s.client, s.sudo, site)
    }
  },
  'ssl:renew': {
    perm: ['deploy', 'ops'],
    scope: 'site',
    run: (c, id: string) =>
      c.job(`ssl:${id}`, async (log) => {
        const site = store.getSite(id)
        const s = await on(site.projectId)
        await ssl.renew(s.client, s.sudo, site, log)
      })
  },
  'ssl:expiries': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => { const s = await on(id); return ssl.expiries(s.client, s.sudo) } },
  'ssl:enable': {
    perm: ['deploy', 'ops'],
    scope: 'site',
    run: (c, id: string, email: string, forceHttps: boolean) =>
      c.job(`ssl:${id}`, async (log) => {
        const site = store.getSite(id)
        const s = await on(site.projectId)
        store.saveSite(await ssl.enable({ client: s.client, sudo: s.sudo, site, email, forceHttps, log }))
      })
  },
  'ssl:disable': {
    perm: ['deploy', 'ops'],
    scope: 'site',
    run: (c, id: string) =>
      c.job(`ssl:${id}`, async (log) => {
        const site = store.getSite(id)
        const s = await on(site.projectId)
        store.saveSite(await ssl.disable(s.client, s.sudo, site, log))
      })
  },

  // PM2
  'pm2:overview': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string, user: string) => pm2.overview((await on(id)).client, sudoFor(id), user) },
  'pm2:logs': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string, user: string, procId: number, lines: number) => pm2.logs((await on(id)).client, sudoFor(id), user, procId, lines) },
  'pm2:action': { perm: ['deploy', 'ops'], scope: 'project', run: async (_c, id: string, user: string, procId: number, what: Pm2Action) => pm2.action((await on(id)).client, sudoFor(id), user, procId, what) },
  'pm2:start': {
    perm: ['deploy', 'ops'],
    scope: 'project',
    run: (c, id: string, user: string, input: Pm2StartInput) => c.job(`pm2:${id}`, async (log) => pm2.start((await on(id)).client, sudoFor(id), user, input, log))
  },
  'pm2:startOnBoot': { perm: 'ops', scope: 'project', run: (c, id: string, user: string) => c.job(`pm2:${id}`, async (log) => pm2.startOnBoot((await on(id)).client, sudoFor(id), user, log)) },
  'pm2:install': { perm: 'ops', scope: 'project', run: (c, id: string) => c.job(`pm2:${id}`, async (log) => pm2.install((await on(id)).client, sudoFor(id), log)) },

  // PHP
  'php:overview': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => php.overview((await on(id)).client, sudoFor(id)) },
  'php:getConfig': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string, v: string) => php.getConfig((await on(id)).client, sudoFor(id), v) },
  'php:extensions': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string, v: string) => php.extensions((await on(id)).client, sudoFor(id), v) },
  'php:install': { perm: 'ops', scope: 'project', run: (c, id: string, v: string) => c.job(`php:${id}`, async (log) => php.installVersion((await on(id)).client, sudoFor(id), v, log)) },
  'php:restart': { perm: 'ops', scope: 'project', run: async (_c, id: string, v: string) => php.restart((await on(id)).client, sudoFor(id), v) },
  'php:saveSettings': { perm: 'ops', scope: 'project', run: async (_c, id: string, v: string, values: Record<string, string>) => php.saveSettings((await on(id)).client, sudoFor(id), v, values) },
  'php:optimizePlan': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string, v: string, input: PhpOptimizeInput) => php.optimizePlan((await on(id)).client, sudoFor(id), v, input ?? { mix: 'with-database' }) },
  'php:optimizeApply': { perm: 'ops', scope: 'project', run: async (_c, id: string, v: string, input: PhpOptimizeInput) => php.optimizeApply((await on(id)).client, sudoFor(id), v, input ?? { mix: 'with-database' }) },
  'php:saveRaw': { perm: 'ops', scope: 'project', run: async (_c, id: string, v: string, raw: string) => php.saveRaw((await on(id)).client, sudoFor(id), v, raw) },
  'php:extension': {
    perm: 'ops',
    scope: 'project',
    run: (c, id: string, v: string, name: string, action: PhpExtAction) => c.job(`php:${id}`, async (log) => php.extensionAction((await on(id)).client, sudoFor(id), v, name, action, log))
  },

  // Redis
  'redis:overview': {
    perm: 'view',
    scope: 'project',
    quiet: true,
    run: async (c, id: string) => {
      const o = await redis.overview((await on(id)).client, sudoFor(id))
      // redis.conf contains the Redis password; only people who may change it get to read it.
      return can(c.user.role, 'ops') ? o : { ...o, raw: '' }
    }
  },
  'redis:service': { perm: 'ops', scope: 'project', run: async (_c, id: string, action: 'start' | 'stop' | 'restart') => redis.service((await on(id)).client, sudoFor(id), action) },
  'redis:saveSettings': { perm: 'ops', scope: 'project', run: async (_c, id: string, s: RedisSettings) => redis.saveSettings((await on(id)).client, sudoFor(id), s) },
  'redis:saveRaw': { perm: 'ops', scope: 'project', run: async (_c, id: string, raw: string) => redis.saveRaw((await on(id)).client, sudoFor(id), raw) },
  'redis:flush': { perm: 'danger', scope: 'project', run: async (_c, id: string, db: number | null) => redis.flush((await on(id)).client, sudoFor(id), db) },
  // Files
  'files:list': { perm: FILES, scope: 'project', quiet: true, run: async (c, id: string, dir: string) => files.list(await fileCtx(c.user, id), dir) },
  'files:size': { perm: FILES, scope: 'project', quiet: true, run: async (c, id: string, path: string) => files.size(await fileCtx(c.user, id), path) },
  // Opening a file is logged: it may hold passwords or keys.
  'files:read': { perm: FILES, scope: 'project', run: async (c, id: string, path: string) => files.read(await fileCtx(c.user, id), path) },
  'files:write': { perm: FILES, scope: 'project', run: async (c, id: string, path: string, content: string, version?: string) => files.write(await fileCtx(c.user, id), path, content, version) },
  'files:search': {
    perm: FILES,
    scope: 'project',
    quiet: true,
    run: async (c, id: string, dir: string, query: string, opts?: { caseSensitive?: boolean; include?: string; everything?: boolean }) => files.search(await fileCtx(c.user, id), dir, query, opts ?? {})
  },
  'files:create': { perm: FILES, scope: 'project', run: async (c, id: string, dir: string, name: string, what: 'file' | 'dir') => files.create(await fileCtx(c.user, id), dir, name, what === 'dir' ? 'dir' : 'file') },
  'files:rename': { perm: FILES, scope: 'project', run: async (c, id: string, path: string, name: string) => files.rename(await fileCtx(c.user, id), path, name) },
  'files:copy': { perm: FILES, scope: 'project', run: async (c, id: string, paths: string[], dest: string, overwrite?: boolean) => files.transfer(await fileCtx(c.user, id), 'copy', paths, dest, overwrite === true) },
  'files:move': { perm: FILES, scope: 'project', run: async (c, id: string, paths: string[], dest: string, overwrite?: boolean) => files.transfer(await fileCtx(c.user, id), 'move', paths, dest, overwrite === true) },
  'files:delete': { perm: FILES, scope: 'project', run: async (c, id: string, paths: string[], permanent?: boolean) => files.remove(await fileCtx(c.user, id), paths, permanent === true, c.user.username) },
  'files:trashList': { perm: FILES, scope: 'project', quiet: true, run: async (c, id: string) => files.trashList(await fileCtx(c.user, id)) },
  'files:trashRestore': { perm: FILES, scope: 'project', run: async (c, id: string, ids: string[]) => files.trashRestore(await fileCtx(c.user, id), ids) },
  'files:trashPurge': { perm: FILES, scope: 'project', run: async (c, id: string, ids?: string[]) => files.trashPurge(await fileCtx(c.user, id), ids ?? undefined) },
  'files:chmod': { perm: FILES, scope: 'project', run: async (c, id: string, paths: string[], input: FilePermInput) => files.chmod(await fileCtx(c.user, id), paths, { mode: String(input?.mode ?? ''), owner: input?.owner || undefined, group: input?.group || undefined, recursive: input?.recursive === true }) },
  'files:compress': { perm: FILES, scope: 'project', run: async (c, id: string, paths: string[], name: string, format: 'tar.gz' | 'zip') => files.compress(await fileCtx(c.user, id), paths, name, format === 'zip' ? 'zip' : 'tar.gz') },
  'files:extract': { perm: FILES, scope: 'project', run: async (c, id: string, path: string, dest: string) => files.extract(await fileCtx(c.user, id), path, dest) },
  'files:upload': {
    perm: FILES,
    scope: 'project',
    run: async (c, id: string, dir: string, name: string, up: { path: string; packed: boolean }, overwrite?: boolean) =>
      files.putUpload(await fileCtx(c.user, id), String(up?.path), dir, name, up?.packed === true, overwrite === true)
  },
  'files:download': { perm: FILES, scope: 'project', run: async (c, id: string, path: string, localPath: string) => files.fetch(await fileCtx(c.user, id), path, localPath) },
  // Node.js versions and Composer
  'node:overview': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => runtimes.nodeOverview((await on(id)).client) },
  'node:install': { perm: 'ops', scope: 'project', run: (c, id: string, line: number) => c.job(`node:${id}`, async (log) => runtimes.nodeInstall((await on(id)).client, sudoFor(id), Number(line), log)) },
  'node:use': { perm: 'ops', scope: 'project', run: async (_c, id: string, version: string) => runtimes.nodeUse((await on(id)).client, sudoFor(id), version) },
  'node:remove': { perm: 'ops', scope: 'project', run: async (_c, id: string, version: string) => runtimes.nodeRemove((await on(id)).client, sudoFor(id), version) },
  'composer:overview': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => runtimes.composerOverview((await on(id)).client) },
  'composer:install': { perm: 'ops', scope: 'project', run: (c, id: string) => c.job(`composer:${id}`, async (log) => runtimes.composerInstall((await on(id)).client, sudoFor(id), log)) },
  'composer:remove': { perm: 'ops', scope: 'project', run: async (_c, id: string) => runtimes.composerRemove((await on(id)).client, sudoFor(id)) },

  // Python and Java
  'python:overview': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => langs.pythonOverview((await on(id)).client) },
  'python:install': { perm: 'ops', scope: 'project', run: (c, id: string) => c.job(`python:${id}`, async (log) => langs.pythonInstall((await on(id)).client, sudoFor(id), log)) },
  'docker:overview': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => docker.overview((await on(id)).client, sudoFor(id)) },
  'docker:install': { perm: 'ops', scope: 'project', run: (c, id: string) => c.job(`docker:${id}`, async (log) => docker.install((await on(id)).client, sudoFor(id), log)) },
  'docker:service': { perm: 'ops', scope: 'project', run: (c, id: string, action: 'start' | 'stop' | 'restart') => c.job(`docker:${id}`, async (log) => docker.service((await on(id)).client, sudoFor(id), action, log)) },
  'docker:container': { perm: 'ops', scope: 'project', run: async (_c, id: string, container: string, action: 'start' | 'stop' | 'restart' | 'remove') => docker.containerAction((await on(id)).client, sudoFor(id), container, action) },
  'docker:logs': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string, container: string, count?: number) => docker.logs((await on(id)).client, sudoFor(id), container, count) },
  'docker:run': { perm: 'ops', scope: 'project', run: (c, id: string, input: DockerRunInput) => c.job(`docker:${id}`, async (log) => docker.run((await on(id)).client, sudoFor(id), input, log)) },
  'docker:pull': { perm: 'ops', scope: 'project', run: (c, id: string, image: string) => c.job(`docker:${id}`, async (log) => docker.pull((await on(id)).client, sudoFor(id), image, log)) },
  'docker:removeImage': { perm: 'ops', scope: 'project', run: async (_c, id: string, image: string) => docker.removeImage((await on(id)).client, sudoFor(id), image) },
  'docker:prune': { perm: 'ops', scope: 'project', run: (c, id: string) => c.job(`docker:${id}`, async (log) => docker.prune((await on(id)).client, sudoFor(id), log)) },
  'docker:composeUp': { perm: 'ops', scope: 'project', run: (c, id: string, dir: string) => c.job(`docker:${id}`, async (log) => docker.composeUp((await on(id)).client, sudoFor(id), dir, log)) },
  'docker:composeDown': { perm: 'ops', scope: 'project', run: (c, id: string, dir: string) => c.job(`docker:${id}`, async (log) => docker.composeDown((await on(id)).client, sudoFor(id), dir, log)) },
  'java:overview': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => langs.javaOverview((await on(id)).client) },
  'java:install': { perm: 'ops', scope: 'project', run: (c, id: string, line: number) => c.job(`java:${id}`, async (log) => langs.javaInstall((await on(id)).client, sudoFor(id), Number(line), log)) },
  'java:use': { perm: 'ops', scope: 'project', run: async (_c, id: string, home: string) => langs.javaUse((await on(id)).client, sudoFor(id), home) },
  'java:remove': { perm: 'ops', scope: 'project', run: (c, id: string, line: number) => c.job(`java:${id}`, async (log) => langs.javaRemove((await on(id)).client, sudoFor(id), Number(line), log)) },

  // nginx itself: service, performance settings, nginx.conf, load and error log (App Store → Nginx).
  'nginx:overview': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => ngx.overview(await getClient(id), sudoFor(id)) },
  'nginx:tuning': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => ngx.tuning(await getClient(id), sudoFor(id)) },
  'nginx:saveTuning': { perm: 'ops', scope: 'project', run: (c, id: string, t: NginxTuning) => c.job(`nginx:${id}`, async (log) => ngx.saveTuning(await getClient(id), sudoFor(id), t, log)) },
  'nginx:control': {
    perm: 'ops',
    scope: 'project',
    run: (c, id: string, action: 'reload' | 'start' | 'stop' | 'test') => c.job(`nginx:${id}`, async (log) => ngx.control(await getClient(id), sudoFor(id), action, log))
  },
  'nginx:config': { perm: 'ops', scope: 'project', quiet: true, run: async (_c, id: string) => ngx.readConfig(await getClient(id), sudoFor(id)) },
  'nginx:saveConfig': { perm: 'ops', scope: 'project', run: (c, id: string, text: string) => c.job(`nginx:${id}`, async (log) => ngx.saveConfig(await getClient(id), sudoFor(id), text, log)) },
  'nginx:load': { perm: 'ops', scope: 'project', quiet: true, run: async (_c, id: string) => ngx.load(await getClient(id), sudoFor(id)) },
  'nginx:errorLog': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string, lines: number) => ngx.errorLog(await getClient(id), sudoFor(id), lines) },
  'nginx:clearErrorLog': { perm: 'ops', scope: 'project', run: async (_c, id: string) => ngx.clearErrorLog(await getClient(id), sudoFor(id)) },

  // NFS: share folders between servers
  'nfs:overview': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => nfs.overview((await on(id)).client, sudoFor(id)) },
  'nfs:install': { perm: 'ops', scope: 'project', run: (c, id: string, role: 'server' | 'client') => c.job(`nfs:${id}`, async (log) => nfs.install((await on(id)).client, sudoFor(id), role === 'client' ? 'client' : 'server', log)) },
  'nfs:saveShares': { perm: 'ops', scope: 'project', run: (c, id: string, shares: NfsShare[]) => c.job(`nfs:${id}`, async (log) => nfs.saveShares((await on(id)).client, sudoFor(id), Array.isArray(shares) ? shares : [], log)) },
  'nfs:addMount': {
    perm: 'ops',
    scope: 'project',
    run: (c, id: string, m: { server: string; remote: string; local: string; readOnly: boolean }) => c.job(`nfs:${id}`, async (log) => nfs.addMount((await on(id)).client, sudoFor(id), { server: m?.server, remote: m?.remote, local: m?.local, readOnly: m?.readOnly === true }, log))
  },
  'nfs:removeMount': { perm: 'ops', scope: 'project', run: (c, id: string, local: string) => c.job(`nfs:${id}`, async (log) => nfs.removeMount((await on(id)).client, sudoFor(id), local, log)) },
  'nfs:remount': { perm: 'ops', scope: 'project', run: (c, id: string, local: string) => c.job(`nfs:${id}`, async (log) => nfs.remount((await on(id)).client, sudoFor(id), local, log)) },
  'nfs:join': {
    perm: 'ops',
    scope: 'project',
    run: (c, id: string, path: string, userId: string, local: string, readOnly: boolean, owner: NfsOwner, allowPublic: boolean) => {
      needAccess(userId)
      if (id === userId) throw new Error('Choose a different server to connect.')
      return c.job(`nfs:${id}`, async (log) => {
        const [sc, uc] = await Promise.all([getClient(id), getClient(userId)])
        const sp = store.getProject(id)
        const up = store.getProject(userId)
        await nfs.join({
          share: { client: sc, sudo: sudoFor(id), name: sp.name, host: sp.host },
          user: { client: uc, sudo: sudoFor(userId), name: up.name, host: up.host },
          path,
          local,
          readOnly: readOnly === true,
          owner: owner === 'web' || owner === 'root' ? owner : 'keep',
          allowPublic: allowPublic === true,
          log
        })
      })
    }
  },

  // Supervisor
  'supervisor:overview': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => supervisor.overview((await on(id)).client, sudoFor(id)) },
  'supervisor:install': { perm: 'ops', scope: 'project', run: (c, id: string) => c.job(`supervisor:${id}`, async (log) => supervisor.install((await on(id)).client, sudoFor(id), log)) },
  'supervisor:save': { perm: 'ops', scope: 'project', run: async (_c, id: string, program: SupervisorProgramInput) => supervisor.saveProgram((await on(id)).client, sudoFor(id), program) },
  'supervisor:action': { perm: 'ops', scope: 'project', run: async (_c, id: string, name: string, what: 'start' | 'stop' | 'restart') => supervisor.action((await on(id)).client, sudoFor(id), name, what) },
  'supervisor:remove': { perm: 'ops', scope: 'project', run: async (_c, id: string, name: string) => supervisor.removeProgram((await on(id)).client, sudoFor(id), name) },
  'supervisor:logs': {
    perm: 'view',
    scope: 'project',
    quiet: true,
    run: async (_c, id: string, name: string, stream?: 'stdout' | 'stderr', lines?: number) => supervisor.logs((await on(id)).client, sudoFor(id), name, stream === 'stderr' ? 'stderr' : 'stdout', Number(lines) || 300)
  },

  // PostgreSQL
  'mongo:overview': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => mongo.overview((await on(id)).client, sudoFor(id)) },
  'mongo:install': { perm: 'ops', scope: 'project', run: (c, id: string, line: string) => c.job(`mongo:${id}`, async (log) => mongo.install((await on(id)).client, sudoFor(id), String(line), log)) },
  'mongo:service': { perm: 'ops', scope: 'project', run: async (_c, id: string, what: 'start' | 'stop' | 'restart') => mongo.service((await on(id)).client, sudoFor(id), what) },
  'mongo:create': {
    perm: 'data',
    scope: 'project',
    run: async (c, id: string, name: string, user: string, password: string) => {
      const res = await mongo.createDatabase((await on(id)).client, sudoFor(id), name, user, password)
      // Kept (encrypted, on the service) so it can be shown again after an authenticator code.
      store.saveDbSecret(id, `mongo:${res.name}`, `mongo:${res.user}`, res.password, c.user.username)
      return res
    }
  },
  'mongo:drop': {
    perm: 'danger',
    scope: 'project',
    run: async (_c, id: string, name: string) => {
      await mongo.dropDatabase((await on(id)).client, sudoFor(id), name)
      store.removeDbSecrets(id, `mongo:${name}`)
    }
  },
  'mongo:backup': { perm: 'data', scope: 'project', run: (c, id: string, name: string) => c.job(`mongo:${id}`, async (log) => mongo.backupNow((await on(id)).client, sudoFor(id), name, log)) },
  'mongo:restore': { perm: 'danger', scope: 'project', run: (c, id: string, file: string) => c.job(`mongo:${id}`, async (log) => mongo.restore((await on(id)).client, sudoFor(id), file, log)) },
  'mongo:deleteBackup': { perm: 'danger', scope: 'project', run: async (_c, id: string, file: string) => mongo.deleteBackup((await on(id)).client, sudoFor(id), file) },
  'pg:overview': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => postgres.overview((await on(id)).client, sudoFor(id)) },
  'pg:install': { perm: 'ops', scope: 'project', run: (c, id: string, version?: string) => c.job(`pg:${id}`, async (log) => postgres.install((await on(id)).client, sudoFor(id), log, versions.checkChoice('postgres', version ?? 'system'))) },
  // Uninstall from the App Store. The program goes; its data and settings stay on the server.
  'apps:uninstall': { perm: 'danger', scope: 'project', run: (c, id: string, app: UninstallApp) => c.job(`power:${id}`, async (log) => uninstaller.uninstall((await on(id)).client, sudoFor(id), app, log)) },
  'versions:list': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string, app: VersionApp) => versions.available((await on(id)).client, app) },
  'pg:service': { perm: 'ops', scope: 'project', run: async (_c, id: string, what: 'start' | 'stop' | 'restart') => postgres.service((await on(id)).client, sudoFor(id), what) },
  'pg:create': {
    perm: 'data',
    scope: 'project',
    run: async (c, id: string, name: string, user: string, password: string) => {
      const res = await postgres.createDatabase((await on(id)).client, sudoFor(id), name, user, password)
      // Kept (encrypted, on the service) so it can be shown again after an authenticator code.
      // The pg: prefix keeps it apart from a MySQL user of the same name.
      store.saveDbSecret(id, `pg:${res.name}`, `pg:${res.user}`, res.password, c.user.username)
      return res
    }
  },
  'pg:drop': {
    perm: 'danger',
    scope: 'project',
    run: async (_c, id: string, name: string, dropUser: string) => {
      await postgres.dropDatabase((await on(id)).client, sudoFor(id), name, dropUser)
      store.removeDbSecrets(id, `pg:${name}`)
    }
  },
  'pg:backup': { perm: 'data', scope: 'project', run: (c, id: string, name: string) => c.job(`pg:${id}`, async (log) => postgres.backupNow((await on(id)).client, sudoFor(id), name, log)) },
  'pg:restore': { perm: 'danger', scope: 'project', run: (c, id: string, file: string) => c.job(`pg:${id}`, async (log) => postgres.restore((await on(id)).client, sudoFor(id), file, log)) },
  'pg:deleteBackup': { perm: 'danger', scope: 'project', run: async (_c, id: string, file: string) => postgres.deleteBackup((await on(id)).client, sudoFor(id), file) },
  'redis:install': { perm: 'ops', scope: 'project', run: (c, id: string, version?: string) => c.job(`redis:${id}`, async (log) => redis.install((await on(id)).client, sudoFor(id), log, versions.checkChoice('redis', version ?? 'system'))) },

  // Cron
  'cron:list': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => cron.list((await on(id)).client, sudoFor(id)) },
  'cron:log': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string, taskId: string) => cron.readLog((await on(id)).client, sudoFor(id), taskId) },
  'cron:save': { perm: ['deploy', 'ops'], scope: 'project', run: async (_c, id: string, task: CronTask) => cron.save((await on(id)).client, sudoFor(id), task) },
  'cron:remove': { perm: ['deploy', 'ops'], scope: 'project', run: async (_c, id: string, taskId: string) => cron.remove((await on(id)).client, sudoFor(id), taskId) },
  'cron:run': { perm: ['deploy', 'ops'], scope: 'project', run: (c, id: string, taskId: string) => c.job(`cron:${id}`, async (log) => cron.runNow((await on(id)).client, sudoFor(id), taskId, log)) },

  // Firewall
  'firewall:status': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => { const s = await on(id); return firewall.status(s.client, s.sudo, s.port) } },
  'firewall:nginxGet': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => firewall.getNginx((await on(id)).client) },
  'firewall:addRule': { perm: 'ops', scope: 'project', run: async (_c, id: string, kind: FirewallStatus['kind'], rule: FirewallRuleInput) => { const s = await on(id); await firewall.addRule(s.client, s.sudo, kind, rule, s.port) } },
  'firewall:deleteRule': { perm: 'ops', scope: 'project', run: async (_c, id: string, ruleId: string) => firewall.deleteRule((await on(id)).client, sudoFor(id), ruleId) },
  'firewall:setEnabled': { perm: 'ops', scope: 'project', run: async (_c, id: string, kind: FirewallStatus['kind'], enabled: boolean) => { const s = await on(id); await firewall.setEnabled(s.client, s.sudo, kind, enabled, s.port) } },
  'firewall:install': { perm: 'ops', scope: 'project', run: (c, id: string) => c.job(`fw:${id}`, async (log) => firewall.install((await on(id)).client, sudoFor(id), log)) },
  'firewall:nginxSet': { perm: 'ops', scope: 'project', run: async (_c, id: string, cfg: NginxFirewall) => firewall.setNginx((await on(id)).client, sudoFor(id), cfg) },
  'firewall:blockIp': { perm: 'ops', scope: 'project', run: async (_c, id: string, ip: string) => { const s = await on(id); return firewall.blockIp(s.client, s.sudo, ip, s.port) } },

  // Logs and alerts
  'logs:sources': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => logs.sources((await on(id)).client, sudoFor(id)) },
  'logs:read': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string, source: string, lines: number, filter: string, tidy?: boolean) => logs.read((await on(id)).client, sudoFor(id), source, lines, filter, tidy === true) },
  // One site's own logs, like the Logs button of a hosting panel's site list.
  'sites:log': {
    perm: 'view',
    scope: 'site',
    quiet: true,
    run: async (_c, id: string, kind: logs.SiteLogKind, lines: number, filter: string) => {
      const site = store.getSite(id)
      return logs.siteLog(await getClient(site.projectId), sudoFor(site.projectId), site.name, kind === 'error' ? 'error' : 'access', Number(lines), String(filter ?? ''))
    }
  },
  'sites:logStats': {
    perm: 'view',
    scope: 'site',
    quiet: true,
    run: async (_c, id: string) => {
      const site = store.getSite(id)
      return logs.siteLogStats(await getClient(site.projectId), sudoFor(site.projectId), site.name)
    }
  },
  'sites:logClear': {
    perm: 'ops',
    scope: 'site',
    run: async (_c, id: string, kind: logs.SiteLogKind) => {
      const site = store.getSite(id)
      await logs.siteLogClear(await getClient(site.projectId), sudoFor(site.projectId), site.name, kind === 'error' ? 'error' : 'access')
    }
  },
  'sites:logDownload': {
    perm: 'view',
    scope: 'site',
    run: async (_c, id: string, kind: logs.SiteLogKind, localPath: string) => {
      const site = store.getSite(id)
      await database.downloadPath(await getClient(site.projectId), sudoFor(site.projectId), logs.siteLogPath(site.name, kind === 'error' ? 'error' : 'access'), localPath)
    }
  },
  'logs:threats': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => logs.threats((await on(id)).client, sudoFor(id)) },
  'alerts:get': {
    perm: 'view',
    scope: 'project',
    quiet: true,
    run: async (c, id: string) => {
      const cfg = await logs.getAlerts((await on(id)).client, sudoFor(id))
      // Whether the team's Telegram exists is only known to people who may operate servers; others just see the settings.
      const info = can(c.user.role, 'ops') && deps.relay ? await deps.relay(id).catch(() => null) : null
      return { ...cfg, teamReady: info?.ready === true }
    }
  },
  'alerts:save': {
    perm: 'ops',
    scope: 'project',
    run: async (_c, id: string, cfg: AlertConfig) => {
      if (cfg.via !== 'team') return logs.saveAlerts((await on(id)).client, sudoFor(id), cfg)
      if (!deps.relay) throw new Error('This app is not connected to a service.')
      const info = await deps.relay(id)
      if (!info.ready) throw new Error('Telegram is not set up for the team yet. An admin sets it once under Team, Protection.')
      if (/^https?:\/\/(localhost|127\.|\[::1\])/i.test(info.url)) throw new Error('The team service runs on this computer only (localhost), so a server cannot send alerts to it. Use the server\'s own bot, or run the service on an address the server can reach.')
      return logs.saveAlerts((await on(id)).client, sudoFor(id), cfg, undefined, { url: info.url, id, key: info.key })
    }
  },
  'alerts:test': { perm: 'ops', scope: 'project', run: async (_c, id: string) => logs.testAlert((await on(id)).client, sudoFor(id)) },

  // Databases
  'db:overview': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => database.overview((await on(id)).client, sudoFor(id)) },
  'db:create': {
    perm: 'data',
    scope: 'project',
    run: async (c, id: string, name: string, user: string, password: string, access?: DbAccess) => {
      if (access && access.mode !== 'local' && !can(c.user.role, 'ops')) throw new Error('Letting other computers connect to a database needs an Admin or IT Support person.')
      const res = await database.createDatabase((await on(id)).client, sudoFor(id), name, user, password, access)
      // Kept (encrypted, on the service) so it can be shown again after an authenticator code.
      store.saveDbSecret(id, res.name, res.user, res.password, c.user.username)
      return res
    }
  },
  'db:drop': {
    perm: 'danger',
    scope: 'project',
    run: async (_c, id: string, name: string, dropUser: string) => {
      await database.dropDatabase((await on(id)).client, sudoFor(id), name, dropUser)
      store.removeDbSecrets(id, name)
    }
  },
  'db:setAccess': { perm: 'ops', scope: 'project', run: (c, id: string, name: string, user: string, access: DbAccess) => c.job(`db:${id}`, async (log) => database.setAccess((await on(id)).client, sudoFor(id), name, user, access, log)) },
  'db:secrets': { perm: 'view', scope: 'project', quiet: true, run: (_c, id: string) => store.listDbSecrets(id) },
  'db:backup': { perm: 'data', scope: 'project', run: (c, id: string, name: string) => c.job(`db:${id}`, async (log) => database.backupNow((await on(id)).client, sudoFor(id), name, log)) },
  'db:restore': { perm: 'danger', scope: 'project', run: (c, id: string, file: string, intoDb: string) => c.job(`db:${id}`, async (log) => database.restore((await on(id)).client, sudoFor(id), file, intoDb, log)) },
  'db:download': { perm: 'data', scope: 'project', run: async (_c, id: string, file: string, localPath: string) => { const s = await on(id); await database.download(s.client, s.sudo, file, localPath) } },
  'db:deleteBackup': { perm: 'danger', scope: 'project', run: async (_c, id: string, file: string) => database.deleteBackup((await on(id)).client, sudoFor(id), file) },
  'db:setSchedule': { perm: 'ops', scope: 'project', run: async (_c, id: string, s: DbSchedule) => database.setSchedule((await on(id)).client, sudoFor(id), s) },
  // Database client. Reading is not logged line by line; anything typed into the query box and every change is.
  // Saved database connections (this computer talks to the database, directly or through an SSH tunnel)
  'dbconn:list': { perm: 'data', quiet: true, run: () => store.listDbConns().map((c) => ({ ...c, open: dbconn.isOpen(c.id) })) },
  'dbconn:save': {
    perm: 'data',
    run: (c, input: DbConnectionInput) => {
      mayEditConn(c.user, input.id)
      if (input.useSsh && input.sshProjectId) needAccess(input.sshProjectId)
      const saved = store.saveDbConn({ ...input, ownerId: input.id ? undefined : c.user.id })
      dbconn.close(saved.id)
      return saved
    }
  },
  'dbconn:test': {
    perm: 'data',
    quiet: true,
    run: (c, input: DbConnectionInput) => {
      if (input.useSsh && input.sshProjectId) needAccess(input.sshProjectId)
      return dbconn.test(store.draftDbConn({ ...input, name: input.name?.trim() || 'test', ownerId: c.user.id }), { borrow: getClient })
    }
  },
  'dbconn:remove': {
    perm: 'data',
    run: async (c, id: string) => {
      mayEditConn(c.user, id)
      // A server that makes this connection's scheduled backups holds its password: take it away there too.
      const sched = store.listDbConns().find((x) => x.id === id)?.backupProjectId
      if (sched) {
        try {
          await dbremote.remove(await getClient(sched), sudoFor(sched), id)
        } catch (err) {
          throw new Error(`This connection has scheduled backups on the server "${projectName(sched)}", which could not be reached to switch them off (${(err as Error).message}). Connect to that server and try again.`)
        }
      }
      dbconn.close(id)
      store.removeDbConn(id)
    }
  },
  'dbconn:close': { perm: 'data', quiet: true, run: (_c, id: string) => dbconn.close(id) },

  // Scheduled backups of a saved connection, made by one of the managed servers and uploaded by its Google Drive job.
  'dbr:status': { perm: 'data', scope: 'project', quiet: true, run: async (_c, id: string) => dbremote.status(await getClient(id), sudoFor(id)) },
  'dbr:setup': {
    // The server gets the database password, so this takes the right to change servers as well as the right to use data.
    perm: 'ops',
    scope: 'project',
    run: (c, id: string, connId: string, databases: string[], when?: DbRemoteWhen) => {
      if (!can(c.user.role, 'data')) throw new RpcError('Your role cannot use database connections.', 'forbidden')
      const conn = store.dbConnSecret(String(connId))
      if (conn.useSsh && !conn.sshProjectId) throw new Error('This connection goes through an SSH server that was typed in by hand. Add that server as a project, set the connection to use it, and schedule the backups there.')
      if (conn.useSsh && conn.sshProjectId !== id) throw new Error(`This connection goes through the server "${projectName(conn.sshProjectId as string)}". Scheduled backups have to run on that server, because only it can reach the database.`)
      if (!conn.useSsh && /^(localhost|127\.|::1$|0\.0\.0\.0$)/i.test(conn.host)) throw new Error('This connection points at this computer (localhost), which a server cannot reach.')
      if (!conn.secrets.password) throw new Error('This connection has no saved password, so a server cannot sign in with it.')
      const list = Array.isArray(databases) ? databases.map(String) : []
      return c.job(`dbr:${conn.id}`, async (log) => {
        // Moving to another server: the old one forgets the password first.
        if (conn.backupProjectId && conn.backupProjectId !== id) {
          try {
            await dbremote.remove(await getClient(conn.backupProjectId), sudoFor(conn.backupProjectId), conn.id)
            log(`Removed the schedule from ${projectName(conn.backupProjectId)}\n`)
          } catch (err) {
            log(`Could not remove the old schedule from ${projectName(conn.backupProjectId)}: ${(err as Error).message}\n`)
          }
        }
        await dbremote.setup(await getClient(id), sudoFor(id), { id: conn.id, name: conn.name, host: conn.host, port: conn.port, username: conn.username, password: conn.secrets.password as string }, list, when, log)
        store.setDbConnBackup(conn.id, id)
      })
    }
  },
  'dbr:remove': {
    perm: 'ops',
    scope: 'project',
    run: async (_c, id: string, connId: string) => {
      await dbremote.remove(await getClient(id), sudoFor(id), String(connId))
      const conn = store.listDbConns().find((x) => x.id === connId)
      if (conn && conn.backupProjectId === id) store.setDbConnBackup(conn.id, undefined)
    }
  },
  'dbr:run': { perm: 'ops', scope: 'project', run: (c, id: string, connId: string) => c.job(`dbr:${String(connId)}`, async (log) => dbremote.runNow(await getClient(id), sudoFor(id), String(connId), log)) },
  'dbr:pullTo': { perm: 'data', scope: 'project', quiet: true, run: async (_c, id: string, file: string, localPath: string) => dbremote.pull(await getClient(id), sudoFor(id), file, localPath) },

  // Database client. `target` is "server:<project id>" (the server's own database, as root) or "conn:<connection id>".
  'dbc:databases': { perm: 'data', quiet: true, run: async (_c, target: string) => dbclient.databases(await execFor(target)) },
  'dbc:tables': { perm: 'data', quiet: true, run: async (_c, target: string, database: string) => dbclient.tables(await execFor(target), database) },
  'dbc:tableInfo': { perm: 'data', quiet: true, run: async (_c, target: string, database: string, table: string) => dbclient.tableInfo(await execFor(target), database, table) },
  'dbc:browse': { perm: 'data', quiet: true, run: async (_c, target: string, database: string, table: string, o: DbBrowseOptions) => dbclient.browse(await execFor(target), database, table, o ?? { page: 1, pageSize: 100 }) },
  'dbc:query': { perm: 'data', run: async (_c, target: string, database: string | null, sql: string) => (await execFor(target))(database || null, sql) },
  'dbc:update': { perm: 'data', run: async (_c, target: string, database: string, table: string, key: Record<string, string | null>, changes: Record<string, string | null>) => dbclient.updateRow(await execFor(target), database, table, key, changes) },
  'dbc:insert': { perm: 'data', run: async (_c, target: string, database: string, table: string, values: Record<string, string | null>) => dbclient.insertRow(await execFor(target), database, table, values) },
  'dbc:createDatabase': { perm: 'data', run: async (_c, target: string, name: string, charset?: string) => dbclient.createDatabase(await execFor(target), name, charset || 'utf8mb4') },
  'dbc:dropDatabase': { perm: 'data', run: async (_c, target: string, name: string) => dbclient.dropDatabase(await execFor(target), name) },
  'dbc:dropTable': { perm: 'data', run: async (_c, target: string, database: string, table: string, view: boolean) => dbclient.dropTable(await execFor(target), database, table, view === true) },
  'dbc:truncateTable': { perm: 'data', run: async (_c, target: string, database: string, table: string) => dbclient.truncateTable(await execFor(target), database, table) },
  'dbc:renameTable': { perm: 'data', run: async (_c, target: string, database: string, table: string, to: string) => dbclient.renameTable(await execFor(target), database, table, to) },
  'dbc:duplicateTable': { perm: 'data', run: async (_c, target: string, database: string, table: string, to: string, withData: boolean) => dbclient.duplicateTable(await execFor(target), database, table, to, withData === true) },
  'dbc:designSql': { perm: 'data', quiet: true, run: async (_c, target: string, database: string, original: string | null, design: DbTableDesign) => dbclient.designSql(await execFor(target), database, original || null, design) },
  'dbc:designApply': { perm: 'data', run: async (_c, target: string, database: string, original: string | null, design: DbTableDesign) => dbclient.designApply(await execFor(target), database, original || null, design) },
  'dbc:dump': { perm: 'data', run: async (_c, target: string, database: string, table: string | null, withData: boolean) => dbclient.dump(await execFor(target), database, table || null, withData !== false) },
  // A full backup of one database into a gzip file on this computer. The path is chosen by the app's main process.
  'dbc:backupTo': {
    perm: 'data',
    run: (c, target: string, database: string, path: string) =>
      c.job(`dbbackup:${String(target)}`, async (log) => {
        const exec = await execFor(target)
        log(`==> Backing up ${database}\n`)
        const part = `${path}.part`
        const gz = createGzip({ level: 6 })
        const file = createWriteStream(part, { mode: 0o600 })
        const done = new Promise<void>((resolve, reject) => {
          file.on('finish', () => resolve())
          file.on('error', reject)
          gz.on('error', reject)
        })
        gz.pipe(file)
        try {
          const res = await dbclient.backup(
            exec,
            database,
            // Wait when the file cannot keep up, so memory stays small.
            (sql) => (gz.write(sql) ? undefined : new Promise<void>((r) => gz.once('drain', () => r()))),
            log
          )
          gz.end()
          await done
          renameSync(part, path)
          log(`\n==> Saved ${res.tables} table${res.tables === 1 ? '' : 's'} and ${res.rows} row${res.rows === 1 ? '' : 's'} (${(statSync(path).size / 1024 / 1024).toFixed(2)} MB)\n${path}\n`)
        } catch (err) {
          gz.destroy()
          file.destroy()
          if (existsSync(part)) unlinkSync(part)
          throw err
        }
      })
  },
  'dbc:importText': {
    perm: 'data',
    run: async (_c, target: string, database: string, file: string, text: string): Promise<DbImportResult> => {
      if (/^\s*DELIMITER\s/im.test(text)) throw new Error('This file defines procedures or triggers (it uses DELIMITER), which this import cannot run. Run it on the server with the mysql command in the Terminal.')
      const exec = await execFor(target)
      const statements = dbconn.splitStatements(text)
      if (statements.length === 0) throw new Error('The file contains no SQL statements.')
      let done = 0
      let batch: string[] = []
      let size = 0
      const flush = async (): Promise<string | undefined> => {
        if (batch.length === 0) return undefined
        const r = await exec(database || null, batch.join(';\n') + ';')
        if (r.error) return r.error
        done += batch.length
        batch = []
        size = 0
        return undefined
      }
      for (const st of statements) {
        if (size + st.length > 400 * 1024) {
          const error = await flush()
          if (error) return { file, statements: done, error }
        }
        batch.push(st)
        size += st.length + 2
      }
      const error = await flush()
      return { file, statements: done, error }
    }
  },
  'dbc:delete': { perm: 'data', run: async (_c, target: string, database: string, table: string, keys: Record<string, string | null>[]) => dbclient.deleteRows(await execFor(target), database, table, keys) },
  'db:offsiteStatus': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => offsite.status((await on(id)).client, sudoFor(id)) },
  'db:offsiteEnable': {
    perm: 'ops',
    scope: 'project',
    run: (c, id: string, toId: string, keepDays: number, address?: string) =>
      c.job(`offsite:${id}`, async (log) => {
        needAccess(toId)
        if (toId === id) throw new Error('Choose a different server. A copy on the same server does not protect against losing it.')
        const to = store.getProject(toId)
        const src = await on(id)
        const dst = await on(toId)
        await offsite.enable({ client: src.client, sudo: src.sudo }, { client: dst.client, sudo: dst.sudo, host: (address ?? '').trim() || to.host, port: to.port, label: to.name }, Math.floor(keepDays), log)
      })
  },
  'db:offsiteDisable': { perm: 'ops', scope: 'project', run: async (_c, id: string) => offsite.disable((await on(id)).client, sudoFor(id)) },
  'db:offsiteRun': { perm: 'ops', scope: 'project', run: (c, id: string) => c.job(`offsite:${id}`, async (log) => offsite.runNow((await on(id)).client, sudoFor(id), log)) },
  'db:install': { perm: 'ops', scope: 'project', run: (c, id: string, version?: string) => c.job(`db:${id}`, async (log) => database.install((await on(id)).client, sudoFor(id), log, versions.checkChoice('mariadb', version ?? 'system'))) },

  // Folder backups
  'backup:list': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string) => backup.list((await on(id)).client, sudoFor(id)) },
  'backup:history': { perm: 'view', scope: 'project', quiet: true, run: async (_c, id: string, name: string) => backup.history((await on(id)).client, sudoFor(id), name) },
  'backup:save': { perm: 'ops', scope: 'project', run: async (_c, id: string, j: BackupJob) => backup.save((await on(id)).client, sudoFor(id), j) },
  'backup:remove': { perm: 'ops', scope: 'project', run: async (_c, id: string, name: string) => backup.remove((await on(id)).client, sudoFor(id), name) },
  'backup:run': { perm: ['ops', 'data'], scope: 'project', run: (c, id: string, name: string) => c.job(`backup:${id}`, async (log) => backup.run((await on(id)).client, sudoFor(id), name, log)) },
  'backup:restore': { perm: 'danger', scope: 'project', run: (c, id: string, name: string, hash: string) => c.job(`backup:${id}`, async (log) => backup.restore((await on(id)).client, sudoFor(id), name, hash, log)) },
  'backup:serverKey': { perm: ['ops', 'deploy'], scope: 'project', run: async (_c, id: string) => backup.serverKey((await on(id)).client, sudoFor(id)) },

}

/** Names of the operations and the permission each needs, for the app's own UI decisions. */
export function permissionTable(): Record<string, Permission | Permission[]> {
  return Object.fromEntries(Object.entries(M).map(([k, d]) => [k, d.perm]))
}

// ---------------------------------------------------------------- audit helpers
const SECRET_KEY = /pass|token|secret|privatekey|stdin|^raw$/i

function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > 90 ? value.slice(0, 90) + '…' : value
  if (Array.isArray(value)) return depth > 2 ? '[…]' : value.slice(0, 8).map((v) => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    if (depth > 2) return '{…}'
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? (v ? '***' : '') : redact(v, depth + 1)
    return out
  }
  return value
}

/** Arguments whose position alone tells us they are secret or bulky. */
const HIDE_ARGS: Record<string, number[]> = { 'db:create': [3], 'pg:create': [3], 'mongo:create': [3], 'php:saveRaw': [2], 'redis:saveRaw': [1], 'files:write': [2, 3], 'files:upload': [3], 'dbc:update': [4], 'dbc:insert': [3], 'dbconn:save': [0], 'dbconn:test': [0], 'dbc:importText': [3], 'dbc:designApply': [3], 'google:setup': [1], 's3:setup': [1], 'nginx:saveConfig': [1] }

function describe(method: string, def: Def, args: unknown[]): { project?: string; target?: string } {
  let project: string | undefined
  let rest = args
  const parts: string[] = []
  try {
    if (def.scope === 'project' && typeof args[0] === 'string') {
      project = projectName(args[0])
      rest = args.slice(1)
    } else if (def.scope === 'site' && typeof args[0] === 'string') {
      const site = store.getSite(args[0])
      project = projectName(site.projectId)
      parts.push(`site ${site.name}`)
      rest = args.slice(1)
    } else if (method.startsWith('dbc:') && typeof args[0] === 'string') {
      const t = args[0]
      if (t.startsWith('server:')) project = projectName(t.slice(7))
      else parts.push(`connection ${store.listDbConns().find((c) => 'conn:' + c.id === t)?.name ?? 'removed'}`)
      rest = args.slice(1)
    } else if (method === 'dbconn:save') {
      const input = args[0] as DbConnectionInput
      return { target: `${input.name} · ${input.username}@${input.host}:${input.port}${input.useSsh ? ' · through SSH' : ''} · ${input.shared ? 'team' : 'private'}`.slice(0, 220) }
    } else if (method === 'dbconn:remove') {
      return { target: store.listDbConns().find((c) => c.id === args[0])?.name }
    } else if (method === 'sites:save') {
      const input = args[0] as SiteInput
      project = projectName(input.projectId)
      // The whole site form would be noise; say which site and what kind.
      return { project, target: `site ${input.name} · ${input.appType} · ${input.domain}`.slice(0, 220) }
    } else if (method === 'projects:save') {
      const input = args[0] as ProjectInput
      return { target: `${input.name} · ${input.username}@${input.host}:${input.port} · ${input.authType} · ${input.share ? (input.share.mode === 'members' ? `shared with ${input.share.members.length}` : input.share.mode) : 'sharing unchanged'}`.slice(0, 220) }
    }
    if (method === 'apps:uninstall') return { project, target: uninstaller.uninstallName(args[1] as UninstallApp) }
    if (method === 'docker:run') {
      // Variable values can be secrets; the log says which image and name only.
      const i = args[1] as DockerRunInput
      return { project, target: `${i?.image} as ${i?.name}`.slice(0, 220) }
    }
    if (method === 'sites:deploy') return { project, target: `${parts[0]}${args[1] ? ' · uploaded files' : ''}` }
  } catch {
    /* the target may already be gone; the raw arguments still say what was asked */
  }
  const hidden = HIDE_ARGS[method] ?? []
  const offset = args.length - rest.length
  const shown = rest.map((a, i) => (hidden.includes(i + offset) ? '***' : redact(a))).filter((a) => a !== undefined && a !== '')
  if (shown.length > 0) parts.push(JSON.stringify(shown).slice(1, -1).slice(0, 220))
  return { project, target: parts.join(' · ') || undefined }
}
// ---------------------------------------------------------------- dispatcher
export function has(method: string): boolean {
  return method in M
}

const NEEDS_APPROVAL = new Set<string>(APPROVAL_ACTIONS)

export async function dispatch(method: string, args: unknown[]): Promise<unknown> {
  const user = deps.user()
  if (!user) throw new RpcError('Your session has ended. Sign in again.', 'unauthorized')
  const def = M[method]
  if (!def) throw new RpcError(`Unknown operation "${method}".`)

  const started = Date.now()
  const info = describe(method, def, args)
  const write = (ok: boolean, error?: string): void => {
    if (def.quiet && ok) return
    deps.report({ action: method, ...info, ok, error, ms: Date.now() - started })
  }

  if (!can(user.role, def.perm)) {
    write(false, 'not allowed for this role')
    throw new RpcError(`Your role does not allow this. Ask an admin if you need it.`, 'forbidden')
  }
  try {
    if (def.scope === 'project') needAccess(String(args[0]))
    if (def.scope === 'site') needAccess(store.getSite(String(args[0])).projectId)
  } catch (err) {
    write(false, err instanceof Error ? err.message : String(err))
    throw err
  }

  // Heavy actions wait here for a second admin when the team switched that on.
  if (NEEDS_APPROVAL.has(method) && deps.approve) {
    try {
      await deps.approve({ action: method, project: info.project, target: info.target })
    } catch (err) {
      write(false, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  const call: Call = {
    user,
    job: async (jobId, fn) => {
      if (busy.has(jobId)) throw new Error('This task is already running. Open it from Tasks at the top of the window.')
      const log = (chunk: string): void => deps.emit('job:log', { jobId, chunk })
      busy.add(jobId)
      // The window keeps a list of tasks from these, so a log that was closed can be opened again.
      deps.emit('job:state', { jobId, state: 'running', method, project: info.project, target: info.target })
      try {
        await fn(log)
        deps.emit('job:state', { jobId, state: 'done' })
      } catch (err) {
        log(`\n[failed] ${err instanceof Error ? err.message : String(err)}\n`)
        deps.emit('job:state', { jobId, state: 'failed' })
        throw err
      } finally {
        busy.delete(jobId)
      }
    }
  }
  try {
    const result = await def.run(call, ...args)
    write(true)
    return result
  } catch (err) {
    write(false, err instanceof Error ? err.message : String(err))
    throw err
  }
}

/** After the shared list changed: drop connections to servers this person may no longer use. */
export function forgetMissing(): void {
  for (const id of [...clients.keys()]) if (!store.hasProject(id)) disconnect(id)
}

/** Close every SSH connection and terminal (sign-out, lost session, app quitting). */
export function shutdown(): void {
  for (const id of [...terminals.keys()]) closeTerminal(id, 'signed out')
  for (const c of clients.values()) c.end()
  dbconn.closeAll()
  pendingGoogle.clear()
  googleGrants.clear()
  clients.clear()
  busy.clear()
}
