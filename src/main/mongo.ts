// MongoDB on the server: install from MongoDB's own package repository (the
// systems' own packages no longer carry it), turn sign-in on, databases with a
// user of their own, backups and restore.
//
// At install the app makes an admin user for itself and switches authorization
// on. Its password stays on the server (root only) and is read from the file by
// the tools, so it is never part of a command line. MongoDB keeps listening on
// the server itself only.
import type { Client } from 'ssh2'
import type { MongoOverview } from '@shared/types'
import type { Sudo } from './deploy'
import { PATH_EXPORT, runPrivileged } from './deploy'
import { generatePassword } from './database'
import { shq } from './ssh'

const ETC = '/etc/superdevops/mongo'
const DIR = '/var/backups/superdevops/mongo'
const ADMIN = 'apsara_admin'
/** Release lines offered, newest first. The server checks which of them exist for its system. */
export const MONGO_LINES = ['8.2', '8.0', '7.0']
const RE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/
const RE_PASS = /^[A-Za-z0-9!@#%^*_+=.,:-]{8,64}$/
const RE_FILE = /^[A-Za-z][A-Za-z0-9_-]{0,47}-\d{8}-\d{6}\.archive\.gz$/
const SYSTEM = ['admin', 'config', 'local']

/** JavaScript every mongosh script starts with: sign in as the app's admin when there is one. */
const JS_AUTH = `const fs = require('fs');
if (fs.existsSync('${ETC}/admin')) { const p = fs.readFileSync('${ETC}/admin', 'utf8').trim(); db.getSiblingDB('admin').auth('${ADMIN}', p); }
`

const HEAD = `${PATH_EXPORT}
export LC_ALL=C
cd /tmp
PORT=$(sed -n 's/^ *port: *\\([0-9][0-9]*\\).*/\\1/p' /etc/mongod.conf 2>/dev/null | head -1); [ -n "$PORT" ] || PORT=27017
# Asked each time: the account does not exist before the install.
muser() { if id mongodb >/dev/null 2>&1; then echo mongodb; else echo mongod; fi; }
# Run JavaScript given on standard input. It is kept in a root-only file for the moment it runs.
msh() {
  local f; f=$(umask 077; mktemp /tmp/.superdevops-mongo-XXXXXX.js)
  cat > "$f"
  mongosh --quiet --norc "mongodb://127.0.0.1:$PORT/admin?serverSelectionTimeoutMS=4000" "$f"
  local rc=$?
  unlink "$f"
  return $rc
}
m_up() { echo 'db.runCommand({ ping: 1 })' | msh >/dev/null 2>&1; }
m_start() {
  m_up && return 0
  local MUSER; MUSER=$(muser)
  if [ -d /run/systemd/system ]; then systemctl enable --now mongod >/dev/null 2>&1 || true
  else
    mkdir -p /var/log/mongodb /var/lib/mongodb; chown -R "$MUSER" /var/log/mongodb /var/lib/mongodb 2>/dev/null
    if command -v runuser >/dev/null 2>&1; then runuser -u "$MUSER" -- mongod --config /etc/mongod.conf --fork >/dev/null 2>&1; else sudo -n -u "$MUSER" mongod --config /etc/mongod.conf --fork >/dev/null 2>&1; fi
  fi
  for i in $(seq 1 40); do m_up && return 0; sleep 0.5; done
  return 1
}
m_stop() {
  local MUSER; MUSER=$(muser)
  if [ -d /run/systemd/system ]; then systemctl stop mongod
  else
    if command -v runuser >/dev/null 2>&1; then runuser -u "$MUSER" -- mongod --config /etc/mongod.conf --shutdown >/dev/null 2>&1; else sudo -n -u "$MUSER" mongod --config /etc/mongod.conf --shutdown >/dev/null 2>&1; fi
    for i in $(seq 1 20); do pgrep -x mongod >/dev/null 2>&1 || break; sleep 0.5; done
  fi
  ! pgrep -x mongod >/dev/null 2>&1
}`

function checkName(name: string, what: string): string {
  if (!RE_NAME.test(String(name))) throw new Error(`${what} names start with a letter and use letters, numbers, dash and underscore (up to 48).`)
  if (SYSTEM.includes(name) || name === ADMIN) throw new Error(`That ${what.toLowerCase()} name belongs to MongoDB or to this app.`)
  return name
}

function checkFile(file: string): string {
  if (!RE_FILE.test(String(file))) throw new Error('Unknown backup file.')
  return `${DIR}/${file}`
}

export async function overview(client: Client, sudo: Sudo): Promise<MongoOverview> {
  const script = `${HEAD}
if ! command -v mongod >/dev/null 2>&1; then
  echo "@@installed=0"
  . /etc/os-release 2>/dev/null
  echo "@@os=$ID $VERSION_CODENAME $VERSION_ID"
  if command -v apt-get >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
    case "$ID" in ubuntu|debian) for v in ${MONGO_LINES.join(' ')}; do curl -fsI --max-time 8 "https://repo.mongodb.org/apt/$ID/dists/$VERSION_CODENAME/mongodb-org/$v/Release" >/dev/null 2>&1 && echo "@@line=$v"; done ;; esac
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    R=\${VERSION_ID%%.*}
    for v in ${MONGO_LINES.join(' ')}; do curl -fsI --max-time 8 "https://repo.mongodb.org/yum/redhat/$R/mongodb-org/$v/$(uname -m)/repodata/repomd.xml" >/dev/null 2>&1 && echo "@@line=$v"; done
  fi
  exit 0
fi
echo "@@installed=1"
echo "@@binary=$(mongod --version 2>/dev/null | sed -n 's/^db version v//p' | head -1)"
[ -f ${ETC}/admin ] && echo "@@managed=1"
echo "@@bind=$(sed -n 's/^ *bindIp: *//p' /etc/mongod.conf 2>/dev/null | head -1)"
echo "@@port=$PORT"
command -v mongodump >/dev/null 2>&1 && echo "@@tools=1"
if ! m_up; then echo "@@running=0"; else
echo "@@running=1"
msh <<'SDJS'
${JS_AUTH}
try {
  print('@@version=' + db.version());
  const users = db.getSiblingDB('admin').system.users.find({ db: { $nin: ['admin'] } }, { user: 1, db: 1 }).toArray();
  const dbs = db.adminCommand({ listDatabases: 1 }).databases.filter((d) => !['admin', 'config', 'local'].includes(d.name));
  const names = new Set(dbs.map((d) => d.name)); users.forEach((u) => names.add(u.db));
  print('@@dbs');
  [...names].sort().forEach((n) => {
    const d = dbs.find((x) => x.name === n);
    const cols = d ? db.getSiblingDB(n).getCollectionNames().length : 0;
    print([n, d ? d.sizeOnDisk : 0, cols, users.filter((u) => u.db === n).map((u) => u.user).join(',')].join('\\t'));
  });
} catch (e) { print('@@denied=' + String(e.message || e).split('\\n')[0]); }
SDJS
fi
echo "@@backups"
if [ -d ${DIR} ]; then find ${DIR} -maxdepth 1 -type f -name '*.archive.gz' -printf '%f\\t%s\\t%T@\\n' 2>/dev/null | sort -t "$(printf '\\t')" -k3,3nr | head -200; fi
echo "@@end"`
  const res = await runPrivileged(client, script, sudo, undefined, 60000)
  const kv: Record<string, string> = {}
  const sec: Record<string, string[]> = {}
  const lines: string[] = []
  let cur = ''
  for (const line of res.stdout.split('\n')) {
    const m = /^@@(\w+)=(.*)$/.exec(line)
    if (m && m[1] === 'line') lines.push(m[2].trim())
    else if (m) kv[m[1]] = m[2].trim()
    else if (line.startsWith('@@')) { cur = line.slice(2).trim(); sec[cur] = [] } // prettier-ignore
    else if (cur && line.trim()) sec[cur].push(line)
  }
  const base: MongoOverview = { installed: kv.installed === '1', running: kv.running === '1', version: kv.version || kv.binary || '', managed: kv.managed === '1', bind: kv.bind ?? '', port: Number(kv.port) || 27017, tools: kv.tools === '1', os: kv.os ?? '', lines, denied: kv.denied, databases: [], backups: [] }
  base.databases = (sec.dbs ?? [])
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 4)
    .map(([name, size, collections, users]) => ({ name, size: Number(size) || 0, collections: Number(collections) || 0, users: users ? users.split(',') : [] }))
  base.backups = (sec.backups ?? [])
    .map((l) => l.split('\t'))
    .filter((p) => RE_FILE.test(p[0] ?? ''))
    .map(([file, size, at]) => ({ file, database: file.replace(/-\d{8}-\d{6}\.archive\.gz$/, ''), size: Number(size) || 0, at: Math.round(Number(at) * 1000) || 0 }))
  return base
}

