// The nginx program itself, as aaPanel's Nginx window has it: service, performance settings in nginx.conf,
// the main configuration file, load status and the error log. Sites' own files are made by deploy.ts.
import type { Client } from 'ssh2'
import { randomBytes } from 'node:crypto'
import type { NginxOverview, NginxLoad, NginxTuning } from '@shared/types'
import { PATH_EXPORT, runPrivileged, type Sudo } from './deploy'

const MAIN = '/etc/nginx/nginx.conf'
const STATUS_CONF = '/etc/nginx/conf.d/00-superdevops-status.conf'
const STATUS_PORT = 39181
const PRELUDE = `export LC_ALL=C\n${PATH_EXPORT}\ncommand -v nginx >/dev/null 2>&1 || { echo "nginx is not installed on this server."; exit 2; }\n`

/** Where each managed setting lives in nginx.conf. */
const CTX: Record<string, 'main' | 'events' | 'http'> = {
  worker_processes: 'main',
  worker_rlimit_nofile: 'main',
  worker_connections: 'events',
  keepalive_timeout: 'http',
  gzip: 'http',
  gzip_min_length: 'http',
  gzip_comp_level: 'http',
  gzip_types: 'http',
  client_max_body_size: 'http',
  server_names_hash_bucket_size: 'http',
  client_header_buffer_size: 'http',
  client_body_buffer_size: 'http'
}

// Reads nginx.conf one line at a time (nginx.conf is written one directive a line) and follows the blocks,
// so "gzip" inside a server block is not mistaken for the http-wide one.
const AWK_CTX = `
function ctx() { return depth == 0 ? "main" : (depth == 1 ? stack[1] : "inner") }
function scan(raw,   line, name, val, i, c) {
  line = raw; sub(/#.*/, "", line)
  name = ""; val = ""
  if (match(line, /^[ \\t]*[a-z_]+[ \\t]+[^;{]*;/)) {
    name = line; sub(/^[ \\t]*/, "", name); sub(/[ \\t].*/, "", name)
    val = line; sub(/^[ \\t]*[a-z_]+[ \\t]+/, "", val); sub(/[ \\t]*;.*/, "", val)
  }
  cur_name = name; cur_val = val; cur_ctx = ctx()
  for (i = 1; i <= length(line); i++) {
    c = substr(line, i, 1)
    if (c == "{") { depth++; b = line; sub(/^[ \\t]*/, "", b); sub(/[ \\t{].*/, "", b); stack[depth] = (depth == 1 ? b : "inner") }
    else if (c == "}") { closing = 1; depth-- }
  }
}`

function readScript(): string {
  return `${PRELUDE}
F=${MAIN}
[ -f "$F" ] || { echo "@@noconf"; exit 0; }
awk '${AWK_CTX}
{ closing = 0; scan($0); if (cur_name != "" && (cur_ctx == "main" || cur_ctx == "events" || cur_ctx == "http")) print "@@d|" cur_ctx "|" cur_name "|" cur_val }' "$F"`
}

/** Values as nginx writes them ("16k", "64m", "1024") in KB or MB for the form. */
function toUnit(v: string | undefined, unit: 'k' | 'm'): number | undefined {
  if (!v) return undefined
  const m = /^(\d+(?:\.\d+)?)([kKmMgG]?)$/.exec(v.trim())
  if (!m) return undefined
  const n = Number(m[1])
  const bytes = n * ({ '': 1, k: 1024, m: 1048576, g: 1073741824 } as Record<string, number>)[m[2].toLowerCase()]
  return Math.round((bytes / (unit === 'k' ? 1024 : 1048576)) * 100) / 100
}

function seconds(v: string | undefined): number | undefined {
  if (!v) return undefined
  const m = /^(\d+)(s|m)?/.exec(v.trim())
  return m ? Number(m[1]) * (m[2] === 'm' ? 60 : 1) : undefined
}

