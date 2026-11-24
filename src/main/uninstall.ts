// Uninstalling an app from the App Store.
//
// The program is removed; what it stored is kept: databases, Docker volumes and
// images, site folders, and the settings files. Installing again finds them.
// (Packages are removed, never purged.) Nothing here deletes data.
import type { Client } from 'ssh2'
import type { UninstallApp } from '@shared/types'
import type { Sudo } from './deploy'
import { PATH_EXPORT, runPrivileged } from './deploy'

interface Plan {
  name: string
  /** Installed packages whose name matches are removed (extended regular expression). */
  packages: string
  /** Services stopped first. */
  services: string[]
  /** Repository files this app added when a version was chosen. */
  repoFiles?: string[]
  /** Shell run before the packages go. */
  before?: string
  /** Shell run afterwards. */
  after?: string
  /** Shell test that succeeds while the program is still there. */
  still: string
  /** Said at the end: what was kept and where. */
  kept: string
}

const PLANS: Record<UninstallApp, Plan> = {
  sites: {
    name: 'Nginx',
    packages: '^(nginx|nginx-core|nginx-full|nginx-light|nginx-extras|nginx-common|libnginx-mod-.*)$',
    services: ['nginx'],
    still: 'command -v nginx >/dev/null 2>&1',
    kept: 'Site folders and the settings in /etc/nginx were kept. Every site on this server is offline until Nginx is installed again.'
  },
  php: {
    name: 'PHP',
    packages: '^(php[0-9]+\\.[0-9]+(-.*)?|php-common|php-fpm|php-cli|libapache2-mod-php.*)$',
    services: [],
    before: `for u in $(ls /etc/init.d 2>/dev/null | grep -E '^php[0-9.]+-fpm$'; systemctl list-units --type=service --all --no-legend --plain 2>/dev/null | awk '{print $1}' | grep -E '^php[0-9.]+-fpm\\.service$' | sed 's/\\.service$//'); do stop_service "$u"; done`,
    still: 'command -v php >/dev/null 2>&1 || ls /usr/sbin/php-fpm* >/dev/null 2>&1',
    kept: 'Settings in /etc/php were kept. PHP sites answer with an error until PHP is installed again.'
  },
  pm2: {
    name: 'PM2',
    packages: '^$',
    services: [],
    before: `if command -v pm2 >/dev/null 2>&1; then
  # Each user's PM2 keeps a list of its apps (~/.pm2); the list stays, the running apps stop.
  for u in $(ps -eo user:32,args | awk '/PM2 v[0-9]/ && !/awk/ {print $1}' | sort -u); do
    if command -v runuser >/dev/null 2>&1; then runuser -u "$u" -- pm2 kill >/dev/null 2>&1 || true; fi
  done
  pm2 kill >/dev/null 2>&1 || true
  for f in /etc/systemd/system/pm2-*.service; do [ -e "$f" ] || continue; systemctl disable --now "$(basename "$f")" >/dev/null 2>&1; unlink "$f"; done
  [ -d /run/systemd/system ] && systemctl daemon-reload >/dev/null 2>&1
  npm rm -g pm2 2>&1 | tail -2
fi`,
    still: 'command -v pm2 >/dev/null 2>&1',
    kept: 'Each app\'s folder and the saved app lists (~/.pm2) were kept. Node.js itself was not removed.'
  },
  database: {
    name: 'MySQL / MariaDB',
    packages: '^(mariadb-server.*|mariadb-client.*|mariadb-backup|mysql-server.*|mysql-client.*|mysql-community-(server|client).*|MariaDB-(server|client).*)$',
    services: ['mariadb', 'mysql', 'mysqld'],
    repoFiles: ['/etc/apt/sources.list.d/mariadb.list', '/etc/apt/sources.list.d/mysql.list', '/etc/apt/preferences.d/superdevops-mysql'],
    still: 'command -v mysqld >/dev/null 2>&1 || command -v mariadbd >/dev/null 2>&1',
    kept: 'The databases themselves (/var/lib/mysql), the settings and the backups were kept. Installing MariaDB again in the same or a newer version opens them.'
  },
  postgres: {
    name: 'PostgreSQL',
    packages: '^postgresql(-(client|contrib))?(-[0-9]+)?$|^postgresql-(client-)?common$|^postgresql[0-9]*-server$',
    services: ['postgresql'],
    repoFiles: ['/etc/apt/sources.list.d/pgdg.list'],
    still: 'ls /usr/lib/postgresql/*/bin/postgres >/dev/null 2>&1 || command -v postgres >/dev/null 2>&1 || command -v psql >/dev/null 2>&1',
    kept: 'The databases (/var/lib/postgresql), the settings and the backups were kept. Installing the same PostgreSQL version again opens them.'
  },
  mongo: {
    name: 'MongoDB',
    packages: '^(mongodb-org.*|mongodb-mongosh|mongodb-database-tools)$',
    services: ['mongod'],
    before: `pgrep -x mongod >/dev/null 2>&1 && { id mongodb >/dev/null 2>&1 && U=mongodb || U=mongod; runuser -u "$U" -- mongod --config /etc/mongod.conf --shutdown >/dev/null 2>&1 || true; }`,
    after: `for f in /etc/apt/sources.list.d/mongodb-org-*.list /etc/yum.repos.d/mongodb-org-*.repo; do [ -e "$f" ] && unlink "$f"; done; true`,
    still: 'command -v mongod >/dev/null 2>&1',
    kept: 'The databases (/var/lib/mongodb), the settings and the app\'s admin sign-in were kept. Installing MongoDB again opens them.'
  },
  redis: {
    name: 'Redis',
    packages: '^(redis|redis-server|redis-tools|redis-sentinel)$',
    services: ['redis-server', 'redis'],
    repoFiles: ['/etc/apt/sources.list.d/redis.list'],
    still: 'command -v redis-server >/dev/null 2>&1',
    kept: 'The settings in /etc/redis and the data file in /var/lib/redis were kept.'
  },
  supervisor: {
    name: 'Supervisor',
    packages: '^supervisor$',
    services: ['supervisor', 'supervisord'],
    still: 'command -v supervisord >/dev/null 2>&1',
    kept: 'The program files in its settings folder were kept. The programs it ran, including sites started by the app, are stopped until Supervisor is installed again.'
  },
  docker: {
    name: 'Docker',
    packages: '^(docker\\.io|docker-ce|docker-ce-cli|docker-ce-rootless-extras|docker-compose-v2|docker-compose-plugin|docker-buildx|docker-buildx-plugin|containerd|containerd\\.io|runc)$',
    services: ['docker.socket', 'docker', 'containerd'],
    still: 'command -v dockerd >/dev/null 2>&1',
    kept: 'Containers, images and volumes (/var/lib/docker) were kept. Every container is stopped until Docker is installed again.'
  }
}