/** Shell: make the app's admin user and switch authorization on. Does nothing when already done. */
const SECURE = `if [ ! -f ${ETC}/admin ]; then
  echo "==> Turning sign-in on"
  if echo 'db.getSiblingDB("admin").system.users.countDocuments({})' | msh >/dev/null 2>&1; then
    # The password is made on the server and never leaves it.
    ( umask 077; mkdir -p ${ETC}; head -c 30 /dev/urandom | od -An -tx1 | tr -d ' \\n' > ${ETC}/admin.new; echo >> ${ETC}/admin.new )
    OUT=$(msh <<'SDJS' 2>&1
const p = require('fs').readFileSync('${ETC}/admin.new', 'utf8').trim();
const a = db.getSiblingDB('admin');
if (a.getUser('${ADMIN}')) a.updateUser('${ADMIN}', { pwd: p, roles: ['root'] }); else a.createUser({ user: '${ADMIN}', pwd: p, roles: ['root'] });
print('made');
SDJS
)
    case "$OUT" in *made*) mv ${ETC}/admin.new ${ETC}/admin ;; *) unlink ${ETC}/admin.new; echo "The admin user could not be made: $(echo "$OUT" | tail -1)"; exit 86 ;; esac
    ( umask 077; printf 'password: %s\\n' "$(cat ${ETC}/admin)" > ${ETC}/tools.yaml )
    chmod 600 ${ETC}/admin ${ETC}/tools.yaml
    if grep -q '^ *authorization: *enabled' /etc/mongod.conf; then :
    elif grep -q '^security:' /etc/mongod.conf; then sed -i 's/^security:.*/security:\\n  authorization: enabled/' /etc/mongod.conf
    elif grep -q '^#security:' /etc/mongod.conf; then sed -i 's/^#security:.*/security:\\n  authorization: enabled/' /etc/mongod.conf
    else printf '\\nsecurity:\\n  authorization: enabled\\n' >> /etc/mongod.conf; fi
    m_stop; m_start || { echo "MongoDB did not start again after sign-in was turned on. Look at /var/log/mongodb/mongod.log"; exit 87; }
    echo "Sign-in is on. Nobody can read or change data without a user and password."
  else
    echo "MongoDB on this server already asks for a sign-in that this app does not know, so the app cannot manage its databases."
    echo "To let the app manage it: make a user named ${ADMIN} with the root role, and put its password alone in ${ETC}/admin (root only)."
  fi
fi`