export async function tuning(client: Client, sudo: Sudo): Promise<NginxTuning> {
  const res = await runPrivileged(client, readScript(), sudo, undefined, 30000)
  if (res.stdout.includes('@@noconf')) throw new Error(`${MAIN} is not on this server.`)
  const d: Record<string, string> = {}
  for (const line of res.stdout.split('\n')) {
    const [tag, c, name, ...rest] = line.split('|')
    if (tag !== '@@d' || CTX[name] !== c || name in d) continue
    d[name] = rest.join('|').trim()
  }
  // Missing ones show nginx's own defaults.
  return {
    workerProcesses: d.worker_processes ?? '1',
    workerConnections: Number(d.worker_connections ?? 512),
    keepaliveTimeout: seconds(d.keepalive_timeout) ?? 75,
    gzip: (d.gzip ?? 'off') === 'on',
    gzipMinLengthKb: Math.round(toUnit(d.gzip_min_length ?? '20', 'k') ?? 0),
    gzipCompLevel: Number(d.gzip_comp_level ?? 1),
    clientMaxBodyMb: Math.round(toUnit(d.client_max_body_size ?? '1m', 'm') ?? 1),
    serverNamesHashBucketSize: Number(d.server_names_hash_bucket_size ?? 64),
    clientHeaderBufferKb: Math.round(toUnit(d.client_header_buffer_size ?? '1k', 'k') ?? 1),
    clientBodyBufferKb: Math.round(toUnit(d.client_body_buffer_size ?? '16k', 'k') ?? 16)
  }
}

function int(v: unknown, min: number, max: number, label: string): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}: a whole number from ${min} to ${max}.`)
  return n
}

const GZIP_TYPES = 'text/plain text/css text/xml text/javascript application/javascript application/json application/xml application/rss+xml image/svg+xml'

/** Write the performance settings into nginx.conf, check it, and reload. A refused file is put back. */
export async function saveTuning(client: Client, sudo: Sudo, t: NginxTuning, log: (s: string) => void): Promise<void> {
  const wp = String(t.workerProcesses ?? '').trim()
  if (wp !== 'auto' && !/^\d+$/.test(wp)) throw new Error('worker_processes: "auto" or a number.')
  if (wp !== 'auto') int(wp, 1, 256, 'worker_processes')
  const conns = int(t.workerConnections, 64, 1000000, 'worker_connections')
  const bucket = int(t.serverNamesHashBucketSize, 32, 4096, 'server_names_hash_bucket_size')
  if ((bucket & (bucket - 1)) !== 0) throw new Error('server_names_hash_bucket_size: a power of two, such as 64, 128 or 512.')
  const want: Record<string, string> = {
    worker_processes: wp,
    worker_rlimit_nofile: String(Math.max(conns, 1024)),
    worker_connections: String(conns),
    keepalive_timeout: String(int(t.keepaliveTimeout, 0, 3600, 'keepalive_timeout')),
    gzip: t.gzip ? 'on' : 'off',
    gzip_min_length: `${int(t.gzipMinLengthKb, 0, 10240, 'gzip_min_length')}k`,
    gzip_comp_level: String(int(t.gzipCompLevel, 1, 9, 'gzip_comp_level')),
    client_max_body_size: `${int(t.clientMaxBodyMb, 0, 102400, 'client_max_body_size')}m`,
    server_names_hash_bucket_size: String(bucket),
    client_header_buffer_size: `${int(t.clientHeaderBufferKb, 1, 1024, 'client_header_buffer_size')}k`,
    client_body_buffer_size: `${int(t.clientBodyBufferKb, 1, 102400, 'client_body_buffer_size')}k`
  }
  if (t.gzip) want.gzip_types = GZIP_TYPES
  const spec = Object.entries(want)
    .map(([k, v]) => `${CTX[k]}|${k}|${v}`)
    .join('\n')
  const script = `${PRELUDE}
