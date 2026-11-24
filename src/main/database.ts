// MySQL / MariaDB management: databases, users, dumps, restore and a daily
// backup schedule. Uses the server's root socket login (sudo mysql), which is
// the default on Debian, Ubuntu and MariaDB packages.
import type { Client } from 'ssh2'
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import type { DbAccess, DbBackup, DbInfo, DbOverview, DbSchedule, DbUser } from '@shared/types'
import type { Sudo } from './deploy'
import { PATH_EXPORT, runPrivileged } from './deploy'
import { shq, wrapScript } from './ssh'
import { repoLines } from './versions'

const HEAD = `export LC_ALL=C\n${PATH_EXPORT}\nSQL=$(command -v mariadb || command -v mysql || true)\nDUMP=$(command -v mariadb-dump || command -v mysqldump || true)`
const DIR = '/var/backups/superdevops/mysql'
const CRON = '/etc/cron.d/superdevops-dbbackup'
const JOB = '/usr/local/bin/superdevops-dbbackup.sh'
const SYSTEM_DBS = `'information_schema','performance_schema','mysql','sys'`
const RE_NAME = /^[A-Za-z0-9_]{1,48}$/
const RE_USER = /^[A-Za-z0-9_]{1,32}$/
const RE_PASS = /^[A-Za-z0-9!@#%^*_+=.,:-]{8,64}$/
const RE_FILE = /^[A-Za-z0-9_]{1,48}-\d{8}-\d{6}\.sql\.gz$/

function checkDb(name: string): string {
  if (!RE_NAME.test(name)) throw new Error('Database names may only use letters, numbers and underscore.')
  if (['information_schema', 'performance_schema', 'mysql', 'sys'].includes(name.toLowerCase())) throw new Error('That is a system database.')
  return name
}

function checkFile(file: string): string {
  if (!RE_FILE.test(file)) throw new Error('Unknown backup file.')
  return `${DIR}/${file}`
}

export function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  return [...randomBytes(20)].map((b) => chars[b % chars.length]).join('')
}

export async function overview(client: Client, sudo: Sudo): Promise<DbOverview> {
  const script = `${HEAD}
PM=""; for p in apt-get dnf yum; do if command -v "$p" >/dev/null 2>&1; then PM="$p"; break; fi; done
echo "@@pm"; echo "$PM"
echo "@@installed"; [ -n "$SQL" ] && echo yes || echo no
if [ -n "$SQL" ]; then
  echo "@@version"; "$SQL" -N -B -e "SELECT VERSION()" 2>&1
  echo "@@dbs"; "$SQL" -N -B -e "SELECT s.schema_name, COALESCE(SUM(t.data_length + t.index_length), 0), COUNT(t.table_name) FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name WHERE s.schema_name NOT IN (${SYSTEM_DBS}) GROUP BY s.schema_name ORDER BY s.schema_name" 2>/dev/null
  echo "@@listen"; "$SQL" -N -B -e "SELECT @@bind_address, @@port, @@skip_networking" 2>/dev/null
  echo "@@users"; "$SQL" -N -B -e "SELECT user, host FROM mysql.user WHERE user NOT IN ('root','mysql','mariadb.sys','mysql.sys','mysql.session','mysql.infoschema','debian-sys-maint','') ORDER BY user" 2>/dev/null
fi
echo "@@backups"; [ -d ${DIR} ] && find ${DIR} -maxdepth 1 -name '*.sql.gz' -printf '%f\\t%s\\t%T@\\n' 2>/dev/null | sort -r
echo "@@cron"; [ -f ${CRON} ] && cat ${CRON}
true`
  const res = await runPrivileged(client, script, sudo, undefined, 30000)
  const sec: Record<string, string[]> = {}
  let cur = ''
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('@@')) {
      cur = line.slice(2)
      sec[cur] = []
    } else if (cur && line.trim()) sec[cur].push(line)
  }
  const installed = sec.installed?.[0] === 'yes'
  const version = sec.version?.[0] ?? ''
  const versionOk = /^\d+\.\d+/.test(version)
  const databases: DbInfo[] = (sec.dbs ?? []).map((l) => {
    const [name, size, tables] = l.split('\t')
    return { name, size: Number(size) || 0, tables: Number(tables) || 0 }
  })
  const users: DbUser[] = (sec.users ?? []).map((l) => {
    const [user, host] = l.split('\t')
    return { user, host }
  })
  const backups: DbBackup[] = (sec.backups ?? []).map((l) => {
    const [file, size, time] = l.split('\t')
    return { file, db: file.replace(/-\d{8}-\d{6}\.sql\.gz$/, ''), size: Number(size) || 0, time: Math.round(Number(time) * 1000) }
  })
  const cron = (sec.cron ?? []).join('\n')
  const cm = /^0 (\d{1,2}) \* \* \* root \S+ (\d+)/m.exec(cron)
  const schedule: DbSchedule = cm ? { enabled: true, hour: Number(cm[1]), keepDays: Number(cm[2]) } : { enabled: false, hour: 2, keepDays: 7 }
  return {
    installed,
    version: versionOk ? version : '',
    error: installed && !versionOk ? 'Could not log in to the database as root. This tool uses the root socket login (sudo mysql).' : undefined,
    databases,
    users,
    backups,
    schedule,
    packageManager: sec.pm?.[0] ?? '',
    listen: listenOf(sec.listen?.[0])
  }
}

