// Saved database connections, as in a desktop database tool: this computer
// talks to MySQL / MariaDB itself, either straight to host:port or through an
// SSH tunnel, so a database that only listens on its own server stays reachable
// without opening its port.
import mysql from 'mysql2'
import type { Client } from 'ssh2'
import type { Duplex } from 'node:stream'
import type { DbConnectionTest, DbResultSet, DbRunResult } from '@shared/types'
import { MAX_BYTES, MAX_ROWS, type Exec } from './dbclient'
import { connect as sshConnect } from './ssh'
import type { StoredDbConn } from './store'

interface Open {
  db: mysql.Connection
  /** Set when this module opened the SSH connection itself and must close it. */
  ssh?: Client
  /** One statement batch at a time, so "USE x" and the batch after it stay together. */
  chain: Promise<unknown>
  current: string | null
  used: number
  dead: boolean
}

export interface Hooks {
  /** The pooled SSH connection of a saved server. */
  borrow: (projectId: string) => Promise<Client>
  /** Called with the SSH host key the first time a tunnel opens. */
  seen?: (fingerprint: string) => void
}

const pool = new Map<string, Promise<Open>>()
const IDLE_MS = 15 * 60 * 1000
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** Text stays text; bytes that are not text are shown as hex, shortened. */
function cell(b: Buffer | null): string | null {
  if (b === null || b === undefined) return null
  try {
    return utf8.decode(b)
  } catch {
    return '0x' + b.subarray(0, 256).toString('hex') + (b.length > 256 ? `… (${b.length} bytes)` : '')
  }
}

function where(c: StoredDbConn): string {
  return `${c.host}:${c.port}`
}

function friendly(err: unknown, c: StoredDbConn): Error {
  const e = err as Error & { code?: string; errno?: number; sqlMessage?: string }
  const via = c.useSsh ? ' from the SSH server' : ''
  if (e.errno === 1045 || e.code === 'ER_ACCESS_DENIED_ERROR') return new Error(`The database refused the user name or password. (${e.sqlMessage ?? e.message})`)
  if (e.errno === 1130) return new Error(`The database does not let this user connect from here. (${e.sqlMessage ?? e.message})`)
  if (e.errno === 1049) return new Error(`The database "${c.database}" does not exist on that server.`)
  if (e.code === 'ECONNREFUSED') return new Error(`Nothing answers at ${where(c)}${via}. Check the host and port${c.useSsh ? '' : ', or turn on SSH if the database only listens on its own server'}.`)
  if (e.code === 'ENOTFOUND') return new Error(`The host ${c.host} was not found. Check the address.`)
  if (e.code === 'ETIMEDOUT') return new Error(`No answer from ${where(c)}${via}. A firewall may be blocking the port${c.useSsh ? '' : '; connecting through SSH usually solves this'}.`)
  if (e.code === 'PROTOCOL_CONNECTION_LOST' || e.code === 'ECONNRESET') return new Error(`The connection to ${where(c)} closed before the database answered. Check that this port really is MySQL / MariaDB.`)
  return e instanceof Error ? e : new Error(String(err))
}

function tunnel(ssh: Client, c: StoredDbConn): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    ssh.forwardOut('127.0.0.1', 0, c.host, c.port, (err, stream) => {
      if (err) reject(new Error(`The SSH server could not reach the database at ${where(c)}. With SSH on, the host is the address as seen from the SSH server, usually 127.0.0.1. (${err.message})`))
      else resolve(stream)
    })
  })
}

async function open(c: StoredDbConn, hooks: Hooks): Promise<Open> {
  let owned: Client | undefined
  let stream: Duplex | undefined
  if (c.useSsh) {
    let ssh: Client
    if (c.sshProjectId) {
      ssh = await hooks.borrow(c.sshProjectId)
    } else {
      const r = await sshConnect({ host: c.sshHost ?? '', port: c.sshPort ?? 22, username: c.sshUsername ?? '', password: c.sshAuth === 'key' ? undefined : c.secrets.sshPassword, privateKey: c.sshAuth === 'key' ? c.secrets.sshKey : undefined, passphrase: c.sshAuth === 'key' ? c.secrets.sshPassphrase : undefined, hostFingerprint: c.sshFingerprint }).catch((err: Error) => {
        throw new Error(`SSH: ${err.message.replace('use "Forget host key" on the project and connect again', 'open this connection for editing and save it again')}`)
      })
      ssh = owned = r.client
      if (!c.sshFingerprint) hooks.seen?.(r.fingerprint)
    }
    try {
      stream = await tunnel(ssh, c)
    } catch (err) {
      owned?.end()
      throw err
    }
  }
  const db = mysql.createConnection({
    host: c.host,
    port: c.port,
    user: c.username,
    password: c.secrets.password ?? '',
    database: c.database || undefined,
    stream,
    charset: 'utf8mb4',
    multipleStatements: true,
    connectTimeout: 15000,
    // Every value arrives as the database wrote it; nothing is turned into a number or a date here.
    typeCast: (field) => cell(field.buffer())
  })
  const o: Open = { db, ssh: owned, chain: Promise.resolve(), current: c.database || null, used: Date.now(), dead: false }
  const drop = (): void => {
    o.dead = true
    try {
      db.destroy()
    } catch {
      /* already gone */
    }
    owned?.end()
  }
  db.on('error', drop)
  owned?.on('close', drop)
  stream?.on('close', drop)
  await new Promise<void>((resolve, reject) => {
    db.connect((err) => {
      if (!err) return resolve()
      drop()
      reject(friendly(err, c))
    })
  })
  return o
}

