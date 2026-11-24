// PHP management in the style of a hosting panel: several versions side by
// side, php.ini settings, and extensions. Debian / Ubuntu (apt) only.
import type { Client } from 'ssh2'
import type { PhpConfig, PhpExtAction, PhpExtension, PhpOverview, PhpVersion, PhpOptimizeInput, PhpOptimizePlan } from '@shared/types'
import { PHP_SETTINGS } from '@shared/types'
import type { Sudo } from './deploy'
import { PATH_EXPORT, runPrivileged } from './deploy'
import { exec, shq, writeRemoteTemp } from './ssh'

export const PHP_VERSIONS = ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4']
const RE_VERSION = /^\d\.\d$/
const RE_EXT = /^[a-z0-9][a-z0-9-]{0,40}$/
const RE_VALUE = /^[A-Za-z0-9_.,/ :+~&|^!-]*$/
/** Packages named phpX.Y-<this> that are not extensions. */
const NOT_EXTENSIONS = new Set(['cli', 'fpm', 'cgi', 'common', 'dev', 'phpdbg', 'embed', 'litespeed', 'libvirt-php'])

function checkVersion(v: string): string {
  if (!RE_VERSION.test(v)) throw new Error('Unknown PHP version.')
  return v
}

/** Shell function that restarts one FPM version, with or without systemd. */
const RESTART_FN = `restart_fpm() {
  if [ -d /run/systemd/system ]; then
    systemctl restart "php$1-fpm"
  else
    # No systemd (containers, some minimal systems): signal the running master, or start one.
    MASTER=$(pgrep -f "php-fpm: master process \\(/etc/php/$1/fpm/php-fpm.conf\\)" | head -1)
    if [ -n "$MASTER" ]; then
      kill -USR2 "$MASTER"
    else
      mkdir -p /run/php
      "/usr/sbin/php-fpm$1" --daemonize --fpm-config "/etc/php/$1/fpm/php-fpm.conf"
    fi
  fi
}`

/**
 * Shell function listing the PHP modules a package provides. Core extensions keep
 * their ini under /usr/share, PECL ones directly in mods-available.
 */
const MODS_FN = `mods_of() {
  dpkg -L "$1" 2>/dev/null | sed -n -e 's#^/usr/share/php[0-9.]*-[^/]*/[^/]*/\\(.*\\)\\.ini$#\\1#p' -e 's#^/etc/php/[0-9.]*/mods-available/\\(.*\\)\\.ini$#\\1#p' | sort -u
}`

export async function overview(client: Client, sudo: Sudo): Promise<PhpOverview> {
  const script = `${PATH_EXPORT}
echo "os=$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")"
command -v apt-get >/dev/null 2>&1 && echo "apt=1"
for d in /etc/php/*/; do
  v=$(basename "$d")
  case "$v" in [0-9].[0-9]) ;; *) continue ;; esac
  fpm=0; [ -x "/usr/sbin/php-fpm$v" ] && fpm=1
  run=0; pgrep -f "php-fpm: master process \\(/etc/php/$v/fpm/php-fpm.conf\\)" >/dev/null 2>&1 && run=1
  sock=""; [ -S "/run/php/php$v-fpm.sock" ] && sock="/run/php/php$v-fpm.sock"
  full=$("php$v" -r 'echo PHP_VERSION;' 2>/dev/null || true)
  echo "v=$v|$full|$fpm|$run|$sock"
done
true`
  const res = await runPrivileged(client, script, sudo, undefined, 30000)
  const versions: PhpVersion[] = []
  let os = ''
  let apt = false
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('os=')) os = line.slice(3).trim()
    if (line.trim() === 'apt=1') apt = true
    if (line.startsWith('v=')) {
      const [version, full, fpm, run, socket] = line.slice(2).split('|')
      versions.push({ version, full: full || version, fpmInstalled: fpm === '1', running: run === '1', socket: socket?.trim() ?? '' })
    }
  }
  versions.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
  const have = new Set(versions.filter((v) => v.fpmInstalled).map((v) => v.version))
  return { supported: apt, os, versions, installable: apt ? PHP_VERSIONS.filter((v) => !have.has(v)).reverse() : [] }
}

