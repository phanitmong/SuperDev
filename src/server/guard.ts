// Protection of the service itself: which addresses may sign in, Telegram
// alerts, and approval of heavy actions by a second admin.
// Kept in its own file on the service (security.json). Unlike the team
// settings, none of this is ever sent to the apps as part of the shared list.
import { BlockList, isIP } from 'node:net'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalRequest, GuardInput, GuardView } from '@shared/team'
import { APPROVAL_ACTIONS, APPROVAL_MINUTES } from '@shared/team'

interface GuardFile {
  allowedIps: string[]
  /** Encrypted bot token. */
  telegramToken?: string
  telegramChat?: string
  alertSignIn: boolean
  alertDanger: boolean
  approvals: boolean
  /** Terminal recordings older than this many days are removed. 0 keeps them for ever. */
  recordingDays: number
  /** Addresses each person has signed in from before. */
  seen: Record<string, string[]>
  /** Secret the per-server alert keys are made from. */
  relaySecret?: string
}

let dir = ''
let enc: (v: string) => string = (v) => v
let dec: (v: string) => string | undefined = (v) => v
let data: GuardFile | null = null
let list: BlockList | null = null
let lastTelegramError: string | undefined

export function configureGuard(opts: { dir: string; encrypt: (v: string) => string; decrypt: (v: string) => string | undefined }): void {
  dir = opts.dir
  enc = opts.encrypt
  dec = opts.decrypt
  data = null
  list = null
}

function file(): string {
  return join(dir, 'security.json')
}

function load(): GuardFile {
  if (data) return data
  let raw: Partial<GuardFile> = {}
  if (existsSync(file())) {
    try {
      raw = JSON.parse(readFileSync(file(), 'utf8'))
    } catch {
      // A damaged file must not silently open the service to every address.
      throw new Error('security.json cannot be read. Repair it, or run: node server.js security-reset')
    }
  }
  data = {
    allowedIps: Array.isArray(raw.allowedIps) ? raw.allowedIps.filter((x) => typeof x === 'string') : [],
    telegramToken: typeof raw.telegramToken === 'string' ? raw.telegramToken : undefined,
    telegramChat: typeof raw.telegramChat === 'string' ? raw.telegramChat : undefined,
    alertSignIn: raw.alertSignIn !== false,
    alertDanger: raw.alertDanger !== false,
    approvals: raw.approvals === true,
    recordingDays: typeof raw.recordingDays === 'number' && raw.recordingDays >= 0 && raw.recordingDays <= 3650 ? Math.floor(raw.recordingDays) : 90,
    seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {},
    relaySecret: typeof raw.relaySecret === 'string' ? raw.relaySecret : undefined
  }
  return data
}

function persist(): void {
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify(load(), null, 2), { mode: 0o600 })
  renameSync(tmp, file())
}

// ---------------------------------------------------------------- allowed addresses
/** "203.0.113.7" or "203.0.113.0/24" (IPv6 too). Returns the tidy form, or throws. */
function cleanRule(text: string): string {
  const t = text.trim()
  const [addr, bits, extra] = t.split('/')
  const family = isIP(addr)
  if (!family || extra !== undefined) throw new Error(`"${t}" is not an address. Use one address such as 203.0.113.7, or a range such as 203.0.113.0/24.`)
  if (bits === undefined) return addr
  const n = Number(bits)
  const max = family === 4 ? 32 : 128
  if (!/^\d{1,3}$/.test(bits) || n < 1 || n > max) throw new Error(`"${t}" is not a valid range. The number after / goes from 1 to ${max}.`)
  return `${addr}/${n}`
}

function build(rules: string[]): BlockList {
  const b = new BlockList()
  for (const r of rules) {
    const [addr, bits] = r.split('/')
    const family = isIP(addr) === 6 ? 'ipv6' : 'ipv4'
    if (bits) b.addSubnet(addr, Number(bits), family)
    else b.addAddress(addr, family)
  }
  return b
}

function inList(b: BlockList, ip: string): boolean {
  const family = isIP(ip)
  if (!family) return false
  return b.check(ip, family === 6 ? 'ipv6' : 'ipv4')
}

/** True when this address may use the service. An empty list allows everyone. */
export function addressAllowed(ip: string): boolean {
  const d = load()
  if (d.allowedIps.length === 0) return true
  if (!list) list = build(d.allowedIps)
  return inList(list, ip)
}

export function isLoopback(ip: string): boolean {
  return ip === '::1' || ip.startsWith('127.')
}