function listenOf(line?: string): { remote: boolean; port: number } | undefined {
  if (!line) return undefined
  const [bind, port, skip] = line.split('\t')
  const local = /^(127\.|localhost$|::1$)/.test(bind ?? '') || skip === '1' || skip === 'ON'
  return { remote: !local, port: Number(port) || 3306 }
}

async function sql(client: Client, sudo: Sudo, statements: string): Promise<void> {
  // The SQL travels base64-encoded so no shell quoting can interfere with it.
  const b64 = Buffer.from(statements).toString('base64')
  await runPrivileged(client, `${HEAD}\nset -e\n[ -n "$SQL" ] || { echo "MySQL / MariaDB is not installed."; exit 50; }\necho ${b64} | base64 -d | "$SQL" 2>&1`, sudo, undefined, 60000)
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1']

/** The account hosts (besides localhost) that an access choice stands for. */
export function accessHosts(a: DbAccess | undefined): string[] {
  if (!a || a.mode === 'local') return []
  if (a.mode === 'any') return ['%']
  if (a.mode !== 'list') throw new Error('Unknown access choice.')
  const hosts = [...new Set((a.hosts ?? []).map((h) => String(h).trim().toLowerCase()).filter(Boolean))]
  if (hosts.length === 0) throw new Error('Add at least one address that may connect.')
  if (hosts.length > 30) throw new Error('At most 30 addresses.')
  for (const h of hosts) {
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
    const range = /^(\d{1,3})(\.\d{1,3}){0,2}\.%$/.test(h)
    const v6 = /^[0-9a-f:]{3,39}$/.test(h) && h.includes(':') && h !== '::1'
    const octetsOk = h.replace('.%', '').split('.').every((o) => !/^\d+$/.test(o) || Number(o) <= 255)
    if (!((v4 || range) && octetsOk) && !v6) throw new Error(`"${h}" is not an address. Write an IP such as 203.0.113.7, or a range such as 192.168.1.%`)
    if (LOCAL_HOSTS.includes(h) || h.startsWith('127.')) throw new Error('Programs on the server itself can always connect; leave that address out.')
  }
  return hosts
}

/**
 * Shell that makes the database reachable for the remote accounts that exist:
 * the server must listen beyond itself, and an active ufw firewall gets rules
 * for exactly the addresses the accounts allow. Run after any change of hosts.
 */
const REMOTE_SH = `
HOSTS=$("$SQL" -N -B -e "SELECT DISTINCT host FROM mysql.user WHERE user NOT IN ('root','mysql','mariadb.sys','mysql.sys','mysql.session','mysql.infoschema','debian-sys-maint','') AND host NOT IN ('localhost','127.0.0.1','::1')")
PORT=$("$SQL" -N -B -e "SELECT @@port")
if [ -n "$HOSTS" ]; then
  BIND=$("$SQL" -N -B -e "SELECT @@bind_address"); SKIP=$("$SQL" -N -B -e "SELECT @@skip_networking")
  case "$BIND" in 127.*|localhost|::1) NEED=1 ;; *) NEED=0 ;; esac
  case "$SKIP" in 1|ON) NEED=1 ;; esac
  if [ "$NEED" = 1 ]; then
    CONF=""
    for d in /etc/mysql/mariadb.conf.d /etc/mysql/mysql.conf.d /etc/my.cnf.d /etc/mysql/conf.d; do [ -d "$d" ] && { CONF="$d/zz-superdevops.cnf"; break; }; done
    if [ -z "$CONF" ]; then
      echo "@@note=The database server only listens on the server itself and its settings folder was not found. Set bind-address = 0.0.0.0 in its configuration and restart it."
    else
      echo "==> The database server only listens on the server itself. Letting it listen for other computers."
      printf '%s\\n' '# Managed by SuperDevops: lets the database accounts that allow other computers be reached.' '[mysqld]' 'bind-address = 0.0.0.0' 'skip-networking = 0' > "$CONF"
      chmod 644 "$CONF"
      echo "==> Restarting the database server (a few seconds)"
      R=1
      for u in mariadb mysql mysqld; do
        if command -v systemctl >/dev/null 2>&1 && systemctl restart "$u" 2>/dev/null; then R=0; break; fi
      done
      if [ "$R" = 1 ]; then for u in mariadb mysql mysqld; do if service "$u" restart >/dev/null 2>&1; then R=0; break; fi; done; fi
      for i in $(seq 1 30); do "$SQL" -e "SELECT 1" >/dev/null 2>&1 && break; sleep 1; done
      if ! "$SQL" -e "SELECT 1" >/dev/null 2>&1; then
        unlink "$CONF"
        for u in mariadb mysql mysqld; do { command -v systemctl >/dev/null 2>&1 && systemctl restart "$u" 2>/dev/null; } || service "$u" restart >/dev/null 2>&1 || true; done
        echo "The database server did not come back with the new setting, so the setting was removed again. Other computers cannot connect yet."
        exit 57
      fi
      case "$("$SQL" -N -B -e "SELECT @@bind_address")" in
        127.*|localhost|::1) echo "@@note=The database server still only listens on the server itself. Restart it (Overview, Restart) so the new setting takes effect." ;;
        *) echo "The database server now listens on port $PORT." ;;
      esac
    fi
  fi
fi
# Firewall: rules for exactly the addresses that may connect; ours carry a label so they can be replaced.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  for n in $(ufw status numbered | sed -n 's/^\\[ *\\([0-9]*\\)\\].*superdevops-db.*/\\1/p' | sort -rn); do ufw --force delete "$n" >/dev/null 2>&1; done
  if echo "$HOSTS" | grep -qx '%'; then
    ufw allow "$PORT"/tcp comment 'superdevops-db' >/dev/null && echo "Firewall: port $PORT is open to every address."
  else
    for h in $HOSTS; do
      case "$h" in
        *.*.*.%) F="\${h%.%}.0/24" ;;
        *.*.%) F="\${h%.%}.0.0/16" ;;
        *.%) F="\${h%.%}.0.0.0/8" ;;
        *%*|*[!0-9a-fA-F.:]*) echo "@@note=The firewall was not opened for $h; add a rule for it on the Firewall page."; continue ;;
        *) F="$h" ;;
      esac
      ufw allow from "$F" to any port "$PORT" proto tcp comment 'superdevops-db' >/dev/null && echo "Firewall: port $PORT is open to $F."
    done
  fi
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1 && [ -n "$HOSTS" ]; then
  echo "@@note=This server uses firewalld. Open port $PORT for the addresses that should connect on the Firewall page."
fi
`

function notes(stdout: string): string[] {
  return stdout.split('\n').filter((l) => l.startsWith('@@note=')).map((l) => l.slice(7))
}

export async function createDatabase(
  client: Client,
  sudo: Sudo,
  name: string,
  user: string,
  password: string,
  access?: DbAccess
): Promise<{ name: string; user: string; password: string; hosts: string[]; notes: string[] }> {
  checkDb(name)
  if (!RE_USER.test(user)) throw new Error('User names may only use letters, numbers and underscore (up to 32).')
  if (user.toLowerCase() === 'root') throw new Error('Choose a user name other than root.')
  const pass = password || generatePassword()
  if (!RE_PASS.test(pass)) throw new Error('Password must be 8-64 characters: letters, numbers and ! @ # % ^ * _ + = . , : -')
  const remote = accessHosts(access)
  const stmts = [`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`]
  for (const h of ['localhost', ...remote]) {
    stmts.push(`CREATE USER IF NOT EXISTS '${user}'@'${h}' IDENTIFIED BY '${pass}';`, `ALTER USER '${user}'@'${h}' IDENTIFIED BY '${pass}';`, `GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${user}'@'${h}';`)
  }
  stmts.push('FLUSH PRIVILEGES;')
  await sql(client, sudo, stmts.join('\n'))
  let out: string[] = []
  if (remote.length) {
    const res = await runPrivileged(client, `${HEAD}\n${REMOTE_SH}`, sudo, undefined, 120000)
    out = notes(res.stdout)
  }
  return { name, user, password: pass, hosts: remote, notes: out }
}

/**
 * Change which computers may connect as a database user. The password is not
 * needed: a new address gets a copy of the sign-in the user already has.
 */
export async function setAccess(client: Client, sudo: Sudo, name: string, user: string, access: DbAccess, log: (s: string) => void): Promise<void> {
  checkDb(name)
  if (!RE_USER.test(user) || user.toLowerCase() === 'root') throw new Error('Unknown user.')
  const want = accessHosts(access)
  const script = `${HEAD}
[ -n "$SQL" ] || { echo "MySQL / MariaDB is not installed."; exit 50; }
q() { "$SQL" -N -B -e "$1"; }
CUR=$(q "SELECT host FROM mysql.user WHERE user='${user}'") || { echo "Could not read the database users."; exit 53; }
[ -n "$CUR" ] || { echo "The database user ${user} does not exist."; exit 54; }
SRC=localhost; echo "$CUR" | grep -qx localhost || SRC=$(echo "$CUR" | head -1)
VER=$(q "SELECT VERSION()")
WANT=${shq(want.join('\n'))}
echo "==> Access for ${user}"
for h in $WANT; do
  if echo "$CUR" | grep -qxF -- "$h"; then echo "$h: already allowed"
  else
    case "$VER" in
      *MariaDB*)
        PLUGIN=$(q "SELECT plugin FROM mysql.user WHERE user='${user}' AND host='$SRC'"); [ -n "$PLUGIN" ] || PLUGIN=mysql_native_password
        HASH=$(q "SELECT authentication_string FROM mysql.user WHERE user='${user}' AND host='$SRC'")
        case "$PLUGIN$HASH" in *[!A-Za-z0-9*\$./_+=-]*|"") echo "The sign-in of ${user} is stored in a form this app cannot copy."; exit 55 ;; esac
        q "CREATE USER '${user}'@'$h' IDENTIFIED VIA $PLUGIN USING '$HASH'" || exit 56
        ;;
      *)
        PLUGIN=$(q "SELECT plugin FROM mysql.user WHERE user='${user}' AND host='$SRC'")
        HEXED=$(q "SELECT HEX(authentication_string) FROM mysql.user WHERE user='${user}' AND host='$SRC'")
        case "$PLUGIN$HEXED" in *[!A-Za-z0-9_]*|"") echo "The sign-in of ${user} is stored in a form this app cannot copy."; exit 55 ;; esac
        q "CREATE USER '${user}'@'$h' IDENTIFIED WITH '$PLUGIN' AS 0x$HEXED" || exit 56
        ;;
    esac
    echo "$h: allowed"
  fi
  q "GRANT ALL PRIVILEGES ON \\\`${name}\\\`.* TO '${user}'@'$h'" || exit 56
done
for h in $CUR; do
  case "$h" in localhost|127.0.0.1|::1) continue ;; esac
  echo "$WANT" | grep -qxF -- "$h" && continue
  q "DROP USER '${user}'@'$h'" && echo "$h: no longer allowed"
done
q "FLUSH PRIVILEGES"
${REMOTE_SH}
echo
echo "==> Done"`
  await runPrivileged(client, script, sudo, (s) => log(s.replace(/^@@note=/gm, 'Note: ')), 180000)
}

export async function dropDatabase(client: Client, sudo: Sudo, name: string, dropUser: string): Promise<void> {
  checkDb(name)
  if (dropUser && (!RE_USER.test(dropUser) || dropUser.toLowerCase() === 'root')) throw new Error('Unknown user.')
  // The user goes with every address it was allowed from, and the firewall rules for those addresses go too.
  const script = `${HEAD}
set -e
[ -n "$SQL" ] || { echo "MySQL / MariaDB is not installed."; exit 50; }
"$SQL" -e "DROP DATABASE \\\`${name}\\\`" 2>&1
${
  dropUser
    ? `for h in $("$SQL" -N -B -e "SELECT host FROM mysql.user WHERE user='${dropUser}'"); do "$SQL" -e "DROP USER '${dropUser}'@'$h'" 2>&1; done
"$SQL" -e "FLUSH PRIVILEGES"`
    : ''
}
set +e
${REMOTE_SH}`
  await runPrivileged(client, script, sudo, undefined, 120000)
}

export async function backupNow(client: Client, sudo: Sudo, name: string, log: (s: string) => void): Promise<void> {
  checkDb(name)
  const script = `${HEAD}
set -e -o pipefail
[ -n "$DUMP" ] || { echo "mysqldump is not installed."; exit 50; }
umask 077
mkdir -p ${DIR}
FILE=${DIR}/${name}-$(date +%Y%m%d-%H%M%S).sql.gz
echo "==> Dumping ${name}"
if ! "$DUMP" --single-transaction --routines --triggers ${shq(name)} | gzip > "$FILE"; then rm -f "$FILE"; echo "Dump failed."; exit 51; fi
echo "Saved $FILE ($(du -h "$FILE" | cut -f1))"`
  await runPrivileged(client, script, sudo, log)
}

export async function restore(client: Client, sudo: Sudo, file: string, intoDb: string, log: (s: string) => void): Promise<void> {
  const path = checkFile(file)
  checkDb(intoDb)
  const script = `${HEAD}
set -e -o pipefail
[ -f ${shq(path)} ] || { echo "Backup file not found."; exit 52; }
echo "==> Restoring ${file} into ${intoDb}"
"$SQL" -e "CREATE DATABASE IF NOT EXISTS \\\`${intoDb}\\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
gunzip -c ${shq(path)} | "$SQL" ${shq(intoDb)}
echo "Restore finished"`
  await runPrivileged(client, script, sudo, log)
}

export async function deleteBackup(client: Client, sudo: Sudo, file: string): Promise<void> {
  await runPrivileged(client, `rm -f ${shq(checkFile(file))}`, sudo, undefined, 20000)
}

/** Stream a backup file from the server to a local path. */
export function download(client: Client, sudo: Sudo, file: string, localPath: string): Promise<void> {
  return downloadPath(client, sudo, checkFile(file), localPath)
}

/** Stream one file from the server to a local path. The caller decides which paths are allowed. */
export function downloadPath(client: Client, sudo: Sudo, path: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.exec(wrapScript(`cat ${shq(path)}`, sudo.mode), (err, stream) => {
      if (err) return reject(err)
      const out = createWriteStream(localPath)
      let stderr = ''
      let code: number | null = null
      let closed = false
      let finished = false
      const done = (): void => {
        if (!closed || !finished) return
        if (code === 0) resolve()
        else reject(new Error(stderr.trim().split('\n').pop() || 'Download failed.'))
      }
      stream.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')))
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
      stream.end(sudo.stdin ?? '')
    })
  })
}

