// Copies of backups in S3-compatible storage (Amazon S3, Cloudflare R2,
// Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO ...).
// The server uploads by itself on a schedule. Requests are signed in the job
// with bash, sha256sum and curl only, so nothing has to be installed, and the
// secret key never appears on a command line.
import type { Client } from 'ssh2'
import type { S3Options, S3RemoteFile, S3Status } from '@shared/types'
import { PATH_EXPORT, runPrivileged, type Sudo } from './deploy'
import { exec, shq, writeRemoteTemp } from './ssh'
import { REMOTE_DIR } from './gdrive'

const DIR = '/etc/superdevops/s3'
const STATE = '/var/lib/superdevops/s3'
const JOB = '/usr/local/bin/superdevops-s3.sh'
const CRON = '/etc/cron.d/superdevops-s3'
const LOG = '/var/log/superdevops/s3.log'
const DB_DIR = '/var/backups/superdevops/mysql'
const PG_DIR = '/var/backups/superdevops/postgres'
const ARCHIVES = '/var/backups/superdevops/folders'
const FROM_S3 = '/var/backups/superdevops/from-s3'
/** One PUT takes at most 5 GB at every provider. */
const MAX_BYTES = 5 * 1024 * 1024 * 1024 - 1024

/**
 * Shell: sign and send one request. Sets CODE (HTTP status) and leaves the answer in $RESP.
 *   s3 METHOD OBJECT [FILE_TO_SEND] [QUERY] [FILE_TO_SAVE]
 * OBJECT and QUERY only ever hold A-Z a-z 0-9 . _ - / = & %, so they need no further encoding.
 */
const SH_S3 = `EMPTY=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
tohex() { od -An -tx1 | tr -d ' \\n'; }
unhex() { printf "$(echo "$1" | sed 's/../\\\\x&/g')"; }
# HMAC-SHA256 with shell built-ins feeding sha256sum, so the key is never an argument of a program.
hmac() {
  local k="$1" i b h p="" q="" inner
  if [ \${#k} -gt 128 ]; then k=$(unhex "$k" | sha256sum | cut -d' ' -f1); fi
  while [ \${#k} -lt 128 ]; do k="\${k}00"; done
  for ((i = 0; i < 128; i += 2)); do
    b=$((16#\${k:i:2}))
    printf -v h '\\\\x%02x\\\\x%02x' $((b ^ 0x36)) $((b ^ 0x5c)); p+=\${h:0:4}; q+=\${h:4:4}
  done
  inner=$({ printf "$p"; printf '%s' "$2"; } | sha256sum | cut -d' ' -f1)
  { printf "$q"; unhex "$inner"; } | sha256sum | cut -d' ' -f1
}
NL='
'
RESP=$(mktemp)
s3() {
  local M="$1" OBJ="$2" SEND="$3" QUERY="$4" SAVE="$5" NOW DAY HASH URI CREQ STS K SIG
  NOW=$(date -u +%Y%m%dT%H%M%SZ); DAY=\${NOW%%T*}
  if [ -n "$SEND" ]; then HASH=$(sha256sum "$SEND" | cut -d' ' -f1); else HASH=$EMPTY; fi
  URI="$BASE_PATH/$BUCKET\${OBJ:+/$OBJ}"
  CREQ="$M$NL$URI$NL$QUERY\${NL}host:$HOST_HEADER\${NL}x-amz-content-sha256:$HASH\${NL}x-amz-date:$NOW$NL\${NL}host;x-amz-content-sha256;x-amz-date$NL$HASH"
  STS="AWS4-HMAC-SHA256$NL$NOW$NL$DAY/$REGION/s3/aws4_request$NL$(printf '%s' "$CREQ" | sha256sum | cut -d' ' -f1)"
  K=$(hmac "$(printf '%s' "AWS4$(cat "$D/secret")" | tohex)" "$DAY")
  K=$(hmac "$K" "$REGION"); K=$(hmac "$K" s3); K=$(hmac "$K" aws4_request)
  SIG=$(hmac "$K" "$STS")
  set -- -sS -X "$M" -o "\${SAVE:-$RESP}" -w '%{http_code}' -H "x-amz-date: $NOW" -H "x-amz-content-sha256: $HASH" \\
    -H "Authorization: AWS4-HMAC-SHA256 Credential=$ACCESS_KEY/$DAY/$REGION/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=$SIG"
  if [ -n "$SEND" ]; then set -- "$@" --max-time 14400 -T "$SEND" -H 'Content-Type: application/gzip' -H 'Expect:'
  elif [ -n "$SAVE" ]; then set -- "$@" --max-time 14400
  else set -- "$@" --max-time 60; fi
  : > "$RESP"
  CODE=$(curl "$@" "$SCHEME://$HOST_HEADER$URI\${QUERY:+?$QUERY}" 2>>"$LOG")
  [ -n "$CODE" ] || CODE=000
}
# The storage's own words for a refusal, with what to do about the usual ones.
why() {
  local c m
  c=$(sed -n 's/.*<Code>\\([^<]*\\)<\\/Code>.*/\\1/p' "$RESP" | head -1)
  m=$(sed -n 's/.*<Message>\\([^<]*\\)<\\/Message>.*/\\1/p' "$RESP" | head -1)
  case "$CODE:$c" in
    000:*) echo "the storage did not answer (check the endpoint address and the server's internet connection)" ;;
    *:InvalidAccessKeyId) echo "the access key is not known to the storage" ;;
    *:SignatureDoesNotMatch) echo "the secret key is wrong, or the region does not match the bucket" ;;
    *:NoSuchBucket) echo "there is no bucket named $BUCKET at that endpoint" ;;
    *:AccessDenied|403:*) echo "the key is not allowed to do this in bucket $BUCKET\${m:+ ($m)}" ;;
    *:RequestTimeTooSkewed) echo "this server's clock is wrong by more than 15 minutes; set the time first" ;;
    *:AuthorizationHeaderMalformed|*:PermanentRedirect|301:*) echo "the region or endpoint is not the bucket's own\${m:+ ($m)}" ;;
    *) echo "HTTP $CODE\${c:+ $c}\${m:+: $m}" ;;
  esac
}
`

