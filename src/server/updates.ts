// New versions of the desktop app, handed out by this service. An admin (or the deploy) publishes a folder of
// installers with `node server.js app-release <folder> <version> [notes]`; signed-in apps ask /app/latest.json and
// download their own file from /app/file/<platform>. Nothing here is public: every request needs a session.
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

export interface ReleaseFile {
  name: string
  size: number
  sha256: string
}

export interface Release {
  version: string
  notes: string
  date: number
  /** Keyed by platform: mac-arm64, mac-x64, win-x64, linux-x64. */
  files: Record<string, ReleaseFile>
}

let DIR = ''

export function configureUpdates(dataDir: string): void {
  DIR = join(dataDir, 'app-updates')
}

const RE_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/
const RE_FILE = /^ApsaraPanel-(mac|win|linux)-(arm64|x64|x86_64)\.(zip|exe|AppImage)$/

export function latest(): Release | null {
  try {
    const r = JSON.parse(readFileSync(join(DIR, 'latest.json'), 'utf8')) as Release
    return RE_VERSION.test(r.version) ? r : null
  } catch {
    return null
  }
}

function sha256(path: string): string {
  const h = createHash('sha256')
  const buf = Buffer.alloc(4 * 1024 * 1024)
  const fd = openSync(path, 'r')
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      h.update(buf.subarray(0, n))
    }
  } finally {
    closeSync(fd)
  }
  return h.digest('hex')
}

/** Copy the installers in `folder` in as `version` and make it the one apps are offered. Keeps the previous version too. */
export function publish(folder: string, version: string, notes: string): Release {
  if (!RE_VERSION.test(version)) throw new Error('The version must look like 1.2.3.')
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`No folder ${folder}.`)
  const found = readdirSync(folder).filter((n) => RE_FILE.test(n))
  if (found.length === 0) throw new Error('No installers found. Expected ApsaraPanel-mac-arm64.zip, ApsaraPanel-mac-x64.zip, ApsaraPanel-win-x64.exe or ApsaraPanel-linux-x86_64.AppImage.')
  const target = join(DIR, version)
  mkdirSync(target, { recursive: true, mode: 0o700 })
  const before = latest()
  // Publishing the same version again adds platforms (Windows today, the Mac build tomorrow) instead of replacing them.
  const files: Record<string, ReleaseFile> = before?.version === version ? { ...before.files } : {}
  for (const name of found) {
    const m = RE_FILE.exec(name)!
    const key = `${m[1]}-${m[2] === 'x86_64' ? 'x64' : m[2]}`
    const dest = join(target, name)
    copyFileSync(join(folder, name), dest + '.part')
    renameSync(dest + '.part', dest)
    files[key] = { name, size: statSync(dest).size, sha256: sha256(dest) }
  }
  const release: Release = { version, notes: (notes || (before?.version === version ? before.notes : '')).slice(0, 2000), date: Date.now(), files }
  writeFileSync(join(DIR, 'latest.json.tmp'), JSON.stringify(release, null, 2), { mode: 0o600 })
  renameSync(join(DIR, 'latest.json.tmp'), join(DIR, 'latest.json'))
  // Keep this version and the one before it; older folders only take space.
  for (const d of readdirSync(DIR)) {
    if (RE_VERSION.test(d) && d !== version && d !== before?.version) rmSync(join(DIR, d), { recursive: true, force: true })
  }
  return release
}

/** GET /app/latest.json and GET /app/file/<platform>. `signedIn` checks the bearer token. */
export function handle(req: IncomingMessage, res: ServerResponse, path: string, signedIn: (token: string) => boolean): boolean {
  if (!path.startsWith('/app/')) return false
  const deny = (code: number, error: string): true => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error }))
    return true
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'Method not allowed.')
  const auth = String(req.headers.authorization ?? '')
  const token = /^Bearer ([0-9a-f]{64})$/.exec(auth)?.[1]
  if (!token || !signedIn(token)) return deny(401, 'Sign in first.')
  const rel = latest()
  if (path === '/app/latest.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(rel ?? { version: '' }))
    return true
  }
  const key = /^\/app\/file\/([a-z]+-[a-z0-9]+)$/.exec(path)?.[1]
  const f = key && rel ? rel.files[key] : undefined
  if (!f || !rel) return deny(404, 'No such file.')
  const file = join(DIR, rel.version, f.name)
  if (!existsSync(file)) return deny(404, 'No such file.')
  const size = statSync(file).size
  // A broken download continues where it stopped.
  const range = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''))
  const start = range ? Math.min(Number(range[1]), size) : 0
  res.writeHead(range ? 206 : 200, {
    'content-type': 'application/octet-stream',
    'content-length': String(size - start),
    'accept-ranges': 'bytes',
    ...(range ? { 'content-range': `bytes ${start}-${size - 1}/${size}` } : {}),
    'cache-control': 'no-store',
    'x-sha256': f.sha256
  })
  if (req.method === 'HEAD' || start >= size) {
    res.end()
    return true
  }
  createReadStream(file, { start }).pipe(res)
  return true
}
