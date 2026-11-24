import { randomBytes } from 'node:crypto'
// Thin promise wrappers around ssh2. No Electron imports here, so this file
// can be tested with plain Node.
import { Client } from 'ssh2'
import type { ConnectConfig, SFTPWrapper } from 'ssh2'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface SshTarget {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  /** Fingerprint saved on first connect. A different key is refused. */
  hostFingerprint?: string
}

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
  signal?: string
}

export interface ExecOptions {
  stdin?: string
  onData?: (chunk: string) => void
  timeoutMs?: number
}

export type SudoMode = 'none' | 'password' | 'nopasswd'

export class HostKeyMismatchError extends Error {
  constructor(
    public expected: string,
    public actual: string
  ) {
    super(
      `The server's host key has changed (expected ${expected}, got ${actual}). ` +
        `If you reinstalled the server, use "Forget host key" on the project and connect again.`
    )
    this.name = 'HostKeyMismatchError'
  }
}

function friendly(err: Error & { level?: string; code?: string }): Error {
  if (err.level === 'client-authentication') {
    return new Error('Authentication failed. Check the username and the password or private key.')
  }
  if (err.code === 'ECONNREFUSED') return new Error('Connection refused. Check the host and SSH port.')
  if (err.code === 'ENOTFOUND') return new Error('Host not found. Check the address.')
  if (err.code === 'ETIMEDOUT' || err.level === 'client-timeout') {
    return new Error('Connection timed out. The server may be offline or blocked by a firewall.')
  }
  return err
}

export function connect(target: SshTarget): Promise<{ client: Client; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let fingerprint = ''
    let mismatch = false
    let settled = false

    const cfg: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      tryKeyboard: !!target.password,
      hostVerifier: (key: Buffer) => {
        fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
        if (target.hostFingerprint && target.hostFingerprint !== fingerprint) {
          mismatch = true
          return false
        }
        return true
      }
    }
    if (target.privateKey) {
      cfg.privateKey = target.privateKey
      if (target.passphrase) cfg.passphrase = target.passphrase
    }
    if (target.password) cfg.password = target.password

    client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
      finish(prompts.map(() => target.password ?? ''))
    })
    client.once('ready', () => {
      settled = true
      resolve({ client, fingerprint })
    })
    client.on('error', (err) => {
      if (settled) return
      settled = true
      reject(mismatch ? new HostKeyMismatchError(target.hostFingerprint ?? '', fingerprint) : friendly(err))
    })
    try {
      client.connect(cfg)
    } catch (err) {
      // ssh2 throws synchronously for an unreadable private key.
      settled = true
      const msg = err instanceof Error ? err.message : String(err)
      reject(new Error(/passphrase|encrypted/i.test(msg) ? 'The private key needs a passphrase (or the passphrase is wrong).' : `Invalid private key: ${msg}`))
    }
  })
}

// ---- how scripts travel ----------------------------------------------------
// Scripts normally travel base64-encoded inside `eval "$(… | base64 -d)"` (see
// wrapScript). Some servers answer that form with nothing at all (seen on a
// real Ubuntu server: plain `bash -c` worked, the wrapped form came back empty;
// host security tools treat "decode base64 and eval" as an attack). So the
// first wrapped command on a connection is preceded by a tiny test, and when
// the test fails every wrapped command on that connection is sent as a plain
// single-quoted `bash -c '…'` instead.

export type ScriptTransport = 'b64' | 'plain' | 'file'
const WRAPPED = /^(sudo -S -p '' |sudo -n )?bash -c 'eval "\$\(echo ([A-Za-z0-9+/=]+) \| base64 -d\)"'$/
const transports = new WeakMap<Client, Promise<ScriptTransport>>()

/** The same wrapped command without base64 and eval. Other commands come back unchanged. */
export function plainForm(command: string): string {
  const m = WRAPPED.exec(command)
  if (!m) return command
  return `${m[1] ?? ''}bash -c ${shq(Buffer.from(m[2], 'base64').toString('utf8'))}`
}

/**
 * The same wrapped command as a short one: the script is uploaded to a private
 * temp file (it removes itself as its first step) and bash is pointed at it.
 * Nothing long and nothing base64 is left on the command line, which is what
 * servers that drop the other forms object to.
 */