const JOB_SCRIPT = `#!/bin/bash
# Managed by SuperDevops. Dumps every database and removes old dumps.
# Usage: superdevops-dbbackup.sh <days to keep>
export PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin:/usr/local/bin"
set -o pipefail
KEEP=\${1:-7}
SQL=$(command -v mariadb || command -v mysql)
DUMP=$(command -v mariadb-dump || command -v mysqldump)
umask 077
mkdir -p ${DIR}
STAMP=$(date +%Y%m%d-%H%M%S)
for db in $("$SQL" -N -B -e "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN (${SYSTEM_DBS})"); do
  FILE=${DIR}/$db-$STAMP.sql.gz
  "$DUMP" --single-transaction --routines --triggers "$db" | gzip > "$FILE" || rm -f "$FILE"
done
find ${DIR} -maxdepth 1 -name '*.sql.gz' -mtime +"$KEEP" -delete
`

export async function setSchedule(client: Client, sudo: Sudo, s: DbSchedule): Promise<void> {
  if (!(Number.isInteger(s.hour) && s.hour >= 0 && s.hour <= 23)) throw new Error('Hour must be between 0 and 23.')
  if (!(Number.isInteger(s.keepDays) && s.keepDays >= 1 && s.keepDays <= 3650)) throw new Error('Days to keep must be between 1 and 3650.')
  const script = s.enabled
    ? `set -e
echo ${Buffer.from(JOB_SCRIPT).toString('base64')} | base64 -d > ${JOB}
chmod 700 ${JOB}
printf '%s\\n' '# Managed by SuperDevops' '0 ${s.hour} * * * root ${JOB} ${s.keepDays} >/dev/null 2>&1' > ${CRON}
chmod 644 ${CRON}`
    : `rm -f ${CRON}`
  await runPrivileged(client, script, sudo, undefined, 20000)
}

