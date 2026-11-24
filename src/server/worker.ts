// One signed-in person's engine, in a process of its own started by the service.
//
// It holds the servers, sites and credentials that person may use (in memory only),
// opens the SSH connections, and runs every operation the app asks for. Nothing in
// here is reachable from the app directly: the service checks the session, passes
// the call on, and keeps the audit log, recordings and approvals itself.
//
// One process per person keeps people apart: one person's connections, terminals
// and credentials are never in the same memory as another's.
import { readFileSync } from 'node:fs'
import type { SessionUser } from '@shared/team'
import * as engine from '../main/engine'
import * as store from '../main/store'
import type { Snapshot, StoreChange } from '../main/store'

/** Messages from the service. */
export type ToWorker =
  | { t: 'init'; user: SessionUser; url: string }
  | { t: 'call'; id: number; method: string; args: unknown[]; user: SessionUser }
  | { t: 'input'; kind: 'write' | 'resize'; term: string; a: unknown; b?: unknown }
  | { t: 'resync' }
  | { t: 'res'; id: number; ok: boolean; data?: unknown; error?: string; code?: string }

/** Messages to the service. */
export type FromWorker =
  | { t: 'ready' }
  | { t: 'failed'; error: string }
  | { t: 'done'; id: number; ok: boolean; data?: unknown; error?: string; code?: string }
  | { t: 'event'; event: string; payload: unknown }
  | { t: 'req'; id: number; method: string; args: unknown[] }
  | { t: 'record'; session: string; text: string }

/** An argument the service filled in with the text of an uploaded file, read here so it never travels twice. */
interface TextFile {
  $readText: string
}

let user: SessionUser | null = null
let serviceUrl = ''
let nextReq = 0
const asked = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

class WorkerError extends Error {
  constructor(
    message: string,
    public code = 'error'
  ) {
    super(message)
  }
}

function post(msg: FromWorker): void {
  process.send?.(msg)
}

/** Ask the service for something only it may do: the shared list, saving a change, the audit log, approvals. */
function ask<T = unknown>(method: string, args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++nextReq
    asked.set(id, { resolve: resolve as (v: unknown) => void, reject })
    post({ t: 'req', id, method, args })
  })
}

async function syncStore(): Promise<void> {
  const initial = await ask<Snapshot>('store:snapshot', [])
  store.configureStore({
    initial,
    encrypt: (v) => v,
    decrypt: (v) => v,
    onChange: (change: StoreChange) => {
      ask('store:apply', [change]).catch((err: Error) => {
        // The service refused the change: go back to what is really saved there, and tell the window.
        post({ t: 'event', event: 'store:error', payload: { message: err.message } })
        void syncStore()
          .then(() => post({ t: 'event', event: 'store:changed', payload: {} }))
          .catch(() => undefined)
      })
    }
  })
  engine.forgetMissing()
}

engine.configureEngine({
  user: () => user,
  emit: (event, payload) => post({ t: 'event', event, payload }),
  report: (entry) => {
    ask('audit:report', [entry]).catch(() => undefined)
  },
  record: (session, text) => post({ t: 'record', session, text }),
  approve: async (a) => {
    await ask('approval:ask', [a])
  },
  relay: async (projectId) => {
    const r = await ask<{ key: string; ready: boolean }>('relay:info', [projectId])
    return { url: process.env.SUPERDEVOPS_RELAY_URL || serviceUrl, key: r.key, ready: r.ready }
  }
})

function isTextFile(v: unknown): v is TextFile {
  return !!v && typeof v === 'object' && typeof (v as TextFile).$readText === 'string' && Object.keys(v).length === 1
}

async function call(id: number, method: string, args: unknown[]): Promise<void> {
  try {
    const ready = args.map((a) => (isTextFile(a) ? readFileSync(a.$readText, 'utf8') : a))
    const data = await engine.dispatch(method, ready)
    post({ t: 'done', id, ok: true, data })
  } catch (err) {
    const code = err instanceof engine.RpcError || err instanceof WorkerError ? err.code : 'error'
    post({ t: 'done', id, ok: false, code, error: err instanceof Error ? err.message : String(err) })
  }
}

export function runWorker(): void {
  process.on('message', (raw: unknown) => {
    const msg = raw as ToWorker
    switch (msg?.t) {
      case 'init':
        user = msg.user
        serviceUrl = msg.url
        syncStore()
          .then(() => post({ t: 'ready' }))
          .catch((err: Error) => post({ t: 'failed', error: err.message }))
        return
      case 'call':
        // Role changes made by an admin apply from the next call on.
        user = msg.user
        void call(msg.id, msg.method, Array.isArray(msg.args) ? msg.args : [])
        return
      case 'input':
        engine.terminalInput(msg.kind, msg.term, msg.a, msg.b)
        return
      case 'resync':
        void syncStore()
          .then(() => post({ t: 'event', event: 'store:changed', payload: {} }))
          .catch(() => undefined)
        return
      case 'res': {
        const w = asked.get(msg.id)
        if (!w) return
        asked.delete(msg.id)
        if (msg.ok) w.resolve(msg.data)
        else w.reject(new WorkerError(msg.error || 'Something went wrong.', msg.code))
        return
      }
    }
  })
  // The service went away (stopped, or ended this person's session): close every connection with it.
  const stop = (): void => {
    try {
      engine.shutdown()
    } finally {
      process.exit(0)
    }
  }
  process.on('disconnect', stop)
  process.on('SIGTERM', stop)
  process.on('SIGINT', () => undefined)
}
