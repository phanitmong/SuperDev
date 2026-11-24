// Scheduled tasks, in the style of a hosting panel's "Cron" page. Each task is
// one file in /etc/cron.d plus its script; output goes to a per-task log.
import type { Client } from 'ssh2'
import { randomBytes } from 'node:crypto'
import type { CronOverview, CronTask } from '@shared/types'
import type { Sudo } from './deploy'
import { PATH_EXPORT, runPrivileged } from './deploy'
import { shq } from './ssh'

const DIR = '/etc/superdevops/cron'
const STATE = '/var/lib/superdevops/cron'
const LOGS = '/var/log/superdevops-cron'
const RUNNER = '/usr/local/bin/superdevops-cron-run.sh'
const PREFIX = '/etc/cron.d/superdevops-task-'
const RE_ID = /^t[0-9a-f]{8}$/
const RE_FIELD = /^[0-9*/,-]+$/
const RE_URL = /^https?:\/\/[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+$/

const RUNNER_SCRIPT = `#!/bin/bash
# Managed by SuperDevops. Runs one scheduled task and records its output.
export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ID=$1
LOG=${LOGS}/$ID.log
mkdir -p ${LOGS} ${STATE}
{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') start"
  bash "${DIR}/$ID.sh"
  code=$?
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') finished with exit code $code"
} >> "$LOG" 2>&1
echo "$(date +%s) $code" > "${STATE}/$ID.last"
# Keep the log from growing without limit.
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit $code
`

function int(v: number, lo: number, hi: number, name: string): number {
  if (!(Number.isInteger(v) && v >= lo && v <= hi)) throw new Error(`${name} must be between ${lo} and ${hi}.`)
  return v
}

/** Turn the friendly schedule into a 5-field cron expression. */
export function expression(t: CronTask): string {
  switch (t.kind) {
    case 'minutes':
      return `*/${int(t.every, 1, 59, 'Minutes')} * * * *`
    case 'hourly':
      return `${int(t.minute, 0, 59, 'Minute')} * * * *`
    case 'daily':
      return `${int(t.minute, 0, 59, 'Minute')} ${int(t.hour, 0, 23, 'Hour')} * * *`
    case 'weekly':
      return `${int(t.minute, 0, 59, 'Minute')} ${int(t.hour, 0, 23, 'Hour')} * * ${int(t.weekday, 0, 6, 'Day of week')}`
    case 'monthly':
      return `${int(t.minute, 0, 59, 'Minute')} ${int(t.hour, 0, 23, 'Hour')} ${int(t.day, 1, 31, 'Day of month')} * *`
    case 'custom': {
      const f = t.expr.trim().split(/\s+/)
      if (f.length !== 5 || !f.every((x) => RE_FIELD.test(x))) throw new Error('A custom schedule needs 5 fields, for example: */10 8-18 * * 1-5')
      return f.join(' ')
    }
    default:
      throw new Error('Unknown schedule type.')
  }
}

export async function list(client: Client, sudo: Sudo): Promise<CronOverview> {
  const script = `${PATH_EXPORT}
echo "@@daemon"; (pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1) && echo yes || echo no
for f in ${PREFIX}*; do
  [ -f "$f" ] || continue
  id=\${f#${PREFIX}}
  echo "@@task $id"
  grep '^# meta: ' "$f" | head -1
  echo "last: $(cat ${STATE}/$id.last 2>/dev/null)"
  echo "script64: $(base64 -w0 ${DIR}/$id.sh 2>/dev/null)"
done
echo "@@other"
crontab -l -u root 2>/dev/null | grep -vE '^[[:space:]]*(#|$)' || true`
  const res = await runPrivileged(client, script, sudo, undefined, 30000)
  const out: CronOverview = { daemonRunning: false, tasks: [], other: [] }
  let mode = ''
  let cur: CronTask | null = null
  for (const line of res.stdout.split('\n')) {
    if (line === '@@daemon' || line === '@@other') {
      mode = line.slice(2)
      cur = null
      continue
    }
    if (line.startsWith('@@task ')) {
      mode = 'task'
      cur = null
      continue
    }
    if (mode === 'daemon' && line.trim()) out.daemonRunning = line.trim() === 'yes'
    if (mode === 'other' && line.trim()) out.other.push(line.trim())
    if (mode === 'task') {
      if (line.startsWith('# meta: ')) {
        try {
          cur = JSON.parse(Buffer.from(line.slice(8).trim(), 'base64').toString('utf8')) as CronTask
          out.tasks.push(cur)
        } catch {
          cur = null
        }
      } else if (cur && line.startsWith('last: ')) {
        const [ts, code] = line.slice(6).trim().split(' ')
        if (/^\d+$/.test(ts ?? '')) {
          cur.lastRun = Number(ts) * 1000
          cur.lastExit = Number(code)
        }
      } else if (cur && line.startsWith('script64: ') && cur.type === 'shell') {
        // The script file on the server is the source of truth for the command text.
        const text = Buffer.from(line.slice(10).trim(), 'base64').toString('utf8')
        if (text) cur.command = text.replace(/\n$/, '')
      }
    }
  }
  out.tasks.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

export async function save(client: Client, sudo: Sudo, input: CronTask): Promise<string> {
  const id = input.id || `t${randomBytes(4).toString('hex')}`
  if (!RE_ID.test(id)) throw new Error('Unknown task.')
  const name = input.name.trim()
  if (!name || name.length > 60 || /[\r\n]/.test(name)) throw new Error('Give the task a name (up to 60 characters).')
  const command = input.command.trim()
  if (!command) throw new Error(input.type === 'url' ? 'Enter the URL to visit.' : 'Enter the command to run.')
  let body: string
  if (input.type === 'url') {
    if (!RE_URL.test(command)) throw new Error('Enter a full URL starting with http:// or https://')
    body = `curl -fsS -L -m 120 -o /dev/null -w 'HTTP %{http_code} in %{time_total}s\\n' ${shq(command)}\n`
  } else if (input.type === 'shell') {
    if (command.length > 20000) throw new Error('The command is too long.')
    body = command.replace(/\r\n/g, '\n') + '\n'
  } else {
    throw new Error('Unknown task type.')
  }
  const expr = expression(input)
  const task: CronTask = { ...input, id, name, command: input.type === 'url' ? command : '', lastRun: undefined, lastExit: undefined }
  const meta = Buffer.from(JSON.stringify(task)).toString('base64')
  const line = `${expr} root ${RUNNER} ${id} >/dev/null 2>&1`
  const file = [
    '# Managed by SuperDevops. Edit this task in the app, not here.',
    `# meta: ${meta}`,
    'SHELL=/bin/bash',
    input.enabled ? line : `#OFF ${line}`,
    ''
  ].join('\n')
  const script = `set -e
umask 077
mkdir -p ${DIR} ${STATE} ${LOGS}
echo ${Buffer.from(RUNNER_SCRIPT).toString('base64')} | base64 -d > ${RUNNER}
chmod 700 ${RUNNER}
echo ${Buffer.from(body).toString('base64')} | base64 -d > ${DIR}/${id}.sh
chmod 700 ${DIR}/${id}.sh
echo ${Buffer.from(file).toString('base64')} | base64 -d > ${PREFIX}${id}
chmod 644 ${PREFIX}${id}`
  await runPrivileged(client, script, sudo, undefined, 20000)
  return id
}

export async function remove(client: Client, sudo: Sudo, id: string): Promise<void> {
  if (!RE_ID.test(id)) throw new Error('Unknown task.')
  await runPrivileged(client, `rm -f ${PREFIX}${id} ${DIR}/${id}.sh ${STATE}/${id}.last ${LOGS}/${id}.log`, sudo, undefined, 20000)
}

/** Run the task right now, exactly as cron would, and stream what it prints. */
export async function runNow(client: Client, sudo: Sudo, id: string, log: (s: string) => void): Promise<void> {
  if (!RE_ID.test(id)) throw new Error('Unknown task.')
  const script = `[ -f ${DIR}/${id}.sh ] || { echo "This task no longer exists on the server."; exit 70; }
BEFORE=$(wc -l < ${LOGS}/${id}.log 2>/dev/null || echo 0)
${RUNNER} ${id}; code=$?
tail -n +$((BEFORE + 1)) ${LOGS}/${id}.log 2>/dev/null
exit $code`
  await runPrivileged(client, script, sudo, log)
}

export async function readLog(client: Client, sudo: Sudo, id: string): Promise<string> {
  if (!RE_ID.test(id)) throw new Error('Unknown task.')
  const res = await runPrivileged(client, `tail -n 400 ${LOGS}/${id}.log 2>/dev/null || true`, sudo, undefined, 20000)
  return res.stdout
}