export async function installVersion(client: Client, sudo: Sudo, version: string, log: (s: string) => void): Promise<void> {
  const v = checkVersion(version)
  if (!PHP_VERSIONS.includes(v)) throw new Error('That PHP version is not offered here.')
  const script = `${PATH_EXPORT}
${RESTART_FN}
set -e
command -v apt-get >/dev/null 2>&1 || { echo "PHP versions can only be installed here on Debian or Ubuntu."; exit 40; }
export DEBIAN_FRONTEND=noninteractive
have() { c=$(apt-cache policy "php${v}-fpm" 2>/dev/null | awk '/Candidate:/{print $2}'); [ -n "$c" ] && [ "$c" != "(none)" ]; }
if ! have; then
  . /etc/os-release
  echo "==> PHP ${v} is not in this system's own packages. Adding the PHP package source."
  apt-get update -y
  if [ "$ID" = "ubuntu" ]; then
    apt-get install -y software-properties-common
    add-apt-repository -y ppa:ondrej/php
  elif [ "$ID" = "debian" ]; then
    apt-get install -y ca-certificates curl lsb-release
    curl -fsSLo /usr/share/keyrings/deb.sury.org-php.gpg https://packages.sury.org/php/apt.gpg
    echo "deb [signed-by=/usr/share/keyrings/deb.sury.org-php.gpg] https://packages.sury.org/php/ $(lsb_release -sc) main" > /etc/apt/sources.list.d/sury-php.list
  else
    echo "Do not know where to get PHP ${v} for $PRETTY_NAME."; exit 41
  fi
  apt-get update -y
  have || { echo "PHP ${v} is not available for this system version."; exit 42; }
fi
echo; echo "==> Installing PHP ${v}"
apt-get install -y php${v}-fpm php${v}-cli php${v}-mysql php${v}-mbstring php${v}-xml php${v}-curl php${v}-zip php${v}-gd php${v}-bcmath php${v}-intl
systemctl enable "php${v}-fpm" >/dev/null 2>&1 || true
restart_fpm ${v}
echo; echo "==> PHP $(php${v} -r 'echo PHP_VERSION;') is installed"`
  await runPrivileged(client, script, sudo, log)
}

export async function restart(client: Client, sudo: Sudo, version: string): Promise<void> {
  const v = checkVersion(version)
  await runPrivileged(client, `${PATH_EXPORT}\n${RESTART_FN}\n[ -x /usr/sbin/php-fpm${v} ] || { echo "PHP-FPM ${v} is not installed."; exit 43; }\nrestart_fpm ${v}`, sudo, undefined, 60000)
}

// ---------------------------------------------------------------- php.ini
function iniPath(v: string): string {
  return `/etc/php/${v}/fpm/php.ini`
}

/** Value of a directive: the last uncommented assignment wins, as in PHP. */
export function iniGet(raw: string, key: string): string {
  const re = new RegExp(`^[ \\t]*${key.replace(/\./g, '\\.')}[ \\t]*=[ \\t]*(.*?)[ \\t]*$`, 'gm')
  let value = ''
  for (const m of raw.matchAll(re)) value = m[1].replace(/\s*;.*$/, '').replace(/^"(.*)"$/, '$1')
  return value
}

/** Set a directive in place, keeping the file's comments and layout. */
export function iniSet(raw: string, key: string, value: string): string {
  const k = key.replace(/\./g, '\\.')
  const line = `${key} = ${value}`
  const active = [...raw.matchAll(new RegExp(`^[ \\t]*${k}[ \\t]*=.*$`, 'gm'))]
  if (active.length > 0) {
    const last = active[active.length - 1]
    return raw.slice(0, last.index) + line + raw.slice(last.index! + last[0].length)
  }
  const commented = new RegExp(`^[ \\t]*;[ \\t]*${k}[ \\t]*=.*$`, 'm').exec(raw)
  if (commented) return raw.slice(0, commented.index) + line + raw.slice(commented.index + commented[0].length)
  return raw.replace(/\n*$/, '\n') + line + '\n'
}

