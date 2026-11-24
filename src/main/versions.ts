// Choosing a version when installing: the system's own package, or a newer
// (or older) release from the project's own package repository.
// The server itself checks which releases exist for its system, so the app
// only offers what can really be installed there. apt systems only; elsewhere
// the system's package is the one choice.
import type { Client } from 'ssh2'
import type { VersionApp, VersionChoice } from '@shared/types'
import { PATH_EXPORT } from './deploy'
import { exec, wrapScript } from './ssh'

const POSTGRES = ['18', '17', '16', '15', '14']
const MARIADB = ['11.8', '11.4', '10.11']
/** MySQL release lines and the name of each in MySQL's own repository. 5.7 only exists there for old systems. */
const MYSQL: Record<string, string> = { 'mysql-8.4': 'mysql-8.4-lts', 'mysql-8.0': 'mysql-8.0', 'mysql-5.7': 'mysql-5.7' }

const SYSTEM_PKG: Record<VersionApp, string> = { postgres: 'postgresql', mariadb: 'mariadb-server', redis: 'redis-server' }

export function checkChoice(app: VersionApp, id: string): string {
  const v = String(id || 'system')
  const ok = v === 'system' || (app === 'postgres' && POSTGRES.includes(v)) || (app === 'mariadb' && (MARIADB.includes(v) || v === 'mysql-system' || v in MYSQL)) || (app === 'redis' && v === 'redis.io')
  if (!ok) throw new Error('Choose one of the versions offered.')
  return v
}

/** What can be installed on this server, the system's own package first. */
export async function available(client: Client, app: VersionApp): Promise<VersionChoice[]> {
  if (!(app in SYSTEM_PKG)) throw new Error('Unknown app.')
  const probe =
    app === 'postgres'
      ? `for v in ${POSTGRES.join(' ')}; do curl -fsI --max-time 8 "https://apt.postgresql.org/pub/repos/apt/dists/$VERSION_CODENAME-pgdg/$v/binary-$ARCH/Packages.gz" >/dev/null 2>&1 && echo "@@v=$v"; done`
      : app === 'mariadb'
        ? `for v in ${MARIADB.join(' ')}; do curl -fsIL --max-time 8 "https://dlm.mariadb.com/repo/mariadb-server/$v/repo/$ID/dists/$VERSION_CODENAME/Release" >/dev/null 2>&1 && echo "@@v=$v"; done
      echo "@@mysqlsystem=$(apt-cache policy mysql-server 2>/dev/null | sed -n 's/^ *Candidate: *//p' | head -1)"
      ${Object.entries(MYSQL).map(([id, comp]) => `curl -fsI --max-time 8 "https://repo.mysql.com/apt/$ID/dists/$VERSION_CODENAME/${comp}/binary-$ARCH/Packages.gz" >/dev/null 2>&1 && echo "@@v=${id}"`).join('\n      ')}`
        : `curl -fsI --max-time 8 "https://packages.redis.io/deb/dists/$VERSION_CODENAME/Release" >/dev/null 2>&1 && echo "@@v=redis.io"`
  const script = `${PATH_EXPORT}
export LC_ALL=C
. /etc/os-release 2>/dev/null
if command -v apt-get >/dev/null 2>&1; then
  echo "@@system=$(apt-cache policy ${SYSTEM_PKG[app]} 2>/dev/null | sed -n 's/^ *Candidate: *//p' | head -1)"
  case "$ID" in ubuntu|debian)
    if command -v curl >/dev/null 2>&1 && [ -n "$VERSION_CODENAME" ]; then
      ARCH=$(dpkg --print-architecture 2>/dev/null || echo amd64)
      ${probe}
    fi ;;
  esac
fi
echo "@@end"`
  const res = await exec(client, wrapScript(script), { timeoutMs: 90000 })
  const found: string[] = []
  let system = ''
  let mysqlSystem = ''
  for (const line of res.stdout.split('\n')) {
    const m = /^@@(\w+)=(.*)$/.exec(line.trim())
    if (m?.[1] === 'v') found.push(m[2])
    if (m?.[1] === 'system') system = m[2].replace(/^\d+:/, '').replace(/[-+~].*$/, '')
    if (m?.[1] === 'mysqlsystem') mysqlSystem = m[2].replace(/^\d+:/, '').replace(/[-+~].*$/, '')
  }
  const name = app === 'postgres' ? 'PostgreSQL' : app === 'mariadb' ? 'MariaDB' : 'Redis'
  const source = app === 'postgres' ? 'postgresql.org' : app === 'mariadb' ? 'mariadb.org' : 'redis.io'
  const out: VersionChoice[] = [{ id: 'system', label: `${name}${system && system !== '(none)' ? ` ${system}` : ''} from this system's own packages`, note: 'Updated together with the system. The safest choice.' }]
  if (app === 'mariadb' && mysqlSystem && mysqlSystem !== '(none)') {
    out.push({ id: 'mysql-system', label: `MySQL ${mysqlSystem} from this system's own packages`, note: 'MySQL instead of MariaDB, updated together with the system.' })
  }
  for (const v of found) {
    if (v in MYSQL) {
      const line = v.replace('mysql-', '')
      out.push({
        id: v,
        label: `MySQL ${line}${line === '8.4' ? ' LTS' : ''} from mysql.com`,
        note: line === '5.7' ? 'MySQL 5.7 reached its end of life in October 2023 and gets no security fixes. Choose it only for an old app that cannot run on 8.' : "Kept up to date from MySQL's own package repository."
      })
      continue
    }
    out.push({
      id: v,
      label: v === 'redis.io' ? `Newest Redis from ${source}` : `${name} ${v} from ${source}`,
      note: app === 'mariadb' ? 'A long-term release, kept up to date from MariaDB\'s own package repository.' : `Kept up to date from ${source}'s own package repository.`
    })
  }
  return out
}