/** Run the scheduled job once, right now. */
export async function runScheduledJob(client: Client, sudo: Sudo, keepDays: number): Promise<void> {
  await runPrivileged(client, `${JOB} ${Math.floor(keepDays)}`, sudo, undefined, 600000)
}

export async function install(client: Client, sudo: Sudo, log: (s: string) => void, version = 'system'): Promise<void> {
  const script = `${PATH_EXPORT}
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  ${repoLines('mariadb', version).split('\n').join('\n  ')}
  apt-get update -y || echo "Some package lists could not be refreshed; carrying on with the ones already here."
  echo "==> Installing $PKG"
  apt-get install -y "$PKG" || { for f in /etc/apt/sources.list.d/mariadb.list /etc/apt/sources.list.d/mysql.list /etc/apt/preferences.d/superdevops-mysql; do ${version === 'system' || version === 'mysql-system' ? ':' : '[ -e "$f" ] && unlink "$f"'}; done; echo "The database server could not be installed."; exit 43; }
elif command -v dnf >/dev/null 2>&1; then dnf install -y mariadb-server || exit 43
elif command -v yum >/dev/null 2>&1; then yum install -y mariadb-server || exit 43
else echo "No supported package manager found."; exit 40
fi
if [ -d /run/systemd/system ]; then systemctl enable --now mariadb 2>/dev/null || systemctl enable --now mysql 2>/dev/null || true
else service mariadb start >/dev/null 2>&1 || service mysql start >/dev/null 2>&1 || true; fi
echo; echo "==> $( (mariadbd --version || mysqld --version) 2>/dev/null | head -1) installed"`
  await runPrivileged(client, script, sudo, log, 30 * 60000)
}
