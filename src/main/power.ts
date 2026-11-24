// Restarting things: the services this app looks after, and the whole server.
import type { Client } from 'ssh2'
import type { ServiceInfo } from '@shared/types'
import { PATH_EXPORT, runPrivileged, type Sudo } from './deploy'
import { exec, shq } from './ssh'

/** Unit name patterns of the services worth restarting from here, with the name people know them by. */
const KNOWN: [RegExp, (unit: string) => string][] = [
  [/^nginx$/, () => 'nginx (web server)'],
  [/^apache2$|^httpd$/, () => 'Apache (web server)'],
  [/^php[\d.]*-fpm$/, (u) => `PHP-FPM ${/[\d.]+/.exec(u)?.[0] ?? ''}`.trim()],
  [/^mariadb$/, () => 'MariaDB (database)'],
  [/^mysql$|^mysqld$/, () => 'MySQL (database)'],
  [/^postgresql$/, () => 'PostgreSQL (database)'],
  [/^mongod$/, () => 'MongoDB (database)'],
  [/^redis-server$|^redis$/, () => 'Redis'],
  [/^cron$|^crond$/, () => 'Cron (scheduled jobs)'],
  [/^fail2ban$/, () => 'Fail2ban'],
  [/^pm2-[\w.-]+$/, (u) => `PM2 (${u.slice(4)})`],
  [/^docker$/, () => 'Docker'],
  [/^supervisor$|^supervisord$/, () => 'Supervisor']
]

function label(unit: string): string | null {
  for (const [re, name] of KNOWN) if (re.test(unit)) return name(unit)
  return null
}

const LIST = `export LC_ALL=C
${PATH_EXPORT}
if [ -d /run/systemd/system ]; then
  systemctl list-units --type=service --all --no-legend --plain --no-pager 2>/dev/null | awk '$2 == "loaded" { sub(/\\.service$/, "", $1); print $1 "|" $3 }'
else
  for s in nginx apache2 httpd mariadb mysql postgresql mongod redis-server redis cron crond fail2ban docker supervisor $(ls /etc/init.d 2>/dev/null | grep -E '^php[0-9.]*-fpm$'); do
    [ -x "/etc/init.d/$s" ] || continue
    if service "$s" status >/dev/null 2>&1; then echo "$s|active"; else echo "$s|inactive"; fi
  done
fi`