export async function install(client: Client, sudo: Sudo, line: string, log: (s: string) => void): Promise<void> {
  if (!MONGO_LINES.includes(line)) throw new Error('Choose one of the MongoDB versions offered.')
  const key = `${line.split('.')[0]}.0`
  const script = `${HEAD}
if command -v mongod >/dev/null 2>&1; then echo "==> MongoDB is already installed: $(mongod --version | head -1)"
else
  . /etc/os-release 2>/dev/null
  command -v curl >/dev/null 2>&1 || { echo "curl is not installed on this server. Install it first."; exit 61; }
  if command -v apt-get >/dev/null 2>&1; then
    case "$ID" in ubuntu) COMP=multiverse ;; debian) COMP=main ;; *) echo "MongoDB publishes packages for Ubuntu and Debian only among apt systems; this is $ID."; exit 80 ;; esac
    curl -fsI --max-time 15 "https://repo.mongodb.org/apt/$ID/dists/$VERSION_CODENAME/mongodb-org/${line}/Release" >/dev/null 2>&1 || { echo "MongoDB ${line} is not published for $ID $VERSION_CODENAME. Choose another version."; exit 81; }
    echo "==> Adding MongoDB's package repository (${line}) with its signing key"
    curl -fsSL --max-time 30 "https://pgp.mongodb.com/server-${key}.asc" -o /usr/share/keyrings/mongodb-server-${key}.asc || { echo "The signing key could not be fetched from pgp.mongodb.com."; exit 82; }
    grep -q 'BEGIN PGP PUBLIC KEY BLOCK' /usr/share/keyrings/mongodb-server-${key}.asc || { unlink /usr/share/keyrings/mongodb-server-${key}.asc; echo "What came from pgp.mongodb.com is not a signing key."; exit 82; }
    echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-${key}.asc ] https://repo.mongodb.org/apt/$ID $VERSION_CODENAME/mongodb-org/${line} $COMP" > /etc/apt/sources.list.d/mongodb-org-${line}.list
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y || echo "Some package lists could not be refreshed; trying with what is there."
    echo "==> Installing MongoDB ${line}"
    apt-get install -y mongodb-org || { unlink /etc/apt/sources.list.d/mongodb-org-${line}.list; echo "MongoDB could not be installed. On some processors without AVX, MongoDB 5 and newer do not run."; exit 83; }
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    P=$(command -v dnf || command -v yum); R=\${VERSION_ID%%.*}
    echo "==> Adding MongoDB's package repository (${line})"
    printf '%s\\n' "[mongodb-org-${line}]" "name=MongoDB Repository" "baseurl=https://repo.mongodb.org/yum/redhat/$R/mongodb-org/${line}/\\$basearch/" "gpgcheck=1" "enabled=1" "gpgkey=https://pgp.mongodb.com/server-${key}.asc" > /etc/yum.repos.d/mongodb-org-${line}.repo
    "$P" install -y mongodb-org || { echo "MongoDB could not be installed."; exit 83; }
  else echo "This server has no package manager this app knows (apt, dnf, yum)."; exit 72
  fi
fi
echo "==> Starting MongoDB and making it start with the server"
m_start || { echo "MongoDB is installed but did not start. Look at /var/log/mongodb/mongod.log (a processor without AVX cannot run it)."; exit 84; }
${SECURE}
echo; echo "==> MongoDB $(echo 'print(db.version())' | msh 2>/dev/null | tail -1) is running on this server only (127.0.0.1:$PORT)."`
  await runPrivileged(client, script, sudo, log, 30 * 60000)
}