export async function getConfig(client: Client, sudo: Sudo, version: string): Promise<PhpConfig> {
  const v = checkVersion(version)
  const res = await runPrivileged(client, `cat ${iniPath(v)}`, sudo, undefined, 30000)
  const values: Record<string, string> = {}
  for (const s of PHP_SETTINGS) values[s.key] = iniGet(res.stdout, s.key)
  return { values, raw: res.stdout }
}

/** Replace php.ini after checking it parses; put the old one back if FPM will not take it. */
export async function saveRaw(client: Client, sudo: Sudo, version: string, raw: string): Promise<void> {
  const v = checkVersion(version)
  if (!raw.trim()) throw new Error('The file is empty.')
  if (raw.length > 400000) throw new Error('The file is too large.')
  // php.ini is too large for a command line, so it is uploaded to a private temp file first.
  const upload = await writeRemoteTemp(client, raw.replace(/\r\n/g, '\n'))
  const script = `${PATH_EXPORT}
${RESTART_FN}
INI=${iniPath(v)}
TMP=${shq(upload)}
[ -f "$INI" ] || { rm -f "$TMP"; echo "PHP ${v} has no FPM php.ini on this server."; exit 43; }
ERR=$(PHP_INI_SCAN_DIR= php${v} -c "$TMP" -r 'exit(0);' 2>&1 | grep -iE 'syntax error|parse error' | head -1)
if [ -n "$ERR" ]; then rm -f "$TMP"; echo "php.ini has a mistake: $(echo "$ERR" | sed "s#$TMP#php.ini#")"; exit 44; fi
cp -p "$INI" "$INI.superdevops.bak"
cat "$TMP" > "$INI"; rm -f "$TMP"
if ! /usr/sbin/php-fpm${v} -t >/dev/null 2>&1 || ! restart_fpm ${v}; then
  cat "$INI.superdevops.bak" > "$INI"
  restart_fpm ${v} || true
  echo "PHP-FPM did not accept the new settings. The previous php.ini was put back."
  exit 45
fi`
  try {
    await runPrivileged(client, script, sudo, undefined, 60000)
  } finally {
    // Normally already removed by the script; this covers a failed sudo.
    await exec(client, `rm -f ${shq(upload)}`, { timeoutMs: 10000 }).catch(() => undefined)
  }
}

export async function saveSettings(client: Client, sudo: Sudo, version: string, values: Record<string, string>): Promise<void> {
  const allowed = new Set(PHP_SETTINGS.map((s) => s.key))
  const current = await getConfig(client, sudo, version)
  let raw = current.raw
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key)) throw new Error(`"${key}" cannot be changed from this form. Use the php.ini editor.`)
    const val = (value ?? '').trim()
    if (!RE_VALUE.test(val)) throw new Error(`The value for ${key} contains characters that are not allowed.`)
    if (val === current.values[key]) continue
    if (val === '' && key !== 'disable_functions' && key !== 'date.timezone') throw new Error(`Enter a value for ${key}.`)
    raw = iniSet(raw, key, val)
  }
  if (raw !== current.raw) await saveRaw(client, sudo, version, raw)
}

// ---------------------------------------------------------------- extensions
export async function extensions(client: Client, sudo: Sudo, version: string): Promise<PhpExtension[]> {
  const v = checkVersion(version)
  const script = `${PATH_EXPORT}
${MODS_FN}
echo "@@available"; apt-cache pkgnames php${v}- 2>/dev/null | sort
echo "@@installed"
for p in $(dpkg-query -W -f='\${Package} \${db:Status-Abbrev}\\n' 'php${v}-*' 2>/dev/null | awk '$2 ~ /^ii/ {print $1}'); do
  mods=$(mods_of "$p" | tr '\\n' ',')
  echo "$p=$mods"
done
echo "@@enabled"; ls /etc/php/${v}/fpm/conf.d 2>/dev/null | sed 's/^[0-9]*-//; s/\\.ini$//'
true`
  const res = await runPrivileged(client, script, sudo, undefined, 60000)
  const prefix = `php${v}-`
  const available = new Set<string>()
  const installed = new Map<string, string[]>()
  const enabled = new Set<string>()
  let mode = ''
  for (const line of res.stdout.split('\n')) {
    const t = line.trim()
    if (t.startsWith('@@')) {
      mode = t.slice(2)
      continue
    }
    if (!t) continue
    if (mode === 'available' && t.startsWith(prefix)) available.add(t.slice(prefix.length))
    if (mode === 'installed' && t.startsWith(prefix)) {
      const [pkg, mods] = t.split('=')
      installed.set(pkg.slice(prefix.length), (mods ?? '').split(',').filter(Boolean))
    }
    if (mode === 'enabled') enabled.add(t)
  }
  const names = new Set([...available, ...installed.keys()])
  const out: PhpExtension[] = []
  for (const name of names) {
    if (NOT_EXTENSIONS.has(name) || /-dbgsym$|-dev$/.test(name) || !RE_EXT.test(name)) continue
    const mods = installed.get(name)
    out.push({
      name,
      installed: !!mods,
      modules: mods ?? [],
      enabled: !!mods && (mods.length === 0 || mods.every((m) => enabled.has(m)))
    })
  }
  return out.sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name))
}

