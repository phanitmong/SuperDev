// What the service does for the desktop apps: sign-in, accounts, the shared
// list of servers and sites, the audit log, and every operation on a managed
// server. Those run in an engine process per signed-in person (worker.ts), which
// is the only thing that holds server credentials and opens SSH connections.
// The apps never receive a password or key.
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type { AuditQuery, GuardInput, LoginStep, Permission, SessionUser, TeamUserInput } from '@shared/team'
import { can } from '@shared/team'
import * as store from '../main/store'
import type { StoreChange } from '../main/store'
import * as auth from './auth'
import * as audit from './audit'
import * as guard from './guard'
import * as engines from './engines'
import { has as isEngineMethod } from '../main/engine'

let devNo2fa = false

/** Development only: skip the authenticator code at sign-in. main.ts allows it only on a service that listens on this computer alone. */
export function setDevNo2fa(on: boolean): void {
  devNo2fa = on
}

export interface Conn {
  id: string
  ip: string
  send(event: string, payload: unknown): void
  close(): void
  token?: string
  /** Password accepted, waiting for the authenticator code. */
  pendingUserId?: string
  /** Code accepted, but a new password must be set before the session starts. */
  passwordUserId?: string
  /** Terminal recordings this app is sending. */
  recordings: Map<string, { out: WriteStream; written: number }>
  /** Requests for approval this app is waiting on. */
  asking?: Set<string>
  /** What a protection change did, for the audit line of the call that is running. */
  guardNote?: string
  /** The service address this app signed in to, which managed servers use to send alerts. */
  publicUrl?: string
  /** A fresh authenticator code was given: one sensitive action (a restore, an uninstall) may run until then. */
  confirmedUntil?: number
}

export class RpcError extends Error {
  constructor(
    message: string,
    public code: 'unauthorized' | 'forbidden' | 'error' = 'error'
  ) {
    super(message)
  }
}

type Actor = SessionUser & { projects: string[] | null }

interface Def {
  perm: Permission | Permission[]
  quiet?: boolean
  run: (user: Actor, conn: Conn, ...args: any[]) => unknown
}

let dataDir = ''
const conns = new Set<Conn>()

export function configureRpc(dir: string): void {
  dataDir = dir
  for (const sub of ['tmp', 'terminal']) {
    const d = join(dir, sub)
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 })
  }
  auth.onSessionsEnded((userId) => {
    for (const c of conns) {
      const s = c.token ? auth.useSession(c.token) : null
      if (c.token && (!s || s.userId === userId)) c.close()
    }
  })
}

export function addConn(c: Conn): void {
  conns.add(c)
}

export function removeConn(c: Conn): void {
  conns.delete(c)
  engines.stopEngine(c.id)
  engines.dropAll(c.id)
  endRecordings(c)
  if (c.asking?.size) guard.cancelAllOf([...c.asking])
}

/** Tell every signed-in admin that the list of requests waiting for approval changed. */
function tellAdmins(): void {
  const list = guard.pendingList()
  for (const c of conns) {
    const u = actorOf(c)
    if (u?.role === 'admin') c.send('approval:pending', list.filter((r) => r.user !== u.username))
  }
}

function allowed(user: Actor, projectId: string): boolean {
  return store.canUse(projectId, user.id, user.role === 'admin')
}