// ---------------------------------------------------------------- settings (admins)
export function view(callerIp: string): GuardView {
  const d = load()
  return {
    allowedIps: [...d.allowedIps],
    yourAddress: callerIp,
    telegramSet: !!d.telegramToken,
    telegramChat: d.telegramChat ?? '',
    alertSignIn: d.alertSignIn,
    alertDanger: d.alertDanger,
    approvals: d.approvals,
    recordingDays: d.recordingDays,
    telegramError: lastTelegramError
  }
}

/** Returns a short description of what changed, for the audit log and the alert. */
export function save(input: GuardInput, callerIp: string, activeAdmins: number): string {
  const d = load()
  const rules = [...new Set((Array.isArray(input.allowedIps) ? input.allowedIps : []).map((r) => cleanRule(String(r))))]
  if (rules.length > 200) throw new Error('At most 200 addresses.')
  if (rules.length > 0) {
    if (isLoopback(callerIp)) {
      throw new Error(
        'The service sees your app as 127.0.0.1, so it cannot tell addresses apart. It is behind a proxy (nginx) that hides the real address. Start the service with TRUST_PROXY=1, make the proxy send X-Forwarded-For, then try again.'
      )
    }
    if (!inList(build(rules), callerIp)) throw new Error(`Your own address (${callerIp}) is not in the list, so saving it would lock you out. Add it first.`)
  }
  const chat = String(input.telegramChat ?? '').trim()
  if (chat && !/^(-?\d{4,20}|@[A-Za-z0-9_]{4,40})$/.test(chat)) throw new Error('The chat ID is a number such as 123456789 or -1001234567890 (for a group), or a channel name such as @myteam.')
  let token = d.telegramToken
  if (input.telegramToken !== undefined) {
    const t = String(input.telegramToken).trim()
    if (t && !/^\d{5,15}:[A-Za-z0-9_-]{25,80}$/.test(t)) throw new Error('That does not look like a bot token. BotFather gives one such as 123456789:AAE...')
    token = t ? enc(t) : undefined
  }
  const approvals = input.approvals === true
  if (approvals && !d.approvals && activeAdmins < 2) throw new Error('Approval needs a second admin: one asks, another approves. Add another admin account first.')

  const recordingDays = input.recordingDays === undefined ? d.recordingDays : Math.floor(Number(input.recordingDays))
  if (!(recordingDays >= 0 && recordingDays <= 3650)) throw new Error('Keep terminal recordings for 0 (for ever) to 3650 days.')

  const changes: string[] = []
  if (rules.join(',') !== d.allowedIps.join(',')) changes.push(rules.length ? `allowed addresses: ${rules.join(', ')}`.slice(0, 160) : 'allowed addresses: anyone')
  if (token !== d.telegramToken) changes.push(token ? 'Telegram bot set' : 'Telegram bot removed')
  if (chat !== (d.telegramChat ?? '')) changes.push(chat ? `Telegram chat ${chat}` : 'Telegram chat removed')
  if ((input.alertSignIn !== false) !== d.alertSignIn) changes.push(`sign-in alerts ${input.alertSignIn !== false ? 'on' : 'off'}`)
  if ((input.alertDanger !== false) !== d.alertDanger) changes.push(`action alerts ${input.alertDanger !== false ? 'on' : 'off'}`)
  if (approvals !== d.approvals) changes.push(`second-admin approval ${approvals ? 'on' : 'off'}`)

  if (recordingDays !== d.recordingDays) changes.push(recordingDays ? `terminal recordings kept ${recordingDays} days` : 'terminal recordings kept for ever')
  d.recordingDays = recordingDays
  d.allowedIps = rules
  d.telegramToken = token
  d.telegramChat = chat || undefined
  d.alertSignIn = input.alertSignIn !== false
  d.alertDanger = input.alertDanger !== false
  d.approvals = approvals
  list = null
  persist()
  return changes.join(' · ') || 'no change'
}

/** From the console, for an admin who is locked out: any address may sign in again and approvals are off. */
export function reset(): void {
  const d = load()
  d.allowedIps = []
  d.approvals = false
  list = null
  persist()
}

// ---------------------------------------------------------------- Telegram
const API = (): string => (process.env.SUPERDEVOPS_TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '')

async function post(text: string): Promise<void> {
  const d = load()
  const token = d.telegramToken ? dec(d.telegramToken) : undefined
  if (!token || !d.telegramChat) throw new Error('Set the bot token and the chat ID first.')
  const res = await fetch(`${API()}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: d.telegramChat, text: text.slice(0, 3500), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10000)
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { description?: string } | null
    throw new Error(`Telegram refused the message (${res.status}${body?.description ? `: ${body.description}` : ''}).`)
  }
}

/** Send and wait, so the settings page can say whether it worked. */
export async function testTelegram(by: string): Promise<void> {
  try {
    await post(`Apsara Panel\nTest message sent by ${by}. Alerts will arrive in this chat.`)
    lastTelegramError = undefined
  } catch (err) {
    // The token is part of the address; never let it reach a message.
    throw new Error(String(err instanceof Error ? err.message : err).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***'))
  }
}

/** Send without waiting. A failed alert never blocks the action that caused it. */
function alert(text: string): void {
  const d = load()
  if (!d.telegramToken || !d.telegramChat) return
  post(`Apsara Panel\n${text}`)
    .then(() => (lastTelegramError = undefined))
    .catch((err) => {
      lastTelegramError = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC: ${String(err instanceof Error ? err.message : err).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***')}`
    })
}