export async function extensionAction(
  client: Client,
  sudo: Sudo,
  version: string,
  name: string,
  action: PhpExtAction,
  log: (s: string) => void
): Promise<void> {
  const v = checkVersion(version)
  if (!RE_EXT.test(name) || NOT_EXTENSIONS.has(name)) throw new Error('Unknown extension.')
  const pkg = `php${v}-${name}`
  const mods = `MODS=$(mods_of ${pkg} | tr '\\n' ' ')
[ -n "$MODS" ] || { echo "${pkg} is not installed, or it has nothing to switch on or off."; exit 46; }`
  let body: string
  if (action === 'install') {
    // Some extension packages can be satisfied by a different PHP version; apt would then
    // quietly install that whole version. Check first and stop instead.
    body = `export DEBIAN_FRONTEND=noninteractive
OTHER=$(apt-get install -s ${pkg} 2>/dev/null | awk '/^Inst php[0-9]\\.[0-9]-(fpm|cli|common) /{print $2}' | grep -v '^php${v}-' | tr '\\n' ' ' || true)
if [ -n "$OTHER" ]; then
  echo "Not installed: on this server ${pkg} would also install another PHP version ($OTHER)."
  echo "This happens when PHP ${v} comes from a different package source than the extension. Update PHP ${v} first (apt-get install --only-upgrade 'php${v}-*'), then try again."
  exit 48
fi
echo "==> Installing ${pkg}"
apt-get install -y ${pkg}`
  } else if (action === 'remove') {
    body = `export DEBIAN_FRONTEND=noninteractive
echo "==> Removing ${pkg}"
apt-get remove -y ${pkg}`
  } else if (action === 'enable') {
    body = `${mods}\necho "==> Enabling $MODS"\nphpenmod -v ${v} -s ALL $MODS`
  } else if (action === 'disable') {
    body = `${mods}\necho "==> Disabling $MODS"\nphpdismod -v ${v} -s ALL $MODS`
  } else {
    throw new Error('Unknown action.')
  }
  const script = `${PATH_EXPORT}
${RESTART_FN}
${MODS_FN}
set -e
${body}
if [ -x /usr/sbin/php-fpm${v} ]; then
  /usr/sbin/php-fpm${v} -t >/dev/null 2>&1 || { echo "PHP-FPM reports a configuration problem after this change:"; /usr/sbin/php-fpm${v} -t 2>&1 | tail -3; exit 47; }
  restart_fpm ${v}
  echo "==> PHP-FPM ${v} restarted"
fi`
  await runPrivileged(client, script, sudo, log)
}

// ---------------------------------------------------------------- optimise for the size of the server
function poolPath(v: string): string {
  return `/etc/php/${v}/fpm/pool.d/www.conf`
}

/** Memory one PHP worker is assumed to use on average. A typical framework or WordPress page sits between 40 and 80 MB. */
const WORKER_MB = 64