export async function service(client: Client, sudo: Sudo, what: 'start' | 'stop' | 'restart'): Promise<void> {
  if (!['start', 'stop', 'restart'].includes(what)) throw new Error('Unknown action.')
  const script = `${HEAD}
${what === 'start' ? '' : 'm_stop || { echo "MongoDB did not stop."; exit 85; }'}
${what === 'stop' ? '' : 'm_start || { echo "MongoDB did not start. Look at /var/log/mongodb/mongod.log"; exit 84; }'}
exit 0`
  await runPrivileged(client, script, sudo, undefined, 120000)
}

const NEED = `m_up || { echo "MongoDB is not running."; exit 84; }
[ -f ${ETC}/admin ] || { echo "This app does not manage the MongoDB on this server (it was set up another way)."; exit 88; }`

/** A database with a user of its own that can read and write that database only. */
export async function createDatabase(client: Client, sudo: Sudo, name: string, user: string, password: string): Promise<{ name: string; user: string; password: string }> {
  checkName(name, 'Database')
  checkName(user, 'User')
  const pass = password || generatePassword()
  if (!RE_PASS.test(pass)) throw new Error('Password must be 8-64 characters: letters, numbers and ! @ # % ^ * _ + = . , : -')
  const script = `${HEAD}
${NEED}
OUT=$(msh <<'SDJS' 2>&1
${JS_AUTH}
const d = db.getSiblingDB(${JSON.stringify(name)});
if (d.getUser(${JSON.stringify(user)})) { print('@@exists'); } else {
  d.createUser({ user: ${JSON.stringify(user)}, pwd: ${JSON.stringify(pass)}, roles: [{ role: 'readWrite', db: ${JSON.stringify(name)} }, { role: 'dbAdmin', db: ${JSON.stringify(name)} }] });
  print('@@created');
}
SDJS
)
case "$OUT" in
  *@@created*) echo created ;;
  *@@exists*) echo "Database ${name} already has a user called ${user}. Choose another user name."; exit 72 ;;
  *) echo "MongoDB refused: $(echo "$OUT" | grep -v '^$' | tail -1)"; exit 73 ;;
esac`
  await runPrivileged(client, script, sudo, undefined, 60000)
  return { name, user, password: pass }
}

