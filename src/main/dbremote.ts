// Scheduled backups of a database that lives on another machine (a saved
// connection in Database Remote). One of the managed servers does the work:
// its Google Drive job connects to the database once a day, dumps the chosen
// databases and uploads them with everything else it copies to Drive.
//
// On that server: /etc/superdevops/dbremote/<connection id>.cnf holds how to
// connect (root only, with the password) and <id>.conf what to back up.
import type { Client } from 'ssh2'
import type { DbRemoteSchedule, DbRemoteStatus, DbRemoteWhen } from '@shared/types'
import type { Sudo } from './deploy'
import { PATH_EXPORT, runPrivileged } from './deploy'
import { downloadPath } from './database'
import { JOB, REMOTE_CONF, REMOTE_DIR, refreshJob } from './gdrive'
import { exec, shq, writeRemoteTemp } from './ssh'

const STATE = '/var/lib/superdevops/gdrive'
const RE_ID = /^[A-Za-z0-9-]{8,64}$/
// The same letters the app's own backup files use, so a copy brought to this computer can be restored there.
const RE_DB = /^[A-Za-z0-9_]{1,64}$/
const RE_FILE = /^remote-[A-Za-z0-9_]{1,40}-[A-Za-z0-9_]{1,64}-\d{8}-\d{6}\.sql\.gz$/

export interface RemoteTarget {
  id: string
  name: string
  host: string
  port: number
  username: string
  password: string
}

const CRON = '/etc/cron.d/superdevops-dbremote'
export const DEFAULT_WHEN: DbRemoteWhen = { kind: 'daily', every: 30, minute: 30, hour: 2, weekday: 0, day: 1 }

function cleanWhen(w: Partial<DbRemoteWhen> | undefined): DbRemoteWhen {
  const n = (v: unknown, lo: number, hi: number, d: number, what: string): number => {
    if (v === undefined || v === null || v === '') return d
    const x = Math.floor(Number(v))
    if (!(x >= lo && x <= hi)) throw new Error(`${what} must be between ${lo} and ${hi}.`)
    return x
  }
  const kind = w?.kind ?? 'daily'
  if (!['minutes', 'hourly', 'daily', 'weekly', 'monthly'].includes(kind)) throw new Error('Choose when the backup runs.')
  // A full backup more often than every 5 minutes fills disks and overlaps itself.
  return { kind, every: n(w?.every, 5, 59, 30, 'Minutes'), minute: n(w?.minute, 0, 59, 30, 'Minute'), hour: n(w?.hour, 0, 23, 2, 'Hour'), weekday: n(w?.weekday, 0, 6, 0, 'Day of the week'), day: n(w?.day, 1, 28, 1, 'Day of the month') }
}

/** The five cron fields for a schedule. */
export function cronOf(w: DbRemoteWhen): string {
  switch (w.kind) {
    case 'minutes':
      return `*/${w.every} * * * *`
    case 'hourly':
      return `${w.minute} * * * *`
    case 'weekly':
      return `${w.minute} ${w.hour} * * ${w.weekday}`
    case 'monthly':
      return `${w.minute} ${w.hour} ${w.day} * *`
    default:
      return `${w.minute} ${w.hour} * * *`
  }
}

/** Shell that rewrites the one cron file from every connection's settings on the server. */
const REWRITE_CRON = `{
  echo '# Managed by SuperDevops. Scheduled backups of databases on other machines.'
  for C in ${REMOTE_CONF}/*.conf; do
    [ -f "$C" ] || continue
    SCHED=""; . "$C"
    [ -n "$SCHED" ] || SCHED="30 2 * * *"
    echo "$SCHED root ${JOB} rdb $(basename "$C" .conf) >/dev/null 2>&1"
  done
} > ${CRON}.new
if grep -q ' rdb ' ${CRON}.new; then mv ${CRON}.new ${CRON}; chmod 644 ${CRON}; else unlink ${CRON}.new; [ -e ${CRON} ] && unlink ${CRON}; fi
true`

/** A name for file names: letters, numbers and underscore only. */
export function labelOf(name: string): string {
  return name.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'database'
}

function checkId(id: string): string {
  if (!RE_ID.test(String(id))) throw new Error('Unknown connection.')
  return id
}