/** The settings worth changing for a server of this size. `mix` says what else lives on it. */
export function recommend(ramMb: number, cores: number, mix: PhpOptimizeInput['mix']): { ini: Record<string, string>; pool: Record<string, string>; reasons: Record<string, string> } {
  const ram = Math.max(256, Math.floor(ramMb))
  const cpu = Math.max(1, Math.floor(cores))
  // What PHP may use: the rest is left for the system, nginx and, when it shares the server, the database.
  const share = mix === 'php-only' ? 0.7 : 0.45
  const forPhp = Math.max(128, Math.floor((ram - Math.min(512, ram * 0.2)) * share))
  const children = Math.max(4, Math.min(400, Math.floor(forPhp / WORKER_MB)))
  const start = Math.max(2, Math.min(Math.floor(children / 2), cpu * 2))
  const minSpare = Math.max(1, Math.min(start, cpu))
  const maxSpare = Math.max(minSpare + 1, Math.min(children, cpu * 4))
  const big = ram >= 7000
  const mid = ram >= 3500
  const small = ram < 1500
  const opcache = big ? 256 : mid ? 192 : small ? 64 : 128
  const ini: Record<string, string> = {
    memory_limit: big ? '512M' : mid ? '256M' : small ? '128M' : '192M',
    upload_max_filesize: '64M',
    post_max_size: '64M',
    max_execution_time: '60',
    max_input_time: '60',
    max_input_vars: '3000',
    'opcache.enable': '1',
    'opcache.memory_consumption': String(opcache),
    'opcache.interned_strings_buffer': big ? '32' : mid ? '16' : '8',
    'opcache.max_accelerated_files': mid ? '20000' : '10000',
    realpath_cache_size: mid ? '4096K' : '2048K',
    realpath_cache_ttl: '600'
  }
  const pool: Record<string, string> = {
    pm: 'dynamic',
    'pm.max_children': String(children),
    'pm.start_servers': String(Math.min(start, maxSpare)),
    'pm.min_spare_servers': String(minSpare),
    'pm.max_spare_servers': String(maxSpare),
    'pm.max_requests': '500'
  }
  const reasons: Record<string, string> = {
    memory_limit: 'The most one page may use. Higher on a bigger server, so heavy pages do not fail.',
    upload_max_filesize: 'Lets people upload files up to this size.',
    post_max_size: 'Must be at least the upload size.',
    max_execution_time: 'Seconds a page may run before it is stopped.',
    max_input_time: 'Seconds PHP waits for an upload to arrive.',
    max_input_vars: 'Large forms and admin screens need more than the default 1000.',
    'opcache.enable': 'Keeps compiled PHP in memory, so pages are not compiled again on every visit.',
    'opcache.memory_consumption': `MB kept for compiled PHP, sized for ${Math.round(ram / 1024) || 1} GB of memory.`,
    'opcache.interned_strings_buffer': 'MB for text that scripts share.',
    'opcache.max_accelerated_files': 'How many PHP files can be kept compiled.',
    realpath_cache_size: 'Remembers where files are, which saves disk lookups.',
    realpath_cache_ttl: 'Seconds those lookups are remembered.',
    pm: 'Starts and stops workers as visitors come and go.',
    'pm.max_children': `Most pages served at the same moment: about ${forPhp} MB for PHP at roughly ${WORKER_MB} MB per worker.`,
    'pm.start_servers': `Workers started with PHP, from ${cpu} core${cpu === 1 ? '' : 's'}.`,
    'pm.min_spare_servers': 'Idle workers kept ready for the next visitor.',
    'pm.max_spare_servers': 'Idle workers above this are stopped to free memory.',
    'pm.max_requests': 'A worker restarts after this many pages, which stops slow memory leaks.'
  }
  return { ini, pool, reasons }
}

const AT_LEAST = new Set(['memory_limit', 'upload_max_filesize', 'post_max_size', 'max_execution_time', 'max_input_time', 'max_input_vars'])

/** "256M", "2G", "60" as one comparable number. -1 (no limit) counts as the largest. */
function amount(v: string): number {
  const m = /^(-?\d+)\s*([KMG]?)/i.exec(v.trim())
  if (!m) return 0
  const n = Number(m[1])
  if (n < 0) return Number.MAX_SAFE_INTEGER
  const unit = m[2].toUpperCase()
  return n * (unit === 'G' ? 1024 ** 3 : unit === 'M' ? 1024 ** 2 : unit === 'K' ? 1024 : 1)
}

async function readSize(client: Client): Promise<{ ramMb: number; cores: number }> {
  const res = await exec(client, "awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo", { timeoutMs: 15000 })
  const [ram, cpu] = res.stdout.trim().split('\n').map((x) => Number(x.trim()))
  return { ramMb: ram > 0 ? ram : 1024, cores: cpu > 0 ? cpu : 1 }
}

