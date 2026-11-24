// Log viewer, attack summary, and Telegram alerts. Alerts run on the server
// itself (a small script + cron), so they work while this app is closed.
import type { Client } from 'ssh2'
import type { AlertConfig, LogSource, Threats } from '@shared/types'
import type { Sudo } from './deploy'
import { PATH_EXPORT, runPrivileged } from './deploy'
import { shq } from './ssh'

const HEAD = `export LC_ALL=C\n${PATH_EXPORT}`
const RE_LOGFILE = /^\/var\/log\/[A-Za-z0-9._/-]+$/

export async function sources(client: Client, sudo: Sudo): Promise<LogSource[]> {
  const script = `${HEAD}
for f in /var/log/auth.log /var/log/secure /var/log/syslog /var/log/messages /var/log/nginx/*.log /var/log/php*-fpm.log /var/log/mysql/*.log /var/log/fail2ban.log; do
  [ -f "$f" ] && echo "file=$f"
done
command -v journalctl >/dev/null 2>&1 && echo "journal=1"
true`
  const res = await runPrivileged(client, script, sudo, undefined, 20000)
  const out: LogSource[] = []
  const files = res.stdout.split('\n').filter((l) => l.startsWith('file=')).map((l) => l.slice(5))
  const nice: Record<string, string> = {
    '/var/log/auth.log': 'SSH and login (auth.log)',
    '/var/log/secure': 'SSH and login (secure)',
    '/var/log/syslog': 'System (syslog)',
    '/var/log/messages': 'System (messages)'
  }
  for (const f of files) out.push({ id: f, label: nice[f] ?? f.replace('/var/log/', '') })
  if (res.stdout.includes('journal=1')) {
    out.push({ id: 'journal:system', label: 'System journal' }, { id: 'journal:ssh', label: 'SSH journal' }, { id: 'journal:nginx', label: 'nginx journal' })
  }
  return out
}

/**
 * Drops what this app writes into the logs itself: every action it takes runs
 * through sudo, which logs the whole (encoded) command plus a session line
 * before and after. Other sudo activity is kept.
 */
const TIDY = `awk '
/sudo: .*COMMAND=.*bash -c .eval ..\\(echo / { open++; close_++; next }
/sudo: .*\\(command continued\\)/ { next }
/sudo: pam_unix\\(sudo:session\\): session opened for user root/ { if (open > 0) { open--; next } }
/sudo: pam_unix\\(sudo:session\\): session closed for user root/ { if (close_ > 0) { close_--; next } }
{ print }'`

export async function read(client: Client, sudo: Sudo, source: string, lines: number, filter: string, tidy = false): Promise<string> {
  const n = Math.max(10, Math.min(5000, Math.floor(lines) || 200))
  // When tidying, start from more lines so that the requested number is left afterwards.
  const take = tidy ? Math.min(60000, n * 12) : n
  let cmd: string
  if (source === 'journal:system') cmd = `journalctl -n ${take} --no-pager -o short-iso`
  else if (source === 'journal:ssh') cmd = `journalctl -u ssh -u sshd -n ${take} --no-pager -o short-iso`
  else if (source === 'journal:nginx') cmd = `journalctl -u nginx -n ${take} --no-pager -o short-iso`
  else if (RE_LOGFILE.test(source) && !source.includes('..')) cmd = `tail -n ${take} ${shq(source)}`
  else throw new Error('Unknown log source.')
  if (tidy) cmd += ` | ${TIDY}`
  if (filter.trim()) cmd += ` | { grep -iF -- ${shq(filter.trim())} || true; }`
  if (tidy) cmd += ` | tail -n ${n}`
  const res = await runPrivileged(client, `${HEAD}\n${cmd}`, sudo, undefined, 30000)
  return res.stdout
}