function actorOf(conn: Conn): Actor | null {
  const s = auth.useSession(conn.token)
  if (!s) return null
  try {
    const u = auth.getUser(s.userId)
    return u.disabled ? null : u
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- terminal recordings sent by the apps
const RECORDING_LIMIT = 6 * 1024 * 1024

function endRecordings(conn: Conn): void {
  for (const r of conn.recordings.values()) r.out.end()
  conn.recordings.clear()
}

/** One-way messages from an app: keystrokes and window sizes for its terminals, which live in its engine. */
export function note(conn: Conn, name: string, args: unknown[]): void {
  if ((name !== 'terminal:write' && name !== 'terminal:resize') || !actorOf(conn)) return
  if (conn.token && !guard.addressAllowed(conn.ip)) return
  engines.input(conn.id, name === 'terminal:write' ? 'write' : 'resize', String(args[0] ?? ''), args[1], args[2])
}

/** Terminal output from this session's engine, kept as the recording admins can read in the audit log. */
function record(conn: Conn, id: unknown, text: unknown): void {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) || typeof text !== 'string') return
  let r = conn.recordings.get(id)
  if (!r) {
    const file = join(dataDir, 'terminal', `${id}.log`)
    // A recording belongs to the app that started it; nobody can add to a finished one.
    if (existsSync(file) || conn.recordings.size >= 40) return
    r = { out: createWriteStream(file, { mode: 0o600 }), written: 0 }
    conn.recordings.set(id, r)
  }
  if (r.written > RECORDING_LIMIT) return
  r.written += text.length
  r.out.write(text)
}

// ---------------------------------------------------------------- shared servers and sites
function mayChange(user: Actor, change: StoreChange): void {
  const deny = (): never => {
    throw new RpcError('Your role does not allow this. Ask an admin if you need it.', 'forbidden')
  }
  const access = (projectId: string | undefined): void => {
    if (!projectId || !allowed(user, projectId)) throw new RpcError('You do not have access to that server.', 'forbidden')
  }
  switch (change?.t) {
    case 'project': {
      if (!can(user.role, 'projects')) deny()
      const id = String(change.record?.id)
      if (store.hasProject(id)) {
        if (!store.canManage(id, user.id, user.role === 'admin')) throw new RpcError('Only the person who added this server, or an admin it is shared with, can change it.', 'forbidden')
      } else {
        // A new server always belongs to the person adding it.
        change.record.ownerId = user.id
      }
      if (change.record?.share?.mode === 'members') {
        const known = new Set(auth.listUsers().map((u) => u.id))
        change.record.share.members = (change.record.share.members ?? []).filter((m) => known.has(m) && m !== user.id)
      }
      return
    }
    case 'project-del':
      if (!can(user.role, 'projects')) deny()
      if (!store.canManage(change.id, user.id, user.role === 'admin')) throw new RpcError('Only the person who added this server, or an admin it is shared with, can remove it.', 'forbidden')
      return
    case 'fingerprint': {
      access(change.id)
      // Anyone may record the key seen on the first connection; replacing or forgetting one is for admins.
      const known = store.getProject(change.id).hostFingerprint
      if (known && known !== change.fingerprint && !can(user.role, 'projects')) deny()
      return
    }
    case 'site': {
      if (!can(user.role, ['deploy', 'ops'])) deny()
      access(change.record?.projectId)
      const current = store.projectOfSite(String(change.record?.id))
      if (current) access(current)
      return
    }
    case 'site-del':
      if (!can(user.role, 'deploy')) deny()
      access(store.projectOfSite(change.id))
      return
    case 'deploy':
      if (!can(user.role, 'deploy')) deny()
      access(store.projectOfSite(String(change.record?.siteId)))
      return
    case 'git': {
      if (!can(user.role, 'deploy')) deny()
      const known = store.gitOwner(String(change.record?.id))
      if (known.exists) {
        if (known.ownerId !== user.id && user.role !== 'admin') throw new RpcError('Only the person who added this Git account, or an admin, can change it.', 'forbidden')
      } else change.record.ownerId = user.id
      return
    }
    case 'git-del': {
      const known = store.gitOwner(change.id)
      if (known.exists && known.ownerId !== user.id && user.role !== 'admin') throw new RpcError('Only the person who added this Git account, or an admin, can remove it.', 'forbidden')
      return
    }
    case 'dbsecret':
      if (!can(user.role, 'data')) deny()
      access(change.record?.projectId)
      change.record.createdBy = user.username
      return
    case 'dbsecret-del':
      if (!can(user.role, 'data')) deny()
      access(change.projectId)
      return
    case 'settings':
      if (user.role !== 'admin') throw new RpcError('Only an admin can change the team settings.', 'forbidden')
      return
    case 'dbconn': {
      if (!can(user.role, 'data')) deny()
      const known = store.dbConnOwner(String(change.record?.id))
      if (known.exists) {
        if (known.ownerId !== user.id && user.role !== 'admin') throw new RpcError('Only the person who added this connection, or an admin, can change it.', 'forbidden')
      } else change.record.ownerId = user.id
      return
    }
    case 'dbconn-del': {
      const known = store.dbConnOwner(change.id)
      if (known.exists && known.ownerId !== user.id && user.role !== 'admin') throw new RpcError('Only the person who added this connection, or an admin, can remove it.', 'forbidden')
      return
    }
    case 'group': {
      if (!can(user.role, 'projects')) deny()
      const known = store.groupInfo(String(change.record?.id))
      if (known.exists) {
        if (known.ownerId !== user.id && user.role !== 'admin') throw new RpcError('Only the person who made this project, or an admin, can change it.', 'forbidden')
      } else change.record.ownerId = user.id
      const members = Array.isArray(change.record?.members) ? change.record.members : []
      // Servers the person cannot see stay in the project as they were; new ones must be servers they can use.
      const hidden = known.members.filter((m) => !allowed(user, m.projectId))
      const had = new Set(known.members.map((m) => `${m.projectId}:${m.role}`))
      for (const m of members) if (!had.has(`${m?.projectId}:${m?.role}`)) access(m?.projectId)
      change.record.members = [...members.filter((m) => allowed(user, String(m?.projectId))), ...hidden]
      // Folder rules of servers the person cannot see stay too; new rules must name a server they can use.
      const rules = Array.isArray(change.record?.nfs) ? change.record.nfs : []
      const hadRules = new Set(known.nfs.map((n) => n.id))
      for (const n of rules) if (!hadRules.has(n?.id)) access(n?.serverId)
      change.record.nfs = [...rules.filter((n) => allowed(user, String(n?.serverId))), ...known.nfs.filter((n) => !allowed(user, n.serverId))]
      return
    }
    case 'group-del': {
      if (!can(user.role, 'projects')) deny()
      const known = store.groupInfo(change.id)
      if (known.exists && known.ownerId !== user.id && user.role !== 'admin') throw new RpcError('Only the person who made this project, or an admin, can remove it.', 'forbidden')
      return
    }
    default:
      throw new RpcError('The change sent by the app is not valid.')
  }
}

