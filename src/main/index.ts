// Desktop app shell. People sign in to the Apsara Panel service, which runs
// every operation on their servers (in an engine of its own for each person) and
// is the only thing that connects to them. This app never receives a server
// password or key: it shows the window, and carries files to and from the service.
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, systemPreferences } from 'electron'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { basename, join } from 'node:path'
import WebSocket from 'ws'
import type { LoginStep, SessionState, SessionUser } from '@shared/team'
import appIcon from '../../resources/icon.png?asset'
import { checkNow, install as installUpdate, startUpdater, updateState } from './updater'

let win: BrowserWindow | null = null
let closeConfirmed = false
/** True while the whole app is quitting (Cmd+Q), not just the window closing. */
let quitting = false

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// ---------------------------------------------------------------- remembered settings (no secrets)
interface ClientConfig {
  serverUrl: string
  lastUsername: string
  /** The session token, encrypted by the system's keychain (safeStorage), so a restart of the app does not ask to sign in again. */
  session?: string
}

function configFile(): string {
  return join(app.getPath('userData'), 'client.json')
}

function loadConfig(): ClientConfig {
  try {
    const c = JSON.parse(readFileSync(configFile(), 'utf8')) as Partial<ClientConfig>
    return { serverUrl: c.serverUrl ?? '', lastUsername: c.lastUsername ?? '', session: typeof c.session === 'string' ? c.session : undefined }
  } catch {
    return { serverUrl: '', lastUsername: '' }
  }
}

function saveConfig(c: ClientConfig): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(configFile(), JSON.stringify(c, null, 2))
}

// ---------------------------------------------------------------- connection to the service
let config: ClientConfig = { serverUrl: '', lastUsername: '' }
let ws: WebSocket | null = null
let token: string | null = null
let user: SessionUser | null = null
let nextId = 0
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