/** Remove a database with everything in it, and the users that belong to it. */
export async function dropDatabase(client: Client, sudo: Sudo, name: string): Promise<void> {
  checkName(name, 'Database')
  const script = `${HEAD}
${NEED}
OUT=$(msh <<'SDJS' 2>&1
${JS_AUTH}
const d = db.getSiblingDB(${JSON.stringify(name)});
d.dropAllUsers(); d.dropDatabase(); print('@@dropped');
SDJS
)
case "$OUT" in *@@dropped*) echo dropped ;; *) echo "MongoDB refused: $(echo "$OUT" | grep -v '^$' | tail -1)"; exit 74 ;; esac`
  await runPrivileged(client, script, sudo, undefined, 90000)
}

const TOOL = `--host 127.0.0.1 --port "$PORT" --username ${ADMIN} --authenticationDatabase admin --config ${ETC}/tools.yaml`

export async function backupNow(client: Client, sudo: Sudo, name: string, log: (s: string) => void): Promise<void> {
  checkName(name, 'Database')
  const script = `${HEAD}
${NEED}
command -v mongodump >/dev/null 2>&1 || { echo "mongodump is not installed (package mongodb-database-tools)."; exit 89; }
umask 077
mkdir -p ${DIR}
FILE=${DIR}/${name}-$(date +%Y%m%d-%H%M%S).archive.gz
echo "==> Backing up ${name}"
if ! mongodump ${TOOL} --db ${shq(name)} --archive="$FILE.part" --gzip 2>&1 | tail -4; then :; fi
if [ ! -s "$FILE.part" ] || ! gzip -t "$FILE.part" 2>/dev/null; then [ -e "$FILE.part" ] && unlink "$FILE.part"; echo "The backup failed."; exit 75; fi
mv "$FILE.part" "$FILE"
echo "Saved $FILE ($(du -h "$FILE" | cut -f1))"`
  await runPrivileged(client, script, sudo, log, 6 * 60 * 60 * 1000)
}

/** Put a backup back into the database it was taken from. Collections in the backup replace the ones there now. */
export async function restore(client: Client, sudo: Sudo, file: string, log: (s: string) => void): Promise<void> {
  const path = checkFile(file)
  const name = checkName(file.replace(/-\d{8}-\d{6}\.archive\.gz$/, ''), 'Database')
  const script = `${HEAD}
${NEED}
[ -f ${shq(path)} ] || { echo "Backup file not found."; exit 76; }
gzip -t ${shq(path)} 2>/dev/null || { echo "The backup file is damaged and was not used."; exit 78; }
echo "==> Restoring ${file} into ${name}"
OUT=$(mongorestore ${TOOL} --archive=${shq(path)} --gzip --drop --nsInclude ${shq(`${name}.*`)} 2>&1); RC=$?
echo "$OUT" | tail -5
if [ $RC -ne 0 ] || echo "$OUT" | grep -q ' [1-9][0-9]* document(s) failed'; then echo "The restore did not finish cleanly. Check the lines above."; exit 79; fi
echo "Restore finished"`
  await runPrivileged(client, script, sudo, log, 6 * 60 * 60 * 1000)
}

export async function deleteBackup(client: Client, sudo: Sudo, file: string): Promise<void> {
  await runPrivileged(client, `unlink ${shq(checkFile(file))}`, sudo, undefined, 20000)
}