/** The services this app knows how to name, with whether each is running. */
export async function services(client: Client): Promise<ServiceInfo[]> {
  const res = await exec(client, `bash -c ${shq(LIST)}`, { timeoutMs: 30000 })
  const out: ServiceInfo[] = []
  const seen = new Set<string>()
  for (const line of res.stdout.split('\n')) {
    const [unit, state] = line.trim().split('|')
    if (!unit || seen.has(unit)) continue
    const name = label(unit)
    if (!name) continue
    // mysql is an alias of mariadb on many systems; show one.
    if ((unit === 'mysql' || unit === 'mysqld') && seen.has('mariadb')) continue
    seen.add(unit)
    out.push({ unit, name, running: state === 'active' })
  }
  if (seen.has('mariadb')) return out.filter((s) => s.unit !== 'mysql' && s.unit !== 'mysqld').sort((a, b) => a.name.localeCompare(b.name))
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export async function restartService(client: Client, sudo: Sudo, unit: string, log: (s: string) => void): Promise<void> {
  if (typeof unit !== 'string' || !/^[\w.@-]{1,80}$/.test(unit) || !label(unit)) throw new Error('That service cannot be restarted from here.')
  const script = `export LC_ALL=C
${PATH_EXPORT}
U=${shq(unit)}
echo "==> Restarting $U"
if [ "$U" = nginx ] && command -v nginx >/dev/null 2>&1; then
  nginx -t 2>&1 || { echo "nginx's configuration has an error, so it was NOT restarted: a restart would take every site offline. Fix the error above first."; exit 31; }
fi
if [ -d /run/systemd/system ]; then
  systemctl restart "$U" || { systemctl status "$U" --no-pager -n 15 2>&1; exit 32; }
  sleep 1
  systemctl is-active --quiet "$U" || { echo "$U did not come back up:"; systemctl status "$U" --no-pager -n 15 2>&1; exit 33; }
else
  service "$U" restart || exit 32
  sleep 1
  service "$U" status >/dev/null 2>&1 || { echo "$U did not come back up."; exit 33; }
fi
echo "==> $U is running again."`
  await runPrivileged(client, script, sudo, log, 120000)
}

/**
 * Restart the whole server. The command returns before the server goes down, so the answer still arrives.
 * `delaySeconds` is how long the server waits before going down.
 */
export async function reboot(client: Client, sudo: Sudo, delaySeconds = 3): Promise<void> {
  const script = `export LC_ALL=C
${PATH_EXPORT}
sync
if [ -d /run/systemd/system ]; then RB="systemctl reboot"; else RB="$(command -v reboot || echo /sbin/reboot)"; fi
nohup sh -c "sleep ${Math.max(1, Math.floor(delaySeconds))}; $RB" >/dev/null 2>&1 &
echo scheduled`
  const res = await runPrivileged(client, script, sudo, undefined, 30000)
  if (!res.stdout.includes('scheduled')) throw new Error('The server did not accept the restart command.')
}

export async function stopService(client: Client, sudo: Sudo, unit: string, log: (s: string) => void): Promise<void> {
  if (typeof unit !== 'string' || !/^[\w.@-]{1,80}$/.test(unit) || !label(unit)) throw new Error('That service cannot be stopped from here.')
  const script = `export LC_ALL=C
${PATH_EXPORT}
U=${shq(unit)}
echo "==> Stopping $U"
if [ -d /run/systemd/system ]; then
  systemctl stop "$U" || { systemctl status "$U" --no-pager -n 15 2>&1; exit 32; }
  sleep 1
  systemctl is-active --quiet "$U" && { echo "$U is still running."; exit 34; }
else
  service "$U" stop || exit 32
  sleep 1
  service "$U" status >/dev/null 2>&1 && { echo "$U is still running."; exit 34; }
fi
echo "==> $U is stopped. It stays stopped until someone starts it or the server restarts."`
  await runPrivileged(client, script, sudo, log, 120000)
}

/** Switch the server off. It can only be switched on again from the hosting provider's panel. */
export async function shutdown(client: Client, sudo: Sudo, delaySeconds = 3): Promise<void> {
  const script = `export LC_ALL=C
${PATH_EXPORT}
sync
if [ -d /run/systemd/system ]; then OFF="systemctl poweroff"; else OFF="$(command -v poweroff || echo /sbin/poweroff)"; fi
nohup sh -c "sleep ${Math.max(1, Math.floor(delaySeconds))}; $OFF" >/dev/null 2>&1 &
echo scheduled`
  const res = await runPrivileged(client, script, sudo, undefined, 30000)
  if (!res.stdout.includes('scheduled')) throw new Error('The server did not accept the shutdown command.')
}

const PLAN = '/etc/cron.d/superdevops-reboot'

/** A restart planned for later, if there is one. `at` is the moment in milliseconds. */
export async function plannedReboot(client: Client): Promise<{ at: number; serverTime: string } | null> {
  const res = await exec(client, `bash -c ${shq(`[ -r ${PLAN} ] && sed -n 's/^# at=\\([0-9]*\\) \\(.*\\)$/\\1|\\2/p' ${PLAN}; true`)}`, { timeoutMs: 15000 })
  const [at, serverTime] = res.stdout.trim().split('|')
  if (!/^\d+$/.test(at ?? '')) return null
  return { at: Number(at) * 1000, serverTime: serverTime ?? '' }
}

/**
 * Restart the server once at a set moment (cron on the server does it, so the app can be closed).
 * `at` is in milliseconds; null cancels a planned restart.
 */
export async function planReboot(client: Client, sudo: Sudo, at: number | null): Promise<void> {
  if (at === null) {
    await runPrivileged(client, `[ -e ${PLAN} ] && unlink ${PLAN}; true`, sudo, undefined, 20000)
    return
  }
  const epoch = Math.floor(Number(at) / 1000)
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(epoch) || epoch < now + 120) throw new Error('Choose a time at least two minutes from now.')
  if (epoch > now + 30 * 86400) throw new Error('Choose a time within the next 30 days.')
  const script = `export LC_ALL=C
${PATH_EXPORT}
( pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1 ) || { echo "The cron service is not running on this server, so a planned restart would never happen. Start cron first (Overview, Restart)."; exit 35; }
E=${epoch}
[ "$E" -gt "$(( $(date +%s) + 60 ))" ] || { echo "That time has already passed on the server's clock."; exit 36; }
if [ -d /run/systemd/system ]; then RB="systemctl reboot"; else RB="$(command -v reboot || echo /sbin/reboot)"; fi
{
  echo "# Managed by SuperDevops. One planned restart; this file removes itself."
  echo "# at=$E $(date -d "@$E" '+%Y-%m-%d %H:%M %Z')"
  echo "$(date -d "@$E" '+%-M %-H %-d %-m') * root unlink ${PLAN}; sync; $RB"
} > ${PLAN}
chmod 644 ${PLAN}
echo "planned for $(date -d "@$E" '+%Y-%m-%d %H:%M %Z')"`
  const res = await runPrivileged(client, script, sudo, undefined, 30000)
  if (!res.stdout.includes('planned for')) throw new Error('The server did not accept the planned restart.')
}