function tellOthers(from: Conn): void {
  for (const c of conns) {
    if (c === from || !actorOf(c)) continue
    // The engine loads the list again and then tells its window.
    if (engines.running(c.id)) engines.resync(c.id)
    else c.send('store:changed', {})
  }
}

/** Roles or server access changed: every engine loads what its person may use again. */
function resyncAll(): void {
  for (const c of conns) if (engines.running(c.id)) engines.resync(c.id)
}

function clip(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v ? v.slice(0, max) : undefined
}

// ---------------------------------------------------------------- the operations
const M: Record<string, Def> = {
  // Names only, so anyone can pick who to share a server with.
  'users:directory': { perm: 'view', quiet: true, run: () => auth.listUsers().filter((u) => !u.disabled).map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role })) },
  // A stored database password is given out only after a fresh authenticator code, and every look is logged.
  'stepup:need': { perm: 'view', quiet: true, run: (u) => auth.proofKind(u.id) },
  // The app asks for a fresh code before something sensitive (restoring a backup). `what` says what for, for the log.
  // It opens one minute for one such action, checked here before the engine is asked to do it.
  'stepup:confirm': {
    perm: 'view',
    run: (u, conn, proof: string) => {
      auth.checkProof(u.id, String(proof ?? ''))
      conn.confirmedUntil = Date.now() + 60 * 1000
    }
  },
  'dbsecret:reveal': {
    perm: 'data',
    run: (u, _conn, id: string, proof: string) => {
      const projectId = store.dbSecretProject(String(id))
      if (!projectId || !allowed(u, projectId)) throw new RpcError('You do not have access to that server.', 'forbidden')
      auth.checkProof(u.id, String(proof ?? ''))
      const secret = store.revealDbSecret(String(id))
      if (!secret) throw new RpcError('No password is stored for that database user.')
      return { database: secret.database, user: secret.user, password: secret.password }
    }
  },
  // The app itself only reports locking and unlocking; everything done on a server is reported by its engine.
  'audit:report': {
    perm: 'view',
    quiet: true,
    run: (u, conn, e: { action?: unknown; ok?: unknown; error?: unknown }) => {
      const action = clip(e?.action, 60) ?? ''
      if (action !== 'app:lock' && action !== 'app:unlock') throw new RpcError('That entry cannot be recorded.')
      audit.record({ user: u.username, role: u.role, ip: conn.ip, action, ok: e.ok === true, error: clip(e.error, 300) })
    }
  },
  'client:hello': {
    perm: 'view',
    quiet: true,
    run: (_u, conn, url: string) => {
      try {
        const u = new URL(String(url ?? ''))
        if (u.protocol === 'http:' || u.protocol === 'https:') conn.publicUrl = u.origin
      } catch {
        /* keep the one from the settings */
      }
    }
  },
  // Files between the app and the service (see engines.ts).
  'xfer:new': { perm: 'view', quiet: true, run: (_u, conn, dir: 'up' | 'down', name?: string) => engines.xferNew(conn.id, dir, name) },
  'xfer:put': { perm: 'view', quiet: true, run: (_u, conn, id: string, offset: number, data: string) => engines.xferPut(conn.id, String(id), Number(offset), String(data ?? '')) },
  'xfer:end': { perm: 'view', quiet: true, run: (_u, conn, id: string, size: number) => engines.xferEnd(conn.id, String(id), Number(size)) },
  'xfer:get': { perm: 'view', quiet: true, run: (_u, conn, id: string, offset: number) => engines.xferGet(conn.id, String(id), Number(offset)) },
  'xfer:drop': { perm: 'view', quiet: true, run: (_u, conn, id: string) => engines.xferDrop(conn.id, String(id)) },

  // Protection of the service: allowed addresses, Telegram alerts, approval by a second admin.
  'guard:get': { perm: 'admin', quiet: true, run: (_u, conn) => guard.view(conn.ip) },
  'guard:save': {
    perm: 'admin',
    run: (u, conn, input: GuardInput, proof: string) => {
      auth.checkProof(u.id, String(proof ?? ''))
      const what = guard.save(input, conn.ip, auth.listUsers().filter((x) => x.role === 'admin' && !x.disabled).length)
      conn.guardNote = what
      guard.sweepRecordings()
      guard.accountEvent(`🛡 Protection settings changed by ${u.username} from ${conn.ip}\n${what}`)
      // An address that is no longer allowed loses its session now, not at the next sign-in.
      for (const c of conns) if (c.token && !guard.addressAllowed(c.ip)) c.close()
      for (const c of conns) c.send('guard:changed', { approvals: guard.approvalsOn() })
      return guard.view(conn.ip)
    }
  },
  'guard:test': { perm: 'admin', run: (u) => guard.testTelegram(u.username) },
  // Any signed-in person: does this action wait for a second admin?
  'approval:on': { perm: 'view', quiet: true, run: () => guard.approvalsOn() },
  'approval:cancel': { perm: 'view', quiet: true, run: (u, _c, id: string) => guard.cancel(String(id), u.id) },
  'approval:list': { perm: 'admin', quiet: true, run: (u) => guard.pendingList().filter((r) => r.user !== u.username) },
  'approval:decide': {
    perm: 'admin',
    run: (u, conn, id: string, approve: boolean) => {
      const r = guard.decide(String(id), u.id, u.username, approve === true)
      conn.guardNote = `${approve === true ? 'approved' : 'refused'} · ${r.user}: ${r.action}${r.project ? ` on ${r.project}` : ''}${r.target ? ` · ${r.target}` : ''}`.slice(0, 260)
    }
  },

  // Accounts and audit (admins)
  'users:list': { perm: 'admin', quiet: true, run: () => auth.listUsers() },
  'users:create': { perm: 'admin', run: (_u, _c, input: TeamUserInput) => auth.createUser(input) },
  'users:update': { perm: 'admin', run: (u, _c, input: TeamUserInput) => auth.updateUser(input, u.id) },
  'users:remove': { perm: 'admin', run: (u, _c, id: string) => auth.removeUser(id, u.id) },
  'users:resetPassword': { perm: 'admin', run: (_u, _c, id: string) => auth.resetPassword(id) },
  'users:resetTwoFactor': { perm: 'admin', run: (_u, _c, id: string) => auth.resetTwoFactor(id) },
  'users:unlock': { perm: 'admin', run: (_u, _c, id: string) => auth.unlock(id) },
  'audit:query': { perm: 'admin', quiet: true, run: (_u, _c, q: AuditQuery) => audit.query(q) },
  'audit:verify': { perm: 'admin', run: () => audit.verify() },
  'audit:transcript': {
    perm: 'admin',
    run: (_u, _c, sessionId: string) => {
      if (!/^[0-9a-f-]{36}$/.test(sessionId)) throw new Error('Unknown terminal session.')
      const file = join(dataDir, 'terminal', `${sessionId}.log`)
      if (!existsSync(file)) throw new Error('No recording exists for that session.')
      const size = statSync(file).size
      const text = readFileSync(file, 'utf8')
      // Strip terminal colour and cursor codes so the recording reads as plain text.
      const plain = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-_]/g, '').replace(/\r(?!\n)/g, '')
      return { size, text: plain.slice(-300000) }
    }
  }
}