class RemoteError extends Error {
  constructor(
    message: string,
    public code = 'error'
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------- lock (Touch ID on a Mac)
let locked = false
let lockTimer: ReturnType<typeof setTimeout> | undefined
/** A locked app used to sign out by itself after 45 minutes. The service's own idle limit (Team → Protection) now decides; 0 = off. */
const LOCK_LIMIT_MINUTES = 0
/** What the window may still ask for while locked. Everything else is refused here, not just hidden. */
const WHILE_LOCKED = new Set(['session:state', 'app:unlock', 'auth:logout', 'monitor:sample', 'app:closeNow', 'app:closeCancelled'])

function canFingerprint(): boolean {
  try {
    return process.platform === 'darwin' && systemPreferences.canPromptTouchID()
  } catch {
    return false
  }
}

function setLocked(value: boolean): void {
  locked = value
  if (lockTimer) clearTimeout(lockTimer)
  lockTimer = undefined
  if (value && LOCK_LIMIT_MINUTES > 0) {
    lockTimer = setTimeout(() => {
      remote('auth:logout', []).catch(() => undefined).finally(() => {
        dropConnection()
        changed()
      })
    }, LOCK_LIMIT_MINUTES * 60000)
  }
}

function state(): SessionState {
  return { serverUrl: config.serverUrl, lastUsername: config.lastUsername, connected: !!ws && ws.readyState === WebSocket.OPEN, reconnecting: !!reconnectTimer || reconnectRunning, user, locked: locked && !!user, biometric: canFingerprint() }
}

function changed(): void {
  send('session:changed', state())
}

/** Accept "192.168.110.63:6787", "devops.example.com", or a full URL. A bare address uses HTTP. */
function normalizeUrl(input: string): string {
  let text = input.trim().replace(/\/+$/, '')
  if (!text) throw new Error('Enter the address of your Apsara Panel service.')
  if (!/^https?:\/\//i.test(text)) text = 'http://' + text
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('That is not a valid address.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('That is not a valid address.')
  return url.origin
}

/** Keep the session on this computer, encrypted by the system, or forget it. */
function rememberSession(t: string | null): void {
  let next: string | undefined
  try {
    if (t && safeStorage.isEncryptionAvailable()) next = safeStorage.encryptString(t).toString('base64')
  } catch {
    next = undefined
  }
  if (next === config.session) return
  config = { ...config, session: next }
  saveConfig(config)
}

function savedSession(): string | null {
  try {
    if (!config.session || !safeStorage.isEncryptionAvailable()) return null
    const t = safeStorage.decryptString(Buffer.from(config.session, 'base64'))
    return /^[0-9a-f]{64}$/.test(t) ? t : null
  } catch {
    return null
  }
}

async function tryResumeAtStart(saved: string): Promise<void> {
  if (user || token !== saved) return
  try {
    await openSocket()
    user = await rawRemote<SessionUser>('auth:resume', [saved])
    if (canFingerprint()) setLocked(true)
    remote('client:hello', [config.serverUrl]).catch(() => undefined)
    changed()
  } catch (err) {
    if (err instanceof RemoteError && err.code === 'unauthorized') {
      token = null
      rememberSession(null)
      changed()
    } else setTimeout(() => void tryResumeAtStart(saved), 10000)
  }
}

// ---------------------------------------------------------------- reconnect
// A dropped connection (sleep, Wi-Fi change, a proxy closing the socket, a restart of the service) is not a sign-out:
// the app keeps the session, connects again and asks the service to resume it.
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let reconnectRunning = false
let reconnectTries = 0
const reconnectWaiters: (() => void)[] = []

function stopReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = undefined
  reconnectTries = 0
  for (const w of reconnectWaiters.splice(0)) w()
}

function scheduleReconnect(): void {
  if (reconnectTimer || reconnectRunning || !token) return
  const delays = [500, 1500, 3000, 5000, 10000, 15000, 30000]
  const wait = delays[Math.min(reconnectTries, delays.length - 1)]
  reconnectTries++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    void tryResume()
  }, wait)
  changed()
}

async function tryResume(): Promise<void> {
  if (!token || reconnectRunning) return
  reconnectRunning = true
  const t = token
  try {
    await openSocket()
    const me = await remote<SessionUser>('auth:resume', [t])
    user = me
    remote('client:hello', [config.serverUrl]).catch(() => undefined)
    reconnectRunning = false
    stopReconnect()
    changed()
    setTimeout(() => void checkNow(), 3000)
  } catch (err) {
    reconnectRunning = false
    if (err instanceof RemoteError && err.code === 'unauthorized') {
      // The service no longer knows the session: sign in again.
      stopReconnect()
      dropConnection()
      changed()
      return
    }
    try {
      ws?.removeAllListeners()
      ws?.close()
    } catch {
      /* already closed */
    }
    ws = null
    scheduleReconnect()
  }
}

/** While reconnecting, a call waits for the connection (up to 30 s) instead of failing at once. */
function waitForConnection(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(t)
      resolve()
    }
    const t = setTimeout(() => {
      const i = reconnectWaiters.indexOf(done)
      if (i >= 0) reconnectWaiters.splice(i, 1)
      resolve()
    }, ms)
    reconnectWaiters.push(done)
  })
}

function dropConnection(): void {
  setLocked(false)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = undefined
  reconnectTries = 0
  for (const w of reconnectWaiters.splice(0)) w()
  rememberSession(null)
  const old = ws
  ws = null
  token = null
  user = null
  for (const w of waiting.values()) w.reject(new RemoteError('The connection to the service was lost.', 'unauthorized'))
  waiting.clear()
  old?.removeAllListeners()
  try {
    old?.close()
  } catch {
    /* already closed */
  }
}

function openConnection(): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve()
  if (!config.serverUrl) return Promise.reject(new Error('Enter the address of your Apsara Panel service.'))
  dropConnection()
  return openSocket()
}