/**
 * Shell lines that add the project's package repository for the chosen version (nothing for "system").
 * Afterwards $PKG holds the package to install. Stops with a message when the repository cannot be added.
 */
export function repoLines(app: VersionApp, id: string): string {
  const v = checkChoice(app, id)
  if (v === 'system') return `PKG=${SYSTEM_PKG[app]}`
  const head = `command -v apt-get >/dev/null 2>&1 || { echo "Choosing a version works on Ubuntu and Debian only. Install the system's own package instead."; exit 41; }
command -v curl >/dev/null 2>&1 || apt-get install -y curl ca-certificates >/dev/null 2>&1 || { echo "curl is not installed on this server."; exit 61; }
. /etc/os-release 2>/dev/null
addkey() { # URL FILE: fetch a signing key and make sure a key came back
  curl -fsSL --max-time 40 "$1" -o "$2" && [ "$(wc -c < "$2")" -gt 600 ] && return 0
  [ -e "$2" ] && unlink "$2"; echo "The signing key could not be fetched from $1."; exit 42
}`
  if (app === 'postgres') {
    return `${head}
echo "==> Adding PostgreSQL's own package repository"
addkey https://www.postgresql.org/media/keys/ACCC4CF8.asc /usr/share/keyrings/postgresql-pgdg.asc
echo "deb [signed-by=/usr/share/keyrings/postgresql-pgdg.asc] https://apt.postgresql.org/pub/repos/apt $VERSION_CODENAME-pgdg main" > /etc/apt/sources.list.d/pgdg.list
PKG=postgresql-${v}`
  }
  if (app === 'mariadb' && v === 'mysql-system') return 'PKG=mysql-server'
  if (app === 'mariadb' && v in MYSQL) {
    return `${head}
echo "==> Adding MySQL's own package repository (${MYSQL[v]})"
addkey https://repo.mysql.com/RPM-GPG-KEY-mysql-2025 /usr/share/keyrings/mysql-2025.asc
addkey https://repo.mysql.com/RPM-GPG-KEY-mysql-2023 /usr/share/keyrings/mysql-2023.asc
echo "deb [signed-by=/usr/share/keyrings/mysql-2025.asc,/usr/share/keyrings/mysql-2023.asc] https://repo.mysql.com/apt/$ID $VERSION_CODENAME ${MYSQL[v]} mysql-tools" > /etc/apt/sources.list.d/mysql.list
# The system may carry a MySQL of its own with a higher number; the chosen line must win.
printf '%s\\n' 'Package: mysql* libmysql*' 'Pin: origin repo.mysql.com' 'Pin-Priority: 1001' > /etc/apt/preferences.d/superdevops-mysql
# No questions during the install: root signs in from the server itself (sudo mysql), as with the system's package.
echo "mysql-community-server mysql-community-server/root-pass password" | debconf-set-selections 2>/dev/null || true
echo "mysql-community-server mysql-community-server/re-root-pass password" | debconf-set-selections 2>/dev/null || true
PKG=mysql-server`
  }
  if (app === 'mariadb') {
    return `${head}
echo "==> Adding MariaDB's own package repository (${v})"
addkey https://mariadb.org/mariadb_release_signing_key.pgp /usr/share/keyrings/mariadb-keyring.pgp
echo "deb [signed-by=/usr/share/keyrings/mariadb-keyring.pgp] https://dlm.mariadb.com/repo/mariadb-server/${v}/repo/$ID $VERSION_CODENAME main" > /etc/apt/sources.list.d/mariadb.list
PKG=mariadb-server`
  }
  return `${head}
echo "==> Adding Redis's own package repository"
addkey https://packages.redis.io/gpg /usr/share/keyrings/redis-archive-keyring.asc
echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.asc] https://packages.redis.io/deb $VERSION_CODENAME main" > /etc/apt/sources.list.d/redis.list
PKG=redis`
}