/** Call after a successful sign-in. Alerts the first time a person comes from an address. */
export function signedIn(userId: string, username: string, role: string, ip: string): void {
  const d = load()
  const known = d.seen[userId] ?? []
  if (known.includes(ip)) return
  d.seen[userId] = [...known, ip].slice(-40)
  persist()
  if (d.alertSignIn) alert(`🔐 Sign-in from a new address\nAccount: ${username} (${role})\nAddress: ${ip}\nIf this was not ${username}, disable the account and reset its password.`)
}

export function forgetUser(userId: string): void {
  const d = load()
  if (d.seen[userId]) {
    delete d.seen[userId]
    persist()
  }
}

const refusedAt = new Map<string, number>()

/** A sign-in attempt from an address outside the list. At most one alert per address every 30 minutes. */
export function refusedAddress(ip: string, username: string): void {
  const now = Date.now()
  if (now - (refusedAt.get(ip) ?? 0) < 30 * 60000) return
  if (refusedAt.size > 500) refusedAt.clear()
  refusedAt.set(ip, now)
  if (load().alertSignIn) alert(`⛔ Sign-in refused: address not allowed\nAddress: ${ip}\nAccount tried: ${username || '(none)'}`)
}

export function accountLocked(username: string, ip: string): void {
  if (load().alertSignIn) alert(`🔒 Account locked after wrong passwords or codes\nAccount: ${username}\nAddress: ${ip}`)
}

/** Actions on servers worth an alert, besides everything that needs approval. */
const DANGER = new Set<string>([...APPROVAL_ACTIONS, 'db:deleteBackup', 'pg:deleteBackup', 'mongo:deleteBackup', 'backup:remove', 'dbc:dropTable', 'files:trashPurge'])

export function isDanger(action: string, target?: string): boolean {
  if (action === 'firewall:setEnabled') return /\bfalse\b/.test(target ?? '')
  return DANGER.has(action)
}

export function dangerDone(e: { user: string; action: string; project?: string; target?: string; ok: boolean; error?: string; ip: string }): void {
  if (!load().alertDanger) return
  alert(`${e.ok ? '⚠️' : '❌'} ${e.action}${e.ok ? '' : ' (failed)'}\nBy: ${e.user} from ${e.ip}${e.project ? `\nServer: ${e.project}` : ''}${e.target ? `\nWhat: ${e.target}` : ''}${e.error ? `\nError: ${e.error}` : ''}`)
}

/** Changes to accounts and to these settings. */
export function accountEvent(text: string): void {
  if (load().alertDanger) alert(text)
}

