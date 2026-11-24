// Security check-up of a managed server: a handful of things that matter most,
// each with a plain explanation and, where it is safe, a one-click fix.
import type { Client } from 'ssh2'
import type { BannedList, SecurityCheck, SecurityFix, SecurityProtection, SecurityReport } from '@shared/types'
import { PATH_EXPORT, runPrivileged, type Sudo } from './deploy'
import { exec } from './ssh'

const PROBE = `export LC_ALL=C
${PATH_EXPORT}
kv() { echo "$1=$2"; }
if command -v apt-get >/dev/null 2>&1; then kv pm apt; elif command -v dnf >/dev/null 2>&1; then kv pm dnf; elif command -v yum >/dev/null 2>&1; then kv pm yum; else kv pm none; fi
SSHD=$(sshd -T 2>/dev/null)
kv root_login "$(echo "$SSHD" | awk '$1=="permitrootlogin"{print $2; exit}')"
kv password_auth "$(echo "$SSHD" | awk '$1=="passwordauthentication"{print $2; exit}')"
kv ssh_port "$(echo "$SSHD" | awk '$1=="port"{print $2; exit}')"
FW=none
if command -v ufw >/dev/null 2>&1; then FW=ufw-off; ufw status 2>/dev/null | grep -q '^Status: active' && FW=ufw-on; fi
if [ "$FW" = none ] && command -v firewall-cmd >/dev/null 2>&1; then FW=firewalld-off; firewall-cmd --state 2>/dev/null | grep -q running && FW=firewalld-on; fi
kv firewall "$FW"
F2B=missing
if command -v fail2ban-client >/dev/null 2>&1; then F2B=stopped; fail2ban-client ping >/dev/null 2>&1 && F2B=running; fi
kv fail2ban "$F2B"
AUTO=off
if [ -f /etc/apt/apt.conf.d/20auto-upgrades ] && grep -q 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades && command -v unattended-upgrade >/dev/null 2>&1; then AUTO=on; fi
if command -v dnf >/dev/null 2>&1 && systemctl is-enabled dnf-automatic.timer >/dev/null 2>&1; then AUTO=on; fi
kv auto_updates "$AUTO"
PENDING=unknown
if command -v apt-get >/dev/null 2>&1; then PENDING=$(timeout 40 apt-get -s -o Debug::NoLocking=true upgrade 2>/dev/null | grep -c '^Inst .*[Ss]ecurity' || true); fi
kv pending "$PENDING"
[ -f /var/run/reboot-required ] && kv reboot yes || kv reboot no
OPEN=""
for p in 3306 5432 6379 27017 11211; do
  if ss -tln 2>/dev/null | awk '{print $4}' | grep -Eq "^(0\\.0\\.0\\.0|\\*|\\[::\\]):$p$"; then OPEN="$OPEN $p"; fi
done
kv open_db "$(echo $OPEN)"
kv pubkey_auth "$(echo "$SSHD" | awk '$1=="pubkeyauthentication"{print $2; exit}')"
PORTS=""
case "$FW" in
  ufw-on) PORTS=$(ufw status 2>/dev/null | awk '/ALLOW/ && $1 !~ /\(v6\)/ { sub(/\/(tcp|udp)$/, "", $1); print $1 }' | sort -un | tr '\n' ' ') ;;
  firewalld-on) PORTS=$(firewall-cmd --list-ports --list-services 2>/dev/null | tr '\n' ' ' | sed 's#/tcp##g; s#/udp##g') ;;
esac
kv fw_ports "$(echo $PORTS)"
FAILED=unknown
if command -v journalctl >/dev/null 2>&1 && journalctl -n 1 >/dev/null 2>&1; then
  FAILED=$(journalctl --since "24 hours ago" --no-pager -q 2>/dev/null | grep -Ec 'sshd.*(Failed password|Invalid user)' || true)
elif [ -r /var/log/auth.log ]; then
  FAILED=$(grep -Ec 'sshd.*(Failed password|Invalid user)' /var/log/auth.log || true)
fi
kv ssh_failed "$FAILED"
BANNED=unknown
[ "$F2B" = running ] && BANNED=$(fail2ban-client status sshd 2>/dev/null | awk -F: '/Currently banned/ { gsub(/[^0-9]/, "", $2); print $2 }')
kv f2b_banned "$BANNED"
NGXFW=off
for d in /etc/nginx/conf.d /etc/nginx/sites-enabled; do [ -s "$d/superdevops-00-firewall.conf" ] && NGXFW=on; done
kv nginx_fw "$NGXFW"
command -v nginx >/dev/null 2>&1 && kv nginx yes || kv nginx no
ALERTS=off
[ -f /etc/cron.d/superdevops-alert ] && [ -f /etc/superdevops/alert.conf ] && ALERTS=on
kv alerts "$ALERTS"
kv uid0 "$(awk -F: '$3 == 0 && $1 != "root" { printf "%s ", $1 }' /etc/passwd)"
`