/** Top sources of failed SSH logins and of web requests, from recent logs. */
export async function threats(client: Client, sudo: Sudo): Promise<Threats> {
  const script = `${HEAD}
echo "@@ssh"
{
  if [ -f /var/log/auth.log ]; then tail -n 50000 /var/log/auth.log
  elif [ -f /var/log/secure ]; then tail -n 50000 /var/log/secure
  elif command -v journalctl >/dev/null 2>&1; then journalctl -u ssh -u sshd --since "-24h" --no-pager 2>/dev/null
  fi
} | grep -E 'Failed password|Invalid user|authentication failure' | grep -oE 'from [0-9A-Fa-f.:]+|rhost=[0-9A-Fa-f.:]+' | sed 's/^from //; s/^rhost=//' | sort | uniq -c | sort -rn | head -10
echo "@@web"
if ls /var/log/nginx/*access.log >/dev/null 2>&1; then
  tail -q -n 20000 /var/log/nginx/*access.log | awk '{ n[$1]++; if ($9 ~ /^[45]/) e[$1]++ } END { for (ip in n) print n[ip], e[ip]+0, ip }' | sort -rn | head -10
fi
true`
  const res = await runPrivileged(client, script, sudo, undefined, 60000)
  const out: Threats = { ssh: [], web: [] }
  let cur: 'ssh' | 'web' | '' = ''
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('@@')) {
      cur = line.slice(2) as 'ssh' | 'web'
      continue
    }
    const f = line.trim().split(/\s+/)
    if (cur === 'ssh' && f.length === 2) out.ssh.push({ count: Number(f[0]), ip: f[1] })
    if (cur === 'web' && f.length === 3) out.web.push({ count: Number(f[0]), errors: Number(f[1]), ip: f[2] })
  }
  return out
}

// ---------------------------------------------------------------- Telegram alerts
const CONF = '/etc/superdevops/alert.conf'
/** Header file for alerts sent through the service: the server's id and its key. */
const RELAY = '/etc/superdevops/alert.relay'
const SCRIPT = '/usr/local/bin/superdevops-alert.sh'
const CRON = '/etc/cron.d/superdevops-alert'