/** What "Optimize" would change, next to what is set now. Nothing is written. */
export async function optimizePlan(client: Client, sudo: Sudo, version: string, input: PhpOptimizeInput): Promise<PhpOptimizePlan> {
  const v = checkVersion(version)
  const detected = await readSize(client)
  const ramMb = input.ramMb && input.ramMb > 0 ? input.ramMb : detected.ramMb
  const cores = input.cores && input.cores > 0 ? input.cores : detected.cores
  const files = await runPrivileged(client, `cat ${iniPath(v)}; echo "@@SDPOOL"; cat ${poolPath(v)} 2>/dev/null || true`, sudo, undefined, 30000)
  const [iniRaw, poolRaw = ''] = files.stdout.split('@@SDPOOL\n')
  const r = recommend(ramMb, cores, input.mix)
  const changes: PhpOptimizePlan['changes'] = []
  for (const [key, value] of Object.entries(r.ini)) {
    const current = iniGet(iniRaw, key)
    // A limit someone already raised is left alone: optimizing never makes a site stop accepting what it accepts today.
    const keep = AT_LEAST.has(key) && amount(current) > amount(value)
    changes.push({ file: 'php.ini', key, current, value: keep ? current : value, why: keep ? `${r.reasons[key]} Already higher than the suggestion (${value}), so it stays.` : r.reasons[key] })
  }
  if (poolRaw.trim()) for (const [key, value] of Object.entries(r.pool)) changes.push({ file: 'pool', key, current: iniGet(poolRaw, key), value, why: r.reasons[key] })
  return { detected, ramMb, cores, mix: input.mix, workerMb: WORKER_MB, hasPool: !!poolRaw.trim(), changes }
}

/** Write the recommended values. Both files are checked by PHP-FPM first and put back if it refuses them. */
export async function optimizeApply(client: Client, sudo: Sudo, version: string, input: PhpOptimizeInput): Promise<void> {
  const v = checkVersion(version)
  const plan = await optimizePlan(client, sudo, v, input)
  const files = await runPrivileged(client, `cat ${iniPath(v)}; echo "@@SDPOOL"; cat ${poolPath(v)} 2>/dev/null || true`, sudo, undefined, 30000)
  const parts = files.stdout.split('@@SDPOOL\n')
  let ini = parts[0]
  let pool = parts[1] ?? ''
  for (const c of plan.changes) {
    if (c.current === c.value) continue
    if (c.file === 'php.ini') ini = iniSet(ini, c.key, c.value)
    else pool = iniSet(pool, c.key, c.value)
  }
  if (ini === parts[0] && pool === (parts[1] ?? '')) return
  const upIni = await writeRemoteTemp(client, ini)
  const upPool = await writeRemoteTemp(client, pool)
  const script = `${PATH_EXPORT}
${RESTART_FN}
INI=${iniPath(v)}
POOL=${poolPath(v)}
TI=${shq(upIni)}
TP=${shq(upPool)}
cp -p "$INI" "$INI.superdevops.bak"
cat "$TI" > "$INI"
HAVE_POOL=0
if [ -f "$POOL" ] && [ -s "$TP" ]; then HAVE_POOL=1; cp -p "$POOL" "$POOL.superdevops.bak"; cat "$TP" > "$POOL"; fi
unlink "$TI"; unlink "$TP"
if ! /usr/sbin/php-fpm${v} -t >/dev/null 2>&1 || ! restart_fpm ${v}; then
  cat "$INI.superdevops.bak" > "$INI"
  [ "$HAVE_POOL" = 1 ] && cat "$POOL.superdevops.bak" > "$POOL"
  restart_fpm ${v} || true
  echo "PHP-FPM did not accept the new settings. The previous files were put back."
  exit 45
fi`
  try {
    await runPrivileged(client, script, sudo, undefined, 90000)
  } finally {
    await exec(client, `for f in ${shq(upIni)} ${shq(upPool)}; do [ -e "$f" ] && unlink "$f"; done; true`, { timeoutMs: 10000 }).catch(() => undefined)
  }
}
