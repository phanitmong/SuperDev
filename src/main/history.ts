// Long-term monitor history. A small script on the managed server writes one
// line per minute, so the charts cover hours and days even while nobody has
// the app open. Also: certificate expiry for the all-servers dashboard.
import type { Client } from 'ssh2'
import type { CertInfo, HistoryPoint, HistoryRange, HistoryStatus } from '@shared/types'
import { exec, wrapScript } from './ssh'
import { runPrivileged, type Sudo } from './deploy'

const SCRIPT = '/usr/local/bin/superdevops-metrics.sh'
const CRON = '/etc/cron.d/superdevops-metrics'
const DIR = '/var/lib/superdevops/metrics'
const LOG = `${DIR}/history.log`
/** Seven days of one line per minute. */
const KEEP_LINES = 7 * 24 * 60

// Line format: time cpu% mem% disk% load1 rxBytesPerSec txBytesPerSec
const COLLECTOR = `#!/bin/bash
# Managed by SuperDevops. Records one line of server load per minute.
export LC_ALL=C
D=${DIR}
mkdir -p "$D"
now=$(date +%s)
read -r _ u n s i w q sq st _ < /proc/stat
total=$((u+n+s+i+w+q+sq+st)); idle=$((i+w))
net=$(awk -F'[: ]+' 'NR>2 && $2 != "lo" { rx+=$3; tx+=$11 } END { printf "%d %d", rx, tx }' /proc/net/dev)
rx=\${net% *}; tx=\${net#* }
cpu=0; rxr=0; txr=0
if [ -f "$D/prev" ]; then
  read -r pt ptotal pidle prx ptx < "$D/prev"
  dt=$((now-pt)); dtotal=$((total-ptotal))
  if [ "$dt" -gt 0 ] && [ "$dt" -lt 600 ] && [ "$dtotal" -gt 0 ]; then
    cpu=$(( (dtotal-(idle-pidle))*1000/dtotal ))
    [ "$rx" -ge "$prx" ] && rxr=$(( (rx-prx)/dt ))
    [ "$tx" -ge "$ptx" ] && txr=$(( (tx-ptx)/dt ))
  fi
fi
echo "$now $total $idle $rx $tx" > "$D/prev"
mem=$(awk '/^MemTotal/{t=$2} /^MemAvailable/{a=$2} END { if (t>0) printf "%d", (t-a)*1000/t; else print 0 }' /proc/meminfo)
disk=$(df -Pk / | awk 'NR==2 { gsub("%","",$5); print $5 }')
load=$(cut -d' ' -f1 /proc/loadavg)
echo "$now $((cpu/10)).$((cpu%10)) $((mem/10)).$((mem%10)) \${disk:-0} $load $rxr $txr" >> "$D/history.log"
# Once an hour, drop what is older than seven days.
if [ "$(date +%M)" = "07" ]; then
  tail -n ${KEEP_LINES} "$D/history.log" > "$D/history.tmp" && mv "$D/history.tmp" "$D/history.log"
fi
exit 0
`

export async function status(client: Client): Promise<HistoryStatus> {
  const res = await exec(client, wrapScript(`[ -f ${CRON} ] && echo on=1; [ -r ${LOG} ] && { head -n 1 ${LOG} | cut -d' ' -f1 | sed 's/^/first=/'; wc -l < ${LOG} | sed 's/^/lines=/'; }; true`), { timeoutMs: 15000 })
  const kv = Object.fromEntries(
    res.stdout
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => l.trim().split('=') as [string, string])
  )
  return { enabled: kv.on === '1', since: kv.first ? Number(kv.first) * 1000 : undefined, points: Number(kv.lines) || 0 }
}

/** Turn recording on or off. Turning it off keeps what was already recorded. */
export async function setEnabled(client: Client, sudo: Sudo, on: boolean): Promise<void> {
  const script = on
    ? `set -e
mkdir -p ${DIR}
chmod 755 /var/lib/superdevops ${DIR}
echo ${Buffer.from(COLLECTOR).toString('base64')} | base64 -d > ${SCRIPT}
chmod 755 ${SCRIPT}
printf '%s\\n' '# Managed by SuperDevops' '* * * * * root ${SCRIPT} >/dev/null 2>&1' > ${CRON}
chmod 644 ${CRON}
${SCRIPT}
( pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1 ) || echo "@@nocron"`
    : `unlink ${CRON} 2>/dev/null; unlink ${SCRIPT} 2>/dev/null; true`
  const res = await runPrivileged(client, script, sudo, undefined, 30000)
  if (res.stdout.includes('@@nocron')) throw new Error('History was set up, but the cron service is not running on this server, so nothing will be recorded. Start cron (see the Cron jobs page) and it begins by itself.')
}

const SPAN: Record<HistoryRange, number> = { '1h': 3600, '24h': 86400, '7d': 7 * 86400 }

/** Averaged into at most about 240 points, oldest first. */
export async function read(client: Client, range: HistoryRange): Promise<HistoryPoint[]> {
  const span = SPAN[range]
  if (!span) throw new Error('Unknown time range.')
  const bucket = Math.max(60, Math.round(span / 240 / 60) * 60)
  const script = `[ -r ${LOG} ] || exit 0
awk -v from="$(( $(date +%s) - ${span} ))" -v b=${bucket} '
$1 >= from && NF >= 7 {
  k = int($1 / b) * b
  if (k != cur && n > 0) { printf "%d %.1f %.1f %.0f %.2f %.0f %.0f\\n", cur, c/n, m/n, d/n, l/n, r/n, t/n; c=m=d=l=r=t=n=0 }
  cur = k; c += $2; m += $3; d += $4; l += $5; r += $6; t += $7; n++
}
END { if (n > 0) printf "%d %.1f %.1f %.0f %.2f %.0f %.0f\\n", cur, c/n, m/n, d/n, l/n, r/n, t/n }' ${LOG}`
  const res = await exec(client, wrapScript(script), { timeoutMs: 30000 })
  return res.stdout
    .split('\n')
    .map((line) => line.trim().split(' ').map(Number))
    .filter((f) => f.length === 7 && f.every((n) => Number.isFinite(n)))
    .map((f) => ({ ts: f[0] * 1000, cpu: f[1], mem: f[2], disk: f[3], load: f[4], rx: f[5], tx: f[6] }))
}

/** HTTPS certificates on the server and how many days each has left, soonest first. */
export async function certs(client: Client, sudo: Sudo): Promise<CertInfo[]> {
  const script = `export LC_ALL=C
command -v openssl >/dev/null 2>&1 || exit 0
now=$(date +%s)
for f in /etc/letsencrypt/live/*/cert.pem; do
  [ -f "$f" ] || continue
  end=$(openssl x509 -enddate -noout -in "$f" 2>/dev/null | cut -d= -f2)
  [ -n "$end" ] || continue
  e=$(date -d "$end" +%s 2>/dev/null) || continue
  echo "$(basename "$(dirname "$f")") $(( (e - now) / 86400 ))"
done`
  const res = await runPrivileged(client, script, sudo, undefined, 20000)
  return res.stdout
    .split('\n')
    .map((l) => l.trim().split(' '))
    .filter((f) => f.length === 2 && /^-?\d+$/.test(f[1]))
    .map((f) => ({ domain: f[0], daysLeft: Number(f[1]) }))
    .sort((a, b) => a.daysLeft - b.daysLeft)
}