const ALERT_SCRIPT = `#!/bin/bash
# Managed by SuperDevops. Checks the server and sends Telegram alerts.
export LC_ALL=C
export PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin:/usr/local/bin"
. ${CONF} || exit 1
STATE=/var/lib/superdevops/alert
mkdir -p "$STATE"
HOST=$(hostname)

send() {
  if [ -n "$RELAY_URL" ]; then
    # Through the team's service, which forwards it to Telegram. The key is read from a file, not put on the command line.
    printf '%s' "$1" | curl -sS -m 25 -o /dev/null -w '%{http_code}' -X POST -H @${RELAY} -H 'Content-Type: text/plain; charset=utf-8' --data-binary @- "$RELAY_URL/relay/alert"
    return
  fi
  curl -sS -m 15 -o /dev/null -w '%{http_code}' "\${API:-https://api.telegram.org}/bot$TOKEN/sendMessage" \\
    --data-urlencode "chat_id=$CHAT_ID" --data-urlencode "text=$1"
}

# notify <key> <message>: at most one message per key per cooldown period.
# A third argument sets its own quiet period in seconds.
notify() {
  local f="$STATE/$1.last" now last
  now=$(date +%s)
  last=$(cat "$f" 2>/dev/null || echo 0)
  if [ $((now - last)) -ge "\${3:-$((COOLDOWN_MIN * 60))}" ]; then
    code=$(send "[$HOST] $2")
    [ "$code" = "200" ] && echo "$now" > "$f"
  fi
}

# say <text>: send one message now (used for deploy problems).
if [ "$1" = "say" ]; then
  code=$(send "[$HOST] $2")
  [ "$code" = "200" ]
  exit $?
fi

if [ "$1" = "test" ]; then
  code=$(send "[$HOST] Apsara Panel test message. Alerts are working.")
  echo "http=$code"
  [ "$code" = "200" ]
  exit $?
fi

df -Pk | awk 'NR>1 && $1 ~ /^\\/dev\\// { gsub("%","",$5); print $5, $6 }' | while read -r pct mnt; do
  if [ "$pct" -ge "$DISK_PCT" ]; then notify "disk$(echo "$mnt" | tr '/' '_')" "Disk $mnt is \${pct}% full"; fi
done

mem=$(awk '/^MemTotal/{t=$2} /^MemAvailable/{a=$2} END { if (t>0) printf "%d", (t-a)*100/t; else print 0 }' /proc/meminfo)
if [ "$mem" -ge "$MEM_PCT" ]; then notify mem "Memory use is \${mem}%"; fi

cores=$(nproc 2>/dev/null || echo 1)
load=$(awk -v c="$cores" '{ printf "%d", $2*100/c }' /proc/loadavg)
if [ "$load" -ge "$LOAD_PCT" ]; then notify load "CPU load is \${load}% of $cores core(s) (5 min average)"; fi

if [ "$SSH_FAILS" -gt 0 ]; then
  AUTH=""
  [ -f /var/log/auth.log ] && AUTH=/var/log/auth.log
  [ -z "$AUTH" ] && [ -f /var/log/secure ] && AUTH=/var/log/secure
  if [ -n "$AUTH" ]; then
    total=$(grep -cE 'Failed password|Invalid user' "$AUTH" || true)
    prev=$(cat "$STATE/sshfails.count" 2>/dev/null || echo "$total")
    echo "$total" > "$STATE/sshfails.count"
    new=$((total - prev))
    [ "$new" -lt 0 ] && new=$total
    recent=$(tail -n 2000 "$AUTH")
  else
    recent=$(journalctl -u ssh -u sshd --since "-2min" --no-pager 2>/dev/null)
    new=$(echo "$recent" | grep -cE 'Failed password|Invalid user' || true)
  fi
  if [ "$new" -ge "$SSH_FAILS" ]; then
    top=$(echo "$recent" | grep -E 'Failed password|Invalid user' | grep -oE 'from [0-9A-Fa-f.:]+' | sort | uniq -c | sort -rn | head -3 | awk '{ printf "%s (%s) ", $3, $1 }')
    notify sshfails "Possible SSH attack: $new failed logins since the last check. Top sources: $top"
  fi
fi

if [ "$WATCH_NGINX" = "1" ] && command -v nginx >/dev/null 2>&1; then
  if ! pgrep -x nginx >/dev/null 2>&1; then notify nginx "nginx is not running"; fi
fi

# HTTPS certificates about to expire.
if [ "\${CERT_DAYS:-0}" -gt 0 ] && command -v openssl >/dev/null 2>&1; then
  now=$(date +%s)
  for f in /etc/letsencrypt/live/*/cert.pem; do
    [ -f "$f" ] || continue
    end=$(openssl x509 -enddate -noout -in "$f" 2>/dev/null | cut -d= -f2)
    e=$(date -d "$end" +%s 2>/dev/null) || continue
    days=$(( (e - now) / 86400 ))
    name=$(basename "$(dirname "$f")")
    if [ "$days" -lt 0 ]; then notify "cert_$name" "The HTTPS certificate for $name has EXPIRED. Visitors see a security warning."
    elif [ "$days" -lt "$CERT_DAYS" ]; then notify "cert_$name" "The HTTPS certificate for $name expires in $days day(s) and has not renewed itself."; fi
  done
fi

# Sites that stopped answering. Asked on this server itself, so DNS and outside firewalls do not matter.
if [ "\${WATCH_SITES:-0}" = "1" ] && command -v curl >/dev/null 2>&1 && pgrep -x nginx >/dev/null 2>&1; then
  for conf in /etc/nginx/conf.d/superdevops-*.conf /www/server/panel/vhost/nginx/superdevops-*.conf; do
    [ -f "$conf" ] || continue
    case "$conf" in *superdevops-firewall*|*superdevops-00*) continue ;; esac
    dom=$(awk '$1 == "server_name" { gsub(";", "", $2); print $2; exit }' "$conf")
    [ -n "$dom" ] && [ "$dom" != "_" ] || continue
    code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' -H "Host: $dom" http://127.0.0.1/ 2>/dev/null)
    key="site_$(echo "$dom" | tr -c 'A-Za-z0-9' '_')"
    bad=$(cat "/var/lib/superdevops/alert/$key.bad" 2>/dev/null || echo 0)
    # 503 is what a site in maintenance mode answers on purpose.
    if [ "$code" = "000" ] || { [ "$code" -ge 500 ] 2>/dev/null && [ "$code" != "503" ]; }; then
      # Two checks in a row, so one slow request does not wake anyone up.
      if [ "$bad" -ge 1 ]; then notify "$key" "The site $dom is not answering (status $code)."; echo 2 > "/var/lib/superdevops/alert/$key.bad"
      else echo 1 > "/var/lib/superdevops/alert/$key.bad"; fi
    else
      if [ "$bad" -ge 2 ]; then send "[$HOST] The site $dom is answering again." >/dev/null; echo 0 > "/var/lib/superdevops/alert/$key.last"; fi
      echo 0 > "/var/lib/superdevops/alert/$key.bad"
    fi
  done
fi

# Backups that quietly stopped. Only looked at where a backup is switched on; said once a day.
if [ "\${BACKUP_HOURS:-0}" -gt 0 ]; then
  now=$(date +%s)
  limit=$((BACKUP_HOURS * 3600))
  G=/var/lib/superdevops/gdrive
  if [ -f /etc/superdevops/gdrive/conf ] && [ -f /etc/superdevops/gdrive/token ]; then
    okat=$(cat "$G/last_ok" 2>/dev/null)
    IFS='|' read -r at res why < "$G/last" 2>/dev/null
    [ -z "$okat" ] && [ "$res" = ok ] && okat=$at
    [ -z "$okat" ] && okat=$(stat -c %Y /etc/superdevops/gdrive/conf 2>/dev/null || echo "$now")
    if [ $((now - okat)) -gt "$limit" ]; then
      notify backup_gdrive "No backup has reached Google Drive for $(( (now - okat) / 3600 )) hours.\${why:+ Last attempt: $why}" 86400
    fi
  fi
  if [ -f /etc/cron.d/superdevops-dbbackup ]; then
    newest=$(find /var/backups/superdevops/mysql -maxdepth 1 -name '*.sql.gz' -printf '%T@\\n' 2>/dev/null | sort -n | tail -1 | cut -d. -f1)
    [ -n "$newest" ] || newest=$(stat -c %Y /etc/cron.d/superdevops-dbbackup 2>/dev/null || echo "$now")
    if [ $((now - newest)) -gt "$limit" ]; then
      notify backup_db "The daily database backup has made nothing new for $(( (now - newest) / 3600 )) hours. Check that cron and the database server are running." 86400
    fi
  fi
fi
exit 0
`

