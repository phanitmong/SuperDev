// PostgreSQL on the server: install, databases with a user of their own,
// backups and restore. Commands run as the postgres system user, so no
// database password is needed to manage it.
//
// PostgreSQL is left listening on the server itself only.
import type { Client } from 'ssh2'
import type { PgOverview } from '@shared/types'
import type { Sudo } from './deploy'
import { PATH_EXPORT, runPrivileged } from './deploy'
import { generatePassword } from './database'
import { shq } from './ssh'
import { repoLines } from './versions'

const DIR = '/var/backups/superdevops/postgres'
// Small letters only: PostgreSQL folds unquoted names to lower case, which surprises people later.
const RE_NAME = /^[a-z_][a-z0-9_]{0,47}$/
const RE_PASS = /^[A-Za-z0-9!@#%^*_+=.,:-]{8,64}$/
const RE_FILE = /^[a-z_][a-z0-9_]{0,47}-\d{8}-\d{6}\.sql\.gz$/
const SYSTEM = ['postgres', 'template0', 'template1']

const HEAD = `${PATH_EXPORT}
export LC_ALL=C
cd /tmp
pg() { if command -v runuser >/dev/null 2>&1; then runuser -u postgres -- "$@"; else sudo -n -u postgres "$@"; fi; }
q() { pg psql -X -At -F "$(printf '\\t')" -v ON_ERROR_STOP=1 "$@"; }
pg_up() { q -d postgres -c 'select 1' >/dev/null 2>&1; }
pg_start() {
  pg_up && return 0
  if [ -d /run/systemd/system ]; then systemctl enable --now postgresql >/dev/null 2>&1 || true
  else service postgresql start >/dev/null 2>&1 || true
  fi
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do pg_up && return 0; sleep 0.5; done
  return 1
}`

function checkName(name: string, what: string): string {
  if (!RE_NAME.test(String(name))) throw new Error(`${what} names use small letters, numbers and underscore, and start with a letter (up to 48).`)
  if (SYSTEM.includes(name) || name.startsWith('pg_')) throw new Error(`That ${what.toLowerCase()} name belongs to PostgreSQL itself.`)
  return name
}

function checkFile(file: string): string {
  if (!RE_FILE.test(String(file))) throw new Error('Unknown backup file.')
  return `${DIR}/${file}`
}

export async function overview(client: Client, sudo: Sudo): Promise<PgOverview> {
  const script = `${HEAD}
if ! command -v psql >/dev/null 2>&1 || ! id postgres >/dev/null 2>&1; then
  echo "@@installed=0"
  if command -v apt-get >/dev/null 2>&1 || command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then echo "@@pm=1"; fi
  exit 0
fi
echo "@@installed=1"
if pg_up; then echo "@@running=1"; else echo "@@running=0"; echo "@@version=$(psql --version 2>/dev/null | head -1)"; exit 0; fi
echo "@@version=$(q -d postgres -c 'show server_version')"
echo "@@listen=$(q -d postgres -c 'show listen_addresses')"
echo "@@port=$(q -d postgres -c 'show port')"
echo "@@dbs"
q -d postgres -c "select d.datname, pg_database_size(d.datname), r.rolname from pg_database d join pg_roles r on r.oid = d.datdba where not d.datistemplate and d.datname <> 'postgres' order by 1"
echo "@@backups"
if [ -d ${DIR} ]; then find ${DIR} -maxdepth 1 -type f -name '*.sql.gz' -printf '%f\\t%s\\t%T@\\n' 2>/dev/null | sort -t "$(printf '\\t')" -k3,3nr | head -200; fi
echo "@@end"`
  const res = await runPrivileged(client, script, sudo, undefined, 40000)
  const kv: Record<string, string> = {}
  const sec: Record<string, string[]> = {}
  let cur = ''
  for (const line of res.stdout.split('\n')) {
    const m = /^@@(\w+)=(.*)$/.exec(line)
    if (m) kv[m[1]] = m[2].trim()
    else if (line.startsWith('@@')) { cur = line.slice(2); sec[cur] = [] } // prettier-ignore
    else if (cur && line.trim()) sec[cur].push(line)
  }
  if (kv.installed !== '1') return { installed: false, packageManager: kv.pm === '1', running: false, version: '', listen: '', port: 5432, databases: [], backups: [] }
  return {
    installed: true,
    packageManager: true,
    running: kv.running === '1',
    version: /(\d+(\.\d+)*)/.exec(kv.version ?? '')?.[1] ?? '',
    listen: kv.listen ?? '',
    port: Number(kv.port) || 5432,
    databases: (sec.dbs ?? []).map((l) => l.split('\t')).filter((p) => p.length >= 3).map(([name, size, owner]) => ({ name, size: Number(size) || 0, owner })),
    backups: (sec.backups ?? []).map((l) => l.split('\t')).filter((p) => RE_FILE.test(p[0] ?? '')).map(([file, size, at]) => ({ file, database: file.replace(/-\d{8}-\d{6}\.sql\.gz$/, ''), size: Number(size) || 0, at: Math.round(Number(at) * 1000) || 0 }))
  }
}

export async function install(client: Client, sudo: Sudo, log: (s: string) => void, version = 'system'): Promise<void> {
  const script = `${HEAD}
set -e
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  ${repoLines('postgres', version).split('\n').join('\n  ')}
  apt-get update -y || echo "Some package lists could not be refreshed; carrying on with the ones already here."
  echo "==> Installing $PKG"
  apt-get install -y "$PKG" || { ${version === 'system' ? '' : '[ -e /etc/apt/sources.list.d/pgdg.list ] && unlink /etc/apt/sources.list.d/pgdg.list; '}echo "PostgreSQL could not be installed."; exit 43; }
elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
  PM=$(command -v dnf || command -v yum)
  "$PM" install -y postgresql-server
  # These systems ship PostgreSQL without a data folder; make one the first time.
  [ -s /var/lib/pgsql/data/PG_VERSION ] || postgresql-setup --initdb
else echo "No supported package manager found."; exit 40
fi
set +e
pg_start || { echo "PostgreSQL is installed but did not start. Look at its log on the server (journalctl -u postgresql, or /var/log/postgresql)."; exit 70; }
echo; echo "==> PostgreSQL $(q -d postgres -c 'show server_version') is installed and running. It starts with the server and listens on this server only."`
  await runPrivileged(client, script, sudo, log, 20 * 60 * 1000)
}

export async function service(client: Client, sudo: Sudo, what: 'start' | 'stop' | 'restart'): Promise<void> {
  if (!['start', 'stop', 'restart'].includes(what)) throw new Error('Unknown action.')
  const script = `${HEAD}
if [ -d /run/systemd/system ]; then systemctl ${what} postgresql; else service postgresql ${what}; fi
RC=$?
${what === 'stop' ? '' : 'pg_start || { echo "PostgreSQL did not start. Look at its log on the server."; exit 70; }'}
[ "${what}" = stop ] && exit $RC
exit 0`
  await runPrivileged(client, script, sudo, undefined, 90000)
}

/** Feed statements to psql on its own input, so they are not part of any command line. */
function psqlScript(sql: string, db = 'postgres'): string {
  const b64 = Buffer.from(sql).toString('base64')
  return `echo ${b64} | base64 -d | q -d ${shq(db)} 2>&1`
}

export async function createDatabase(client: Client, sudo: Sudo, name: string, user: string, password: string): Promise<{ name: string; user: string; password: string }> {
  checkName(name, 'Database')
  checkName(user, 'User')
  const pass = password || generatePassword()
  if (!RE_PASS.test(pass)) throw new Error('Password must be 8-64 characters: letters, numbers and ! @ # % ^ * _ + = . , : -')
  const script = `${HEAD}
pg_up || { echo "PostgreSQL is not running."; exit 70; }
[ -z "$(q -d postgres -c "select 1 from pg_database where datname = '${name}'")" ] || { echo "There is already a database called ${name}."; exit 71; }
# An existing user keeps its password: changing it here would break whatever already signs in with it.
[ -z "$(q -d postgres -c "select 1 from pg_roles where rolname = '${user}'")" ] || { echo "There is already a user called ${user}. Choose another user name."; exit 72; }
OUT=$(${psqlScript(`CREATE ROLE "${user}" LOGIN PASSWORD '${pass}';\nCREATE DATABASE "${name}" OWNER "${user}" ENCODING 'UTF8' TEMPLATE template0;\nREVOKE ALL ON DATABASE "${name}" FROM PUBLIC;\n`)}) || {
  q -d postgres -c 'DROP ROLE IF EXISTS "${user}"' >/dev/null 2>&1
  echo "PostgreSQL refused: $(echo "$OUT" | grep -i error | head -1)"; exit 73
}
echo created`
  await runPrivileged(client, script, sudo, undefined, 90000)
  return { name, user, password: pass }
}

export async function dropDatabase(client: Client, sudo: Sudo, name: string, dropUser: string): Promise<void> {
  checkName(name, 'Database')
  if (dropUser) checkName(dropUser, 'User')
  const script = `${HEAD}
pg_up || { echo "PostgreSQL is not running."; exit 70; }
q -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}' and pid <> pg_backend_pid()" >/dev/null 2>&1
OUT=$(q -d postgres -c 'DROP DATABASE IF EXISTS "${name}"' 2>&1) || { echo "PostgreSQL refused: $(echo "$OUT" | grep -i error | head -1)"; exit 74; }
${dropUser ? `# The user goes too, unless it still owns something else.\nq -d postgres -c 'DROP ROLE IF EXISTS "${dropUser}"' >/dev/null 2>&1 || echo "@@note=The user ${dropUser} still owns other things and was kept."` : ''}
echo dropped`
  await runPrivileged(client, script, sudo, undefined, 90000)
}

export async function backupNow(client: Client, sudo: Sudo, name: string, log: (s: string) => void): Promise<void> {
  checkName(name, 'Database')
  const script = `${HEAD}
set -o pipefail
pg_up || { echo "PostgreSQL is not running."; exit 70; }
umask 077
mkdir -p ${DIR}
FILE=${DIR}/${name}-$(date +%Y%m%d-%H%M%S).sql.gz
echo "==> Dumping ${name}"
if ! pg pg_dump --clean --if-exists ${shq(name)} | gzip > "$FILE"; then unlink "$FILE" 2>/dev/null; echo "The dump failed."; exit 75; fi
echo "Saved $FILE ($(du -h "$FILE" | cut -f1))"`
  await runPrivileged(client, script, sudo, log, 60 * 60 * 1000)
}

/** Put a backup back into the database it was taken from. What is in the database now is replaced. */
export async function restore(client: Client, sudo: Sudo, file: string, log: (s: string) => void): Promise<void> {
  const path = checkFile(file)
  const name = checkName(file.replace(/-\d{8}-\d{6}\.sql\.gz$/, ''), 'Database')
  const script = `${HEAD}
set -o pipefail
pg_up || { echo "PostgreSQL is not running."; exit 70; }
[ -f ${shq(path)} ] || { echo "Backup file not found."; exit 76; }
[ -n "$(q -d postgres -c "select 1 from pg_database where datname = '${name}'")" ] || { echo "There is no database called ${name} to restore into. Create it first."; exit 77; }
gunzip -t ${shq(path)} 2>/dev/null || { echo "The backup file is damaged and was not used."; exit 78; }
echo "==> Restoring ${file} into ${name}"
# One transaction: if anything fails, the database stays as it was.
if ! gunzip -c ${shq(path)} | pg psql -X -q -v ON_ERROR_STOP=1 --single-transaction -d ${shq(name)} >/dev/null; then echo "The restore failed and nothing was changed."; exit 79; fi
echo "Restore finished"`
  await runPrivileged(client, script, sudo, log, 60 * 60 * 1000)
}

export async function deleteBackup(client: Client, sudo: Sudo, file: string): Promise<void> {
  await runPrivileged(client, `unlink ${shq(checkFile(file))}`, sudo, undefined, 20000)
}