/** Labels for result sets: the statements of a batch, cut at ";" outside quotes and comments. */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const two = sql.slice(i, i + 2)
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < sql.length && sql[j] !== ch) j += sql[j] === '\\' && ch !== '`' ? 2 : 1
      cur += sql.slice(i, j + 1)
      i = j + 1
    } else if (two === '--' || ch === '#') {
      const j = sql.indexOf('\n', i)
      i = j < 0 ? sql.length : j
    } else if (two === '/*') {
      const j = sql.indexOf('*/', i + 2)
      const end = j < 0 ? sql.length : j + 2
      // "/*! ... */" is not a comment to MySQL: it runs. Dump files rely on it.
      if (sql[i + 2] === '!') cur += sql.slice(i, end)
      i = end
    } else if (ch === ';') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      i++
    } else {
      cur += ch
      i++
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function batch(o: Open, sql: string, maxRows: number): Promise<{ sets: DbResultSet[]; error?: string }> {
  return new Promise((resolve) => {
    const labels = splitStatements(sql).map((s) => s.replace(/\s+/g, ' ').slice(0, 200))
    const sets: DbResultSet[] = []
    let error: string | undefined
    let bytes = 0
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      // Labels only when they line up; a stored procedure can return more sets than there are statements.
      const named = sets.length <= labels.length
      resolve({ sets: sets.map((s, i) => ({ ...s, statement: named ? labels[i] : `Result ${i + 1}`, truncated: s.total > s.rows.length })), error })
    }
    const q = o.db.query({ sql, rowsAsArray: true })
    q.on('fields', (fields: { name: string }[] | undefined) => {
      if (Array.isArray(fields)) sets.push({ statement: '', columns: fields.map((f) => f.name), rows: [], total: 0, truncated: false })
    })
    q.on('result', (row: unknown) => {
      if (!Array.isArray(row)) {
        sets.push({ statement: '', columns: [], rows: [], total: 0, truncated: false, affected: Number((row as { affectedRows?: number }).affectedRows) || 0 })
        return
      }
      const set = sets[sets.length - 1]
      if (!set) return
      set.total++
      if (set.rows.length >= maxRows) return
      for (const v of row) bytes += typeof v === 'string' ? v.length : 4
      if (bytes > MAX_BYTES) {
        error = 'The result was larger than 24 MB and was cut. Add a LIMIT or select fewer columns.'
        o.dead = true
        o.db.destroy()
        return finish()
      }
      set.rows.push(row as (string | null)[])
    })
    q.on('error', (err: Error & { errno?: number; sqlMessage?: string }) => {
      error = error ?? (err.errno && err.sqlMessage ? `Error ${err.errno}: ${err.sqlMessage}` : err.message || 'The statement failed.')
    })
    q.on('end', finish)
  })
}

async function runOn(o: Open, database: string | null, sql: string, maxRows = MAX_ROWS): Promise<DbRunResult> {
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('Write a SQL statement first.')
  if (Buffer.byteLength(sql) > 2 * 1024 * 1024) throw new Error('That is more than 2 MB of SQL. Run large imports with the restore function instead.')
  const task = async (): Promise<DbRunResult> => {
    const started = Date.now()
    o.used = started
    if (database && database !== o.current) {
      const use = await batch(o, 'USE `' + database.replace(/`/g, '``') + '`', 1)
      if (use.error) return { sets: [], error: use.error, ms: Date.now() - started }
      o.current = database
    }
    const r = await batch(o, sql, maxRows)
    // The batch itself may have switched database, or dropped the one in use.
    if (/\buse\s+|\bdrop\s+(database|schema)\b/i.test(sql)) o.current = null
    o.used = Date.now()
    return { ...r, ms: Date.now() - started }
  }
  const next = o.chain.then(task, task)
  o.chain = next.catch(() => undefined)
  return next
}

/** The way to run SQL on a saved connection, opening it when needed. */
export function connExec(c: StoredDbConn, hooks: Hooks): Exec {
  return async (database, sql, maxRows) => {
    let p = pool.get(c.id)
    if (!p) {
      p = open(c, hooks)
      pool.set(c.id, p)
      p.catch(() => {
        if (pool.get(c.id) === p) pool.delete(c.id)
      })
    }
    let o = await p
    if (o.dead) {
      pool.delete(c.id)
      p = open(c, hooks)
      pool.set(c.id, p)
      p.catch(() => {
        if (pool.get(c.id) === p) pool.delete(c.id)
      })
      o = await p
    }
    return runOn(o, database, sql, maxRows)
  }
}

export function isOpen(id: string): boolean {
  return pool.has(id)
}

export function close(id: string): void {
  const p = pool.get(id)
  pool.delete(id)
  p?.then((o) => {
    o.dead = true
    o.db.destroy()
    o.ssh?.end()
  }).catch(() => undefined)
}

export function closeAll(): void {
  for (const id of [...pool.keys()]) close(id)
}

/** Open, ask the version, close. Nothing is kept. */
export async function test(c: StoredDbConn, hooks: Hooks): Promise<DbConnectionTest> {
  const started = Date.now()
  const o = await open({ ...c, id: `test-${c.id}-${started}` }, hooks)
  try {
    const r = await runOn(o, null, 'SELECT VERSION()')
    if (r.error) throw new Error(r.error)
    return { version: r.sets[0]?.rows[0]?.[0] ?? '', ms: Date.now() - started }
  } finally {
    o.dead = true
    o.db.destroy()
    o.ssh?.end()
  }
}

const sweep = setInterval(() => {
  for (const [id, p] of pool) void p.then((o) => (Date.now() - o.used > IDLE_MS ? close(id) : undefined)).catch(() => undefined)
}, 60 * 1000)
sweep.unref?.()