// ---------------------------------------------------------------- approval by a second admin
interface Pending extends ApprovalRequest {
  userId: string
  settle: (r: { ok: boolean; by?: string; why?: string }) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()

export function approvalsOn(): boolean {
  return load().approvals
}

export function needsApproval(action: string, target?: string): boolean {
  if (!load().approvals) return false
  if (action === 'firewall:setEnabled') return /\bfalse\b/.test(target ?? '')
  return (APPROVAL_ACTIONS as readonly string[]).includes(action)
}

export function pendingList(): ApprovalRequest[] {
  return [...pending.values()].map(({ id, user, action, project, target, time, ip }) => ({ id, user, action, project, target, time, ip }))
}

/** Resolves when another admin approves. Rejects when refused, cancelled or nobody answers in time. */
export function ask(req: { userId: string; user: string; ip: string; action: string; project?: string; target?: string }, onChange: () => void): { id: string; done: Promise<string> } {
  if ([...pending.values()].filter((p) => p.userId === req.userId).length >= 5) throw new Error('You already have 5 requests waiting for approval.')
  const id = randomUUID()
  const done = new Promise<string>((resolve, reject) => {
    const settle = (r: { ok: boolean; by?: string; why?: string }): void => {
      const p = pending.get(id)
      if (!p) return
      clearTimeout(p.timer)
      pending.delete(id)
      onChange()
      if (r.ok) resolve(r.by ?? '')
      else reject(new Error(r.why ?? 'Not approved.'))
    }
    const timer = setTimeout(() => settle({ ok: false, why: `Nobody approved within ${APPROVAL_MINUTES} minutes, so nothing was done. Ask again when another admin is available.` }), APPROVAL_MINUTES * 60000)
    pending.set(id, { id, userId: req.userId, user: req.user, ip: req.ip, action: req.action, project: req.project, target: req.target, time: Date.now(), settle, timer })
  })
  onChange()
  alert(`🙋 Approval needed\n${req.user} asks to run: ${req.action}${req.project ? `\nServer: ${req.project}` : ''}${req.target ? `\nWhat: ${req.target}` : ''}\nAnother admin can approve or refuse in the app within ${APPROVAL_MINUTES} minutes.`)
  return { id, done }
}

/** Returns the request that was decided. The person who asked can never approve their own request. */
export function decide(id: string, approverId: string, approver: string, approve: boolean): ApprovalRequest {
  const p = pending.get(id)
  if (!p) throw new Error('That request is no longer waiting. It was answered, cancelled or ran out of time.')
  if (p.userId === approverId) throw new Error('You cannot approve your own request. Another admin has to.')
  const copy = { id: p.id, user: p.user, action: p.action, project: p.project, target: p.target, time: p.time, ip: p.ip }
  p.settle(approve ? { ok: true, by: approver } : { ok: false, why: `${approver} refused this request, so nothing was done.` })
  alert(`${approve ? '✅ Approved' : '🚫 Refused'} by ${approver}\n${p.user}: ${p.action}${p.project ? ` on ${p.project}` : ''}${p.target ? `\nWhat: ${p.target}` : ''}`)
  return copy
}

export function cancel(id: string, userId: string): boolean {
  const p = pending.get(id)
  if (!p || p.userId !== userId) return false
  p.settle({ ok: false, why: 'You cancelled the request.' })
  return true
}

/** The app that asked went away: its requests cannot run any more. */
export function cancelAllOf(ids: string[]): void {
  for (const id of ids) pending.get(id)?.settle({ ok: false, why: 'The app that asked has disconnected.' })
}

// ---------------------------------------------------------------- old terminal recordings
/** Remove recordings past the chosen age, so the service's disk does not fill over the years. Returns how many went. */
export function sweepRecordings(): number {
  const days = load().recordingDays
  const folder = join(dir, 'terminal')
  if (!days || !existsSync(folder)) return 0
  const cut = Date.now() - days * 86400000
  let gone = 0
  for (const name of readdirSync(folder)) {
    if (!/^[0-9a-f-]{36}\.log$/.test(name)) continue
    const file = join(folder, name)
    try {
      if (statSync(file).mtimeMs < cut) {
        unlinkSync(file)
        gone += 1
      }
    } catch {
      /* in use or already gone; the next sweep sees it */
    }
  }
  return gone
}

// ---------------------------------------------------------------- alerts from managed servers
// A managed server sends its alerts here and the service forwards them with the team's bot,
// so Telegram is set up once and no bot token sits on any managed server.
// Each server gets its own key, made from one secret kept here.

export function telegramReady(): boolean {
  const d = load()
  return !!d.telegramToken && !!d.telegramChat
}

export function relayKey(projectId: string): string {
  const d = load()
  if (!d.relaySecret) {
    d.relaySecret = enc(randomBytes(32).toString('hex'))
    persist()
  }
  return createHmac('sha256', dec(d.relaySecret) ?? '').update(`alert:${projectId}`).digest('hex')
}

const relayed = new Map<string, number[]>()

/** Forward one alert. Throws an error whose `status` says what to answer the server. */
export async function relayAlert(projectId: string, key: string, serverName: string, text: string): Promise<void> {
  const fail = (status: number, message: string): never => {
    throw Object.assign(new Error(message), { status })
  }
  const want = Buffer.from(relayKey(projectId))
  const got = Buffer.from(String(key))
  if (got.length !== want.length || !timingSafeEqual(got, want)) fail(401, 'wrong key')
  const now = Date.now()
  const recent = (relayed.get(projectId) ?? []).filter((t) => now - t < 10 * 60000)
  if (recent.length >= 60) fail(429, 'too many alerts from this server in ten minutes')
  recent.push(now)
  relayed.set(projectId, recent)
  if (!telegramReady()) fail(409, 'Telegram is not set up on the service')
  const body = text.replace(/\u0000/g, '').trim().slice(0, 3000)
  if (!body) fail(400, 'empty message')
  try {
    await post(`📟 ${serverName}\n${body}`)
    lastTelegramError = undefined
  } catch (err) {
    lastTelegramError = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC: ${String(err instanceof Error ? err.message : err).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***')}`
    fail(502, 'Telegram did not accept the message')
  }
}
