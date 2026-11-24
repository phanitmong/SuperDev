// Copy a folder from one server to another. The data flows through this app
// (source -> desktop -> destination), so the two servers never need to be
// able to log in to each other.
import type { Client } from 'ssh2'
import type { Sudo } from './deploy'
import { exec, openSftp, shq, wrapScript, prepare } from './ssh'

const SYSTEM_FOLDERS = new Set(['', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/dev', '/proc', '/sys', '/run', '/var', '/root', '/home', '/opt', '/srv', '/tmp'])

/** An absolute path as the file manager gives it: spaces and other characters in names are fine, since every use is quoted. */
function checkPath(input: string, label: string, refuseSystemFolders: boolean): string {
  const p = (input ?? '').trim().replace(/\/+$/, '')
  if (!p.startsWith('/') || /[\0\n\r]/.test(p) || p.includes('//') || p.split('/').includes('..') || p.length > 1000) {
    throw new Error(`${label} must be an absolute path, for example /www/wwwroot/shop.`)
  }
  if (refuseSystemFolders && SYSTEM_FOLDERS.has(p)) throw new Error(`${label}: "${p || '/'}" is a system folder. Choose a sub-folder.`)
  return p
}

function mb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export async function copyFolder(opts: {
  src: Client
  srcSudo: Sudo
  dst: Client
  dstSudo: Sudo
  srcPath: string
  dstPath: string
  log: (chunk: string) => void
}): Promise<void> {
  const { src, srcSudo, dst, dstSudo, log } = opts
  const srcPath = checkPath(opts.srcPath, 'Source', false)
  const dstPath = checkPath(opts.dstPath, 'Destination folder', true)

  log('==> Checking the source folder\n')
  const probe = await exec(
    src,
    wrapScript(`if [ -d ${shq(srcPath)} ]; then du -sk ${shq(srcPath)} 2>/dev/null | cut -f1; elif [ -f ${shq(srcPath)} ]; then echo FILE; du -sk ${shq(srcPath)} 2>/dev/null | cut -f1; else echo MISSING; fi`, srcSudo.mode),
    { stdin: srcSudo.stdin, timeoutMs: 120000 }
  )
  const answer = probe.stdout.trim().split('\n').pop() ?? ''
  // A single file travels the same way: packed from its folder, unpacked into the destination folder.
  const isFile = /(^|\n)FILE(\n|$)/.test(probe.stdout)
  const slash = srcPath.lastIndexOf('/')
  const packFrom = isFile ? srcPath.slice(0, slash) || '/' : srcPath
  const packWhat = isFile ? srcPath.slice(slash + 1) : '.'
  if (answer === 'MISSING') throw new Error(`${srcPath} does not exist on the source server.`)
  if (!/^\d+$/.test(answer)) throw new Error(probe.stderr.trim() || 'Could not read the source folder.')
  log(`${srcPath} · about ${mb(Number(answer) * 1024)}\n`)

  const tmp = `/tmp/superdevops-copy-${Date.now()}.tar.gz`
  const sftp = await openSftp(dst)
  log('\n==> Transferring (compressed)\n')
  const packCommand = await prepare(src, wrapScript(`tar -czf - -C ${shq(packFrom)} -- ${shq(packWhat)}`, srcSudo.mode))
  try {
    await new Promise<void>((resolve, reject) => {
      src.exec(packCommand, (err, stream) => {
        if (err) return reject(err)
        const out = sftp.createWriteStream(tmp, { mode: 0o600 })
        let sent = 0
        let lastLog = Date.now()
        let stderr = ''
        let code: number | null = null
        let finished = false
        let closed = false
        const done = (): void => {
          if (!finished || !closed) return
          if (code !== 0) reject(new Error(stderr.trim().split('\n').pop() || `Reading the source folder failed (exit code ${code}).`))
          else {
            log(`  ${mb(sent)} sent\n`)
            resolve()
          }
        }
        stream.on('data', (b: Buffer) => {
          sent += b.length
          if (Date.now() - lastLog > 2000) {
            lastLog = Date.now()
            log(`  ${mb(sent)}...\n`)
          }
        })
        stream.stderr.on('data', (b: Buffer) => {
          stderr += b.toString('utf8')
        })
        stream.on('close', (c: number | null) => {
          code = c
          closed = true
          done()
        })
        out.on('error', reject)
        out.on('close', () => {
          finished = true
          done()
        })
        stream.pipe(out)
        stream.end(srcSudo.stdin ?? '')
      })
    })

    log('\n==> Unpacking on the destination\n')
    const script = [
      'set -e',
      `DST=${shq(dstPath)}`,
      `TMP=${shq(tmp)}`,
      'mkdir -p "$DST"',
      'tar -xzf "$TMP" -C "$DST"',
      'rm -f "$TMP"',
      'echo "Copied into $DST ($(find "$DST" -type f | wc -l) files there now)"'
    ].join('\n')
    const res = await exec(dst, wrapScript(script, dstSudo.mode), { stdin: dstSudo.stdin, onData: log })
    if (res.code !== 0) {
      if (/a password is required|Sorry, try again|incorrect password/i.test(res.stdout + res.stderr)) {
        throw new Error('The destination user could not use sudo. Check the sudo password on that project.')
      }
      throw new Error(`Unpacking failed on the destination (exit code ${res.code}).`)
    }
    log('\n==> Copy finished\n')
  } catch (err) {
    await new Promise<void>((r) => sftp.unlink(tmp, () => r()))
    throw err
  } finally {
    sftp.end()
  }
}
