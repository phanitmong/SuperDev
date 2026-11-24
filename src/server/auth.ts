// Accounts, passwords, Google Authenticator codes (TOTP), lockout and sessions.
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LoginStep, Role, SessionUser, TeamUser, TeamUserInput } from '@shared/team'
import { ROLE_LABELS } from '@shared/team'

interface UserRec {
  id: string
  username: string
  displayName: string
  role: Role
  salt: string
  hash: string
  /** Encrypted TOTP secret (base32 before encryption). */
  totp?: string
  totpEnabled: boolean
  /** Last accepted 30-second step, so one code cannot be used twice. */
  totpStep?: number
  disabled: boolean
  failed: number
  lockedUntil?: number
  mustChangePassword: boolean
  projects: string[] | null
  createdAt: number
  lastLoginAt?: number
}

export interface Session {
  token: string
  userId: string
  ip: string
  createdAt: number
  lastSeen: number
}

export const MAX_FAILED = 5
export const LOCK_MINUTES = 15
const SESSION_IDLE_MS = 60 * 60 * 1000
// Development sign-in (see rpc.setDevNo2fa): wrong passwords never lock an account.
let noLock = false
export function setNoLock(on: boolean): void {
  noLock = on
}
function isLocked(u: { lockedUntil?: number }): boolean {
  return !noLock && !!u.lockedUntil && u.lockedUntil > Date.now()
}

const SESSION_MAX_MS = 12 * 60 * 60 * 1000
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }
const RE_USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/

let dir = ''
let enc: (v: string) => string = (v) => v
let dec: (v: string) => string | undefined = (v) => v
let users: UserRec[] | null = null
const sessions = new Map<string, Session>()

export function configureAuth(opts: { dir: string; encrypt: (v: string) => string; decrypt: (v: string) => string | undefined }): void {
  dir = opts.dir
  enc = opts.encrypt
  dec = opts.decrypt
  users = null
}

function file(): string {
  return join(dir, 'users.json')
}

function load(): UserRec[] {
  if (users) return users
  try {
    users = JSON.parse(readFileSync(file(), 'utf8')) as UserRec[]
  } catch {
    users = []
  }
  return users
}

function persist(): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify(load(), null, 2), { mode: 0o600 })
  renameSync(tmp, file())
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password.normalize('NFKC'), Buffer.from(salt, 'hex'), 64, SCRYPT).toString('hex')
}

export function checkPasswordRules(password: string, username: string): void {
  if (password.length < 6) {
    throw new Error('The password must have at least 6 characters.')
  }
  if (password.length > 200) throw new Error('The password is too long.')
  if (username && password.toLowerCase().includes(username.toLowerCase())) throw new Error('The password must not contain the username.')
}

export function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  let out = ''
  while (!(/[a-z]/.test(out) && /[A-Z]/.test(out) && /[0-9]/.test(out) && out.length >= 16)) {
    out = [...randomBytes(16)].map((b) => chars[b % chars.length]).join('')
  }
  return out
}

// ---------------------------------------------------------------- TOTP (RFC 6238, as used by Google Authenticator)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of text.replace(/[\s=-]/g, '').toUpperCase()) {
    const i = B32.indexOf(ch)
    if (i < 0) continue
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function totpCode(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest()
  const offset = mac[mac.length - 1] & 15
  const num = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
  return String(num % 1_000_000).padStart(6, '0')
}

/** Returns the matching time step, or null. Accepts the previous and next 30 seconds for clock drift. */
function matchTotp(secretBase32: string, code: string, now = Date.now()): number | null {
  const clean = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(clean)) return null
  const step = Math.floor(now / 30000)
  for (const s of [step, step - 1, step + 1]) {
    const expect = Buffer.from(totpCode(secretBase32, s))
    if (timingSafeEqual(expect, Buffer.from(clean))) return s
  }
  return null
}

// ---------------------------------------------------------------- views
function toSession(u: UserRec): SessionUser {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role }
}

function toTeam(u: UserRec): TeamUser {
  return {
    ...toSession(u),
    disabled: u.disabled,
    twoFactor: u.totpEnabled,
    locked: isLocked(u),
    mustChangePassword: u.mustChangePassword,
    projects: u.projects,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt
  }
}

export function hasUsers(): boolean {
  return load().length > 0
}

export function listUsers(): TeamUser[] {
  return load()
    .map(toTeam)
    .sort((a, b) => a.username.localeCompare(b.username))
}

export function getUser(id: string): SessionUser & { projects: string[] | null; disabled: boolean } {
  const u = load().find((x) => x.id === id)
  if (!u) throw new Error('That account no longer exists.')
  return { ...toSession(u), projects: u.projects, disabled: u.disabled }
}

function admins(): UserRec[] {
  return load().filter((u) => u.role === 'admin' && !u.disabled)
}

