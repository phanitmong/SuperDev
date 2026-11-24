// Redis server management: service control, live stats, settings, redis.conf
// editor and flushing databases.
import type { Client } from 'ssh2'
import type { RedisOverview, RedisSettings, RedisStats } from '@shared/types'
import { REDIS_POLICIES } from '@shared/types'
import type { Sudo } from './deploy'
import { PATH_EXPORT, isIp, runPrivileged } from './deploy'
import { exec, shq, writeRemoteTemp } from './ssh'
import { repoLines } from './versions'

const RE_PASSWORD = /^[A-Za-z0-9_@#%^+=.,:!-]{8,128}$/

/**
 * Shell helpers shared by every script: find the config, read how to connect
 * from it, and control the service with or without systemd.
 */
const PRELUDE = `${PATH_EXPORT}
CONF=""
for f in /etc/redis/redis.conf /etc/redis.conf /etc/redis/6379.conf; do if [ -f "$f" ]; then CONF="$f"; break; fi; done
load_conn() {
  PORT=$(awk '$1=="port"{p=$2} END{print p+0}' "$CONF" 2>/dev/null); [ "\${PORT:-0}" -gt 0 ] 2>/dev/null || PORT=6379
  PASS=$(awk '$1=="requirepass"{p=$2} END{print p}' "$CONF" 2>/dev/null | sed 's/^"\\(.*\\)"$/\\1/')
  HOST=$(awk '$1=="bind"{for(i=2;i<=NF;i++){a=$i; sub(/^-/,"",a); if(a=="127.0.0.1"||a=="*"||a=="0.0.0.0"){print "127.0.0.1"; exit}} a=$2; sub(/^-/,"",a); print a; exit}' "$CONF" 2>/dev/null)
  [ -n "$HOST" ] || HOST=127.0.0.1
}
rc() {
  if [ -n "$PASS" ]; then REDISCLI_AUTH="$PASS" redis-cli -h "$HOST" -p "$PORT" --no-auth-warning "$@"
  else redis-cli -h "$HOST" -p "$PORT" "$@"
  fi
}
svc() { for s in redis-server redis; do if systemctl cat "$s.service" >/dev/null 2>&1; then echo "$s"; return; fi; done; echo redis-server; }
wait_ping() { for i in 1 2 3 4 5 6 7 8 9 10 11 12; do if rc ping 2>/dev/null | grep -q PONG; then return 0; fi; sleep 0.5; done; return 1; }
wait_down() { for i in 1 2 3 4 5 6 7 8 9 10 11 12; do if ! pgrep -x redis-server >/dev/null 2>&1; then return 0; fi; sleep 0.5; done; return 1; }
redis_stop() {
  if [ -d /run/systemd/system ]; then systemctl stop "$(svc)"
  else rc shutdown >/dev/null 2>&1 || true; wait_down || pkill -x redis-server || true; wait_down || true
  fi
}
redis_start() {
  if [ -d /run/systemd/system ]; then systemctl start "$(svc)"
  else mkdir -p /run/redis && chown redis:redis /run/redis 2>/dev/null; runuser -u redis -- redis-server "$CONF" --daemonize yes >/dev/null 2>&1 || redis-server "$CONF" --daemonize yes >/dev/null
  fi
}
load_conn`

export function confGet(raw: string, key: string): string {
  const re = new RegExp(`^[ \\t]*${key}[ \\t]+(.*?)[ \\t]*$`, 'gm')
  let value = ''
  for (const m of raw.matchAll(re)) value = m[1].replace(/^"(.*)"$/, '$1')
  return value
}

/** Set a directive in place (last active line, else the commented example, else append). */
export function confSet(raw: string, key: string, value: string | null): string {
  const active = [...raw.matchAll(new RegExp(`^[ \\t]*${key}[ \\t]+.*$`, 'gm'))]
  if (value === null) {
    // Remove every active line for this key.
    return raw.replace(new RegExp(`^[ \\t]*${key}[ \\t]+.*\\n?`, 'gm'), '')
  }
  const line = `${key} ${value}`
  if (active.length > 0) {
    const last = active[active.length - 1]
    return raw.slice(0, last.index) + line + raw.slice(last.index! + last[0].length)
  }
  const commented = new RegExp(`^#[ \\t]*${key}[ \\t]+.*$`, 'm').exec(raw)
  if (commented) return raw.slice(0, commented.index + commented[0].length) + '\n' + line + raw.slice(commented.index + commented[0].length)
  return raw.replace(/\n*$/, '\n') + line + '\n'
}

function parseMemory(value: string): number {
  const m = /^(\d+)\s*(b|k|kb|m|mb|g|gb)?$/i.exec(value.trim())
  if (!m) return 0
  const n = Number(m[1])
  const unit = (m[2] ?? 'b').toLowerCase()
  const mult = unit === 'b' ? 1 : unit === 'k' ? 1000 : unit === 'kb' ? 1024 : unit === 'm' ? 1e6 : unit === 'mb' ? 1048576 : unit === 'g' ? 1e9 : 1073741824
  return Math.round((n * mult) / 1048576)
}

function settingsFrom(raw: string): RedisSettings {
  const saves = [...raw.matchAll(/^[ \t]*save[ \t]+(.*?)[ \t]*$/gm)].map((m) => m[1])
  return {
    bind: confGet(raw, 'bind') || '127.0.0.1 -::1',
    port: Number(confGet(raw, 'port')) || 6379,
    maxmemoryMb: parseMemory(confGet(raw, 'maxmemory') || '0'),
    policy: confGet(raw, 'maxmemory-policy') || 'noeviction',
    appendonly: confGet(raw, 'appendonly') === 'yes',
    // No save line at all means Redis's default snapshots; a single save "" turns them off.
    rdb: !(saves.length > 0 && saves[saves.length - 1].replace(/"/g, '') === ''),
    password: '',
    removePassword: false
  }
}

function isOpen(bind: string): boolean {
  return bind
    .split(/\s+/)
    .filter(Boolean)
    .some((a) => {
      const addr = a.replace(/^-/, '')
      return !(addr === '127.0.0.1' || addr === '::1' || addr === 'localhost')
    })
}

export async function overview(client: Client, sudo: Sudo): Promise<RedisOverview> {
  const script = `${PRELUDE}
PM=""; for p in apt-get dnf yum; do if command -v "$p" >/dev/null 2>&1; then PM="$p"; break; fi; done
echo "@@pm"; echo "$PM"
echo "@@installed"; command -v redis-server >/dev/null 2>&1 && echo yes || echo no
echo "@@version"; redis-server --version 2>/dev/null | sed -n 's/.*v=\\([0-9.]*\\).*/\\1/p'
echo "@@confpath"; echo "$CONF"
echo "@@running"; rc ping 2>/dev/null | grep -q PONG && echo yes || echo no
echo "@@info"; rc info 2>/dev/null | tr -d '\\r' | grep -E '^(used_memory|connected_clients|uptime_in_seconds|keyspace_hits|keyspace_misses|role|db[0-9]+):' || true
echo "@@conf"; [ -n "$CONF" ] && cat "$CONF"
true`
  const res = await runPrivileged(client, script, sudo, undefined, 30000)
  const marker = '\n@@conf\n'
  const at = res.stdout.indexOf(marker)
  const head = at >= 0 ? res.stdout.slice(0, at) : res.stdout
  const raw = at >= 0 ? res.stdout.slice(at + marker.length) : ''
  const sec: Record<string, string[]> = {}
  let cur = ''
  for (const line of head.split('\n')) {
    if (line.startsWith('@@')) {
      cur = line.slice(2)
      sec[cur] = []
    } else if (cur && line.trim()) sec[cur].push(line.trim())
  }
  const running = sec.running?.[0] === 'yes'
  let stats: RedisStats | undefined
  if (running) {
    const kv: Record<string, string> = {}
    for (const l of sec.info ?? []) kv[l.slice(0, l.indexOf(':'))] = l.slice(l.indexOf(':') + 1)
    stats = {
      usedMemory: Number(kv.used_memory) || 0,
      clients: Number(kv.connected_clients) || 0,
      uptime: Number(kv.uptime_in_seconds) || 0,
      hits: Number(kv.keyspace_hits) || 0,
      misses: Number(kv.keyspace_misses) || 0,
      role: kv.role ?? '',
      databases: Object.keys(kv)
        .filter((k) => /^db\d+$/.test(k))
        .map((k) => ({ db: Number(k.slice(2)), keys: Number(/keys=(\d+)/.exec(kv[k])?.[1] ?? 0) }))
        .sort((a, b) => a.db - b.db)
    }
  }
  const settings = settingsFrom(raw)
  const hasPassword = !!confGet(raw, 'requirepass')
  return {
    installed: sec.installed?.[0] === 'yes',
    running,
    version: sec.version?.[0] ?? '',
    confPath: sec.confpath?.[0] ?? '',
    packageManager: sec.pm?.[0] ?? '',
    hasPassword,
    exposed: isOpen(settings.bind) && !hasPassword,
    settings,
    stats,
    raw
  }
}

export async function service(client: Client, sudo: Sudo, action: 'start' | 'stop' | 'restart'): Promise<void> {
  const body =
    action === 'stop'
      ? 'redis_stop'
      : action === 'start'
        ? 'redis_start\nwait_ping || { echo "Redis did not start. Check its log in Logs & Alerts or /var/log/redis."; exit 81; }'
        : 'redis_stop\nredis_start\nwait_ping || { echo "Redis did not come back after the restart."; exit 81; }'
  await runPrivileged(client, `${PRELUDE}\n[ -n "$CONF" ] || { echo "Redis is not installed."; exit 80; }\n${body}`, sudo, undefined, 60000)
}

/** Replace redis.conf, restart, and put the old file back if Redis does not come up. */
export async function saveRaw(client: Client, sudo: Sudo, raw: string): Promise<void> {
  if (!raw.trim()) throw new Error('The file is empty.')
  if (raw.length > 600000) throw new Error('The file is too large.')
  const upload = await writeRemoteTemp(client, raw.replace(/\r\n/g, '\n'))
  const script = `${PRELUDE}
TMP=${shq(upload)}
[ -n "$CONF" ] || { rm -f "$TMP"; echo "Redis is not installed."; exit 80; }
cp -p "$CONF" "$CONF.superdevops.bak"
redis_stop
cat "$TMP" > "$CONF"; rm -f "$TMP"
load_conn
redis_start
if ! wait_ping; then
  redis_stop
  cat "$CONF.superdevops.bak" > "$CONF"
  load_conn
  redis_start
  wait_ping || true
  echo "Redis did not start with the new settings. The previous redis.conf was put back."
  exit 82
fi`
  try {
    await runPrivileged(client, script, sudo, undefined, 90000)
  } finally {
    await exec(client, `rm -f ${shq(upload)}`, { timeoutMs: 10000 }).catch(() => undefined)
  }
}

export async function saveSettings(client: Client, sudo: Sudo, s: RedisSettings): Promise<void> {
  const current = await overview(client, sudo)
  if (!current.installed || !current.raw) throw new Error('Redis is not installed on this server.')
  const bind = s.bind.trim().split(/\s+/).filter(Boolean)
  if (bind.length === 0) throw new Error('Enter at least one address to listen on (127.0.0.1 for this server only).')
  for (const a of bind) {
    const addr = a.replace(/^-/, '')
    if (addr !== '*' && !isIp(addr)) throw new Error(`"${a}" is not a valid IP address.`)
  }
  if (!(Number.isInteger(s.port) && s.port > 0 && s.port < 65536)) throw new Error('Port must be between 1 and 65535.')
  if (!(Number.isInteger(s.maxmemoryMb) && s.maxmemoryMb >= 0 && s.maxmemoryMb <= 4194304)) throw new Error('Memory limit must be 0 (no limit) or a number of megabytes.')
  if (!REDIS_POLICIES.some((p) => p.value === s.policy)) throw new Error('Unknown eviction policy.')
  if (s.password && !RE_PASSWORD.test(s.password)) throw new Error('Password must be 8-128 characters: letters, numbers and _ @ # % ^ + = . , : ! -')
  const willHavePassword = s.removePassword ? false : !!s.password || current.hasPassword
  if (isOpen(bind.join(' ')) && !willHavePassword) {
    throw new Error('Set a password before letting other machines reach Redis. Without one, anyone who can reach the port can read and wipe your data.')
  }

  let raw = current.raw
  const before = current.settings
  if (bind.join(' ') !== before.bind) raw = confSet(raw, 'bind', bind.join(' '))
  if (s.port !== before.port) raw = confSet(raw, 'port', String(s.port))
  if (s.maxmemoryMb !== before.maxmemoryMb) raw = confSet(raw, 'maxmemory', s.maxmemoryMb === 0 ? '0' : `${s.maxmemoryMb}mb`)
  if (s.policy !== before.policy) raw = confSet(raw, 'maxmemory-policy', s.policy)
  if (s.appendonly !== before.appendonly) raw = confSet(raw, 'appendonly', s.appendonly ? 'yes' : 'no')
  if (s.rdb !== before.rdb) {
    raw = confSet(raw, 'save', null)
    if (!s.rdb) raw = confSet(raw, 'save', '""')
  }
  if (s.removePassword) raw = confSet(raw, 'requirepass', null)
  else if (s.password) raw = confSet(raw, 'requirepass', s.password)
  if (raw === current.raw) return

  // Switching the append-only file through the config file alone loses data: Redis would
  // start from an empty AOF. So make the running server convert its data first.
  if (current.running && s.appendonly !== before.appendonly) {
    const prepare = s.appendonly
      ? `rc config set appendonly yes >/dev/null
for i in $(seq 1 240); do
  P=$(rc info persistence | tr -d '\\r')
  if echo "$P" | grep -q '^aof_enabled:1' && echo "$P" | grep -q '^aof_rewrite_in_progress:0' && ! echo "$P" | grep -q '^aof_rewrite_scheduled:1'; then DONE=1; break; fi
  sleep 0.5
done
[ "$DONE" = "1" ] || { echo "Redis is still writing its append-only file. Try again in a moment."; exit 84; }`
      : `rc config set appendonly no >/dev/null
OUT=$(rc save 2>&1)
[ "$OUT" = "OK" ] || { echo "Could not save a snapshot before turning the append-only file off: $OUT"; exit 85; }`
    await runPrivileged(client, `${PRELUDE}\n${prepare}`, sudo, undefined, 180000)
  }
  await saveRaw(client, sudo, raw)
}

/** Delete every key in one database, or in all of them when db is null. */
export async function flush(client: Client, sudo: Sudo, db: number | null): Promise<void> {
  if (db !== null && !(Number.isInteger(db) && db >= 0 && db < 1024)) throw new Error('Unknown database.')
  const cmd = db === null ? 'rc flushall' : `rc -n ${db} flushdb`
  await runPrivileged(client, `${PRELUDE}\nOUT=$(${cmd} 2>&1)\n[ "$OUT" = "OK" ] || { echo "Redis refused: $OUT"; exit 83; }`, sudo, undefined, 30000)
}

export async function install(client: Client, sudo: Sudo, log: (s: string) => void, version = 'system'): Promise<void> {
  const script = `${PATH_EXPORT}
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  ${repoLines('redis', version).split('\n').join('\n  ')}
  apt-get update -y || echo "Some package lists could not be refreshed; carrying on with the ones already here."
  echo "==> Installing $PKG"
  apt-get install -y "$PKG" || { ${version === 'system' ? '' : '[ -e /etc/apt/sources.list.d/redis.list ] && unlink /etc/apt/sources.list.d/redis.list; '}echo "Redis could not be installed."; exit 43; }
  if [ -d /run/systemd/system ]; then systemctl enable --now redis-server 2>/dev/null || true; else service redis-server start >/dev/null 2>&1 || true; fi
elif command -v dnf >/dev/null 2>&1; then dnf install -y redis || exit 43; systemctl enable --now redis 2>/dev/null || true
elif command -v yum >/dev/null 2>&1; then yum install -y redis || exit 43; systemctl enable --now redis 2>/dev/null || true
else echo "No supported package manager found."; exit 40
fi
echo; echo "==> Redis $(redis-server --version | sed -n 's/.*v=\\([0-9.]*\\).*/\\1/p') installed. It listens on this server only (127.0.0.1)."`
  await runPrivileged(client, script, sudo, log, 30 * 60000)
}