// ---------------------------------------------------------------- asked by a person's engine, never by an app
const INTERNAL: Record<string, Def> = {
  // Everything this person may use, credentials opened. Only ever leaves the service for its own engine process.
  'store:snapshot': { perm: 'view', quiet: true, run: (u) => store.snapshot(u.id, u.role === 'admin') },
  'store:apply': {
    perm: 'view',
    quiet: true,
    run: (u, conn, change: StoreChange) => {
      mayChange(u, change)
      store.apply(change)
      tellOthers(conn)
    }
  },
  // What the engine did on a server. Sign-in and account entries can only be written by the service itself.
  'audit:report': {
    perm: 'view',
    quiet: true,
    run: (u, conn, e: { action?: unknown; project?: unknown; target?: unknown; ok?: unknown; error?: unknown; ms?: unknown }) => {
      const action = clip(e?.action, 60) ?? ''
      if (!/^[a-z0-9]+:[A-Za-z0-9]+$/.test(action) || /^(auth|users|audit|store|guard|approval):/.test(action)) throw new RpcError('That entry cannot be recorded.')
      audit.record({
        user: u.username,
        role: u.role,
        ip: conn.ip,
        action,
        project: clip(e.project, 80),
        target: clip(e.target, 260),
        ok: e.ok === true,
        error: clip(e.error, 300),
        ms: typeof e.ms === 'number' && Number.isFinite(e.ms) ? Math.max(0, Math.round(e.ms)) : undefined
      })
      const target = clip(e.target, 260)
      if (guard.isDanger(action, target)) guard.dangerDone({ user: u.username, action, project: clip(e.project, 80), target, ok: e.ok === true, error: clip(e.error, 300), ip: conn.ip })
    }
  },
  // The key a managed server uses to send its alerts through the service. Only for people who may operate that server.
  'relay:info': {
    perm: 'ops',
    quiet: true,
    run: (u, _c, projectId: string) => {
      if (!allowed(u, String(projectId))) throw new RpcError('You do not have access to that server.', 'forbidden')
      return { key: guard.relayKey(String(projectId)), ready: guard.telegramReady() }
    }
  },
  'approval:ask': {
    perm: 'view',
    quiet: true,
    run: async (u, conn, e: { action?: unknown; project?: unknown; target?: unknown }) => {
      const action = clip(e?.action, 60) ?? ''
      const target = clip(e?.target, 260)
      const project = clip(e?.project, 80)
      if (!guard.needsApproval(action, target)) return { needed: false }
      const others = auth.listUsers().filter((x) => x.role === 'admin' && !x.disabled && x.id !== u.id)
      if (others.length === 0) throw new RpcError('This action needs approval from another admin, and there is no other admin account. Add one, or switch approval off in Team → Protection.')
      const { id, done } = guard.ask({ userId: u.id, user: u.username, ip: conn.ip, action, project, target }, tellAdmins)
      ;(conn.asking ??= new Set()).add(id)
      audit.record({ user: u.username, role: u.role, ip: conn.ip, action: 'approval:ask', project, target: `${action}${target ? ` · ${target}` : ''}`.slice(0, 260), ok: true })
      conn.send('approval:waiting', { id, action, project, target })
      try {
        const by = await done
        return { needed: true, by }
      } finally {
        conn.asking?.delete(id)
        conn.send('approval:waiting', null)
      }
    }
  },
}