async function fileForm(client: Client, command: string): Promise<string> {
  const m = WRAPPED.exec(command)
  if (!m) return command
  const script = Buffer.from(m[2], 'base64').toString('utf8')
  const path = `/tmp/.superdevops-${randomBytes(12).toString('hex')}`
  const sftp = await openSftp(client)
  try {
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(path, `unlink "$0" 2>/dev/null\n${script}\n`, { mode: 0o600 }, (err) => (err ? reject(err) : resolve()))
    })
  } finally {
    sftp.end()
  }
  return `${m[1] ?? ''}bash ${path}`
}

/** A script file that never got to run (and so never removed itself) is removed here. */
function sweep(client: Client, command: string): void {
  const m = /bash (\/tmp\/\.superdevops-[0-9a-f]{24})$/.exec(command)
  if (!m) return
  openSftp(client).then(
    (sftp) => sftp.unlink(m[1], () => sftp.end()),
    () => undefined
  )
}

export function transportOf(client: Client): Promise<ScriptTransport> {
  let t = transports.get(client)
  if (!t) {
    const forced = process.env.SUPERDEVOPS_SCRIPT_TRANSPORT
    t =
      forced === 'plain' || forced === 'b64' || forced === 'file'
        ? Promise.resolve(forced as ScriptTransport)
        : (async (): Promise<ScriptTransport> => {
            const said = async (cmd: string): Promise<boolean> =>
              (await rawExec(client, cmd, { timeoutMs: 10000 }).catch(() => null))?.stdout.includes('sd-wrap-ok') ?? false
            const probe = wrapScript('echo sd-wrap-ok')
            if (await said(probe)) return 'b64'
            const short = await fileForm(client, probe).catch(() => 'true')
            if (await said(short)) return 'file'
            sweep(client, short)
            return 'plain'
          })()
    transports.set(client, t)
  }
  return t
}

/** The command to really send on this connection (see the note above). */
export async function prepare(client: Client, command: string): Promise<string> {
  if (!WRAPPED.test(command)) return command
  const mode = await transportOf(client)
  return mode === 'file' ? fileForm(client, command) : mode === 'plain' ? plainForm(command) : command
}

// A server lets one connection hold only so many commands at once (OpenSSH: 10,
// counting terminals and file transfers). Pages that look up many things at the
// same moment wait their turn here instead of being refused by the server.
const MAX_AT_ONCE = 5
const lanes = new WeakMap<Client, { busy: number; waiting: (() => void)[] }>()

async function turn<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  let lane = lanes.get(client)
  if (!lane) lanes.set(client, (lane = { busy: 0, waiting: [] }))
  if (lane.busy >= MAX_AT_ONCE) await new Promise<void>((go) => lane!.waiting.push(go))
  else lane.busy++
  try {
    return await fn()
  } finally {
    // Hand the place straight to the next one waiting, if any.
    const next = lane.waiting.shift()
    if (next) next()
    else lane.busy--
  }
}

/** Open a command channel; when the server says it has no room for one more, wait a moment and ask again. */
async function openExec(client: Client, command: string, opts: ExecOptions): Promise<ExecResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rawExec(client, command, opts)
    } catch (err) {
      if (attempt >= 4 || !/Channel open failure/i.test(String((err as Error)?.message))) throw err
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
    }
  }
}

export function exec(client: Client, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  return turn(client, () => execNow(client, command, opts))
}

async function execNow(client: Client, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const started = Date.now()
  const sent = await prepare(client, command)
  const res = await openExec(client, sent, opts)
  if (res.code !== 0) sweep(client, sent)
  // A command the server drops ends at once with no exit code and not one byte
  // of output (seen with long commands on a real server). Switch this
  // connection to uploaded scripts and run it that way.
  const dropped = res.code === null && !res.stdout && !res.stderr && Date.now() - started < 4000
  if (dropped && WRAPPED.test(command) && (await transportOf(client)) !== 'file') {
    let short: string
    try {
      short = await fileForm(client, command)
    } catch {
      return res
    }
    transports.set(client, Promise.resolve('file'))
    const again = await openExec(client, short, opts)
    if (again.code !== 0) sweep(client, short)
    return again
  }
  return res
}