const DB_NAMES: Record<string, string> = { '3306': 'MySQL / MariaDB', '5432': 'PostgreSQL', '6379': 'Redis', '27017': 'MongoDB', '11211': 'Memcached' }

/** `login` says how this app itself signs in, so a fix that would lock the app out is not offered. */
export async function report(client: Client, sudo: Sudo, login: { username: string; usesPassword: boolean }): Promise<SecurityReport> {
  const res = await runPrivileged(client, PROBE, sudo, undefined, 90000)
  const kv: Record<string, string> = {}
  for (const line of res.stdout.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim()
  }
  const apt = kv.pm === 'apt'
  const checks: SecurityCheck[] = []
  const add = (c: SecurityCheck): void => void checks.push(c)

  const fwOn = kv.firewall?.endsWith('-on')
  add({
    id: 'firewall',
    title: 'Firewall',
    weight: 25,
    ok: !!fwOn,
    detail: fwOn ? `${kv.firewall.startsWith('ufw') ? 'ufw' : 'firewalld'} is on.` : kv.firewall === 'none' ? 'No firewall is installed. Every port a program opens is reachable from the internet.' : 'A firewall is installed but turned off. Every port a program opens is reachable from the internet.',
    action: fwOn ? undefined : { kind: 'page', page: 'firewall', label: 'Open the Firewall page' }
  })

  const rootPw = kv.root_login === 'yes' && kv.password_auth !== 'no'
  const selfLock = login.username === 'root' && login.usesPassword
  add({
    id: 'root-login',
    title: 'Root sign-in with a password',
    weight: 20,
    ok: !rootPw,
    detail: rootPw
      ? 'Anyone on the internet can try passwords for "root", the account with full control. Attack bots do this all day.'
      : kv.password_auth === 'no'
        ? 'SSH accepts keys only.'
        : 'Root cannot sign in with a password.',
    action: !rootPw
      ? undefined
      : selfLock
        ? { kind: 'note', label: 'This app itself signs in as root with a password, so it will not change this. Switch this server to an SSH key or to another user first.' }
        : { kind: 'fix', fix: 'root-login', label: 'Allow root with a key only', confirm: 'Root will only be able to sign in with an SSH key. Other users are not affected. Make sure nobody relies on the root password over SSH.' }
  })

  const guarded = kv.fail2ban === 'running' || kv.password_auth === 'no'
  add({
    id: 'bruteforce',
    title: 'Protection against password guessing',
    weight: 15,
    ok: guarded,
    detail: guarded
      ? kv.fail2ban === 'running'
        ? 'Fail2ban is running and blocks addresses that keep failing to sign in.'
        : 'Password sign-in is off, so there is nothing to guess.'
      : kv.fail2ban === 'stopped'
        ? 'Fail2ban is installed but not running.'
        : 'Nothing stops a bot from trying thousands of passwords.',
    action: guarded ? undefined : apt ? { kind: 'fix', fix: 'fail2ban', label: kv.fail2ban === 'stopped' ? 'Start Fail2ban' : 'Install Fail2ban', confirm: `Fail2ban blocks an address for 1 hour after 5 failed SSH sign-ins within 10 minutes. This includes you if you mistype your password five times.` } : { kind: 'note', label: 'Install fail2ban with this server\'s package manager.' }
  })

  add({
    id: 'auto-updates',
    title: 'Automatic security updates',
    weight: 10,
    ok: kv.auto_updates === 'on',
    detail: kv.auto_updates === 'on' ? 'Security fixes are installed by themselves.' : 'Security fixes wait until someone installs them by hand.',
    action: kv.auto_updates === 'on' ? undefined : apt ? { kind: 'fix', fix: 'auto-updates', label: 'Turn on', confirm: 'The server will install security updates by itself every day. It does not restart by itself.' } : { kind: 'note', label: 'Set up dnf-automatic on this server.' }
  })

  const pending = /^\d+$/.test(kv.pending ?? '') ? Number(kv.pending) : null
  add({
    id: 'pending',
    title: 'Security updates waiting',
    weight: 10,
    ok: pending === 0 || pending === null,
    detail: pending === null ? 'Could not be counted on this system.' : pending === 0 ? 'None.' : `${pending} security update${pending === 1 ? ' is' : 's are'} waiting to be installed.`,
    action: pending && apt ? { kind: 'fix', fix: 'upgrade', label: 'Install updates now', confirm: 'All waiting package updates are installed. Services such as nginx, PHP or MySQL may restart for a few seconds while they are updated.' } : undefined
  })

  const open = (kv.open_db ?? '').split(' ').filter(Boolean)
  add({
    id: 'db-ports',
    title: 'Databases reachable from outside',
    weight: 10,
    ok: open.length === 0 || !!fwOn,
    detail:
      open.length === 0
        ? 'No database listens on a public address.'
        : `${open.map((p) => `${DB_NAMES[p] ?? 'port'} (${p})`).join(', ')} ${open.length === 1 ? 'listens' : 'listen'} on every network address. ${fwOn ? 'The firewall is on; check that it does not allow ' + (open.length === 1 ? 'this port' : 'these ports') + ' from everywhere.' : 'With no firewall, anyone can connect and try to sign in.'}`,
    action: open.length > 0 && !fwOn ? { kind: 'page', page: 'firewall', label: 'Open the Firewall page' } : undefined
  })

  add({
    id: 'reboot',
    title: 'Restart needed',
    weight: 5,
    ok: kv.reboot !== 'yes',
    detail: kv.reboot === 'yes' ? 'An installed update (usually the kernel) only takes effect after the server restarts. Pick a quiet moment and restart it.' : 'No restart is waiting.'
  })

  add({
    id: 'uid0',
    title: 'Extra accounts with full control',
    weight: 5,
    ok: !kv.uid0,
    detail: kv.uid0 ? `Besides root, these accounts have user id 0 and therefore full control: ${kv.uid0}. Unless you created them on purpose, treat this as a sign of a break-in.` : 'Only root has full control.'
  })

  const total = checks.reduce((a, c) => a + c.weight, 0)
  const lost = checks.filter((c) => !c.ok).reduce((a, c) => a + c.weight, 0)
  const sshPort = Number(kv.ssh_port) || 22
  const num = (v: string | undefined): number | null => (/^\d+$/.test(v ?? '') ? Number(v) : null)
  const fixOf = (id: string): SecurityProtection['action'] => {
    const a = checks.find((c) => c.id === id)?.action
    return a?.kind === 'fix' ? a : undefined
  }
  const ports = (kv.fw_ports ?? '').split(' ').filter(Boolean)
  const onOff = (v: string | undefined): string => (v === 'no' ? 'Off' : v === 'yes' ? 'On' : 'Unknown')
  // The switches people expect to see at a glance. Each says where it is turned on.
  const protections: SecurityProtection[] = [
    { id: 'firewall', name: 'Firewall', on: !!fwOn, detail: fwOn ? (ports.length ? `Allowed: ${ports.join(', ')}` : 'On. No port is open to everyone.') : kv.firewall === 'none' ? 'Not installed' : 'Installed, turned off', action: { kind: 'page', page: 'firewall', label: 'Open the Firewall page' } },
    { id: 'ssh', name: 'SSH protection', on: !rootPw, detail: `Port ${sshPort} · Key sign-in: ${onOff(kv.pubkey_auth)} · Password sign-in: ${onOff(kv.password_auth)} · Root with password: ${rootPw ? 'Allowed' : 'Blocked'}`, action: fixOf('root-login') },
    { id: 'fail2ban', name: 'Fail2ban', on: kv.fail2ban === 'running', detail: kv.fail2ban === 'running' ? `Running${num(kv.f2b_banned) !== null ? ` · ${num(kv.f2b_banned)} address${num(kv.f2b_banned) === 1 ? '' : 'es'} blocked now` : ''}` : kv.fail2ban === 'stopped' ? 'Installed, not running' : 'Not installed', action: kv.fail2ban === 'running' ? undefined : fixOf('bruteforce') },
    { id: 'nginx-firewall', name: 'Nginx firewall', on: kv.nginx_fw === 'on', detail: kv.nginx !== 'yes' ? 'nginx is not installed' : kv.nginx_fw === 'on' ? 'Rules are active for every site' : 'No rules set', action: { kind: 'page', page: 'firewall', label: 'Open the Firewall page' } },
    { id: 'auto-updates', name: 'Automatic security updates', on: kv.auto_updates === 'on', detail: kv.auto_updates === 'on' ? 'Security fixes install by themselves' : 'Turned off', action: fixOf('auto-updates') },
    { id: 'alerts', name: 'Attack alerts', on: kv.alerts === 'on', detail: kv.alerts === 'on' ? 'Telegram messages are switched on' : 'Not set up', action: { kind: 'page', page: 'logs', label: 'Open Logs & Alerts' } }
  ]
  return { score: Math.round(((total - lost) / total) * 100), checks, sshPort, protections, stats: { failedLogins: num(kv.ssh_failed), banned: num(kv.f2b_banned), pendingUpdates: pending, restartNeeded: kv.reboot === 'yes' }, scannedAt: Date.now() }
}