/** Open the WebSocket without touching the session (used to sign in and to reconnect). */
function openSocket(): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve()
  if (!config.serverUrl) return Promise.reject(new Error('Enter the address of your Apsara Panel service.'))
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(config.serverUrl.replace(/^http/, 'ws') + '/ws', { handshakeTimeout: 12000 })
    let opened = false
    socket.on('open', () => {
      opened = true
      ws = socket
      changed()
      resolve()
    })
    socket.on('message', (raw) => {
      let msg: { id?: number; ok?: boolean; data?: unknown; error?: string; code?: string; event?: string; payload?: unknown }
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (msg.event) return send(msg.event, msg.payload)
      const w = msg.id !== undefined ? waiting.get(msg.id) : undefined
      if (!w) return
      waiting.delete(msg.id!)
      if (msg.ok) w.resolve(msg.data)
      else w.reject(new RemoteError(msg.error || 'Something went wrong.', msg.code))
    })
    socket.on('close', () => {
      if (ws !== socket) return
      ws = null
      for (const w of waiting.values()) w.reject(new RemoteError('The connection to the service was lost. Connecting again…', 'reconnecting'))
      waiting.clear()
      socket.removeAllListeners()
      if (token && user) scheduleReconnect()
      else {
        dropConnection()
        changed()
      }
    })
    socket.on('error', (err: Error & { code?: string }) => {
      if (opened) return
      const why =
        err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT'
          ? 'Could not reach the service at that address.'
          : /certificate|self.signed|CERT_/i.test(err.message)
            ? 'The service does not have a valid HTTPS certificate.'
            : `Could not connect to the service (${err.message}).`
      reject(new Error(why))
    })
  })
}

async function remote<T = unknown>(method: string, args: unknown[]): Promise<T> {
  if ((!ws || ws.readyState !== WebSocket.OPEN) && token && (reconnectTimer || reconnectRunning) && method !== 'auth:resume') {
    await waitForConnection(30000)
  }
  return rawRemote<T>(method, args)
}

function rawRemote<T = unknown>(method: string, args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new RemoteError('Not connected to the service.', 'unauthorized'))
    const id = ++nextId
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject })
    ws.send(JSON.stringify({ id, method, args }))
  })
}

// ---------------------------------------------------------------- files to and from the service
/** One-way message to the service (terminal keystrokes). */
function tell(name: string, args: unknown[]): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ send: name, args }))
}

/** Send a file to the service in pieces. Returns the transfer to name in the call that uses it. */
async function sendFile(path: string, name: string): Promise<string> {
  const { id, chunk } = await remote<{ id: string; chunk: number }>('xfer:new', ['up', name])
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(chunk)
    let offset = 0
    for (;;) {
      const n = readSync(fd, buf, 0, chunk, offset)
      if (n === 0) break
      await remote('xfer:put', [id, offset, buf.subarray(0, n).toString('base64')])
      offset += n
    }
    await remote('xfer:end', [id, offset])
    return id
  } catch (err) {
    remote('xfer:drop', [id]).catch(() => undefined)
    throw err
  } finally {
    closeSync(fd)
  }
}