/** What an engine process gets to ask for, always as the person whose session it belongs to. */
function hostOf(conn: Conn): engines.Host {
  return {
    internal: async (method, args) => {
      const user = actorOf(conn)
      if (!user || (conn.token && !guard.addressAllowed(conn.ip))) {
        engines.stopEngine(conn.id)
        throw new RpcError('Your session has ended. Sign in again.', 'unauthorized')
      }
      const def = INTERNAL[method]
      if (!def) throw new RpcError(`Unknown operation "${method}".`)
      return runDef(conn, user, method, def, args)
    },
    emit: (event, payload) => conn.send(event, payload),
    record: (id, text) => record(conn, id, text),
    url: () => process.env.SUPERDEVOPS_PUBLIC_URL || conn.publicUrl || ''
  }
}

/** Restoring and uninstalling replace or remove live things: they run only right after a fresh authenticator code. */
const AFTER_CODE = new Set(['backup:restore', 'apps:uninstall', 'mongo:restore', 'pg:restore', 'db:restore', 'ssl:privateKey'])

async function engineCall(conn: Conn, user: Actor, method: string, args: unknown[]): Promise<unknown> {
  if (AFTER_CODE.has(method)) {
    if (!conn.confirmedUntil || Date.now() > conn.confirmedUntil) throw new RpcError('Confirm with your authenticator code first.', 'forbidden')
    conn.confirmedUntil = 0
  }
  const files = engines.prepareFiles(conn.id, method, args)
  let ok = false
  try {
    const result = await engines.call(conn.id, user, hostOf(conn), method, files.args)
    ok = true
    return result
  } finally {
    files.after(ok)
  }
}