const APT = 'export DEBIAN_FRONTEND=noninteractive\ncommand -v apt-get >/dev/null 2>&1 || { echo "This one-click fix needs apt (Debian or Ubuntu)."; exit 60; }'

export async function fix(client: Client, sudo: Sudo, what: SecurityFix, login: { username: string; usesPassword: boolean }, log: (s: string) => void): Promise<void> {
  let script: string
  if (what === 'root-login') {
    if (login.username === 'root' && login.usesPassword) throw new Error('This app signs in to this server as root with a password. Changing this would lock the app out. Switch the server to an SSH key or another user first.')
    script = `${PATH_EXPORT}
set -e
F=/etc/ssh/sshd_config.d/00-superdevops.conf
mkdir -p /etc/ssh/sshd_config.d
grep -q '^Include /etc/ssh/sshd_config.d/' /etc/ssh/sshd_config || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
echo "==> Writing $F"
printf '%s\\n' '# Managed by SuperDevops' 'PermitRootLogin prohibit-password' > "$F"
if ! sshd -t; then echo "The SSH configuration was rejected; the change was undone."; : > "$F"; exit 61; fi
[ "$(sshd -T 2>/dev/null | awk '$1=="permitrootlogin"{print $2}')" != "yes" ] || { echo "Another SSH setting still allows root with a password; the change was undone."; : > "$F"; exit 62; }
echo "==> Reloading SSH (open connections stay open)"
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload 2>/dev/null || service sshd reload 2>/dev/null || kill -HUP "$(cat /run/sshd.pid 2>/dev/null)" 2>/dev/null || echo "SSH could not be reloaded by itself. The change takes effect after SSH restarts."
echo "Done."`
  } else if (what === 'fail2ban') {
    script = `${PATH_EXPORT}
${APT}
set -e
if ! command -v fail2ban-client >/dev/null 2>&1; then
  echo "==> Installing fail2ban"
  apt-get update -qq || echo "(Some package sources could not be refreshed. Continuing with what is known.)"
  apt-get install -y -qq fail2ban
fi
PORT=$(sshd -T 2>/dev/null | awk '$1=="port"{print $2; exit}')
echo "==> Protecting SSH on port \${PORT:-22}"
mkdir -p /etc/fail2ban/jail.d
BACKEND=auto
[ -f /var/log/auth.log ] || BACKEND=systemd
printf '%s\\n' '# Managed by SuperDevops' '[sshd]' 'enabled = true' "port = \${PORT:-22}" 'maxretry = 5' 'findtime = 10m' 'bantime = 1h' "backend = $BACKEND" > /etc/fail2ban/jail.d/superdevops.conf
echo "==> Starting fail2ban"
systemctl enable --now fail2ban 2>/dev/null || service fail2ban restart 2>/dev/null || true
systemctl restart fail2ban 2>/dev/null || true
sleep 2
fail2ban-client ping >/dev/null 2>&1 || { echo "fail2ban is installed and configured but did not start. Check: systemctl status fail2ban"; exit 63; }
echo "Done. Blocked addresses: fail2ban-client status sshd"`
  } else if (what === 'auto-updates') {
    script = `${PATH_EXPORT}
${APT}
set -e
if ! command -v unattended-upgrade >/dev/null 2>&1; then
  echo "==> Installing unattended-upgrades"
  apt-get update -qq || echo "(Some package sources could not be refreshed. Continuing with what is known.)"
  apt-get install -y -qq unattended-upgrades
fi
echo "==> Turning on daily security updates"
printf '%s\\n' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades
echo "Done."`
  } else if (what === 'upgrade') {
    script = `${PATH_EXPORT}
${APT}
set -e
echo "==> Refreshing the package list"
apt-get update -qq || echo "(Some package sources could not be refreshed. Continuing with what is known.)"
echo "==> Installing updates"
apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
[ -f /var/run/reboot-required ] && echo "A restart is needed for some updates to take effect."
echo "Done."`
  } else {
    throw new Error('Unknown fix.')
  }
  await runPrivileged(client, script, sudo, log, 20 * 60 * 1000)
}

