// The service's side of the per-person engine processes (worker.ts), and the
// file transfers between the desktop app and the service.
//
// The engine runs here, not on people's computers, so a file someone uploads
// first travels to the service, and a file they download is first written here.
// Calls that take a file never accept a path from the app: only a transfer the
// same session started, so nobody can make the service read or write its own files.
import { fork, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { SessionUser } from '@shared/team'
import type { FromWorker, ToWorker } from './worker'

export class EngineError extends Error {
  constructor(
    message: string,
    public code: 'unauthorized' | 'forbidden' | 'error' = 'error'
  ) {
    super(message)
  }
}

/** What an engine process may ask its service for, on behalf of the person it belongs to. */
export interface Host {
  /** Methods only an engine process may call: the shared list with credentials, saving changes, audit, approvals. */
  internal(method: string, args: unknown[]): Promise<unknown>
  /** An event for the person's window. */
  emit(event: string, payload: unknown): void
  /** Terminal output to keep in the recording. */
  record(session: string, text: string): void
  /** The address managed servers send their alerts to. */
  url(): string
}

interface Engine {
  child: ChildProcess
  ready: Promise<void>
  calls: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
  nextId: number
}

let xferDir = ''
const engines = new Map<string, Engine>()

/** Where transfers live while they are on the service. Leftovers from a stopped service are removed. */
export function configureEngines(dataDir: string): void {
  xferDir = join(dataDir, 'tmp', 'xfer')
  mkdirSync(xferDir, { recursive: true, mode: 0o700 })
  for (const f of readdirSync(xferDir)) rmSync(join(xferDir, f), { force: true, recursive: true })
}

// ---------------------------------------------------------------- engine processes
function start(key: string, user: SessionUser, host: Host): Engine {
  const env: NodeJS.ProcessEnv = { ...process.env, APSARA_ENGINE_WORKER: '1' }
  // The engine gets the credentials it needs from the service, already opened. It never needs the master key.
  delete env.SUPERDEVOPS_KEY
  const child = fork(process.argv[1], [], { env, execArgv: process.execArgv, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' })
  const e: Engine = { child, calls: new Map(), nextId: 0, ready: Promise.resolve() }
  e.ready = new Promise<void>((resolve, reject) => {
    child.on('message', (raw: unknown) => {
      const msg = raw as FromWorker
      switch (msg?.t) {
        case 'ready':
          return resolve()
        case 'failed':
          return reject(new EngineError(msg.error))
        case 'done': {
          const w = e.calls.get(msg.id)
          if (!w) return
          e.calls.delete(msg.id)
          if (msg.ok) w.resolve(msg.data)
          else w.reject(new EngineError(msg.error || 'Something went wrong.', (msg.code as EngineError['code']) || 'error'))
          return
        }
        case 'event':
          return host.emit(msg.event, msg.payload)
        case 'record':
          return host.record(msg.session, msg.text)
        case 'req':
          host
            .internal(msg.method, Array.isArray(msg.args) ? msg.args : [])
            .then((data) => send(e, { t: 'res', id: msg.id, ok: true, data }))
            .catch((err: Error & { code?: string }) => send(e, { t: 'res', id: msg.id, ok: false, error: err.message, code: err.code }))
          return
      }
    })
    child.on('exit', () => {
      reject(new EngineError('The engine could not start.'))
      if (engines.get(key) === e) engines.delete(key)
      for (const w of e.calls.values()) w.reject(new EngineError('The connection to your servers was closed on the service. Try again.'))
      e.calls.clear()
    })
  })
  e.ready.catch(() => stopEngine(key))
  send(e, { t: 'init', user, url: host.url() })
  engines.set(key, e)
  return e
}

function send(e: Engine, msg: ToWorker): void {
  if (e.child.connected) e.child.send(msg)
}

/** Run one engine operation for this session, starting its engine process on first use. */
export async function call(key: string, user: SessionUser, host: Host, method: string, args: unknown[]): Promise<unknown> {
  const e = engines.get(key) ?? start(key, user, host)
  await e.ready
  return new Promise((resolve, reject) => {
    const id = ++e.nextId
    e.calls.set(id, { resolve, reject })
    send(e, { t: 'call', id, method, args, user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role } })
  })
}

export function input(key: string, kind: 'write' | 'resize', term: string, a: unknown, b?: unknown): void {
  const e = engines.get(key)
  if (e) send(e, { t: 'input', kind, term, a, b })
}

/** The shared list changed: the engine loads what this person may use again. */
export function resync(key: string): void {
  const e = engines.get(key)
  if (e) send(e, { t: 'resync' })
}

/** Sign-out or a closed session: the engine closes every SSH connection and terminal and ends. */
export function stopEngine(key: string): void {
  const e = engines.get(key)
  if (!e) return
  engines.delete(key)
  e.child.disconnect?.()
  const t = setTimeout(() => e.child.kill('SIGKILL'), 5000)
  t.unref()
  e.child.once('exit', () => clearTimeout(t))
}

export function running(key: string): boolean {
  return engines.has(key)
}

// ---------------------------------------------------------------- file transfers
const MAX_UPLOAD = 4 * 1024 * 1024 * 1024
const CHUNK = 2 * 1024 * 1024
const MAX_OPEN = 12

interface Xfer {
  id: string
  path: string
  dir: 'up' | 'down'
  size: number
  /** An upload that was finished, or a download the engine has written. */
  complete: boolean
  /** Used by an engine call already. */
  used: boolean
}

const xfers = new Map<string, Map<string, Xfer>>()

function mine(key: string): Map<string, Xfer> {
  let m = xfers.get(key)
  if (!m) xfers.set(key, (m = new Map()))
  return m
}

function get(key: string, id: unknown): Xfer {
  const x = typeof id === 'string' ? xfers.get(key)?.get(id) : undefined
  if (!x) throw new EngineError('That file transfer is not known to the service. Start again.')
  return x
}

/** Start a transfer. Uploads keep the ending of the file name (.zip, .tar.gz), because that says how it is unpacked. */
export function xferNew(key: string, dir: 'up' | 'down', name?: string): { id: string; chunk: number } {
  const m = mine(key)
  if (m.size >= MAX_OPEN) throw new EngineError('Too many file transfers at once. Wait for one to finish.')
  const id = randomUUID()
  const lower = String(name ?? '').toLowerCase()
  const ext = lower.endsWith('.tar.gz') ? '.tar.gz' : lower.endsWith('.tgz') ? '.tgz' : lower.endsWith('.zip') ? '.zip' : ''
  const path = join(xferDir, `${key.replace(/[^A-Za-z0-9-]/g, '')}-${id}${ext}`)
  closeSync(openSync(path, 'w', 0o600))
  m.set(id, { id, path, dir: dir === 'down' ? 'down' : 'up', size: 0, complete: false, used: false })
  return { id, chunk: CHUNK }
}

/** Add the next piece of an upload. Pieces arrive in order, one at a time. */
export function xferPut(key: string, id: string, offset: number, data: string): number {
  const x = get(key, id)
  if (x.dir !== 'up' || x.complete) throw new EngineError('That transfer does not take more data.')
  if (offset !== x.size) throw new EngineError('A piece of the file went missing on the way. Start again.')
  const buf = Buffer.from(String(data ?? ''), 'base64')
  if (buf.length > CHUNK) throw new EngineError('That piece is too large.')
  if (x.size + buf.length > MAX_UPLOAD) throw new EngineError('Files over 4 GB cannot be sent through the service.')
  const fd = openSync(x.path, 'a')
  try {
    writeSync(fd, buf)
  } finally {
    closeSync(fd)
  }
  x.size += buf.length
  return x.size
}

export function xferEnd(key: string, id: string, size: number): void {
  const x = get(key, id)
  if (x.dir !== 'up') throw new EngineError('That is not an upload.')
  if (x.size !== size) throw new EngineError('The file did not arrive whole. Start again.')
  x.complete = true
}

/** Read the next piece of a download the engine has written. */
export function xferGet(key: string, id: string, offset: number): { data: string; size: number; eof: boolean } {
  const x = get(key, id)
  if (x.dir !== 'down' || !x.complete) throw new EngineError('That download is not ready.')
  const size = statSync(x.path).size
  const at = Math.max(0, Math.floor(Number(offset) || 0))
  const buf = Buffer.alloc(Math.min(CHUNK, Math.max(0, size - at)))
  if (buf.length > 0) {
    const fd = openSync(x.path, 'r')
    try {
      readSync(fd, buf, 0, buf.length, at)
    } finally {
      closeSync(fd)
    }
  }
  return { data: buf.toString('base64'), size, eof: at + buf.length >= size }
}

export function xferDrop(key: string, id: string): void {
  const m = xfers.get(key)
  const x = m?.get(String(id))
  if (!x) return
  m!.delete(x.id)
  rmSync(x.path, { force: true })
}

/** Everything of a closed session. */
export function dropAll(key: string): void {
  const m = xfers.get(key)
  if (!m) return
  for (const x of m.values()) rmSync(x.path, { force: true })
  xfers.delete(key)
}

// ---------------------------------------------------------------- calls that carry files
type Ref = { $upload?: unknown; $download?: unknown; $uploadText?: unknown; packed?: unknown; kind?: unknown }

/**
 * The arguments that are files, by operation. Each one must be a transfer of this session;
 * anything else in that place is refused, so a path on the service can never be given.
 */
const FILE_ARGS: Record<string, { at: number; as: 'upload' | 'packedUpload' | 'deployUpload' | 'download' | 'text'; optional?: boolean }> = {
  'files:upload': { at: 3, as: 'packedUpload' },
  'sites:deploy': { at: 1, as: 'deployUpload', optional: true },
  'files:download': { at: 2, as: 'download' },
  'db:download': { at: 2, as: 'download' },
  'dbr:pullTo': { at: 2, as: 'download' },
  'dbc:backupTo': { at: 2, as: 'download' },
  'sites:logDownload': { at: 2, as: 'download' },
  'dbc:importText': { at: 3, as: 'text' }
}

function takeUpload(key: string, ref: Ref['$upload']): Xfer {
  const x = get(key, ref)
  if (x.dir !== 'up' || !x.complete || x.used) throw new EngineError('That upload is not complete. Start again.')
  x.used = true
  return x
}

/**
 * Put the service's own paths in place of transfer references. Returns the arguments to pass on,
 * what to do once the call ends, and the download the app may then read.
 */
export function prepareFiles(key: string, method: string, args: unknown[]): { args: unknown[]; after: (ok: boolean) => void } {
  const rule = FILE_ARGS[method]
  const out = [...args]
  if (!rule) return { args: out, after: () => undefined }
  const v = out[rule.at] as Ref | string | null | undefined
  const refuse = (): never => {
    throw new EngineError('Files must be sent through the app.', 'forbidden')
  }
  if (rule.as === 'text') {
    // Short text may come inline; a file comes as an upload and is read by the engine.
    if (typeof v === 'string') return { args: out, after: () => undefined }
    if (!v || typeof v !== 'object' || typeof v.$uploadText !== 'string' || 'path' in v) refuse()
    const x = takeUpload(key, (v as Ref).$uploadText)
    out[rule.at] = { $readText: x.path }
    return { args: out, after: () => xferDrop(key, x.id) }
  }
  if (v === undefined || v === null) {
    if (rule.optional) return { args: out, after: () => undefined }
    refuse()
  }
  if (typeof v !== 'object') refuse()
  const ref = v as Ref & { path?: unknown }
  // Only a reference: an object that also names a path, or names none, is not from the app's own transfer code.
  if ('path' in ref) refuse()
  if (rule.as === 'download' ? typeof ref.$download !== 'string' : typeof ref.$upload !== 'string') refuse()
  if (rule.as === 'download') {
    const x = get(key, ref.$download)
    if (x.dir !== 'down' || x.complete || x.used) refuse()
    x.used = true
    out[rule.at] = x.path
    return {
      args: out,
      after: (ok) => {
        if (ok && existsSync(x.path)) {
          x.complete = true
          x.size = statSync(x.path).size
        } else xferDrop(key, x.id)
      }
    }
  }
  const x = takeUpload(key, ref.$upload)
  if (rule.as === 'packedUpload') out[rule.at] = { path: x.path, packed: ref.packed === true }
  // A folder is packed on the person's computer and unpacked on the managed server, which gives the same files.
  else out[rule.at] = { kind: 'archive', path: x.path }
  return { args: out, after: () => xferDrop(key, x.id) }
}
