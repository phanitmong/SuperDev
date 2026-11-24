// Apsara Panel service. Holds the server credentials, runs every operation in an
// engine process per signed-in person, and is the only thing that ever logs in to
// your servers. The desktop apps never receive a server password or key.
//
//   node server.js                         start the service
//   node server.js create-admin <name>     create an admin account (prints a temporary password)
//   node server.js reset-password <name>   new temporary password for an account
//   node server.js reset-2fa <name>        make an account set up its authenticator again
//   node server.js verify-audit            check the audit log has not been altered
//   node server.js security-reset          locked out? allow every address again and switch approval off
//
// Settings (environment variables):
//   SUPERDEVOPS_DATA   data folder (default ./data)
//   PORT, HOST         where to listen (default 8787 on 127.0.0.1)
//   TLS_CERT, TLS_KEY  certificate files to serve HTTPS directly (otherwise put nginx in front)
//   TRUST_PROXY=1      take the client address from X-Forwarded-For (only behind your own proxy).
//                      The number is how many of your own proxies are in front: 1 for nginx alone, 2 for a CDN and nginx.
//   SUPERDEVOPS_PUBLIC_URL  the address managed servers send their alerts to (default: the one each app signed in to)
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttps } from 'node:https'
import { join, resolve } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { can } from '@shared/team'
import { configureStore } from '../main/store'
import * as storeApi from '../main/store'
import * as auth from './auth'
import * as audit from './audit'
import * as guard from './guard'
import * as updates from './updates'
import * as rpc from './rpc'
import * as engines from './engines'
import { runWorker } from './worker'

const DATA = resolve(process.env.SUPERDEVOPS_DATA || './data')
const PORT = Number(process.env.PORT) || 8787
const HOST = process.env.HOST || '127.0.0.1'
const TRUST_PROXY = /^[1-5]$/.test(process.env.TRUST_PROXY ?? '') ? Number(process.env.TRUST_PROXY) : 0

// ---------------------------------------------------------------- encryption of stored secrets
function masterKey(): Buffer {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true, mode: 0o700 })
  if (process.env.SUPERDEVOPS_KEY) {
    const k = Buffer.from(process.env.SUPERDEVOPS_KEY, 'hex')
    if (k.length !== 32) throw new Error('SUPERDEVOPS_KEY must be 64 hex characters.')
    return k
  }
  const file = join(DATA, 'master.key')
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 })
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex')
}

function setup(): void {
  const key = masterKey()
  const encrypt = (value: string): string => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return 'aes:' + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
  }
  const decrypt = (value: string): string | undefined => {
    if (!value.startsWith('aes:')) return undefined
    const raw = Buffer.from(value.slice(4), 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  }
  configureStore({ dir: DATA, encrypt, decrypt })
  auth.configureAuth({ dir: DATA, encrypt, decrypt })
  audit.configureAudit(DATA)
  guard.configureGuard({ dir: DATA, encrypt, decrypt })
  updates.configureUpdates(DATA)
  // Read the session lengths before any saved session is looked at.
  try {
    guard.view('')
  } catch {
    /* reported when an admin opens Protection */
  }
  rpc.configureRpc(DATA)
  engines.configureEngines(DATA)
}