const HEAD = (need: string): string => `export LC_ALL=C
export PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin:/usr/local/bin"
D=${DIR}
S=${STATE}
LOG=${LOG}
${need}
. "$D/conf"
mkdir -p "$S" /var/log/superdevops
${SH_S3}`

const JOB_SCRIPT = `#!/bin/bash
# Managed by SuperDevops. Copies backups to S3-compatible storage. Settings: ${DIR}
${HEAD('[ -f "$D/conf" ] && [ -f "$D/secret" ] || exit 0')}
mkdir -p ${ARCHIVES}
touch "$S/uploaded.list"
exec 9>"$S/lock"
flock -n 9 || { echo "Another upload is still running."; exit 0; }
say() { echo "[$(date '+%F %T')] $*" >> "$LOG"; echo "$*"; }
finish() { echo "$(date +%s)|$1|$2" > "$S/last"; [ "$1" = ok ] && date +%s > "$S/last_ok"; unlink "$RESP" 2>/dev/null; return 0; }
SENT=0; FAILED=0; LASTWHY=""; OWN_MY=""; OWN_PG=""
DUE=1
[ "$1" = now ] || [ "$(date +%-H)" -ge "\${DAILY_HOUR:-0}" ] || DUE=0
TODAY=$(date +%Y%m%d)
STAMP=$(date +%Y%m%d-%H%M%S)

# 1. One archive a day of each chosen folder (shared with the Google Drive job: whichever runs first makes it).
if [ -s "$D/paths" ] && [ "$DUE" = 1 ]; then
  while IFS= read -r P; do
    [ -n "$P" ] || continue
    if [ ! -d "$P" ]; then say "Skipped $P: it is not a folder on this server"; FAILED=$((FAILED+1)); continue; fi
    NAME=$(echo "$P" | sed 's#^/##; s#[^A-Za-z0-9._-]#_#g')
    OUT="${ARCHIVES}/$NAME-$TODAY.tar.gz"
    [ -f "$OUT" ] && continue
    if tar -czf "$OUT.part" -C "$P" . 2>>"$LOG"; then mv "$OUT.part" "$OUT"; say "Packed $P ($(du -h "$OUT" | cut -f1))"; else say "Could not pack $P"; FAILED=$((FAILED+1)); fi
  done < "$D/paths"
  find ${ARCHIVES} -maxdepth 1 -name '*.tar.gz' -mtime +2 -delete
  find ${ARCHIVES} -maxdepth 1 -name '*.part' -mmin +180 -delete
fi

# 2. A fresh backup of every MySQL / MariaDB and PostgreSQL database, once a day.
SQL=$(command -v mariadb || command -v mysql)
DUMP=$(command -v mariadb-dump || command -v mysqldump)
if [ "$INCLUDE_DB" = 1 ] && [ "$DUE" = 1 ] && [ -n "$SQL" ] && [ -n "$DUMP" ]; then
  NAMES=$("$SQL" -N -B -e "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema','performance_schema','mysql','sys')" 2>>"$LOG")
  if [ $? -ne 0 ]; then
    say "Could not list the MySQL databases (the database server did not answer root on this server)"; FAILED=$((FAILED+1)); LASTWHY="The MySQL databases could not be read"
  else
    ( umask 077; mkdir -p ${DB_DIR} )
    for db in $NAMES; do
      ls ${DB_DIR}/"$db"-"$TODAY"-*.sql.gz >/dev/null 2>&1 && continue
      FILE=${DB_DIR}/$db-$STAMP.sql.gz
      if ( set -o pipefail; umask 077; "$DUMP" --single-transaction --routines --triggers "$db" 2>>"$LOG" | gzip > "$FILE.part" ); then
        mv "$FILE.part" "$FILE"; echo "$FILE" >> "$S/dumps.list"; OWN_MY="$OWN_MY $FILE"; say "Backed up database $db ($(du -h "$FILE" | cut -f1))"
      else
        [ -e "$FILE.part" ] && unlink "$FILE.part"
        say "Could not back up database $db"; FAILED=$((FAILED+1)); LASTWHY="Database $db could not be backed up"
      fi
    done
  fi
fi
if [ "$INCLUDE_DB" = 1 ] && [ "$DUE" = 1 ] && command -v pg_dump >/dev/null 2>&1 && id postgres >/dev/null 2>&1; then
  pg() { if command -v runuser >/dev/null 2>&1; then runuser -u postgres -- "$@"; else su -s /bin/sh postgres -c "$(printf '%q ' "$@")"; fi; }
  NAMES=$(cd / && pg psql -At -c "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'" 2>>"$LOG")
  if [ $? -eq 0 ]; then
    ( umask 077; mkdir -p ${PG_DIR} )
    for db in $NAMES; do
      case "$db" in *[!A-Za-z0-9_]*) continue ;; esac
      ls ${PG_DIR}/"$db"-"$TODAY"-*.sql.gz >/dev/null 2>&1 && continue
      FILE=${PG_DIR}/$db-$STAMP.sql.gz
      if ( set -o pipefail; umask 077; cd / && pg pg_dump --clean --if-exists "$db" 2>>"$LOG" | gzip > "$FILE.part" ); then
        mv "$FILE.part" "$FILE"; echo "$FILE" >> "$S/dumps.list"; OWN_PG="$OWN_PG $FILE"; say "Backed up PostgreSQL database $db ($(du -h "$FILE" | cut -f1))"
      else
        [ -e "$FILE.part" ] && unlink "$FILE.part"
        say "Could not back up PostgreSQL database $db"; FAILED=$((FAILED+1)); LASTWHY="PostgreSQL database $db could not be backed up"
      fi
    done
  fi
fi
# The backups made here stay on the server for 7 days; backups made by anyone else are never removed.
if [ -s "$S/dumps.list" ]; then
  K=$(mktemp)
  while IFS= read -r F; do
    [ -f "$F" ] || continue
    if [ -n "$(find "$F" -mtime +7 2>/dev/null)" ]; then unlink "$F"; else echo "$F" >> "$K"; fi
  done < "$S/dumps.list"
  cat "$K" > "$S/dumps.list"; unlink "$K"
fi

# 3. Upload what is not in the bucket yet. The object is <prefix>/<kind>/<file name>.
upload() {
  KIND="$1"; F="$2"; N=$(basename "$F")
  case "$N" in *[!A-Za-z0-9._-]*) return 0 ;; esac
  grep -q "^$KIND/$N|" "$S/uploaded.list" && return 0
  SIZE=$(stat -c %s "$F" 2>/dev/null || echo 0)
  if [ "$SIZE" -gt ${MAX_BYTES} ]; then
    grep -q "^$KIND/$N$" "$S/toobig.list" 2>/dev/null || { echo "$KIND/$N" >> "$S/toobig.list"; say "Skipped $N: it is larger than 5 GB, the most one upload can carry"; FAILED=$((FAILED+1)); LASTWHY="$N is larger than 5 GB"; }
    return 1
  fi
  s3 PUT "$PREFIX$KIND/$N" "$F"
  if [ "$CODE" != 200 ]; then WHY=$(why); say "The storage did not accept $N: $WHY"; FAILED=$((FAILED+1)); LASTWHY="$WHY"; return 1; fi
  echo "$KIND/$N|$(date +%s)" >> "$S/uploaded.list"
  SENT=$((SENT+1))
  say "Uploaded $N ($(du -h "$F" | cut -f1))"
}
if [ "$INCLUDE_DB" = 1 ]; then
  # Backups made just now are complete; anything else must have rested a minute, so a file still being written is left for the next run.
  for F in $OWN_MY; do upload mysql "$F"; done
  for F in $OWN_PG; do upload postgres "$F"; done
  [ -d ${DB_DIR} ] && for F in $(find ${DB_DIR} -maxdepth 1 -name '*.sql.gz' -mmin +1 | sort); do upload mysql "$F"; done
  [ -d ${PG_DIR} ] && for F in $(find ${PG_DIR} -maxdepth 1 -name '*.sql.gz' -mmin +1 | sort); do upload postgres "$F"; done
  [ -d ${REMOTE_DIR} ] && for F in $(find ${REMOTE_DIR} -maxdepth 1 -name 'remote-*.sql.gz' -mmin +1 | sort); do upload remote-db "$F"; done
fi
for F in $(find ${ARCHIVES} -maxdepth 1 -name '*.tar.gz' | sort); do upload folders "$F"; done

# 4. Old copies leave the bucket after the chosen number of days.
if [ "\${KEEP_DAYS:-0}" -gt 0 ]; then
  CUT=$(( $(date +%s) - KEEP_DAYS * 86400 ))
  K=$(mktemp)
  while IFS='|' read -r OBJ AT; do
    [ -n "$OBJ" ] || continue
    if [ -n "$AT" ] && [ "$AT" -lt "$CUT" ]; then
      s3 DELETE "$PREFIX$OBJ"
      if [ "$CODE" = 204 ] || [ "$CODE" = 200 ] || [ "$CODE" = 404 ]; then say "Removed $OBJ from the bucket (older than $KEEP_DAYS days)"; continue; fi
    fi
    echo "$OBJ|$AT" >> "$K"
  done < "$S/uploaded.list"
  cat "$K" > "$S/uploaded.list"
  unlink "$K"
fi

if [ "$FAILED" -gt 0 ]; then
  finish fail "$SENT uploaded, $FAILED failed\${LASTWHY:+. $LASTWHY}"
  [ -x /usr/local/bin/superdevops-alert.sh ] && /usr/local/bin/superdevops-alert.sh say "S3 backup: $FAILED item(s) failed on $(hostname). See $LOG" >/dev/null 2>&1
  echo "Finished with problems: $SENT uploaded, $FAILED failed."
  exit 1
fi
finish ok "$SENT uploaded"
echo "Finished: $SENT uploaded, nothing failed."
`

