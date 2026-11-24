// Updates of this app, downloaded from the team's own service (src/server/updates.ts).
// After sign-in and every 6 hours: ask the service for the newest version; when it is newer, download this
// computer's file in the background, check its SHA-256, and tell the window, which offers "Restart to update".
// Installing: Windows runs the installer silently and starts the app again; macOS swaps the .app bundle
// (the app is not signed by Apple, so the system's own updater cannot be used); Linux swaps the AppImage.
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, chmodSync, constants, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { UpdateState } from '@shared/team'


interface Release {
  version: string
  notes: string
  files: Record<string, { name: string; size: number; sha256: string }>
}

let opts: { url: () => string; token: () => string | null; notify: (s: UpdateState) => void; quit: () => void } | null = null
let state: UpdateState = { current: '' }
let timer: ReturnType<typeof setInterval> | undefined
let busy = false
let readyFile = ''

function set(next: Partial<UpdateState>): void {
  state = { ...state, ...next }
  opts?.notify(state)
}

export function updateState(): UpdateState {
  return state
}

/** 1.10.0 > 1.9.3 */
export function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}

function platformKey(): string {
  const os = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'
  return `${os}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
}

/** Updates only make sense in an installed app (or when a test asks for them). */
function enabled(): boolean {
  return app.isPackaged || process.env.APSARA_UPDATE_TEST === '1'
}

function currentVersion(): string {
  return process.env.APSARA_UPDATE_TEST === '1' && process.env.APSARA_UPDATE_VERSION ? process.env.APSARA_UPDATE_VERSION : app.getVersion()
}

export function startUpdater(o: NonNullable<typeof opts>): void {
  opts = o
  state = { current: currentVersion() }
  if (timer) clearInterval(timer)
  timer = setInterval(() => void checkNow(), 6 * 60 * 60 * 1000)
}

function dir(): string {
  const d = join(app.getPath('userData'), 'updates')
  mkdirSync(d, { recursive: true })
  return d
}

function fileSha(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

/** Ask the service; download when there is something newer. Quiet on failure: it is tried again later. */
export async function checkNow(): Promise<UpdateState> {
  if (!opts || !enabled() || busy || state.ready) return state
  const token = opts.token()
  const base = opts.url()
  if (!token || !base) return state
  busy = true
  try {
    const res = await fetch(`${base}/app/latest.json`, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) return state
    const rel = (await res.json()) as Release
    if (!rel.version || !newer(rel.version, state.current)) {
      set({ available: undefined, error: undefined })
      return state
    }
    const f = rel.files?.[platformKey()]
    if (!f || !/^ApsaraPanel-[A-Za-z0-9_.-]+$/.test(f.name)) return state
    set({ available: rel.version, notes: rel.notes, progress: 0, error: undefined })
    const dest = join(dir(), `${rel.version}-${f.name}`)
    if (!existsSync(dest) || statSync(dest).size !== f.size || (await fileSha(dest)) !== f.sha256) {
      await download(`${base}/app/file/${platformKey()}`, token, dest, f.size)
      const sum = await fileSha(dest)
      if (sum !== f.sha256) {
        rmSync(dest, { force: true })
        throw new Error('The downloaded update was damaged; it will be fetched again later.')
      }
    }
    // Older downloads only take space.
    for (const n of readdirSync(dir())) if (join(dir(), n) !== dest && !n.startsWith('unpack')) rmSync(join(dir(), n), { recursive: true, force: true })
    readyFile = dest
    set({ progress: 100, ready: true })
  } catch (err) {
    set({ error: err instanceof Error ? err.message : String(err), progress: undefined })
  } finally {
    busy = false
  }
  return state
}

async function download(url: string, token: string, dest: string, size: number): Promise<void> {
  const part = dest + '.part'
  let have = existsSync(part) ? statSync(part).size : 0
  if (have > size) {
    rmSync(part, { force: true })
    have = 0
  }
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, ...(have ? { range: `bytes=${have}-` } : {}) } })
  if (!res.ok || !res.body) throw new Error(`The service answered ${res.status} for the update.`)
  if (have && res.status !== 206) have = 0
  const out = createWriteStream(part, { flags: have ? 'a' : 'w' })
  let got = have
  let last = -1
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r))
      got += value.length
      const pct = Math.floor((got / size) * 100)
      if (pct !== last && pct < 100) {
        last = pct
        set({ progress: pct })
      }
    }
  } finally {
    await new Promise((r) => out.end(r))
  }
  if (statSync(part).size !== size) throw new Error('The update download stopped early; it continues at the next check.')
  renameSync(part, dest)
}

/** Install the downloaded version and start it. The app quits. */
export function install(): void {
  if (!state.ready || !readyFile || !existsSync(readyFile) || !opts) throw new Error('No update is ready.')
  const file = readyFile
  if (process.platform === 'win32') {
    // NSIS: /S installs silently into the same place; --force-run starts the app when it is done.
    spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref()
    return opts.quit()
  }
  if (process.platform === 'darwin') {
    const bundle = dirname(dirname(dirname(app.getPath('exe'))))
    if (!bundle.endsWith('.app')) throw new Error('This copy of the app is not an installed .app, so it cannot replace itself.')
    try {
      accessSync(dirname(bundle), constants.W_OK)
    } catch {
      throw new Error(`The app cannot write to ${dirname(bundle)}. Drag the new version in by hand, or move Apsara Panel to a folder you can write to.`)
    }
    const unpack = join(dir(), 'unpack')
    rmSync(unpack, { recursive: true, force: true })
    mkdirSync(unpack, { recursive: true })
    const script = join(dir(), 'apply-update.sh')
    writeFileSync(
      script,
      [
        '#!/bin/bash',
        'PID="$1"; ZIP="$2"; DEST="$3"; WORK="$4"',
        'for i in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done',
        'ditto -x -k "$ZIP" "$WORK" || { open "$DEST"; exit 1; }',
        'NEW=$(find "$WORK" -maxdepth 2 -name "*.app" -type d | head -1)',
        '[ -n "$NEW" ] || { open "$DEST"; exit 1; }',
        'rm -rf "$DEST.old"',
        'if mv "$DEST" "$DEST.old" && ditto "$NEW" "$DEST"; then rm -rf "$DEST.old"; else rm -rf "$DEST"; mv "$DEST.old" "$DEST"; fi',
        'xattr -dr com.apple.quarantine "$DEST" 2>/dev/null',
        'rm -rf "$WORK"',
        'open "$DEST"',
        ''
      ].join('\n'),
      { mode: 0o700 }
    )
    spawn('/bin/bash', [script, String(process.pid), file, bundle, unpack], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref()
    return opts.quit()
  }
  // Linux AppImage: swap the file the app was started from.
  const image = process.env.APPIMAGE
  if (!image) throw new Error('Only the AppImage can update itself on Linux.')
  copyAndSwap(file, image)
  spawn(image, [], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref()
  opts.quit()
}

function copyAndSwap(from: string, to: string): void {
  const tmp = to + '.new'
  // Synchronous copy keeps the swap simple; AppImages are a few hundred MB at most.
  copyFileSync(from, tmp)
  chmodSync(tmp, 0o755)
  renameSync(tmp, to)
}