F=${MAIN}
[ -f "$F" ] || { echo "${MAIN} is not on this server."; exit 2; }
SPEC=$(mktemp); NEW=$(mktemp)
cat > "$SPEC" <<'SPECEND'
${spec}
SPECEND
# Pass 1 notes which settings exist; pass 2 sets the first of each, comments out repeats, and adds the missing ones.
awk -v specfile="$SPEC" '${AWK_CTX}
BEGIN { while ((getline l < specfile) > 0) { split(l, p, "|"); want[p[1] "|" p[2]] = p[3]; order[++n] = p[1] "|" p[2] } }
FNR == 1 { pass++; depth = 0 }
pass == 1 { closing = 0; scan($0); if (cur_name != "" && ((cur_ctx "|" cur_name) in want)) seen[cur_ctx "|" cur_name] = 1; next }
FNR == 1 { for (i = 1; i <= n; i++) { split(order[i], p, "|"); if (p[1] == "main" && !(order[i] in seen)) print p[2] " " want[order[i]] ";" } }
{
  closing = 0; before = depth; inblock = (depth == 1 ? stack[1] : "")
  scan($0)
  key = cur_ctx "|" cur_name
  if (cur_name != "" && (key in want)) {
    if (done[key]++) { print "# " $0 "  # replaced by Apsara Panel"; next }
    ind = $0; sub(/[^ \\t].*/, "", ind)
    print ind cur_name " " want[key] ";"
    next
  }
  if (closing && before == 1 && depth == 0 && (inblock == "events" || inblock == "http")) {
    for (i = 1; i <= n; i++) { split(order[i], p, "|"); if (p[1] == inblock && !(order[i] in seen)) print "    " p[2] " " want[order[i]] ";" }
  }
  print
}' "$F" "$F" > "$NEW"
grep -q '^[[:space:]]*events[[:space:]]*{' "$F" || { echo "nginx.conf has no events block; set worker_connections in the Config file tab."; }
cp "$F" "$F.superdevops-bak"
cat "$NEW" > "$F"
rm -f "$SPEC" "$NEW"
if OUT=$(nginx -t 2>&1); then
  echo "Settings written. nginx accepts them."
  if [ -d /run/systemd/system ]; then systemctl reload nginx; else nginx -s reload; fi
  echo "nginx reloaded. Sites keep running."
else
  cat "$F.superdevops-bak" > "$F"
  echo "$OUT"
  echo "nginx refused the new settings, so the previous nginx.conf was put back. Nothing changed."
  exit 5
fi`
  await runPrivileged(client, script, sudo, log, 60000)
}

export async function overview(client: Client, sudo: Sudo): Promise<NginxOverview> {
  const res = await runPrivileged(
    client,
    `export LC_ALL=C\n${PATH_EXPORT}