function rawExec(client: Client, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      let done = false
      const dOut = new StringDecoder('utf8')
      const dErr = new StringDecoder('utf8')
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            if (done) return
            done = true
            stream.close()
            reject(new Error('The command timed out.'))
          }, opts.timeoutMs)
        : undefined

      stream.on('data', (b: Buffer) => {
        const s = dOut.write(b)
        stdout += s
        opts.onData?.(s)
      })
      stream.stderr.on('data', (b: Buffer) => {
        const s = dErr.write(b)
        stderr += s
        opts.onData?.(s)
      })
      stream.on('close', (code: number | null, signal?: string) => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        resolve({ code: code ?? null, stdout, stderr, signal: signal || undefined })
      })
      stream.end(opts.stdin ?? '')
    })
  })
}

/**
 * Wrap a multi-line bash script into one command line. The script travels
 * base64-encoded, so nothing in it needs shell escaping.
 */
/**
 * Scripts used to write files on the server with `echo <base64> | base64 -d`.
 * Some servers stop exactly that (it is how malware unpacks itself), so every
 * such piece is turned into a small function that prints the same text from a
 * here-document, and the function is called in its place. Content that is not
 * plain text is left as it was.
 */
export function withoutBase64(script: string): string {
  const defs: string[] = []
  const body = script.replace(/echo ([A-Za-z0-9+/]{2,}={0,2}) \| base64 -d/g, (whole, b64: string) => {
    const bytes = Buffer.from(b64, 'base64')
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes) || text.includes('\0') || text.includes('\r')) return whole
    let mark = 'SD_EOF'
    while (text.includes(mark)) mark += randomBytes(3).toString('hex')
    const name = `__sd_put_${defs.length}`
    defs.push(
      text.endsWith('\n')
        ? `${name}() { cat <<'${mark}'\n${text.slice(0, -1)}\n${mark}\n}`
        : `${name}() { printf '%s' "$(cat <<'${mark}'\n${text}\n${mark}\n)"; }`
    )
    return name
  })
  return defs.length ? `${defs.join('\n')}\n${body}` : script
}

export function wrapScript(script: string, sudo: SudoMode = 'none'): string {
  const b64 = Buffer.from(withoutBase64(script), 'utf8').toString('base64')
  const inner = `bash -c 'eval "$(echo ${b64} | base64 -d)"'`
  if (sudo === 'password') return `sudo -S -p '' ${inner}`
  if (sudo === 'nopasswd') return `sudo -n ${inner}`
  return inner
}

/** Single-quote a value for safe use inside a shell script. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
  })
}

function sftpMkdir(sftp: SFTPWrapper, dir: string): Promise<void> {
  return new Promise((resolve) => sftp.mkdir(dir, () => resolve()))
}

export function uploadFile(sftp: SFTPWrapper, local: string, remote: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve()))
  })
}

const SKIP = new Set(['.git', 'node_modules', '.DS_Store', '.idea', '.vscode'])

/** Upload a local folder recursively. Returns the number of files sent. */
export async function uploadDir(
  sftp: SFTPWrapper,
  localDir: string,
  remoteDir: string,
  onFile?: (relative: string, count: number) => void
): Promise<number> {
  let count = 0
  const walk = async (local: string, remote: string, rel: string): Promise<void> => {
    await sftpMkdir(sftp, remote)
    const entries = await fs.readdir(local, { withFileTypes: true })
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue
      const l = path.join(local, entry.name)
      const r = `${remote}/${entry.name}`
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(l, r, relPath)
      } else if (entry.isFile()) {
        await uploadFile(sftp, l, r)
        count += 1
        onFile?.(relPath, count)
      }
    }
  }
  await walk(localDir, remoteDir, '')
  return count
}

/**
 * Put text into a private temp file on the server and return its path.
 * Use this for content too large to travel inside a command line (about 100 KB).
 */
export async function writeRemoteTemp(client: Client, content: string): Promise<string> {
  const sftp = await openSftp(client)
  const path = `/tmp/superdevops-up-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  try {
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(path, content, { mode: 0o600 }, (err) => (err ? reject(err) : resolve()))
    })
  } finally {
    sftp.end()
  }
  return path
}