function describe(method: string, args: unknown[]): { target?: string } {
  if (method === 'users:create' || method === 'users:update') {
    const input = args[0] as TeamUserInput
    const servers = input?.projects === null ? 'all servers' : `${input?.projects?.length ?? 0} server(s)`
    return { target: `${input?.username} · ${input?.role}${input?.disabled ? ' · disabled' : ''} · ${servers}` }
  }
  if (method === 'store:apply') {
    const c = args[0] as StoreChange
    return { target: `${c?.t ?? '?'} ${'id' in (c ?? {}) ? (c as { id: string }).id : ((c as { record?: { name?: string; id?: string } })?.record?.name ?? '')}`.slice(0, 200) }
  }
  // The proof (a code or a password) never goes into the log.
  if (method === 'stepup:confirm') return { target: String(args[1] ?? '').slice(0, 200) || undefined }
  if (method === 'guard:save' || method === 'approval:decide' || method === 'guard:test') return {}
  if (method === 'dbsecret:reveal') return { target: `database user ${String(args[0] ?? '').split(':').slice(1).join(':') || '?'}` }
  const shown = args.filter((a) => typeof a === 'string').map((a) => String(a).slice(0, 80))
  return { target: shown.join(' · ') || undefined }
}

// ---------------------------------------------------------------- sign-in (before a session exists)
const attempts = new Map<string, number[]>()