// ---------------------------------------------------------------- command line
function cli(cmd: string, args: string[]): boolean {
  const find = (name: string): string => {
    const u = auth.listUsers().find((x) => x.username === (name ?? '').toLowerCase())
    if (!u) {
      console.error(`No account named "${name}".`)
      process.exit(1)
    }
    return u.id
  }
  const who = `console (${process.env.SUDO_USER || process.env.USER || 'unknown'})`
  if (cmd === 'create-admin') {
    if (!args[0]) {
      console.error('Usage: create-admin <username> [display name]')
      process.exit(1)
    }
    const { user, password } = auth.createUser({ username: args[0], displayName: args.slice(1).join(' ') || args[0], role: 'admin', disabled: false, projects: null })
    audit.record({ user: who, role: 'console', ip: 'local', action: 'users:create', target: `${user.username} (admin)`, ok: true })
    console.log(`Admin "${user.username}" created.\nTemporary password: ${password}\nAt first sign-in they set up Google Authenticator and choose their own password.`)
    return true
  }
  if (cmd === 'reset-password') {
    const r = auth.resetPassword(find(args[0]))
    audit.record({ user: who, role: 'console', ip: 'local', action: 'users:resetPassword', target: r.username, ok: true })
    console.log(`Temporary password for "${r.username}": ${r.password}`)
    return true
  }
  if (cmd === 'reset-2fa') {
    const name = auth.resetTwoFactor(find(args[0]))
    audit.record({ user: who, role: 'console', ip: 'local', action: 'users:resetTwoFactor', target: name, ok: true })
    console.log(`"${name}" will set up their authenticator again at next sign-in.`)
    return true
  }
  if (cmd === 'security-reset') {
    guard.reset()
    audit.record({ user: who, role: 'console', ip: 'local', action: 'guard:reset', target: 'allowed addresses: anyone · second-admin approval off', ok: true })
    console.log('Every address may sign in again and second-admin approval is off. Restart the service, then set them again under Team → Protection.')
    return true
  }
  if (cmd === 'app-release') {
    if (!args[0] || !args[1]) {
      console.error('Usage: app-release <folder with ApsaraPanel-*.zip/.exe> <version, e.g. 1.1.0> [what is new]')
      process.exit(1)
    }
    const r = updates.publish(args[0], args[1], args.slice(2).join(' '))
    audit.record({ user: who, role: 'console', ip: 'local', action: 'app:release', target: `${r.version}: ${Object.keys(r.files).join(', ')}`, ok: true })
    console.log(`App ${r.version} published for ${Object.keys(r.files).join(', ')}. Signed-in apps offer the update within a few minutes.`)
    return true
  }
  if (cmd === 'verify-audit') {
    const v = audit.verify()
    console.log(v.ok ? `Audit log intact (${v.entries} entries).` : `Audit log has been altered: the chain breaks at entry ${v.brokenAt} of ${v.entries}.`)
    process.exit(v.ok ? 0 : 2)
  }
  return false
}

// ---------------------------------------------------------------- HTTP: health check only
function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    // Each proxy appends the address it saw, so only the last entries are ours. The first ones are whatever
    // the caller typed, and trusting them would let anyone pretend to come from an allowed address.
    const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    const fwd = hops[hops.length - TRUST_PROXY]
    if (fwd) return fwd.replace(/^::ffff:/, '')
  }
  return (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function http(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/healthz') return json(res, 200, { ok: true, service: 'superdevops' })
  // New versions of the desktop app, for signed-in apps only.
  if (updates.handle(req, res, url.pathname, (t) => !!auth.useSession(t) && guard.addressAllowed(clientIp(req)))) return

  // Alerts from managed servers, forwarded with the team's Telegram bot.
  if (url.pathname === '/relay/alert' && req.method === 'POST') {
    const id = String(req.headers['x-server-id'] ?? '')
    const key = String(req.headers['x-relay-key'] ?? '')
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of req) {
      size += (c as Buffer).length
      if (size > 16384) return json(res, 413, { error: 'too long' })
      chunks.push(c as Buffer)
    }
    let name = ''
    try {
      name = storeApi.getProject(id).name
    } catch {
      return json(res, 401, { error: 'wrong key' })
    }
    try {
      await guard.relayAlert(id, key, name, Buffer.concat(chunks).toString('utf8'))
      return json(res, 200, { ok: true })
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500
      return json(res, status, { error: err instanceof Error ? err.message : 'failed' })
    }
  }

  json(res, 404, { error: 'Not found.' })
}