const DEFAULTS: AlertConfig = {
  enabled: false,
  token: '',
  hasToken: false,
  chatId: '',
  diskPct: 90,
  memPct: 90,
  loadPct: 150,
  sshFails: 10,
  watchNginx: true,
  cooldownMin: 30,
  certDays: 14,
  watchSites: true,
  backupHours: 26
}

export async function getAlerts(client: Client, sudo: Sudo): Promise<AlertConfig> {
  const script = `[ -f ${CONF} ] && grep -vE '^(TOKEN|API)=' ${CONF}; [ -f ${CONF} ] && grep -q '^TOKEN=..' ${CONF} && echo HAS_TOKEN=1; [ -f ${CRON} ] && echo ENABLED=1; true`
  const res = await runPrivileged(client, script, sudo, undefined, 20000)
  const kv: Record<string, string> = {}
  for (const line of res.stdout.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (m) kv[m[1]] = m[2].replace(/^'(.*)'$/, '$1')
  }
  const num = (k: string, d: number): number => (kv[k] !== undefined && /^\d+$/.test(kv[k]) ? Number(kv[k]) : d)
  return {
    enabled: kv.ENABLED === '1',
    token: '',
    hasToken: kv.HAS_TOKEN === '1',
    via: kv.RELAY_URL ? 'team' : 'own',
    chatId: kv.CHAT_ID ?? '',
    diskPct: num('DISK_PCT', DEFAULTS.diskPct),
    memPct: num('MEM_PCT', DEFAULTS.memPct),
    loadPct: num('LOAD_PCT', DEFAULTS.loadPct),
    sshFails: num('SSH_FAILS', DEFAULTS.sshFails),
    watchNginx: kv.WATCH_NGINX !== undefined ? kv.WATCH_NGINX === '1' : DEFAULTS.watchNginx,
    cooldownMin: num('COOLDOWN_MIN', DEFAULTS.cooldownMin),
    certDays: num('CERT_DAYS', DEFAULTS.certDays),
    watchSites: kv.WATCH_SITES !== undefined ? kv.WATCH_SITES === '1' : DEFAULTS.watchSites,
    backupHours: num('BACKUP_HOURS', DEFAULTS.backupHours ?? 26)
  }
}

