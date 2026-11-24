// Append-only audit log. Every line carries the hash of the line before it,
// so removing or editing an entry later breaks the chain and can be detected.
//
// One file per month (audit/audit-YYYY-MM.log), so years of use never make the
// log slow to read: looking at recent activity opens the newest month only.
// The chain runs on from one month's last line to the next month's first.
// A log written before this (audit.log) stays where it is and is the oldest part.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AuditEntry, AuditPage, AuditQuery } from '@shared/team'

interface Stored extends AuditEntry {
  prev: string
  hash: string
}

let dir = ''
let seq = 0
let last = 'genesis'
/** Month ("2026-11") of the file new lines go to. */
let current = ''
/** Finished months never change, so a few stay in memory once read. */
const cache = new Map<string, Stored[]>()

const MONTH_FILE = /^audit-(\d{4}-\d{2})\.log$/

function digest(prev: string, entry: AuditEntry): string {
  return createHash('sha256').update(prev).update(JSON.stringify(entry)).digest('hex')
}

/** Every part of the log, oldest first. */
function parts(): string[] {
  const out: string[] = []
  if (existsSync(join(dir, 'audit.log'))) out.push(join(dir, 'audit.log'))
  const sub = join(dir, 'audit')
  if (existsSync(sub)) {
    for (const name of readdirSync(sub).filter((n) => MONTH_FILE.test(n)).sort()) out.push(join(sub, name))
  }
  return out
}

function read(file: string, keep: boolean): Stored[] {
  const hit = cache.get(file)
  if (hit) return hit
  const out: Stored[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as Stored)
    } catch {
      out.push({ seq: -1, time: 0, user: '', role: '', ip: '', action: 'UNREADABLE LINE', ok: false, prev: '', hash: '' })
    }
  }
  if (keep) {
    if (cache.size >= 6) cache.delete(cache.keys().next().value as string)
    cache.set(file, out)
  }
  return out
}

function monthOf(time: number): string {
  return new Date(time).toISOString().slice(0, 7)
}

export function configureAudit(dataDir: string): void {
  dir = dataDir
  cache.clear()
  seq = 0
  last = 'genesis'
  current = ''
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const all = parts()
  // The newest line of the newest part that has one.
  for (let i = all.length - 1; i >= 0; i--) {
    const rows = read(all[i], false)
    const tail = rows[rows.length - 1]
    if (tail) {
      seq = tail.seq
      last = tail.hash
      break
    }
  }
  const newest = all.length ? MONTH_FILE.exec(all[all.length - 1].split(/[\\/]/).pop() ?? '')?.[1] : undefined
  current = newest ?? ''
}

export function record(e: Omit<AuditEntry, 'seq' | 'time'>): void {
  seq += 1
  const entry: AuditEntry = { seq, time: Date.now(), ...e }
  // Drop undefined fields so the hash is computed over exactly what is written.
  const clean = JSON.parse(JSON.stringify(entry)) as AuditEntry
  const hash = digest(last, clean)
  // A clock set back must not put a line into an older file, or the order of the chain would be lost.
  const month = monthOf(entry.time)
  if (month > current) current = month
  const sub = join(dir, 'audit')
  if (!existsSync(sub)) mkdirSync(sub, { recursive: true, mode: 0o700 })
  appendFileSync(join(sub, `audit-${current}.log`), JSON.stringify({ ...clean, prev: last, hash }) + '\n', { mode: 0o600 })
  last = hash
}

/**
 * Newest first. Reads back only as many months as the page needs. While older months are still unread,
 * `total` is "at least this many": one page more than what was found, so the list offers a next page.
 */
export function query(q: AuditQuery): AuditPage {
  const text = q.text?.trim().toLowerCase()
  const user = q.user?.trim().toLowerCase()
  const limit = Math.max(1, Math.min(200, q.limit || 50))
  const offset = Math.max(0, q.offset || 0)
  const all = parts()
  const rows: Stored[] = []
  let i = all.length - 1
  for (; i >= 0 && rows.length < offset + limit; i--) {
    const isNewest = i === all.length - 1
    for (const e of [...read(all[i], !isNewest)].reverse()) {
      if (user && e.user.toLowerCase() !== user) continue
      if (q.onlyFailed && e.ok) continue
      if (text && ![e.action, e.project, e.target, e.error, e.user, e.ip].some((v) => v?.toLowerCase().includes(text))) continue
      rows.push(e)
    }
  }
  const unread = i >= 0
  return {
    total: unread ? Math.max(rows.length, offset + limit) + limit : rows.length,
    entries: rows.slice(offset, offset + limit).map(({ prev: _p, hash: _h, ...e }) => e)
  }
}

/** Recompute the whole chain, through every month. Returns the first broken entry, if any. */
export function verify(): { ok: boolean; entries: number; brokenAt?: number } {
  let prev = 'genesis'
  let expectSeq = 1
  let count = 0
  let brokenAt: number | undefined
  for (const file of parts()) {
    for (const e of read(file, false)) {
      count += 1
      if (brokenAt !== undefined) continue
      const { prev: storedPrev, hash, ...entry } = e
      if (storedPrev !== prev || digest(prev, entry) !== hash || entry.seq !== expectSeq) brokenAt = expectSeq
      prev = hash
      expectSeq += 1
    }
  }
  return brokenAt === undefined ? { ok: true, entries: count } : { ok: false, entries: count, brokenAt }
}