// ---------------------------------------------------------------- account management (admin)
export function createUser(input: TeamUserInput): { user: TeamUser; password: string } {
  const username = input.username.trim().toLowerCase()
  if (!RE_USERNAME.test(username)) throw new Error('Usernames are 3-32 characters: lower-case letters, numbers, dot, dash and underscore.')
  if (load().some((u) => u.username === username)) throw new Error(`The username "${username}" is already taken.`)
  if (!ROLE_LABELS[input.role]) throw new Error('Unknown role.')
  const password = generatePassword()
  const salt = randomBytes(16).toString('hex')
  const rec: UserRec = {
    id: randomUUID(),
    username,
    displayName: input.displayName.trim() || username,
    role: input.role,
    salt,
    hash: hashPassword(password, salt),
    totpEnabled: false,
    disabled: false,
    failed: 0,
    mustChangePassword: true,
    projects: input.role === 'admin' ? null : input.projects,
    createdAt: Date.now()
  }
  load().push(rec)
  persist()
  return { user: toTeam(rec), password }
}

export function updateUser(input: TeamUserInput, actingUserId: string): TeamUser {
  const u = load().find((x) => x.id === input.id)
  if (!u) throw new Error('That account no longer exists.')
  if (!ROLE_LABELS[input.role]) throw new Error('Unknown role.')
  const losesAdmin = u.role === 'admin' && (input.role !== 'admin' || input.disabled)
  if (losesAdmin && admins().filter((a) => a.id !== u.id).length === 0) throw new Error('This is the last active admin. Make someone else an admin first.')
  if (u.id === actingUserId && input.disabled) throw new Error('You cannot disable your own account.')
  u.displayName = input.displayName.trim() || u.username
  u.role = input.role
  u.projects = input.role === 'admin' ? null : input.projects
  if (input.disabled !== u.disabled) {
    u.disabled = input.disabled
    if (u.disabled) endSessionsOf(u.id)
  }
  persist()
  return toTeam(u)
}

export function removeUser(id: string, actingUserId: string): string {
  const u = load().find((x) => x.id === id)
  if (!u) throw new Error('That account no longer exists.')
  if (u.id === actingUserId) throw new Error('You cannot delete your own account.')
  if (u.role === 'admin' && admins().filter((a) => a.id !== u.id).length === 0) throw new Error('This is the last active admin.')
  users = load().filter((x) => x.id !== id)
  endSessionsOf(id)
  persist()
  return u.username
}

/** New temporary password; the person must change it at next sign-in. */
export function resetPassword(id: string): { username: string; password: string } {
  const u = load().find((x) => x.id === id)
  if (!u) throw new Error('That account no longer exists.')
  const password = generatePassword()
  u.salt = randomBytes(16).toString('hex')
  u.hash = hashPassword(password, u.salt)
  u.mustChangePassword = true
  u.failed = 0
  u.lockedUntil = undefined
  endSessionsOf(id)
  persist()
  return { username: u.username, password }
}

/** Forget the authenticator; the person sets up a new one at next sign-in. */
export function resetTwoFactor(id: string): string {
  const u = load().find((x) => x.id === id)
  if (!u) throw new Error('That account no longer exists.')
  u.totp = undefined
  u.totpEnabled = false
  u.totpStep = undefined
  endSessionsOf(id)
  persist()
  return u.username
}

export function unlock(id: string): string {
  const u = load().find((x) => x.id === id)
  if (!u) throw new Error('That account no longer exists.')
  u.failed = 0
  u.lockedUntil = undefined
  persist()
  return u.username
}

// ---------------------------------------------------------------- sign-in
export class LoginError extends Error {}

/** One message for every wrong-credentials case, so nothing leaks about which accounts exist. */
const BAD = 'Wrong username, password or code.'

function fail(u: UserRec | undefined): never {
  if (u) {
    u.failed += 1
    if (!noLock && u.failed >= MAX_FAILED) {
      u.lockedUntil = Date.now() + LOCK_MINUTES * 60000
      u.failed = 0
    }
    persist()
    if (isLocked(u)) throw new LoginError(`Too many wrong attempts. This account is locked for ${LOCK_MINUTES} minutes.`)
  }
  throw new LoginError(BAD)
}