if ! command -v nginx >/dev/null 2>&1; then echo "@@installed=0"; exit 0; fi
echo "@@installed=1"
echo "@@version=$(nginx -v 2>&1 | sed 's/.*nginx\\///')"
if pgrep -x nginx >/dev/null 2>&1; then echo "@@running=1"; else echo "@@running=0"; fi
echo "@@workers=$(ps -C nginx -o args= 2>/dev/null | grep -c 'worker process')"
echo "@@memkb=$(ps -C nginx -o rss= 2>/dev/null | awk '{s+=$1} END {print s+0}')"
echo "@@since=$(ps -C nginx -o etimes=,args= 2>/dev/null | awk '/master/ {print $1; exit}')"
if T=$(nginx -t 2>&1); then echo "@@test=ok"; else echo "@@test=bad"; fi
echo "@@testout"; echo "$T" | tail -n 5
echo "@@stub=$(nginx -V 2>&1 | grep -c http_stub_status_module)"
echo "@@end"`,
    sudo,
    undefined,
    30000
  )
  const kv: Record<string, string> = {}
  let test: string[] = []
  let inTest = false
  for (const line of res.stdout.split('\n')) {
    if (line === '@@testout') { inTest = true; continue } // prettier-ignore
    if (line === '@@end') { inTest = false; continue } // prettier-ignore
    const m = /^@@(\w+)=(.*)$/.exec(line)
    if (m) {
      kv[m[1]] = m[2].trim()
      if (m[1] === 'stub') inTest = false
    } else if (inTest && line.trim()) test.push(line)
  }
  test = test.filter((l) => !l.startsWith('@@'))
  return {
    installed: kv.installed === '1',
    version: kv.version ?? '',
    running: kv.running === '1',
    workers: Number(kv.workers) || 0,
    memoryKb: Number(kv.memkb) || 0,
    upSeconds: Number(kv.since) || 0,
    configOk: kv.test === 'ok',
    testOutput: test.join('\n'),
    hasStubStatus: kv.stub !== '0'
  }
}

/** Reload, start or stop nginx, or only check its configuration. */
export async function control(client: Client, sudo: Sudo, action: 'reload' | 'start' | 'stop' | 'test', log: (s: string) => void): Promise<void> {
  const body: Record<string, string> = {
    test: 'nginx -t 2>&1 && echo "The configuration is fine." || { echo "The configuration has an error (above)."; exit 5; }',
    reload: 'nginx -t 2>&1 || { echo "The configuration has an error, so nginx was NOT reloaded. Sites keep running on the old settings."; exit 5; }\nif [ -d /run/systemd/system ]; then systemctl reload nginx; else nginx -s reload; fi && echo "nginx reloaded."',
    start: 'nginx -t 2>&1 || { echo "The configuration has an error, so nginx cannot start. Fix it first."; exit 5; }\nif [ -d /run/systemd/system ]; then systemctl start nginx; else nginx; fi\nsleep 1; pgrep -x nginx >/dev/null && echo "nginx is running." || { echo "nginx did not start."; exit 6; }',
    stop: 'if [ -d /run/systemd/system ]; then systemctl stop nginx; else nginx -s quit; fi\nsleep 1; pgrep -x nginx >/dev/null && { echo "nginx is still running."; exit 6; } || echo "nginx stopped. Every site on this server is offline until it is started again."'
  }
  if (!(action in body)) throw new Error('Unknown action.')
  await runPrivileged(client, `${PRELUDE}${body[action]}`, sudo, log, 60000)
}

/** nginx.conf as it is on the server. */
export async function readConfig(client: Client, sudo: Sudo): Promise<string> {
  const res = await runPrivileged(client, `${PRELUDE}[ -f ${MAIN} ] || { echo "@@noconf"; exit 0; }\necho "@@begin"; cat ${MAIN}`, sudo, undefined, 30000)
  if (res.stdout.includes('@@noconf')) throw new Error(`${MAIN} is not on this server.`)
  return res.stdout.slice(res.stdout.indexOf('@@begin\n') + 8)
}

/** Replace nginx.conf, check it, reload; a file nginx refuses is put back and its message returned as the error. */
export async function saveConfig(client: Client, sudo: Sudo, text: string, log: (s: string) => void): Promise<void> {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The file is empty.')
  if (text.length > 512 * 1024) throw new Error('nginx.conf is larger than 512 KB.')
  const mark = `NGINXCONF_${randomBytes(8).toString('hex')}`
  const body = text.endsWith('\n') ? text : `${text}\n`
  const script = `${PRELUDE}
F=${MAIN}
NEW=$(mktemp)
cat > "$NEW" <<'${mark}'
${body}${mark}
cp "$F" "$F.superdevops-bak"
cat "$NEW" > "$F"; rm -f "$NEW"
if OUT=$(nginx -t 2>&1); then
  echo "$OUT"
  if [ -d /run/systemd/system ]; then systemctl reload nginx; else nginx -s reload; fi
  echo "Saved. nginx reloaded."
else
  cat "$F.superdevops-bak" > "$F"
  echo "$OUT"
  echo "nginx refused the file, so the previous nginx.conf was put back. Nothing changed."
  exit 5
fi`
  await runPrivileged(client, script, sudo, log, 60000)
}

/** Connections and requests, from nginx's status page (made on 127.0.0.1 the first time it is asked for). */
export async function load(client: Client, sudo: Sudo): Promise<NginxLoad> {
  const script = `${PRELUDE}