function throttle(ip: string): void {
  const now = Date.now()
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < 10 * 60000)
  if (recent.length >= 30) throw new RpcError('Too many sign-in attempts from this address. Wait a few minutes.')
  recent.push(now)
  attempts.set(ip, recent)
}

function finish(conn: Conn, userId: string): LoginStep {
  const { token, user } = auth.startSession(userId, conn.ip)
  conn.token = token
  conn.pendingUserId = undefined
  conn.passwordUserId = undefined
  audit.record({ user: user.username, role: user.role, ip: conn.ip, action: 'auth:login', ok: true })
  guard.signedIn(user.id, user.username, user.role, conn.ip)
  if (user.role === 'admin') setTimeout(tellAdmins, 500)
  return { next: 'done', user, token }
}

const NOT_ALLOWED = (ip: string): string => `Signing in is not allowed from your address (${ip}). Ask an admin to add it under Team → Protection.`

async function authCall(conn: Conn, method: string, args: any[]): Promise<unknown> {
  const failLog = (user: string, action: string, error: string): void => {
    audit.record({ user, role: '', ip: conn.ip, action, ok: false, error })
    if (/is locked for/.test(error)) guard.accountLocked(user, conn.ip)
  }
  // Before the password is even looked at: an address outside the list cannot guess passwords either.
  if ((method === 'auth:login' || method === 'auth:totp' || method === 'auth:setPassword') && !guard.addressAllowed(conn.ip)) {
    throttle(conn.ip)
    const name = String(method === 'auth:login' ? (args[0] ?? '') : '').trim().toLowerCase().slice(0, 40)
    audit.record({ user: name || '(unknown)', role: '', ip: conn.ip, action: 'auth:login', ok: false, error: 'address not allowed' })
    guard.refusedAddress(conn.ip, name)
    conn.pendingUserId = undefined
    conn.passwordUserId = undefined
    throw new RpcError(NOT_ALLOWED(conn.ip), 'forbidden')
  }
  switch (method) {
    case 'auth:login': {
      throttle(conn.ip)
      const username = String(args[0] ?? '').trim().toLowerCase()
      try {
        const { userId, step } = auth.loginPassword(username, String(args[1] ?? ''))
        if (devNo2fa) {
          // Development only: the password alone signs in. See setDevNo2fa.
          if (auth.mustChangePassword(userId)) {
            conn.passwordUserId = userId
            return { next: 'password', reason: 'Choose your own password before you continue.' } satisfies LoginStep
          }
          return finish(conn, userId)
        }
        conn.pendingUserId = userId
        return step
      } catch (err) {
        failLog(username.slice(0, 40) || '(empty)', 'auth:login', err instanceof Error ? err.message : String(err))
        throw err
      }
    }
    case 'auth:totp': {
      throttle(conn.ip)
      if (!conn.pendingUserId) throw new RpcError('Sign in with your username and password first.', 'unauthorized')
      const name = (() => {
        try {
          return auth.getUser(conn.pendingUserId).username
        } catch {
          return '(unknown)'
        }
      })()
      try {
        const { mustChangePassword } = auth.loginTotp(conn.pendingUserId, String(args[0] ?? ''))
        if (mustChangePassword) {
          conn.passwordUserId = conn.pendingUserId
          conn.pendingUserId = undefined
          return { next: 'password', reason: 'Choose your own password before you continue.' } satisfies LoginStep
        }
        return finish(conn, conn.pendingUserId)
      } catch (err) {
        failLog(name, 'auth:totp', err instanceof Error ? err.message : String(err))
        throw err
      }
    }
    case 'auth:setPassword': {
      if (!conn.passwordUserId) throw new RpcError('Sign in first.', 'unauthorized')
      auth.setPassword(conn.passwordUserId, String(args[0] ?? ''))
      return finish(conn, conn.passwordUserId)
    }
    case 'auth:me': {
      const u = actorOf(conn)
      return u ? { id: u.id, username: u.username, displayName: u.displayName, role: u.role } : null
    }
    case 'auth:logout': {
      const u = actorOf(conn)
      if (conn.token) auth.endSession(conn.token)
      conn.token = undefined
      conn.confirmedUntil = 0
      engines.stopEngine(conn.id)
      engines.dropAll(conn.id)
      endRecordings(conn)
      if (u) audit.record({ user: u.username, role: u.role, ip: conn.ip, action: 'auth:logout', ok: true })
      return null
    }
    case 'auth:changePassword': {
      const u = actorOf(conn)
      if (!u) throw new RpcError('Your session has ended. Sign in again.', 'unauthorized')
      try {
        auth.setPassword(u.id, String(args[1] ?? ''), String(args[0] ?? ''))
        audit.record({ user: u.username, role: u.role, ip: conn.ip, action: 'auth:changePassword', ok: true })
      } catch (err) {
        audit.record({ user: u.username, role: u.role, ip: conn.ip, action: 'auth:changePassword', ok: false, error: err instanceof Error ? err.message : String(err) })
        throw err
      }
      return null
    }
    default:
      throw new RpcError('Unknown sign-in step.')
  }
}