/** Step 1. Returns the user id to continue with, plus what to ask next. */
export function loginPassword(username: string, password: string): { userId: string; step: LoginStep } {
  const u = load().find((x) => x.username === username.trim().toLowerCase())
  // Always do the expensive hash, so response time does not reveal whether the account exists.
  const hash = hashPassword(password, u?.salt ?? '00000000000000000000000000000000')
  if (!u) throw new LoginError(BAD)
  if (isLocked(u)) {
    throw new LoginError(`This account is locked after too many wrong attempts. Try again in ${Math.ceil(((u.lockedUntil ?? 0) - Date.now()) / 60000)} minutes, or ask an admin to unlock it.`)
  }
  if (!timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.hash, 'hex'))) fail(u)
  if (u.disabled) throw new LoginError('This account is disabled. Ask an admin.')
  if (u.totpEnabled) return { userId: u.id, step: { next: 'totp' } }
  // First sign-in: create the authenticator secret now, confirmed by the first code.
  const secret = base32Encode(randomBytes(20))
  u.totp = enc(secret)
  persist()
  const label = encodeURIComponent(`Apsara Panel:${u.username}`)
  return { userId: u.id, step: { next: 'enroll', secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=Apsara%20Panel&algorithm=SHA1&digits=6&period=30` } }
}

/** What this person must give to see a stored secret again: an authenticator code, or (only without an authenticator, in development) the account password. */
export function proofKind(userId: string): 'totp' | 'password' {
  return load().find((x) => x.id === userId)?.totpEnabled ? 'totp' : 'password'
}

/** Check a fresh proof of identity from someone already signed in. Wrong proofs count towards the account lock, like wrong sign-ins. */
export function checkProof(userId: string, proof: string): void {
  const u = load().find((x) => x.id === userId)
  if (!u || u.disabled) throw new LoginError(BAD)
  if (isLocked(u)) throw new LoginError('This account is locked after too many wrong attempts. Try again later.')
  if (u.totpEnabled) {
    const secret = u.totp ? dec(u.totp) : undefined
    const step = secret ? matchTotp(secret, String(proof ?? '')) : null
    // A code that already signed in or revealed something cannot be used again.
    if (step === null || (u.totpStep !== undefined && step <= u.totpStep)) fail(u)
    u.totpStep = step as number
  } else if (!timingSafeEqual(Buffer.from(hashPassword(String(proof ?? ''), u.salt), 'hex'), Buffer.from(u.hash, 'hex'))) {
    fail(u)
  }
  u.failed = 0
  persist()
}

export function mustChangePassword(userId: string): boolean {
  return load().find((x) => x.id === userId)?.mustChangePassword === true
}

/** Step 2. Checks the 6-digit code (and completes enrolment on first use). */
export function loginTotp(userId: string, code: string): { mustChangePassword: boolean } {
  const u = load().find((x) => x.id === userId)
  if (!u || u.disabled) throw new LoginError(BAD)
  if (isLocked(u)) throw new LoginError('This account is locked. Try again later.')
  const secret = u.totp ? dec(u.totp) : undefined
  const step = secret ? matchTotp(secret, code) : null
  if (step === null || (u.totpStep !== undefined && step <= u.totpStep)) fail(u)
  u.totpStep = step as number
  u.totpEnabled = true
  u.failed = 0
  persist()
  return { mustChangePassword: u.mustChangePassword }
}

export function setPassword(userId: string, password: string, current?: string): void {
  const u = load().find((x) => x.id === userId)
  if (!u) throw new Error('That account no longer exists.')
  if (current !== undefined && !timingSafeEqual(Buffer.from(hashPassword(current, u.salt), 'hex'), Buffer.from(u.hash, 'hex'))) {
    throw new Error('The current password is wrong.')
  }
  checkPasswordRules(password, u.username)
  if (timingSafeEqual(Buffer.from(hashPassword(password, u.salt), 'hex'), Buffer.from(u.hash, 'hex'))) throw new Error('Choose a password different from the current one.')
  u.salt = randomBytes(16).toString('hex')
  u.hash = hashPassword(password, u.salt)
  u.mustChangePassword = false
  persist()
}

// ---------------------------------------------------------------- sessions
export function startSession(userId: string, ip: string): { token: string; user: SessionUser } {
  const u = load().find((x) => x.id === userId)
  if (!u || u.disabled) throw new LoginError(BAD)
  u.lastLoginAt = Date.now()
  persist()
  const token = randomBytes(32).toString('hex')
  sessions.set(token, { token, userId, ip, createdAt: Date.now(), lastSeen: Date.now() })
  return { token, user: toSession(u) }
}

/** The session for a token, if it is still valid. Touches its idle timer. */
export function useSession(token: string | undefined): Session | null {
  if (!token) return null
  const s = sessions.get(token)
  if (!s) return null
  const now = Date.now()
  if (now - s.lastSeen > SESSION_IDLE_MS || now - s.createdAt > SESSION_MAX_MS) {
    sessions.delete(token)
    return null
  }
  s.lastSeen = now
  return s
}

export function endSession(token: string): void {
  sessions.delete(token)
}

const sessionEndListeners: ((userId: string) => void)[] = []

/** Called when an account is disabled, deleted or reset: its open connections must be dropped. */
export function onSessionsEnded(fn: (userId: string) => void): void {
  sessionEndListeners.push(fn)
}

export function endSessionsOf(userId: string): void {
  for (const [t, s] of sessions) if (s.userId === userId) sessions.delete(t)
  for (const fn of sessionEndListeners) fn(userId)
}