interface Clean {
  scheme: string
  host: string
  basePath: string
  region: string
  bucket: string
  prefix: string
  accessKey: string
  secretKey: string
  keepDays: number
  includeDb: boolean
  paths: string[]
  everyHours: number
  dailyHour: number
}

function clean(o: S3Options, needSecret: boolean): Clean {
  let text = String(o.endpoint ?? '').trim().replace(/\/+$/, '')
  if (!text) throw new Error('Enter the endpoint, for example https://s3.ap-southeast-1.amazonaws.com')
  if (!/^https?:\/\//i.test(text)) text = 'https://' + text
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('The endpoint is not a valid address. Example: https://s3.ap-southeast-1.amazonaws.com')
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Enter only the address of the storage as the endpoint, without keys or a query.')
  if (!/^[A-Za-z0-9./_-]*$/.test(url.pathname)) throw new Error('The endpoint path has characters that are not allowed.')
  const region = String(o.region ?? '').trim() || 'us-east-1'
  if (!/^[a-z0-9-]{1,40}$/.test(region)) throw new Error('The region looks like ap-southeast-1, us-east-1 or auto.')
  const bucket = String(o.bucket ?? '').trim()
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Enter the bucket name: 3 to 63 lowercase letters, numbers, dots or dashes.')
  const prefix = String(o.prefix ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (prefix && (!/^[A-Za-z0-9._/-]{1,120}$/.test(prefix) || prefix.split('/').some((p) => p === '' || p === '.' || p === '..'))) throw new Error('The folder in the bucket may use letters, numbers, dots, dashes, underscores and /.')
  const accessKey = String(o.accessKey ?? '').trim()
  if (!/^[A-Za-z0-9]{8,128}$/.test(accessKey)) throw new Error('Enter the access key ID (letters and numbers).')
  const secretKey = String(o.secretKey ?? '')
  if (needSecret || secretKey) {
    if (!/^[\x21-\x7e]{8,200}$/.test(secretKey)) throw new Error('Enter the secret access key.')
  }
  const keepDays = Math.floor(Number(o.keepDays))
  if (!(keepDays >= 0 && keepDays <= 3650)) throw new Error('Keep copies for 0 (for ever) to 3650 days.')
  const paths = [...new Set((o.paths ?? []).map((p) => String(p).trim().replace(/\/+$/, '')).filter(Boolean))]
  if (paths.length > 30) throw new Error('Choose at most 30 folders.')
  for (const p of paths) {
    if (!p.startsWith('/') || /[\0\n\r]/.test(p) || p.split('/').includes('..') || p.length > 500) throw new Error(`"${p}" is not a folder path. Use absolute paths such as /www/wwwroot/shop.`)
    if (['/', '/etc', '/usr', '/var', '/home', '/root', '/proc', '/sys', '/dev'].includes(p)) throw new Error(`${p} is a system folder and far too large to send every day. Choose the website's own folder.`)
  }
  if (!o.includeDb && paths.length === 0) throw new Error('Choose at least one thing to copy: database backups, or a folder.')
  const everyHours = o.everyHours === undefined ? 24 : Number(o.everyHours)
  if (![1, 6, 12, 24].includes(everyHours)) throw new Error('Upload every hour, every 6 hours, every 12 hours, or once a day.')
  const dailyHour = o.dailyHour === undefined ? 2 : Number(o.dailyHour)
  if (!(Number.isInteger(dailyHour) && dailyHour >= 0 && dailyHour <= 23)) throw new Error('The backup hour must be between 0 and 23.')
  return { scheme: url.protocol.replace(':', ''), host: url.host, basePath: url.pathname.replace(/\/+$/, ''), region, bucket, prefix: prefix ? prefix + '/' : '', accessKey, secretKey, keepDays, includeDb: o.includeDb === true, paths, everyHours, dailyHour }
}

function cronHours(every: number, hour: number): string {
  if (every === 1) return '*'
  const hours: number[] = []
  for (let h = hour % every; h < 24; h += every) hours.push(h)
  return hours.join(',')
}

/**
 * Store the settings, check that the bucket really accepts a file from this server, and start the schedule.
 * An empty secret key keeps the one already on the server.
 */
export async function setup(client: Client, sudo: Sudo, options: S3Options, log: (s: string) => void): Promise<void> {
  const o = clean(options, false)
  const conf = [
    `SCHEME=${shq(o.scheme)}`,
    `HOST_HEADER=${shq(o.host)}`,
    `BASE_PATH=${shq(o.basePath)}`,
    `REGION=${shq(o.region)}`,
    `BUCKET=${shq(o.bucket)}`,
    `PREFIX=${shq(o.prefix)}`,
    `ACCESS_KEY=${shq(o.accessKey)}`,
    `KEEP_DAYS=${o.keepDays}`,
    `INCLUDE_DB=${o.includeDb ? 1 : 0}`,
    `EVERY_HOURS=${o.everyHours}`,
    `DAILY_HOUR=${o.dailyHour}`
  ].join('\n')
  const upJob = await writeRemoteTemp(client, JOB_SCRIPT)
  const upConf = await writeRemoteTemp(client, conf + '\n')
  const upPaths = await writeRemoteTemp(client, o.paths.join('\n') + (o.paths.length ? '\n' : ''))
  const upSecret = o.secretKey ? await writeRemoteTemp(client, o.secretKey + '\n') : ''
  const all = [upJob, upConf, upPaths, upSecret].filter(Boolean)
  const script = `export LC_ALL=C
${PATH_EXPORT}
tidy() { for f in ${all.map(shq).join(' ')}; do [ -e "$f" ] && unlink "$f"; done; }
for t in curl sha256sum od flock; do command -v $t >/dev/null 2>&1 || { tidy; echo "$t is not installed on this server. Install it first."; exit 61; }; done
umask 077
mkdir -p ${DIR} ${STATE} /var/log/superdevops
${upSecret ? '' : `[ -f ${DIR}/secret ] || { tidy; echo "Enter the secret access key."; exit 62; }`}
# Try the new settings on the side first, so a mistake does not break a schedule that works.
T=$(mktemp -d)
cat ${shq(upConf)} > "$T/conf"
${upSecret ? `cat ${shq(upSecret)} > "$T/secret"` : `cat ${DIR}/secret > "$T/secret"`}
D="$T"; S=${STATE}; LOG=${LOG}
. "$T/conf"
${SH_S3}
echo "==> Checking bucket $BUCKET at $HOST_HEADER"
PROBE=$(mktemp); echo "Apsara Panel can write here. $(date -u '+%F %T') UTC" > "$PROBE"
s3 PUT "\${PREFIX}apsara-panel-check.txt" "$PROBE"
unlink "$PROBE"
if [ "$CODE" != 200 ]; then
  echo "The storage refused a test file: $(why)"
  unlink "$T/conf"; unlink "$T/secret"; rmdir "$T"; unlink "$RESP"; tidy
  exit 63
fi
s3 DELETE "\${PREFIX}apsara-panel-check.txt"
echo "The bucket accepts files from this server."
OLD=$( [ -f ${DIR}/conf ] && . ${DIR}/conf && echo "$HOST_HEADER|$BUCKET|$PREFIX" )
cat "$T/conf" > ${DIR}/conf; cat "$T/secret" > ${DIR}/secret
unlink "$T/conf"; unlink "$T/secret"; rmdir "$T"; unlink "$RESP"
# Another bucket or folder: what was uploaded before is not there, so the list starts again.
if [ "$OLD" != ${shq(`${o.host}|${o.bucket}|${o.prefix}`)} ]; then for f in ${STATE}/uploaded.list ${STATE}/toobig.list; do [ -e "$f" ] && unlink "$f"; done; fi
cat ${shq(upPaths)} > ${DIR}/paths
chmod 600 ${DIR}/conf ${DIR}/secret ${DIR}/paths
umask 022
cat ${shq(upJob)} > ${JOB}
chmod 755 ${JOB}
printf '%s\\n' '# Managed by SuperDevops. Backups to S3 storage.' '41 ${cronHours(o.everyHours, o.dailyHour)} * * * root ${JOB} >/dev/null 2>&1' > ${CRON}
chmod 644 ${CRON}
tidy
echo "==> Saved. ${o.everyHours === 24 ? `Uploads run once a day at ${String(o.dailyHour).padStart(2, '0')}:41` : o.everyHours === 1 ? 'Uploads run every hour at 41 minutes past' : `Uploads run every ${o.everyHours} hours`} (server time)."`
  try {
    await runPrivileged(client, script, sudo, log, 120000)
  } finally {
    await exec(client, `for f in ${all.map(shq).join(' ')}; do [ -e "$f" ] && unlink "$f"; done; true`, { timeoutMs: 10000 }).catch(() => undefined)
  }
}

export async function runNow(client: Client, sudo: Sudo, log: (s: string) => void): Promise<void> {
  const up = await writeRemoteTemp(client, JOB_SCRIPT)
  try {
    await runPrivileged(client, `if [ ! -f ${DIR}/conf ]; then unlink ${shq(up)}; echo "S3 storage is not set up on this server."; exit 62; fi\ncat ${shq(up)} > ${JOB}; unlink ${shq(up)}; chmod 755 ${JOB}\n${JOB} now`, sudo, log, 4 * 60 * 60 * 1000)
  } finally {
    await exec(client, `[ -e ${shq(up)} ] && unlink ${shq(up)}; true`, { timeoutMs: 10000 }).catch(() => undefined)
  }
}

/** Stop uploading and remove the keys from the server. What is already in the bucket stays there. */
export async function disable(client: Client, sudo: Sudo): Promise<void> {
  await runPrivileged(client, `for f in ${CRON} ${JOB} ${DIR}/conf ${DIR}/secret ${DIR}/paths ${STATE}/uploaded.list ${STATE}/toobig.list ${STATE}/last ${STATE}/last_ok; do [ -e "$f" ] && unlink "$f"; done; true`, sudo, undefined, 30000)
}

export async function status(client: Client, sudo: Sudo): Promise<S3Status> {
  const script = `export LC_ALL=C
if [ ! -f ${DIR}/conf ] || [ ! -f ${DIR}/secret ]; then echo "@@off"; exit 0; fi
. ${DIR}/conf
echo "endpoint=$SCHEME://$HOST_HEADER$BASE_PATH"
echo "region=$REGION"
echo "bucket=$BUCKET"
echo "prefix=$PREFIX"
echo "access=$ACCESS_KEY"
echo "keep=$KEEP_DAYS"
echo "db=$INCLUDE_DB"
echo "every=\${EVERY_HOURS:-24}"
echo "hour=\${DAILY_HOUR:-2}"
echo "now=$(date '+%H:%M %Z')"
echo "last=$(cat ${STATE}/last 2>/dev/null)"
echo "count=$(grep -c '|' ${STATE}/uploaded.list 2>/dev/null || echo 0)"
echo "newest=$(tail -1 ${STATE}/uploaded.list 2>/dev/null)"
echo "@@paths"
cat ${DIR}/paths 2>/dev/null
echo "@@log"
tail -n 12 ${LOG} 2>/dev/null`
  const res = await runPrivileged(client, script, sudo, undefined, 30000)
  const off: S3Status = { enabled: false, endpoint: '', region: '', bucket: '', prefix: '', accessKey: '', includeDb: true, paths: [], keepDays: 30, everyHours: 24, dailyHour: 2, uploaded: 0, recent: [] }
  if (res.stdout.includes('@@off')) return off
  const [head, rest = ''] = res.stdout.split('@@paths\n')
  const [pathText, logText = ''] = rest.split('@@log\n')
  const kv: Record<string, string> = {}
  for (const line of head.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim()
  }
  const [at, result, message] = (kv.last ?? '').split('|')
  const [newestName, newestAt] = (kv.newest ?? '').split('|')
  return {
    enabled: true,
    endpoint: kv.endpoint ?? '',
    region: kv.region ?? '',
    bucket: kv.bucket ?? '',
    prefix: (kv.prefix ?? '').replace(/\/$/, ''),
    accessKey: kv.access ?? '',
    keepDays: Number(kv.keep) || 0,
    includeDb: kv.db === '1',
    everyHours: Number(kv.every) || 24,
    dailyHour: /^\d+$/.test(kv.hour ?? '') ? Number(kv.hour) : 2,
    serverTime: kv.now || undefined,
    paths: pathText.split('\n').map((p) => p.trim()).filter(Boolean),
    uploaded: Number(kv.count) || 0,
    newest: newestName ? { name: newestName.split('/').pop() ?? newestName, at: Number(newestAt) * 1000 } : undefined,
    last: at ? { at: Number(at) * 1000, ok: result === 'ok', message: message ?? '' } : undefined,
    recent: logText.split('\n').filter(Boolean)
  }
}

// ---- bringing a copy back ----------------------------------------------------
const KINDS = ['mysql', 'postgres', 'remote-db', 'folders'] as const
const OBJECT = /^(mysql|postgres|remote-db|folders)\/([A-Za-z0-9._-]{1,200}\.(sql|tar)\.gz)$/

/** What is in the bucket under this server's folder, newest first. Read from the bucket itself, so it also works on a fresh server. */
export async function remoteFiles(client: Client, sudo: Sudo): Promise<S3RemoteFile[]> {
  const script = `${HEAD('[ -f "$D/conf" ] && [ -f "$D/secret" ] || { echo "S3 storage is not set up on this server."; exit 62; }')}
ENC=$(printf '%s' "$PREFIX" | sed 's#/#%2F#g')
TOKEN=""
for PAGE in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  s3 GET "" "" "\${TOKEN:+continuation-token=$TOKEN&}list-type=2&prefix=$ENC"
  if [ "$CODE" != 200 ]; then echo "Could not look in the bucket: $(why)"; unlink "$RESP"; exit 64; fi
  sed 's/<Contents>/\\n<Contents>/g' "$RESP" | sed -n 's/.*<Key>\\([^<]*\\)<\\/Key>.*<LastModified>\\([^<]*\\)<\\/LastModified>.*<Size>\\([0-9]*\\)<\\/Size>.*/@@f|\\1|\\2|\\3/p'
  echo
  grep -q '<IsTruncated>true</IsTruncated>' "$RESP" || break
  # The token is opaque text; encode everything outside the unreserved set.
  TOKEN=$(sed -n 's/.*<NextContinuationToken>\\([^<]*\\)<\\/NextContinuationToken>.*/\\1/p' "$RESP" | head -1 | sed 's/&amp;/\\&/g' | od -An -tx1 | tr -d '\\n' | sed 's/ \\(..\\)/%\\U\\1/g')
  [ -n "$TOKEN" ] || break
done
echo "@@prefix|$PREFIX"
unlink "$RESP"`
  const res = await runPrivileged(client, script, sudo, undefined, 180000)
  const prefix = /@@prefix\|(.*)/.exec(res.stdout)?.[1] ?? ''
  const files: S3RemoteFile[] = []
  for (const line of res.stdout.split('\n')) {
    if (!line.startsWith('@@f|')) continue
    const [, key, modified, size] = line.split('|')
    if (!key.startsWith(prefix)) continue
    const m = OBJECT.exec(key.slice(prefix.length))
    if (!m) continue
    files.push({ id: `${m[1]}/${m[2]}`, name: m[2], size: Number(size) || 0, at: Date.parse(modified) || 0, kind: m[1] as S3RemoteFile['kind'] })
  }
  return files.sort((a, b) => b.at - a.at)
}

/**
 * Copy one file from the bucket back onto the server. A database backup lands in the backup list of its page,
 * where restoring asks for the code. A folder archive is unpacked in ${FROM_S3}; nothing live is touched.
 */
export async function fetchRemote(client: Client, sudo: Sudo, id: string, log: (s: string) => void): Promise<void> {
  const m = OBJECT.exec(String(id))
  if (!m || !(KINDS as readonly string[]).includes(m[1])) throw new Error('That is not a backup this app put in the bucket.')
  const [, kind, name] = m
  const dir = kind === 'mysql' ? DB_DIR : kind === 'postgres' ? PG_DIR : kind === 'remote-db' ? REMOTE_DIR : FROM_S3
  const out = `${FROM_S3}/${name.replace(/\.tar\.gz$/, '')}`
  const script = `${HEAD('[ -f "$D/conf" ] && [ -f "$D/secret" ] || { echo "S3 storage is not set up on this server."; exit 62; }')}
umask 077
mkdir -p ${dir}
DEST=${shq(`${dir}/${name}`)}
if [ -f "$DEST" ]; then
  echo "==> ${name} is already on this server"
else
  echo "==> Fetching ${name} from bucket $BUCKET"
  s3 GET "\${PREFIX}${kind}/${name}" "" "" "$DEST.part"
  if [ "$CODE" != 200 ]; then
    head -c 2000 "$DEST.part" > "$RESP" 2>/dev/null; unlink "$DEST.part" 2>/dev/null
    echo "The storage did not hand over the file: $(why)"; unlink "$RESP"
    exit 65
  fi
  if ! gzip -t "$DEST.part" 2>/dev/null; then
    unlink "$DEST.part"; unlink "$RESP"
    echo "The file that came from the bucket is damaged (not a complete backup), so it was not kept."
    exit 66
  fi
  mv "$DEST.part" "$DEST"
  ${kind === 'postgres' ? 'chown postgres "$DEST" 2>/dev/null; ' : ''}echo "Saved $(du -h "$DEST" | cut -f1) as $DEST"
fi
unlink "$RESP" 2>/dev/null
${
  kind === 'mysql'
    ? `echo; echo "==> It is now in the backup list on the Databases page. Restore it from there."`
    : kind === 'postgres'
      ? `echo; echo "==> It is now in the backup list on the PostgreSQL page. Restore it from there."`
      : kind === 'remote-db'
        ? `echo; echo "==> It is on this server again. Open Database Remote, Backup, Scheduled backups, and copy it to this computer to restore it."`
        : `OUT=${shq(out)}
mkdir -p "$OUT"
tar -xzf "$DEST" -C "$OUT" || { echo "The archive could not be unpacked."; exit 67; }
echo; echo "==> Unpacked into $OUT"
echo "Nothing on the live site was changed. Open the Files page to copy what you need."`
}`
  await runPrivileged(client, script, sudo, log, 4 * 60 * 60 * 1000)
}