export interface AlertRelay {
  /** Address of the team's service, as the managed server reaches it. */
  url: string
  id: string
  key: string
}

export async function saveAlerts(client: Client, sudo: Sudo, cfg: AlertConfig, apiBase?: string, relay?: AlertRelay): Promise<void> {
  const token = relay ? '' : cfg.token.trim()
  const chat = (cfg.chatId ?? '').trim()
  if (relay) {
    if (!/^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(relay.url) || !/^[A-Za-z0-9-]{6,80}$/.test(relay.id) || !/^[a-f0-9]{64}$/.test(relay.key)) throw new Error('The service did not give a usable address for alerts.')
  } else {
    if (token && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('That does not look like a Telegram bot token (it should look like 123456:ABC-DEF...).')
    if (!/^(-?\d+|@[A-Za-z0-9_]{4,})$/.test(chat)) throw new Error('Chat ID must be a number (or @channelname).')
  }
  const range = (v: number, lo: number, hi: number, name: string): number => {
    if (!(Number.isInteger(v) && v >= lo && v <= hi)) throw new Error(`${name} must be between ${lo} and ${hi}.`)
    return v
  }
  const body = [
    `CHAT_ID=${shq(chat)}`,
    `DISK_PCT=${range(cfg.diskPct, 1, 100, 'Disk threshold')}`,
    `MEM_PCT=${range(cfg.memPct, 1, 100, 'Memory threshold')}`,
    `LOAD_PCT=${range(cfg.loadPct, 10, 10000, 'Load threshold')}`,
    `SSH_FAILS=${range(cfg.sshFails, 0, 100000, 'Failed-login threshold')}`,
    `WATCH_NGINX=${cfg.watchNginx ? 1 : 0}`,
    `COOLDOWN_MIN=${range(cfg.cooldownMin, 1, 1440, 'Repeat interval')}`,
    `CERT_DAYS=${range(cfg.certDays ?? DEFAULTS.certDays, 0, 90, 'Certificate warning')}`,
    `WATCH_SITES=${cfg.watchSites === false ? 0 : 1}`,
    `BACKUP_HOURS=${range(cfg.backupHours ?? DEFAULTS.backupHours ?? 26, 0, 720, 'Backup warning')}`
  ]
  if (apiBase) body.push(`API=${shq(apiBase)}`)
  if (relay) body.push(`RELAY_URL=${shq(relay.url)}`)
  const script = `${HEAD}
set -e
command -v curl >/dev/null 2>&1 || { echo "curl is not installed on the server. Install it first (Sites & Deploy can do that)."; exit 41; }
mkdir -p /etc/superdevops /var/lib/superdevops/alert
OLD=""
[ -f ${CONF} ] && OLD=$(grep '^TOKEN=' ${CONF} || true)
NEW=${shq(token ? `TOKEN=${shq(token)}` : '')}
${relay ? '# Sending through the service: no bot token stays on this server.\nNEW=""' : '[ -z "$NEW" ] && NEW="$OLD"'}
${relay ? '' : '[ -z "$NEW" ] && { echo "Enter the bot token."; exit 42; }'}
umask 077
${relay ? `printf '%s\\n' ${shq(`X-Server-Id: ${relay.id}`)} ${shq(`X-Relay-Key: ${relay.key}`)} > ${RELAY}; chmod 600 ${RELAY}` : `[ -e ${RELAY} ] && unlink ${RELAY}`}
{ [ -n "$NEW" ] && echo "$NEW"; echo ${Buffer.from(body.join('\n') + '\n').toString('base64')} | base64 -d; } > ${CONF}
chmod 600 ${CONF}
echo ${Buffer.from(ALERT_SCRIPT).toString('base64')} | base64 -d > ${SCRIPT}
chmod 700 ${SCRIPT}
${
  cfg.enabled
    ? `printf '%s\\n' '# Managed by SuperDevops' '*/2 * * * * root ${SCRIPT} >/dev/null 2>&1' > ${CRON}; chmod 644 ${CRON}`
    : `rm -f ${CRON}`
}`
  await runPrivileged(client, script, sudo, undefined, 30000)
}

export async function testAlert(client: Client, sudo: Sudo): Promise<void> {
  const script = `[ -x ${SCRIPT} ] || { echo "Save the alert settings first."; exit 43; }
OUT=$(${SCRIPT} test 2>&1) && exit 0
grep -q '^RELAY_URL=..' ${CONF} 2>/dev/null && OUT="RELAYED $OUT"
case "$OUT" in
  *RELAYED*http=401*) echo "The team's service did not accept this server's key. Save the alert settings again." ;;
  *RELAYED*http=409*) echo "Telegram is not set up on the team's service yet. An admin sets it once under Team, Protection." ;;
  *RELAYED*http=429*) echo "The service is holding back: too many alerts from this server in ten minutes." ;;
  *RELAYED*http=502*) echo "The service reached Telegram, but Telegram did not accept the message. Check the bot and chat under Team, Protection." ;;
  *RELAYED*http=000*|*RELAYED*resolve*|*RELAYED*timed*) echo "This server could not reach the team's service at its address. A server on the internet cannot reach a service that runs on a private or local address." ;;
  *RELAYED*) echo "The team's service did not accept the message: $OUT" ;;
  *http=401*|*http=404*) echo "Telegram rejected the bot token." ;;
  *http=400*|*http=403*) echo "Telegram rejected the chat ID. Open a chat with your bot and press Start first." ;;
  *http=000*|*resolve*|*timed*) echo "The server could not reach Telegram (network blocked?)." ;;
  *) echo "Telegram did not accept the message: $OUT" ;;
esac
exit 44`
  await runPrivileged(client, script, sudo, undefined, 40000)
}

/** Run one check now (used by tests and the "check now" action). */
export async function runAlertCheck(client: Client, sudo: Sudo): Promise<void> {
  await runPrivileged(client, `${SCRIPT}`, sudo, undefined, 60000)
}

// ---------------------------------------------------------------- one site's own logs (Sites → Logs)
export type SiteLogKind = 'access' | 'error'

/** Where nginx writes a site's logs: the same names the site's config uses (deploy.ts). */
export function siteLogPath(siteName: string, kind: SiteLogKind): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(siteName)) throw new Error('Unknown site.')
  return `/var/log/nginx/${siteName}.${kind === 'error' ? 'error' : 'access'}.log`
}