/** Turn scheduled backups on for a connection, or change which databases they cover. */
export async function setup(client: Client, sudo: Sudo, t: RemoteTarget, databases: string[], whenIn: Partial<DbRemoteWhen> | undefined, log: (s: string) => void): Promise<void> {
  checkId(t.id)
  const when = cleanWhen(whenIn)
  const dbs = [...new Set(databases.map((d) => String(d).trim()).filter(Boolean))]
  if (dbs.length === 0) throw new Error('Choose at least one database.')
  if (dbs.length > 50) throw new Error('Choose up to 50 databases.')
  for (const d of dbs) if (!RE_DB.test(d)) throw new Error(`The database "${d}" has a name with other characters than letters, numbers and underscore, which scheduled backups cannot handle yet.`)
  if (!t.host || /[\s"'\\]/.test(t.host)) throw new Error('The host of this connection cannot be used on a server.')
  if (!t.username || /[\r\n]/.test(t.username)) throw new Error('The user name of this connection cannot be used on a server.')
  if (/[\r\n\0]/.test(t.password)) throw new Error('The password of this connection contains a line break, which cannot be stored on the server.')
  if (!(await refreshJob(client, sudo))) throw new Error('Google Drive is not connected on that server yet. Open its Backups page, connect Google Drive, then come back.')

  const quote = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const cnf = ['# Managed by SuperDevops. How this server reaches a database on another machine.', '[client]', `host=${t.host}`, `port=${t.port}`, `user=${quote(t.username)}`, `password=${quote(t.password)}`, '', '[mysql]', 'connect-timeout=20', ''].join('\n')
  const label = labelOf(t.name)
  const conf = [`LABEL=${shq(label)}`, `DBS=${shq(dbs.join(' '))}`, `HOST=${shq(`${t.host}:${t.port}`)}`, `NAME=${shq(t.name.replace(/[\r\n]/g, ' ').slice(0, 80))}`, `SCHED=${shq(cronOf(when))}`, `WHEN=${shq([when.kind, when.every, when.minute, when.hour, when.weekday, when.day].join(' '))}`, ''].join('\n')
  const upCnf = await writeRemoteTemp(client, cnf)
  const script = `${PATH_EXPORT}
export LC_ALL=C
TMP=${shq(upCnf)}
trap '[ -e "$TMP" ] && unlink "$TMP"' EXIT
SQL=$(command -v mariadb || command -v mysql)
DUMP=$(command -v mariadb-dump || command -v mysqldump)
if [ -z "$SQL" ] || [ -z "$DUMP" ]; then
  echo "==> Installing the database client programs"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y >/dev/null 2>&1 || true
    apt-get install -y mariadb-client >/dev/null 2>&1 || apt-get install -y default-mysql-client >/dev/null 2>&1
  elif command -v dnf >/dev/null 2>&1; then dnf install -y mariadb >/dev/null 2>&1
  elif command -v yum >/dev/null 2>&1; then yum install -y mariadb >/dev/null 2>&1
  fi
  SQL=$(command -v mariadb || command -v mysql)
  DUMP=$(command -v mariadb-dump || command -v mysqldump)
  if [ -z "$SQL" ] || [ -z "$DUMP" ]; then echo "The programs mysql and mysqldump are not on this server and could not be installed."; exit 91; fi
fi
umask 077
mkdir -p ${REMOTE_CONF} ${REMOTE_DIR}
NEW=${REMOTE_CONF}/${t.id}.cnf.new
cat "$TMP" > "$NEW"
echo "==> Checking that this server can reach ${t.host}:${t.port}"
OUT=$("$SQL" --defaults-extra-file="$NEW" -N -B -e "SELECT VERSION()" 2>&1)
if [ $? -ne 0 ]; then
  unlink "$NEW"
  echo "This server could not sign in to the database: $(echo "$OUT" | tail -1)"
  echo "The database must accept connections from this server (its address, the database user's allowed hosts, and any firewall in between)."
  exit 92
fi
echo "Connected: $OUT"
for db in ${dbs.map(shq).join(' ')}; do
  if ! "$SQL" --defaults-extra-file="$NEW" -N -B -e "SELECT 1" "$db" >/dev/null 2>&1; then unlink "$NEW"; echo "The database $db cannot be opened with this connection's user."; exit 93; fi
done
mv "$NEW" ${REMOTE_CONF}/${t.id}.cnf
cat > ${REMOTE_CONF}/${t.id}.conf <<'SDEOF'
${conf}SDEOF
chmod 600 ${REMOTE_CONF}/${t.id}.cnf ${REMOTE_CONF}/${t.id}.conf
chmod 700 ${REMOTE_CONF}
${REWRITE_CRON}
pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1 || echo "Note: the cron service is not running on this server, so nothing scheduled will run until it is started."
echo "==> Scheduled. ${dbs.length} database${dbs.length === 1 ? '' : 's'}, ${describeWhen(when)} (server time), backed up by this server and uploaded to its Google Drive folder."`
  try {
    await runPrivileged(client, script, sudo, log, 10 * 60 * 1000)
  } finally {
    await exec(client, `[ -e ${shq(upCnf)} ] && unlink ${shq(upCnf)}; true`, { timeoutMs: 10000 }).catch(() => undefined)
  }
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const p2 = (n: number): string => String(n).padStart(2, '0')
export function describeWhen(w: DbRemoteWhen): string {
  switch (w.kind) {
    case 'minutes':
      return `every ${w.every} minutes`
    case 'hourly':
      return `every hour at ${p2(w.minute)} minutes past`
    case 'weekly':
      return `every ${DAYS[w.weekday]} at ${p2(w.hour)}:${p2(w.minute)}`
    case 'monthly':
      return `on day ${w.day} of each month at ${p2(w.hour)}:${p2(w.minute)}`
    default:
      return `every day at ${p2(w.hour)}:${p2(w.minute)}`
  }
}

/** Back one connection's databases up now and upload them, whatever its schedule says. */
export async function runNow(client: Client, sudo: Sudo, id: string, log: (s: string) => void): Promise<void> {
  checkId(id)
  if (!(await refreshJob(client, sudo))) throw new Error('Google Drive is not connected on that server.')
  await runPrivileged(client, `[ -f ${REMOTE_CONF}/${id}.conf ] || { echo "Scheduled backups are not switched on for this connection on this server."; exit 94; }\n${JOB} rdb ${id}\nR=$(cut -d'|' -f2 /var/lib/superdevops/gdrive/remote-${id}.last 2>/dev/null)\n[ "$R" = ok ] || exit 95`, sudo, log, 4 * 60 * 60 * 1000)
}

/** What this server backs up for other machines, and the files it holds. Passwords are never read back. */
export async function status(client: Client, sudo: Sudo): Promise<DbRemoteStatus> {
  const script = `export LC_ALL=C
if [ -f /etc/superdevops/gdrive/conf ] && [ -f /etc/superdevops/gdrive/token ]; then echo "@@drive=1"; else echo "@@drive=0"; fi
echo "@@now=$(date '+%H:%M %Z')"
for C in ${REMOTE_CONF}/*.conf; do
  [ -f "$C" ] || continue
  ID=$(basename "$C" .conf); LABEL=""; DBS=""; HOST=""; NAME=""; WHEN=""
  . "$C"
  printf '@@item\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$ID" "$LABEL" "$HOST" "$DBS" "$(cat ${STATE}/remote-$ID.last 2>/dev/null)" "$NAME" "$WHEN"
done
echo "@@files"
if [ -d ${REMOTE_DIR} ]; then find ${REMOTE_DIR} -maxdepth 1 -type f -name 'remote-*.sql.gz' -printf '%f\\t%s\\t%T@\\n' | sort -t "$(printf '\\t')" -k3,3nr | head -300; fi
echo "@@uploaded"
cut -d'|' -f1 ${STATE}/uploaded.list 2>/dev/null | grep '^remote-' | tail -2000`
  const res = await runPrivileged(client, script, sudo, undefined, 30000)
  const out = res.stdout
  const kv = (k: string): string => new RegExp(`^@@${k}=(.*)$`, 'm').exec(out)?.[1].trim() ?? ''
  const [head, rest = ''] = out.split('@@files\n')
  const [fileText, upText = ''] = rest.split('@@uploaded\n')
  const uploaded = new Set(upText.split('\n').map((x) => x.trim()).filter(Boolean))
  const files = fileText
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((p) => RE_FILE.test(p[0] ?? ''))
    .map(([name, size, at]) => ({ name, size: Number(size) || 0, at: Math.round(Number(at) * 1000) || 0, inDrive: uploaded.has(name) }))
  const schedules: DbRemoteSchedule[] = head
    .split('\n')
    .filter((l) => l.startsWith('@@item\t'))
    .map((l) => l.split('\t'))
    .map(([, id, label, host, dbs, last, name, whenText]) => {
      const [at, result, ...msg] = (last ?? '').split('|')
      const [kind, every, minute, hour, weekday, day] = (whenText ?? '').split(' ')
      let when = DEFAULT_WHEN
      try {
        if (kind) when = cleanWhen({ kind: kind as DbRemoteWhen['kind'], every: Number(every), minute: Number(minute), hour: Number(hour), weekday: Number(weekday), day: Number(day) })
      } catch {
        when = DEFAULT_WHEN
      }
      return {
        id,
        label,
        name: name || label,
        host,
        databases: (dbs ?? '').split(' ').filter(Boolean),
        when,
        last: at ? { at: Number(at) * 1000, ok: result === 'ok', message: msg.join('|') } : undefined,
        files: files.filter((f) => f.name.startsWith(`remote-${label}-`))
      }
    })
  return { driveConnected: kv('drive') === '1', serverTime: kv('now'), schedules }
}

/** Stop backing a connection up from this server and forget how to reach it. Backups already made stay. */
export async function remove(client: Client, sudo: Sudo, id: string): Promise<void> {
  checkId(id)
  await runPrivileged(client, `for f in ${REMOTE_CONF}/${id}.conf ${REMOTE_CONF}/${id}.cnf ${STATE}/remote-${id}.last; do [ -e "$f" ] && unlink "$f"; done\n${REWRITE_CRON}`, sudo, undefined, 20000)
}

/** Which database a scheduled backup file holds, given the label its connection has. */
export function databaseOf(file: string, label: string): string {
  if (!RE_FILE.test(String(file)) || !file.startsWith(`remote-${label}-`)) throw new Error('Unknown backup file.')
  return file.slice(`remote-${label}-`.length).replace(/-\d{8}-\d{6}\.sql\.gz$/, '')
}

/** Copy one scheduled backup from the server to a file on this computer. */
export async function pull(client: Client, sudo: Sudo, file: string, localPath: string): Promise<void> {
  if (!RE_FILE.test(String(file))) throw new Error('Unknown backup file.')
  await downloadPath(client, sudo, `${REMOTE_DIR}/${file}`, localPath)
}