// ---------------------------------------------------------------- dispatcher
export async function dispatch(conn: Conn, method: string, args: unknown[]): Promise<unknown> {
  if (method.startsWith('auth:')) return authCall(conn, method, args as any[])
  if (conn.token && !guard.addressAllowed(conn.ip)) {
    auth.endSession(conn.token)
    conn.token = undefined
    throw new RpcError(NOT_ALLOWED(conn.ip), 'unauthorized')
  }
  const user = actorOf(conn)
  if (!user) {
    // Timed out or ended elsewhere: the engine and its SSH connections go too.
    engines.stopEngine(conn.id)
    throw new RpcError('Your session has ended. Sign in again.', 'unauthorized')
  }
  const def = M[method]
  if (!def) {
    // Everything on a managed server: the engine checks the role and access and writes the audit line itself.
    if (isEngineMethod(method)) return engineCall(conn, user, method, args)
    throw new RpcError(`Unknown operation "${method}".`)
  }
  return runDef(conn, user, method, def, args)
}

async function runDef(conn: Conn, user: Actor, method: string, def: Def, args: unknown[]): Promise<unknown> {
  const started = Date.now()
  const write = (ok: boolean, error?: string): void => {
    if (def.quiet && ok) return
    const note = conn.guardNote
    conn.guardNote = undefined
    audit.record({ user: user.username, role: user.role, ip: conn.ip, action: method, ...describe(method, args), ...(note ? { target: note } : {}), ok, error, ms: Date.now() - started })
    if (ok && method.startsWith('users:')) guard.accountEvent(`👤 ${method} by ${user.username} from ${conn.ip}\n${describe(method, args).target ?? ''}`)
    if (ok && method === 'users:remove') guard.forgetUser(String(args[0]))
    if (ok && method.startsWith('users:')) resyncAll()
  }
  if (!can(user.role, def.perm)) {
    write(false, 'not allowed for this role')
    throw new RpcError(`Your role does not allow this. Ask an admin if you need it.`, 'forbidden')
  }
  try {
    const result = await def.run(user, conn, ...args)
    write(true)
    return result
  } catch (err) {
    write(false, err instanceof Error ? err.message : String(err))
    throw err
  }
}