// ---------------------------------------------------------------- Fail2ban: who is blocked
const RE_IP = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{2,45})(?:\/\d{1,3})?$/
const RE_JAIL = /^[\w.-]{1,60}$/

const BANNED = `export LC_ALL=C
${PATH_EXPORT}
command -v fail2ban-client >/dev/null 2>&1 || { echo "@@missing"; exit 0; }
fail2ban-client ping >/dev/null 2>&1 || { echo "@@stopped"; exit 0; }
for j in $(fail2ban-client status | awk -F: '/Jail list/ { gsub(/[ \\t]/, "", $2); gsub(/,/, " ", $2); print $2 }'); do
  T=$(fail2ban-client get "$j" bantime 2>/dev/null)
  echo "@@jail $j \${T:-0}"
  fail2ban-client status "$j" | awk -F: '/Banned IP list/ { print $2 }' | tr ' \\t' '\\n\\n' | awk 'NF'
done`

/** Every address Fail2ban is blocking now, by the rule ("jail") that caught it. */
export async function banned(client: Client, sudo: Sudo): Promise<BannedList> {
  const res = await runPrivileged(client, BANNED, sudo, undefined, 30000)
  if (res.stdout.includes('@@missing')) return { state: 'missing', jails: [] }
  if (res.stdout.includes('@@stopped')) return { state: 'stopped', jails: [] }
  const jails: BannedList['jails'] = []
  for (const line of res.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (line.startsWith('@@jail ')) {
      const [, name, seconds] = line.split(' ')
      jails.push({ name, banSeconds: Number(seconds) || 0, addresses: [] })
    } else if (RE_IP.test(line) && jails.length) jails[jails.length - 1].addresses.push(line)
  }
  return { state: 'running', jails }
}

function checkBan(jail: string, address: string): void {
  if (typeof jail !== 'string' || !RE_JAIL.test(jail)) throw new Error('That rule name cannot be used.')
  if (typeof address !== 'string' || !RE_IP.test(address.trim())) throw new Error('Enter an IP address, for example 203.0.113.7.')
}

export async function unban(client: Client, sudo: Sudo, jail: string, address: string): Promise<void> {
  checkBan(jail, address)
  await runPrivileged(client, `${PATH_EXPORT}\nfail2ban-client set ${jail} unbanip ${address.trim()} >/dev/null`, sudo, undefined, 30000)
}

/** Block an address by hand. The address this app itself connects from is refused. */
export async function ban(client: Client, sudo: Sudo, jail: string, address: string): Promise<void> {
  checkBan(jail, address)
  const me = (await exec(client, 'echo "$SSH_CONNECTION"', { timeoutMs: 10000 })).stdout.trim().split(/\s+/)[0]
  if (me && me === address.trim()) throw new Error('That is the address this app is connected from. Blocking it would lock you out.')
  await runPrivileged(client, `${PATH_EXPORT}\nfail2ban-client set ${jail} banip ${address.trim()} >/dev/null`, sudo, undefined, 30000)
}