nginx -V 2>&1 | grep -q http_stub_status_module || { echo "@@nostub"; exit 0; }
if [ ! -f ${STATUS_CONF} ]; then
  mkdir -p /etc/nginx/conf.d
  grep -rqs 'conf.d/\\*.conf' /etc/nginx/nginx.conf || { echo "@@noinclude"; exit 0; }
  printf '%s\\n' '# Made by Apsara Panel: nginx load status, only on this server itself.' 'server {' '    listen 127.0.0.1:${STATUS_PORT};' '    server_name _;' '    access_log off;' '    location = /status { stub_status; }' '}' > ${STATUS_CONF}
  if nginx -t >/dev/null 2>&1; then
    if [ -d /run/systemd/system ]; then systemctl reload nginx; else nginx -s reload; fi; sleep 1
  else
    rm -f ${STATUS_CONF}; echo "@@refused"; exit 0
  fi
fi
echo "@@status"; curl -s -m 5 http://127.0.0.1:${STATUS_PORT}/status
echo "@@workers=$(ps -C nginx -o args= 2>/dev/null | grep -c 'worker process')"
echo "@@memkb=$(ps -C nginx -o rss= 2>/dev/null | awk '{s+=$1} END {print s+0}')"`
  const res = await runPrivileged(client, script, sudo, undefined, 30000)
  const out = res.stdout
  if (out.includes('@@nostub')) throw new Error('This nginx was built without its status module, so its load cannot be read.')
  if (out.includes('@@noinclude')) throw new Error('nginx.conf does not read /etc/nginx/conf.d, so the status page could not be added.')
  if (out.includes('@@refused')) throw new Error('nginx refused the status page (perhaps port 39181 is taken). Nothing was changed.')
  const num = (re: RegExp): number => Number(re.exec(out)?.[1] ?? 0)
  const m = /\s(\d+)\s+(\d+)\s+(\d+)\s*\n/.exec(out)
  return {
    active: num(/Active connections:\s*(\d+)/),
    accepts: Number(m?.[1] ?? 0),
    handled: Number(m?.[2] ?? 0),
    requests: Number(m?.[3] ?? 0),
    reading: num(/Reading:\s*(\d+)/),
    writing: num(/Writing:\s*(\d+)/),
    waiting: num(/Waiting:\s*(\d+)/),
    workers: num(/@@workers=(\d+)/),
    memoryKb: num(/@@memkb=(\d+)/),
    at: Date.now()
  }
}

/** The end of nginx's own error log (the one nginx.conf names, else the usual place). */
export async function errorLog(client: Client, sudo: Sudo, lines: number): Promise<{ path: string; text: string }> {
  const n = Math.max(20, Math.min(5000, Math.floor(Number(lines) || 200)))
  const res = await runPrivileged(
    client,
    `${PRELUDE}
L=$(awk '!/^[ \\t]*#/ && /^[ \\t]*error_log[ \\t]/ { sub(/^[ \\t]*error_log[ \\t]+/, ""); sub(/[ \\t;].*/, ""); print; exit }' ${MAIN} 2>/dev/null)
case "$L" in /*) ;; *) L=/var/log/nginx/error.log;; esac
echo "@@path=$L"
[ -f "$L" ] && tail -n ${n} "$L" || echo "(the file is not there yet)"`,
    sudo,
    undefined,
    30000
  )
  const path = /@@path=(.*)/.exec(res.stdout)?.[1]?.trim() ?? '/var/log/nginx/error.log'
  return { path, text: res.stdout.replace(/^[\s\S]*?@@path=.*\n/, '') }
}

/** Empty nginx's error log (the file stays, so nginx keeps writing to it). */
export async function clearErrorLog(client: Client, sudo: Sudo): Promise<void> {
  await runPrivileged(
    client,
    `${PRELUDE}
L=$(awk '!/^[ \\t]*#/ && /^[ \\t]*error_log[ \\t]/ { sub(/^[ \\t]*error_log[ \\t]+/, ""); sub(/[ \\t;].*/, ""); print; exit }' ${MAIN} 2>/dev/null)
case "$L" in /*) ;; *) L=/var/log/nginx/error.log;; esac
case "$L" in /var/log/*) [ -f "$L" ] && : > "$L"; echo "Emptied $L";; *) echo "The error log is outside /var/log; empty it by hand."; exit 4;; esac`,
    sudo,
    undefined,
    30000
  )
}