// ---------------------------------------------------------------- WebSocket: everything else
function serve(): void {
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    http(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : 'Server error.' })
    })
  }
  const tls = process.env.TLS_CERT && process.env.TLS_KEY
  const server = tls
    ? createHttps({ cert: readFileSync(process.env.TLS_CERT!), key: readFileSync(process.env.TLS_KEY!) }, handler)
    : createHttp(handler)
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 * 1024 })

  wss.on('connection', (ws: WebSocket, req) => {
    let alive = true
    const conn: rpc.Conn = {
      id: randomUUID(),
      ip: clientIp(req),
      recordings: new Map(),
      send: (event, payload) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event, payload }))
      },
      close: () => ws.close(4001, 'session ended')
    }
    rpc.addConn(conn)
    ws.on('pong', () => (alive = true))
    const beat = setInterval(() => {
      if (!alive) return ws.terminate()
      alive = false
      ws.ping()
    }, 30000)

    ws.on('message', (raw) => {
      let msg: { id?: number; method?: string; args?: unknown[]; send?: string }
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      const args = Array.isArray(msg.args) ? msg.args : []
      // One-way messages: terminal keystrokes and resizes.
      if (typeof msg.send === 'string') return rpc.note(conn, msg.send, args)
      if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return
      const id = msg.id
      rpc
        .dispatch(conn, msg.method, args)
        .then((data) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id, ok: true, data }))
        })
        .catch((err) => {
          const code = err instanceof rpc.RpcError || err instanceof engines.EngineError ? err.code : 'error'
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id, ok: false, code, error: err instanceof Error ? err.message : String(err) }))
        })
    })
    ws.on('close', () => {
      clearInterval(beat)
      rpc.removeConn(conn)
    })
    ws.on('error', () => ws.terminate())
  })

  // Development convenience, asked for with --dev-no-2fa or SUPERDEVOPS_DEV_NO_2FA=1.
  // Refused unless the service is reachable from this computer only, so it cannot weaken a shared service by mistake.
  const wantNo2fa = process.argv.includes('--dev-no-2fa') || process.env.SUPERDEVOPS_DEV_NO_2FA === '1'
  const localOnly = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1'
  rpc.setDevNo2fa(wantNo2fa && localOnly)
  auth.setNoLock(wantNo2fa && localOnly)

  // Old terminal recordings leave the disk: shortly after start, then twice a day.
  const sweep = (): void => {
    try {
      const gone = guard.sweepRecordings()
      if (gone > 0) audit.record({ user: 'service', role: 'service', ip: 'local', action: 'audit:prune', target: `${gone} terminal recording(s) older than the kept days removed`, ok: true })
    } catch (err) {
      console.error('Could not remove old terminal recordings:', err instanceof Error ? err.message : err)
    }
  }
  setTimeout(sweep, 60000).unref()
  setInterval(sweep, 12 * 3600000).unref()

  server.listen(PORT, HOST, () => {
    console.log(`Apsara Panel service listening on ${tls ? 'https' : 'http'}://${HOST}:${PORT}  (data: ${DATA})`)
    if (wantNo2fa && localOnly) console.log('DEVELOPMENT MODE: sign-in asks for the password only, no authenticator code, and wrong passwords never lock an account. Never run a shared service like this.')
    if (wantNo2fa && !localOnly) console.log(`--dev-no-2fa was IGNORED because the service listens on ${HOST}. It only works on 127.0.0.1. Authenticator codes are required.`)
    if (!tls && HOST !== '127.0.0.1' && HOST !== 'localhost') {
      console.log('WARNING: serving plain HTTP on a public address. Put nginx with HTTPS in front, or set TLS_CERT and TLS_KEY.')
    }
    if (!auth.hasUsers()) console.log('No accounts yet. Create the first admin with:  node server.js create-admin <username>')
  })
  const stop = (): void => {
    auth.flushSessions()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

// The same file runs as one person's engine when the service starts it for them (engines.ts).
if (process.env.APSARA_ENGINE_WORKER === '1') runWorker()
else {
  setup()
  const [cmd, ...rest] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  if (!cmd) serve()
  else if (!cli(cmd, rest)) {
    console.error(`Unknown command "${cmd}". Commands: create-admin, reset-password, reset-2fa, security-reset, verify-audit`)
    process.exit(1)
  }
}