export interface SiteLogText {
  path: string
  exists: boolean
  /** Size of the file in bytes. */
  size: number
  text: string
}

/** The last lines of a site's access or error log, optionally only those containing some text. */
export async function siteLog(client: Client, sudo: Sudo, siteName: string, kind: SiteLogKind, lines: number, filter: string): Promise<SiteLogText> {
  const path = siteLogPath(siteName, kind)
  const n = Math.max(20, Math.min(5000, Math.floor(lines) || 500))
  const f = String(filter ?? '').trim()
  if (f.length > 200 || /[\0\n\r]/.test(f)) throw new Error('Filter on one line of at most 200 characters.')
  // With a filter the last 200 000 lines are searched, so a match is found even when it is not among the newest.
  const body = f ? `tail -n 200000 -- "$F" | { grep -iF -- ${shq(f)} || true; } | tail -n ${n}` : `tail -n ${n} -- "$F"`
  const res = await runPrivileged(client, `${HEAD}\nF=${shq(path)}\nif [ -f "$F" ]; then echo "@@size=$(stat -c %s -- "$F")"; ${body}; else echo "@@missing"; fi`, sudo, undefined, 30000)
  const out = res.stdout
  if (out.startsWith('@@missing')) return { path, exists: false, size: 0, text: '' }
  const nl = out.indexOf('\n')
  return { path, exists: true, size: Number(/@@size=(\d+)/.exec(out.slice(0, nl))?.[1] ?? 0), text: nl < 0 ? '' : out.slice(nl + 1) }
}