export function uninstallName(app: UninstallApp): string {
  const p = PLANS[app]
  if (!p) throw new Error('This app cannot be uninstalled from here.')
  return p.name
}

export async function uninstall(client: Client, sudo: Sudo, app: UninstallApp, log: (s: string) => void): Promise<void> {
  const p = PLANS[app]
  if (!p) throw new Error('This app cannot be uninstalled from here.')
  const script = `${PATH_EXPORT}
export LC_ALL=C DEBIAN_FRONTEND=noninteractive
stop_service() {
  if [ -d /run/systemd/system ]; then systemctl disable --now "$1" >/dev/null 2>&1 || true
  elif [ -x "/etc/init.d/$1" ]; then service "$1" stop >/dev/null 2>&1 || true; fi
}
echo "==> Stopping ${p.name}"
${p.before ?? ''}
${p.services.map((s) => `stop_service ${s}`).join('\n')}
echo "==> Removing the program (data and settings are kept)"
if command -v dpkg-query >/dev/null 2>&1; then
  PKGS=$(dpkg-query -W -f '\${db:Status-Abbrev} \${Package}\\n' 2>/dev/null | awk '$1 ~ /^i/ {print $2}' | grep -E ${JSON.stringify(p.packages)} | tr '\\n' ' ')
  if [ -n "$PKGS" ]; then
    echo "Packages: $PKGS"
    # remove, not purge: settings and data stay on the server.
    OUT=$(apt-get remove -y $PKGS 2>&1); RC=$?; echo "$OUT" | tail -6; [ $RC -eq 0 ] || { echo "The packages could not be removed."; exit 91; }
  fi
elif command -v rpm >/dev/null 2>&1; then
  PKGS=$(rpm -qa --qf '%{NAME}\\n' 2>/dev/null | grep -E ${JSON.stringify(p.packages)} | tr '\\n' ' ')
  if [ -n "$PKGS" ]; then
    echo "Packages: $PKGS"
    P=$(command -v dnf || command -v yum)
    OUT=$("$P" remove -y $PKGS 2>&1); RC=$?; echo "$OUT" | tail -6; [ $RC -eq 0 ] || { echo "The packages could not be removed."; exit 91; }
  fi
fi
${(p.repoFiles ?? []).map((f) => `[ -e ${f} ] && unlink ${f}`).join('\n')}
${p.after ?? ''}
hash -r
if ${p.still}; then echo "${p.name} is still on this server. It was installed another way than from the system's packages, so it was left alone."; exit 92; fi
echo
echo "==> ${p.name} is uninstalled."
echo ${JSON.stringify(p.kept)}`
  await runPrivileged(client, script, sudo, log, 20 * 60000)
}