/** Text the app already holds, sent like a file. */
async function sendText(text: string, name: string): Promise<string> {
  const tmp = join(app.getPath('temp'), `apsara-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`)
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  try {
    return await sendFile(tmp, name)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** A place on the service for an operation to write a file this app then fetches. */
async function newDownload(): Promise<string> {
  return (await remote<{ id: string }>('xfer:new', ['down'])).id
}

/** Copy a finished download from the service into a file here. */
async function receive(id: string, dest: string): Promise<void> {
  const fd = openSync(dest, 'w', 0o600)
  try {
    let offset = 0
    for (;;) {
      const r = await remote<{ data: string; size: number; eof: boolean }>('xfer:get', [id, offset])
      const buf = Buffer.from(r.data, 'base64')
      if (buf.length > 0) writeSync(fd, buf)
      offset += buf.length
      if (r.eof) break
    }
  } finally {
    closeSync(fd)
    remote('xfer:drop', [id]).catch(() => undefined)
  }
}

/** Run an operation that writes a file on the service, then bring that file here. */
async function fetchTo(dest: string, method: string, args: (download: { $download: string }) => unknown[]): Promise<unknown> {
  const id = await newDownload()
  let result: unknown
  try {
    result = await remote(method, args({ $download: id }))
  } catch (err) {
    remote('xfer:drop', [id]).catch(() => undefined)
    throw err
  }
  await receive(id, dest)
  return result
}

/** Pack a folder into a temporary .tar.gz on this computer. tar ships with macOS, Linux and Windows 10+. */
function packFolder(dir: string): Promise<string> {
  const out = join(app.getPath('temp'), `superdevops-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.tar.gz`)
  return new Promise((resolve, reject) => {
    // macOS tar adds a "._name" file for every file with Mac metadata unless told not to; Finder leaves .DS_Store.
    const tar = spawn('tar', ['-czf', out, '--exclude=.DS_Store', '--exclude=._*', '--exclude=__MACOSX', '-C', dir, '.'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, COPYFILE_DISABLE: '1' }
    })
    let stderr = ''
    tar.stderr.on('data', (c) => (stderr += c))
    tar.on('error', () => reject(new Error('Could not pack the folder: the "tar" command is not available on this computer.')))
    tar.on('close', (code) => {
      if (code === 0) return resolve(out)
      rmSync(out, { force: true })
      reject(new Error(`Could not pack the folder: ${stderr.trim().split('\n').pop() || `tar exited with ${code}`}`))
    })
  })
}

// ---------------------------------------------------------------- things handled on this computer
type Local = (...args: any[]) => unknown

async function finishLogin(step: LoginStep): Promise<LoginStep> {
  if (step.next === 'done') {
    token = step.token
    user = step.user
    rememberSession(step.token)
    setTimeout(() => void checkNow(), 3000)
    // Managed servers send their alerts to the address this app reached the service at.
    remote('client:hello', [config.serverUrl]).catch(() => undefined)
    changed()
    // The token stays in this process; the window only needs to know who is signed in.
    return { ...step, token: '' }
  }
  return step
}

// The app was called SuperDevops before it became Apsara Panel. Its settings stay in the folder they were
// always in, so nobody has to type the service address again after updating.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), 'SuperDevops')) // pinUserData

let confirmedUntil = 0

const BACKUP_FILE = /^[A-Za-z0-9_]{1,64}-\d{8}-\d{6}\.sql\.gz$/
/** Where the backups of one saved database connection live on this computer. */
function backupDir(target: string, connName: string): string {
  const id = /^conn:([A-Za-z0-9-]{6,64})$/.exec(String(target))?.[1]
  if (!id) throw new Error('Backups are kept per saved connection. Open one first.')
  // The folder kept its first name where it already exists, so backups made before the app was renamed stay listed.
  const former = join(app.getPath('documents'), 'SuperDevops backups')
  const base = process.env.SUPERDEVOPS_BACKUP_DIR || (existsSync(former) ? former : join(app.getPath('documents'), 'Apsara Panel backups'))
  const name = String(connName ?? '').replace(/[^A-Za-z0-9 ._-]/g, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 40) || 'connection'
  return join(base, `${name} (${id.slice(0, 8)})`)
}

const local: Record<string, Local> = {
  'session:state': () => state(),
  'update:state': () => updateState(),
  'update:check': () => checkNow(),
  'update:install': () => installUpdate(),
  'session:connect': async (url: string) => {
    const next = normalizeUrl(url)
    if (next !== config.serverUrl) {
      dropConnection()
      config = { ...config, serverUrl: next }
      saveConfig(config)
    }
    await openConnection()
    return state()
  },
  'auth:login': async (username: string, password: string) => {
    await openConnection()
    const step = await remote<LoginStep>('auth:login', [username, password])
    config = { ...config, lastUsername: username.trim().toLowerCase() }
    saveConfig(config)
    return finishLogin(step)
  },
  'auth:totp': async (code: string) => finishLogin(await remote<LoginStep>('auth:totp', [code])),
  'auth:setPassword': async (password: string) => finishLogin(await remote<LoginStep>('auth:setPassword', [password])),
  'auth:logout': async () => {
    try {
      await remote('auth:logout', [])
    } catch {
      /* the session may already be gone */
    }
    dropConnection()
    changed()
    return null
  },
  'app:closeNow': () => {
    closeConfirmed = true
    if (quitting) app.quit()
    else win?.close()
    return null
  },
  'app:closeCancelled': () => {
    quitting = false
    return null
  },
  'app:lock': () => {
    if (!user) return state()
    if (!canFingerprint()) throw new Error('Locking needs Touch ID, which this computer does not have. Sign out instead.')
    setLocked(true)
    remote('audit:report', [{ action: 'app:lock', ok: true }]).catch(() => undefined)
    changed()
    return state()
  },
  'app:unlock': async () => {
    if (!locked) return state()
    try {
      await systemPreferences.promptTouchID('unlock Apsara Panel')
    } catch {
      remote('audit:report', [{ action: 'app:unlock', ok: false, error: 'fingerprint not accepted or cancelled' }]).catch(() => undefined)
      throw new Error('The fingerprint was not accepted. Try again, or sign out and sign in with your password.')
    }
    setLocked(false)
    remote('audit:report', [{ action: 'app:unlock', ok: true }]).catch(() => undefined)
    changed()
    return state()
  },
  'projects:readKeyFile': async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose a private key',
      defaultPath: join(app.getPath('home'), '.ssh'),
      properties: ['openFile', 'showHiddenFiles']
    })
    if (res.canceled || !res.filePaths[0]) return null
    if (statSync(res.filePaths[0]).size > 64 * 1024) throw new Error('That file is too large to be a private key.')
    return readFileSync(res.filePaths[0], 'utf8')
  },
  'sites:pickUpload': async (kind: 'folder' | 'archive') => {
    const res = await dialog.showOpenDialog(win!, {
      title: kind === 'folder' ? 'Choose the folder to upload' : 'Choose a .zip or .tar.gz archive',
      properties: kind === 'folder' ? ['openDirectory'] : ['openFile'],
      filters: kind === 'archive' ? [{ name: 'Archives', extensions: ['zip', 'gz', 'tgz'] }] : undefined
    })
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  },
  'files:pickUpload': async (kind: 'files' | 'folder') => {
    const res = await dialog.showOpenDialog(win!, {
      title: kind === 'folder' ? 'Choose the folder to upload' : 'Choose files to upload',
      properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections', 'showHiddenFiles']
    })
    return res.canceled ? [] : res.filePaths
  },
  'files:upload': async (projectId: string, dir: string, localPath: string, packed: boolean, overwrite: boolean) => {
    const path = packed ? await packFolder(localPath) : localPath
    try {
      const id = await sendFile(path, packed ? 'folder.tar.gz' : basename(localPath))
      return await remote('files:upload', [projectId, dir, basename(localPath), { $upload: id, packed }, overwrite])
    } finally {
      if (packed) rmSync(path, { force: true })
    }
  },
  // Code for a site: a folder is packed here and unpacked on the server, which gives the same files.
  'sites:deploy': async (siteId: string, upload?: { kind: 'folder' | 'archive'; path: string }, target?: 'production' | 'preview') => {
    if (!upload) return remote('sites:deploy', [siteId])
    const packed = upload.kind === 'folder' ? await packFolder(upload.path) : null
    try {
      const id = await sendFile(packed ?? upload.path, packed ? 'folder.tar.gz' : basename(upload.path))
      return await remote('sites:deploy', [siteId, { $upload: id }, target === 'preview' ? 'preview' : 'production'])
    } finally {
      if (packed) rmSync(packed, { force: true })
    }
  },
  'files:download': async (projectId: string, path: string, isDir: boolean) => {
    const name = (path.split('/').pop() || 'download') + (isDir ? '.tar.gz' : '')
    const res = await dialog.showSaveDialog(win!, { title: 'Save as', defaultPath: join(app.getPath('downloads'), name) })
    if (res.canceled || !res.filePath) return null
    await fetchTo(res.filePath, 'files:download', (d) => [projectId, path, d])
    return res.filePath
  },
  // A fresh authenticator code, checked by the service, opens a one-minute window for one sensitive action.
  // The Tasks list of the window, kept in a file so it survives closing (and a crash of) the app.
  'tasks:load': async (owner: string) => {
    try {
      const raw = JSON.parse(readFileSync(join(app.getPath('userData'), 'tasks.json'), 'utf8')) as { owner?: string; tasks?: unknown }
      return raw.owner === String(owner) && Array.isArray(raw.tasks) ? raw.tasks : []
    } catch {
      return []
    }
  },
  'tasks:save': async (owner: string, tasks: unknown) => {
    if (!Array.isArray(tasks)) return
    const text = JSON.stringify({ owner: String(owner), tasks: tasks.slice(0, 25) })
    if (text.length > 4 * 1024 * 1024) return
    writeFileSync(join(app.getPath('userData'), 'tasks.json'), text, { encoding: 'utf8', mode: 0o600 })
  },
  // The service checks the code and opens one minute for one restore or uninstall, which it checks itself.
  // The app keeps its own minute only for restoring a backup kept on this computer.
  'session:confirm': async (proof: string, what: string) => {
    await remote('stepup:confirm', [String(proof ?? ''), String(what ?? '').slice(0, 200)])
    confirmedUntil = Date.now() + 60 * 1000
  },
  'dbc:exportSql': async (target: string, database: string, table: string | null, withData: boolean) => {
    const res = await dialog.showSaveDialog(win!, { title: 'Export as SQL', defaultPath: join(app.getPath('downloads'), `${String(table || database).replace(/[\\/:*?"<>|]/g, '_')}.sql`), filters: [{ name: 'SQL', extensions: ['sql'] }] })
    if (res.canceled || !res.filePath) return null
    const text = (await remote('dbc:dump', [target, database, table, withData])) as string
    writeFileSync(res.filePath, text, 'utf8')
    return res.filePath
  },
  // ---- backups of a saved database connection, kept on this computer
  'dbc:backup': async (target: string, connName: string, database: string) => {
    const dir = backupDir(target, connName)
    mkdirSync(dir, { recursive: true })
    const d = new Date()
    const p2 = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
    const file = `${String(database).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64) || 'database'}-${stamp}.sql.gz`
    const part = join(dir, `${file}.part`)
    try {
      await fetchTo(part, 'dbc:backupTo', (d) => [target, database, d])
      renameSync(part, join(dir, file))
    } catch (err) {
      if (existsSync(part)) unlinkSync(part)
      throw err
    }
    return join(dir, file)
  },
  // A scheduled backup made by a server, copied into this connection's folder here so it can be restored like the others.
  'dbr:pull': async (projectId: string, connId: string, connName: string, label: string, file: string) => {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(String(label))) throw new Error('Unknown backup file.')
    const m = new RegExp(`^remote-${label}-([A-Za-z0-9_]{1,64})-(\\d{8}-\\d{6})\\.sql\\.gz$`).exec(String(file))
    if (!m) throw new Error('Unknown backup file.')
    const dir = backupDir(`conn:${connId}`, connName)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${m[1]}-${m[2]}.sql.gz`)
    if (existsSync(path)) return path
    const part = `${path}.part`
    try {
      await fetchTo(part, 'dbr:pullTo', (d) => [projectId, file, d])
      renameSync(part, path)
    } catch (err) {
      if (existsSync(part)) unlinkSync(part)
      throw err
    }
    return path
  },
  'dbc:backups': async (target: string, connName: string) => {
    const dir = backupDir(target, connName)
    if (!existsSync(dir)) return { folder: dir, files: [] }
    const files = readdirSync(dir)
      .filter((f) => BACKUP_FILE.test(f))
      .map((f) => {
        const st = statSync(join(dir, f))
        return { file: f, database: f.replace(/-\d{8}-\d{6}\.sql\.gz$/, ''), size: st.size, time: st.mtimeMs }
      })
      .sort((a, b) => b.time - a.time)
    return { folder: dir, files }
  },
  'dbc:backupShow': async (target: string, connName: string, file?: string) => {
    const dir = backupDir(target, connName)
    if (file && BACKUP_FILE.test(file) && existsSync(join(dir, file))) shell.showItemInFolder(join(dir, file))
    else {
      mkdirSync(dir, { recursive: true })
      await shell.openPath(dir)
    }
  },
  'dbc:backupDelete': async (target: string, connName: string, file: string) => {
    if (!BACKUP_FILE.test(String(file))) throw new Error('Unknown backup file.')
    const path = join(backupDir(target, connName), file)
    if (!existsSync(path)) return
    // To the system's trash when there is one, so a slip can be undone.
    await shell.trashItem(path).catch(() => rmSync(path))
  },
  /** Only runs within a minute of session.confirm(). */
  'dbc:backupRestore': async (target: string, connName: string, file: string, intoDb: string) => {
    if (Date.now() > confirmedUntil) throw new Error('Confirm with your authenticator code first.')
    confirmedUntil = 0
    if (!BACKUP_FILE.test(String(file))) throw new Error('Unknown backup file.')
    const path = join(backupDir(target, connName), file)
    if (!existsSync(path)) throw new Error('That backup file is no longer on this computer.')
    let text: string
    try {
      text = gunzipSync(readFileSync(path), { maxOutputLength: 400 * 1024 * 1024 }).toString('utf8')
    } catch (err) {
      const big = err instanceof Error && /maxOutputLength|larger than|ERR_BUFFER_TOO_LARGE/i.test(`${(err as NodeJS.ErrnoException).code} ${err.message}`)
      throw new Error(big ? 'This backup is larger than 400 MB when unpacked, which is more than the app restores in one go. Unpack it and load it with the mysql command instead.' : 'The backup file is damaged and cannot be read.')
    }
    const names = (await remote('dbc:databases', [target])) as { name: string }[] | string[]
    const has = names.some((n) => (typeof n === 'string' ? n : n.name) === intoDb)
    if (!has) await remote('dbc:createDatabase', [target, intoDb])
    return remote('dbc:importText', [target, intoDb, file, { $uploadText: await sendText(text, file) }])
  },
  'dbc:importSql': async (target: string, database: string) => {
    const res = await dialog.showOpenDialog(win!, { title: 'Run an SQL file', properties: ['openFile'], filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }] })
    if (res.canceled || !res.filePaths[0]) return null
    const file = res.filePaths[0]
    if (statSync(file).size > 100 * 1024 * 1024) throw new Error('That file is larger than 100 MB. Restore large dumps on the server with the mysql command in the Terminal.')
    return remote('dbc:importText', [target, database, basename(file), { $uploadText: await sendFile(file, basename(file)) }])
  },
  'dbc:saveText': async (name: string, text: string) => {
    const res = await dialog.showSaveDialog(win!, { title: 'Save as', defaultPath: join(app.getPath('downloads'), String(name).replace(/[\\/:*?"<>|]/g, '_')) })
    if (res.canceled || !res.filePath) return null
    writeFileSync(res.filePath, String(text), 'utf8')
    return res.filePath
  },
  'sites:logDownload': async (siteId: string, siteName: string, kind: 'access' | 'error') => {
    const name = `${String(siteName).replace(/[^A-Za-z0-9_-]/g, '_')}.${kind === 'error' ? 'error' : 'access'}.log`
    const res = await dialog.showSaveDialog(win!, { title: 'Save log', defaultPath: join(app.getPath('downloads'), name) })
    if (res.canceled || !res.filePath) return null
    await fetchTo(res.filePath, 'sites:logDownload', (d) => [siteId, kind, d])
    return res.filePath
  },
  'db:download': async (projectId: string, file: string) => {
    const res = await dialog.showSaveDialog(win!, { title: 'Save backup', defaultPath: join(app.getPath('downloads'), file) })
    if (res.canceled || !res.filePath) return null
    await fetchTo(res.filePath, 'db:download', (d) => [projectId, file, d])
    return res.filePath
  }
}

function registerIpc(): void {
  ipcMain.handle('rpc', async (_e, method: string, args: unknown[]) => {
    if (locked && !WHILE_LOCKED.has(method)) return { ok: false, code: 'locked', error: 'The app is locked.' }
    try {
      const fn = local[method]
      return { ok: true, data: fn ? await fn(...args) : await remote(method, args) }
    } catch (err) {
      const code = err instanceof RemoteError ? err.code : 'error'
      if (code === 'unauthorized' && user) {
        // The service no longer knows this session (timeout, account disabled, restart).
        dropConnection()
        changed()
      }
      return { ok: false, code, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.on('rpc-send', (_e, name: string, args: unknown[]) => {
    if (name === 'window:minimize') return win?.minimize()
    if (name === 'window:maximize') return win?.isMaximized() ? win.unmaximize() : win?.maximize()
    if (name === 'window:close') return win?.close()
    if (locked) return
    // Terminals run in the service's engine; keystrokes and sizes go straight there.
    if (name === 'terminal:write' || name === 'terminal:resize') return tell(name, args)
  })
}

// ---------------------------------------------------------------- window
function createWindow(): void {
  const isMac = process.platform === 'darwin'
  win = new BrowserWindow({
    width: 1340,
    height: 860,
    minWidth: 1060,
    minHeight: 680,
    show: false,
    backgroundColor: '#0e1124',
    title: 'Apsara Panel',
    icon: appIcon,
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  // Closing ends the session and every terminal, so ask first when someone is signed in.
  win.on('close', (e) => {
    if (closeConfirmed || !user || !win) return
    e.preventDefault()
    // The window asks in its own style; the answer comes back as "app:closeNow".
    send('app:confirmClose', {})
  })
  win.on('closed', () => {
    win = null
    closeConfirmed = false
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  // In development macOS shows Electron's own Dock icon unless told otherwise.
  // An installed app has its own icon already, and a failure here must never stop the app from opening.
  if (process.platform === 'darwin' && !app.isPackaged) {
    try {
      app.dock?.setIcon(appIcon)
    } catch {
      // keep Electron's default icon
    }
  }
  config = loadConfig()
  // Tests on Linux without a keychain only (never in an installed app).
  if (!app.isPackaged && process.env.APSARA_TEST_PLAIN_STORAGE === '1') {
    try {
      ;(safeStorage as unknown as { setUsePlainTextEncryption?: (v: boolean) => void }).setUsePlainTextEncryption?.(true)
    } catch {
      /* not offered by this Electron */
    }
  }
  registerIpc()
  startUpdater({
    url: () => config.serverUrl,
    token: () => token,
    notify: (s) => send('update:state', s),
    quit: () => {
      closeConfirmed = true
      quitting = true
      app.quit()
    }
  })
  // Signed in before on this computer: pick the session up again instead of asking for the password and code.
  const saved = savedSession()
  if (saved && config.serverUrl) {
    token = saved
    reconnectRunning = true
    openSocket()
      .then(() => rawRemote<SessionUser>('auth:resume', [saved]))
      .then((me) => {
        user = me
        // With Touch ID the app opens locked, so someone else at this computer cannot just open it.
        if (canFingerprint()) setLocked(true)
        remote('client:hello', [config.serverUrl]).catch(() => undefined)
        setTimeout(() => void checkNow(), 5000)
      })
      .catch((err) => {
        if (err instanceof RemoteError && err.code === 'unauthorized') {
          token = null
          rememberSession(null)
        } else if (token) {
          // Offline at start: keep trying in the background; the sign-in page shows until it works.
          setTimeout(() => void tryResumeAtStart(saved), 5000)
        }
      })
      .finally(() => {
        reconnectRunning = false
        for (const w of reconnectWaiters.splice(0)) w()
        changed()
      })
  }
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((err: unknown) => {
  // Without this a start-up fault leaves an icon in the Dock and no window, with nothing to go on.
  dialog.showErrorBox('Apsara Panel could not start', err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err))
  app.quit()
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  dropConnection()
  if (process.platform !== 'darwin') app.quit()
})