export interface SiteLogStats {
  /** Lines looked at: the newest of the access log, at most 50 000. */
  requests: number
  bytes: number
  status: { s2: number; s3: number; s4: number; s5: number }
  first: string
  last: string
  ips: { ip: string; count: number; errors: number }[]
  paths: { path: string; count: number }[]
}

/** A summary of the newest access log lines: requests by status, top visitors and top pages. */
export async function siteLogStats(client: Client, sudo: Sudo, siteName: string): Promise<SiteLogStats> {
  const path = siteLogPath(siteName, 'access')
  // nginx's default "combined" format: ip - user [time] "METHOD path PROTO" status bytes "referer" "agent"
  const script = `${HEAD}
F=${shq(path)}
[ -f "$F" ] || { echo "@@missing"; exit 0; }
OUT=$(tail -n 50000 -- "$F" | awk '
{
  n++; ip=$1; st=$9; b=$10
  if (n == 1) { first=$4 }
  last=$4
  if (st ~ /^2/) s2++; else if (st ~ /^3/) s3++; else if (st ~ /^4/) s4++; else if (st ~ /^5/) s5++
  if (b ~ /^[0-9]+$/) bytes += b
  ips[ip]++; if (st ~ /^[45]/) errs[ip]++
  p=$7; sub(/\\?.*/, "", p); if (p != "") paths[p]++
}
END {
  printf "total %d %d %d %d %d %d\\n", n, bytes, s2, s3, s4, s5
  printf "first %s\\nlast %s\\n", first, last
  for (i in ips) printf "ip %d %d %s\\n", ips[i], errs[i]+0, i
  for (q in paths) printf "path %d %s\\n", paths[q], q
}')
# Each part reads the whole summary; one grep on a shared pipe would swallow it for the others.
printf '%s\n' "$OUT" | grep -E '^(total|first|last)'
printf '%s\n' "$OUT" | grep '^ip ' | sort -k2,2nr | head -10
printf '%s\n' "$OUT" | grep '^path ' | sort -k2,2nr | head -10
true`
  const res = await runPrivileged(client, script, sudo, undefined, 60000)
  const empty: SiteLogStats = { requests: 0, bytes: 0, status: { s2: 0, s3: 0, s4: 0, s5: 0 }, first: '', last: '', ips: [], paths: [] }
  if (res.stdout.includes('@@missing')) return empty
  const out = { ...empty, ips: [] as SiteLogStats['ips'], paths: [] as SiteLogStats['paths'] }
  for (const line of res.stdout.split('\n')) {
    const p = line.split(' ')
    if (p[0] === 'total') {
      out.requests = Number(p[1]) || 0
      out.bytes = Number(p[2]) || 0
      out.status = { s2: Number(p[3]) || 0, s3: Number(p[4]) || 0, s4: Number(p[5]) || 0, s5: Number(p[6]) || 0 }
    } else if (p[0] === 'first') out.first = (p[1] ?? '').replace(/^\[/, '')
    else if (p[0] === 'last') out.last = (p[1] ?? '').replace(/^\[/, '')
    else if (p[0] === 'ip') out.ips.push({ count: Number(p[1]) || 0, errors: Number(p[2]) || 0, ip: p.slice(3).join(' ') })
    else if (p[0] === 'path') out.paths.push({ count: Number(p[1]) || 0, path: p.slice(2).join(' ').slice(0, 300) })
  }
  return out
}

/** Empty a site's log file. nginx keeps writing to the same file. */
export async function siteLogClear(client: Client, sudo: Sudo, siteName: string, kind: SiteLogKind): Promise<void> {
  const path = siteLogPath(siteName, kind)
  await runPrivileged(client, `${HEAD}\nF=${shq(path)}\n[ -f "$F" ] && truncate -s 0 -- "$F"\ntrue`, sudo, undefined, 20000)
}
