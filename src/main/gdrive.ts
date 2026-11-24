// Backups copied to Google Drive. The server itself uploads, once an hour, with
// a sign-in the user approved on google.com: a daily backup of every database
// (plus any backup made on the Databases page), and a daily archive of each
// chosen folder. The app only sets it up and shows how it went.
import type { Client } from 'ssh2'
import type { GdriveOptions, GdriveStatus } from '@shared/types'
import { PATH_EXPORT, runPrivileged, type Sudo } from './deploy'
import { exec, shq, writeRemoteTemp } from './ssh'

const DIR = '/etc/superdevops/gdrive'
const STATE = '/var/lib/superdevops/gdrive'
export const JOB = '/usr/local/bin/superdevops-gdrive.sh'
const CRON = '/etc/cron.d/superdevops-gdrive'
const LOG = '/var/log/superdevops/gdrive.log'
const DB_DIR = '/var/backups/superdevops/mysql'
const ARCHIVES = '/var/backups/superdevops/folders'

// Overridable for tests.
const OAUTH_URL = (process.env.SUPERDEVOPS_GOOGLE_OAUTH || 'https://oauth2.googleapis.com').replace(/\/+$/, '')
const API_URL = (process.env.SUPERDEVOPS_GOOGLE_API || 'https://www.googleapis.com').replace(/\/+$/, '')

const FROM_DRIVE = '/var/backups/superdevops/from-drive'
/** Databases on other machines that this server backs up (set up from Database Remote). */
export const REMOTE_CONF = '/etc/superdevops/dbremote'
export const REMOTE_DIR = '/var/backups/superdevops/remote-db'

// Shell helpers shared by the hourly job and the bring-back tool.
const SH_HELPERS = `field() { sed -n "s/.*\\"$1\\" *: *\\"\\([^\\"]*\\)\\".*/\\1/p" | head -1; }
# Google's own reason for a refusal, with what to do about the usual ones.
explain() {
  M=$(echo "$1" | field message)
  [ -n "$M" ] || M=$(echo "$1" | field error_description)
  [ -n "$M" ] || M=$(echo "$1" | tr '\\n' ' ' | cut -c1-200)
  case "$M" in
    *"has not been used in project"*|*"is disabled"*|*"accessNotConfigured"*) echo "The Google Drive API is not switched on for your Google Cloud project. In the Cloud Console open APIs & Services, Library, Google Drive API, and press Enable. Wait a minute, then press Upload now." ;;
    *nsufficient*|*"insufficientPermissions"*|*"ACCESS_TOKEN_SCOPE_INSUFFICIENT"*) echo "Google was not given permission for Drive. Press Use another Google account, and on Google's page tick the box that lets the app see and manage its own Drive files before you continue." ;;
    *"storage quota"*|*"storageQuotaExceeded"*) echo "The Google Drive is full. Free up space or keep copies for fewer days." ;;
    *"Rate Limit"*|*"rateLimitExceeded"*) echo "Google asked to slow down. It will be tried again at the next hourly run." ;;
    "") echo "Google gave no reason." ;;
    *) echo "$M" ;;
  esac
}
# Turns Google's list answer (one field per line) into lines of id|name|size|createdTime.
parse() { awk '
  function val(l) { sub(/^[^:]*: *"?/, "", l); sub(/"?,?[ \\r]*$/, "", l); return l }
  /"id" *:/ { id = val($0) }
  /"name" *:/ { name = val($0) }
  /"size" *:/ { size = val($0) }
  /"createdTime" *:/ { ct = val($0) }
  /^ *} *,?[ \\r]*$/ { if (id != "") print id "|" name "|" size "|" ct; id = name = size = ct = "" }
'; }
`

const JOB_SCRIPT = `#!/bin/bash
# Managed by SuperDevops. Copies backups to Google Drive. Settings: ${DIR}
export LC_ALL=C
export PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin:/usr/local/bin"
D=${DIR}
S=${STATE}
LOG=${LOG}
[ -f "$D/conf" ] && [ -f "$D/token" ] || exit 0
. "$D/conf"
mkdir -p "$S" ${ARCHIVES} /var/log/superdevops
touch "$S/uploaded.list"
exec 9>"$S/lock"
# A scheduled backup of one remote database waits its turn; everything else gives way to a run in progress.
if [ "$1" = rdb ]; then flock -w 900 9 || { echo "Another upload was still running after 15 minutes."; exit 0; }
else flock -n 9 || { echo "Another upload is still running."; exit 0; }
fi
say() { echo "[$(date '+%F %T')] $*" >> "$LOG"; echo "$*"; }
finish() { [ "$1" = rdb ] && return 0; echo "$(date +%s)|$1|$2" > "$S/last"; [ "$1" = ok ] && date +%s > "$S/last_ok"; return 0; }
# A run for one remote database does not count as a run of the whole job.
[ "$1" = rdb ] && finish() { return 0; }
${SH_HELPERS}SENT=0; FAILED=0
# The day's backups are made from the chosen hour on (server time). "Upload now" in the app does not wait for it.
DUE=1
[ "$1" = now ] || [ "$(date +%-H)" -ge "\${DAILY_HOUR:-0}" ] || DUE=0
# "rdb <connection id>": only back up that remote database (its own schedule calls this) and upload.
RDB=""
if [ "$1" = rdb ]; then RDB="$2"; DUE=0; case "$RDB" in ""|*[!A-Za-z0-9-]*) exit 0 ;; esac; fi

# 1. A short-lived pass from Google, from the long-lived one stored here.
T=$(curl -sS --max-time 40 -d "client_id=$CLIENT_ID" -d "client_secret=$CLIENT_SECRET" --data-urlencode "refresh_token=$(cat "$D/token")" -d grant_type=refresh_token "$OAUTH_URL/token" 2>&1)
ACCESS=$(echo "$T" | field access_token)
if [ -z "$ACCESS" ]; then
  WHY=$(echo "$T" | field error_description); [ -n "$WHY" ] || WHY=$(echo "$T" | field error); [ -n "$WHY" ] || WHY="no answer from Google"
  say "Google did not accept the sign-in: $WHY. Connect Google Drive again in the app."
  finish fail "Google did not accept the sign-in: $WHY"
  exit 1
fi
AUTH="Authorization: Bearer $ACCESS"

# 2. The folder in Drive. Made once; made again if someone deleted it.
FID=$(cat "$S/folder_id" 2>/dev/null)
if [ -n "$FID" ]; then
  curl -sS --max-time 40 -H "$AUTH" "$API_URL/drive/v3/files/$FID?fields=id,trashed" 2>/dev/null | grep -q '"trashed" *: *false' || FID=""
fi
if [ -z "$FID" ]; then
  # A folder of this name that this app made earlier (another server, or before a reinstall) is used again.
  R=$(curl -sS -G --max-time 40 -H "$AUTH" --data-urlencode "q=name = '$FOLDER' and mimeType = 'application/vnd.google-apps.folder' and trashed = false" --data-urlencode "fields=files(id,name)" "$API_URL/drive/v3/files" 2>/dev/null)
  FID=$(echo "$R" | parse | head -1 | cut -d'|' -f1)
  if [ -n "$FID" ]; then
    echo "$FID" > "$S/folder_id"
    : > "$S/uploaded.list"
    curl -sS -G --max-time 60 -H "$AUTH" --data-urlencode "q='$FID' in parents and trashed = false" --data-urlencode "fields=files(id,name,size,createdTime)" --data-urlencode "pageSize=1000" "$API_URL/drive/v3/files" 2>/dev/null | parse | while IFS='|' read -r I N Z C; do
      case "$N" in ""|*[!A-Za-z0-9._-]*) continue ;; esac
      echo "$N|$I|$(date -d "$C" +%s 2>/dev/null || date +%s)" >> "$S/uploaded.list"
    done
    say "Found the folder $FOLDER in Google Drive with $(grep -c '|' "$S/uploaded.list") file(s); carrying on with it"
  fi
fi
if [ -z "$FID" ]; then
  R=$(curl -sS --max-time 40 -H "$AUTH" -H 'Content-Type: application/json' -d "{\\"name\\": \\"$FOLDER\\", \\"mimeType\\": \\"application/vnd.google-apps.folder\\"}" "$API_URL/drive/v3/files?fields=id" 2>&1)
  FID=$(echo "$R" | field id)
  if [ -z "$FID" ]; then
    WHY=$(explain "$R")
    say "Could not create the folder $FOLDER in Google Drive: $WHY"
    finish fail "Could not create the folder in Google Drive: $WHY"
    exit 1
  fi
  echo "$FID" > "$S/folder_id"
  : > "$S/uploaded.list"
  say "Created the folder $FOLDER in Google Drive"
fi

# 3. One archive a day of each chosen folder.
TODAY=$(date +%Y%m%d)
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

# 3b. A fresh backup of every database, once a day, so Drive gets them without
# anyone having to set a schedule. A database that already has a backup from
# today (made here earlier, or on the Databases page) is not backed up again.
OWN=""
SQL=$(command -v mariadb || command -v mysql)
DUMP=$(command -v mariadb-dump || command -v mysqldump)
if [ "$INCLUDE_DB" = 1 ] && [ "\${DB_DUMP:-1}" = 1 ] && [ "$DUE" = 1 ] && [ -n "$SQL" ] && [ -n "$DUMP" ]; then
  if true; then
    NAMES=$("$SQL" -N -B -e "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema','performance_schema','mysql','sys')" 2>>"$LOG")
    if [ $? -ne 0 ]; then
      say "Could not list the databases (the database server did not answer root on this server)"; FAILED=$((FAILED+1)); LASTWHY="The databases could not be read"
    else
      ( umask 077; mkdir -p ${DB_DIR} )
      STAMP=$(date +%Y%m%d-%H%M%S)
      for db in $NAMES; do
        ls ${DB_DIR}/"$db"-"$TODAY"-*.sql.gz >/dev/null 2>&1 && continue
        FILE=${DB_DIR}/$db-$STAMP.sql.gz
        if ( set -o pipefail; umask 077; "$DUMP" --single-transaction --routines --triggers "$db" 2>>"$LOG" | gzip > "$FILE.part" ); then
          mv "$FILE.part" "$FILE"; echo "$FILE" >> "$S/dbdumps.list"; OWN="$OWN $FILE"
          say "Backed up database $db ($(du -h "$FILE" | cut -f1))"
        else
          [ -e "$FILE.part" ] && unlink "$FILE.part"
          say "Could not back up database $db"; FAILED=$((FAILED+1)); LASTWHY="Database $db could not be backed up"
        fi
      done
    fi
  fi
  # The backups made here stay on the server for 7 days; others are left to their own schedule.
  if [ -s "$S/dbdumps.list" ]; then
    K=$(mktemp)
    while IFS= read -r F; do
      [ -f "$F" ] || continue
      if [ -n "$(find "$F" -mtime +7 2>/dev/null)" ]; then unlink "$F"; else echo "$F" >> "$K"; fi
    done < "$S/dbdumps.list"
    cat "$K" > "$S/dbdumps.list"; unlink "$K"
  fi
fi

# 3c. One database on another machine, when its own schedule (set in Database Remote) calls for it.
RBAD=0; RWHY=""
if [ -n "$RDB" ] && [ -f ${REMOTE_CONF}/$RDB.conf ] && [ -f ${REMOTE_CONF}/$RDB.cnf ]; then
  CNF=${REMOTE_CONF}/$RDB.cnf
  LABEL=""; DBS=""
  . ${REMOTE_CONF}/$RDB.conf
  RDUMP=$(command -v mariadb-dump || command -v mysqldump)
  ROK=0
  if [ -z "$LABEL" ]; then
    RBAD=1; RWHY="the settings on this server are incomplete"
  elif [ -z "$RDUMP" ]; then
    RBAD=1; RWHY="mysqldump is not installed on this server"
    say "Could not back up the remote databases of $LABEL: $RWHY"
  else
    ( umask 077; mkdir -p ${REMOTE_DIR} )
    RSTAMP=$(date +%Y%m%d-%H%M%S)
    for db in $DBS; do
      FILE=${REMOTE_DIR}/remote-$LABEL-$db-$RSTAMP.sql.gz
      ERR=$(mktemp)
      if ( set -o pipefail; umask 077; "$RDUMP" --defaults-extra-file="$CNF" --single-transaction --quick --skip-triggers --no-tablespaces "$db" 2>"$ERR" | gzip > "$FILE.part" ); then
        mv "$FILE.part" "$FILE"; ROK=$((ROK+1))
        say "Backed up remote database $db of $LABEL ($(du -h "$FILE" | cut -f1))"
      else
        [ -e "$FILE.part" ] && unlink "$FILE.part"
        RWHY=$(grep -v '^$' "$ERR" | tail -1 | cut -c1-220); RBAD=$((RBAD+1))
        say "Could not back up remote database $db of $LABEL: $RWHY"
      fi
      unlink "$ERR"
      # On the server: the newest \${KEEP_LOCAL:-30} of each database, and nothing older than 7 days.
      ls -1t ${REMOTE_DIR}/remote-"$LABEL"-"$db"-[0-9]*.sql.gz 2>/dev/null | tail -n +$(( \${KEEP_LOCAL:-30} + 1 )) | while IFS= read -r OLD; do unlink "$OLD"; done
    done
  fi
  if [ "$RBAD" -gt 0 ]; then FAILED=$((FAILED+RBAD)); LASTWHY="Remote database of $LABEL: $RWHY"; fi
fi
if [ -d ${REMOTE_DIR} ]; then
  find ${REMOTE_DIR} -maxdepth 1 -name 'remote-*.sql.gz' -mtime +7 -delete
  find ${REMOTE_DIR} -maxdepth 1 -name '*.part' -mmin +180 -delete
fi

# 4. Upload what is not in Drive yet.
upload() {
  F="$1"; N=$(basename "$F")
  case "$N" in *[!A-Za-z0-9._-]*) return 0 ;; esac
  grep -q "^$N|" "$S/uploaded.list" && return 0
  H=$(mktemp); B=$(mktemp)
  curl -sS --max-time 60 -D "$H" -o "$B" -X POST -H "$AUTH" -H 'Content-Type: application/json; charset=UTF-8' -d "{\\"name\\": \\"$N\\", \\"parents\\": [\\"$FID\\"]}" "$API_URL/upload/drive/v3/files?uploadType=resumable" 2>>"$LOG"
  LOC=$(tr -d '\\r' < "$H" | sed -n 's/^[Ll]ocation: *//p' | head -1)
  WHY=$(explain "$(cat "$B")")
  unlink "$H"; unlink "$B"
  if [ -z "$LOC" ]; then say "Google did not accept the upload of $N: $WHY"; FAILED=$((FAILED+1)); LASTWHY="$WHY"; return 1; fi
  # Send the file; when the connection drops or Google has a hiccup, ask Google how much arrived and send the rest.
  SIZE=$(stat -c %s "$F"); OFF=0; ID=""; TRY=0; WHY=""
  B=$(mktemp); E=$(mktemp)
  while [ -z "$ID" ] && [ "$TRY" -lt 5 ]; do
    TRY=$((TRY+1))
    if [ "$OFF" -eq 0 ]; then
      CODE=$(curl -sS --max-time 14400 -o "$B" -w '%{http_code}' -X PUT -H "$AUTH" -H 'Content-Type: application/gzip' --upload-file "$F" "$LOC" 2>"$E")
    else
      CODE=$(tail -c +$((OFF+1)) "$F" | curl -sS --max-time 14400 -o "$B" -w '%{http_code}' -X PUT -H "$AUTH" -H "Content-Length: $((SIZE-OFF))" -H "Content-Range: bytes $OFF-$((SIZE-1))/$SIZE" -H "Transfer-Encoding:" --upload-file - "$LOC" 2>"$E")
    fi
    ID=$(field id < "$B")
    [ -n "$ID" ] && break
    NET=$(tr '\\n' ' ' < "$E" | cut -c1-200)
    case "$CODE" in
      4[0-9][0-9]) WHY="Google refused it (HTTP $CODE): $(explain "$(cat "$B")")"; break ;;
      000|1[0-9][0-9]) WHY="The connection to Google broke: \${NET:-no answer}" ;;
      *) WHY="Google answered HTTP $CODE: $(explain "$(cat "$B")")" ;;
    esac
    say "Upload of $N stopped (try $TRY): $WHY"
    sleep $((TRY*10))
    # How much did Google keep? 308 + Range = continue from there; 200/201 = it is there after all.
    HDR=$(mktemp)
    CODE=$(curl -sS --max-time 60 -D "$HDR" -o "$B" -w '%{http_code}' -X PUT -H "$AUTH" -H "Content-Length: 0" -H "Content-Range: bytes */$SIZE" "$LOC" 2>>"$LOG")
    case "$CODE" in
      200|201) ID=$(field id < "$B") ;;
      308) R=$(tr -d '\\r' < "$HDR" | sed -n 's/^[Rr]ange: *bytes=0-\\([0-9]*\\).*/\\1/p' | head -1); if [ -n "$R" ]; then OFF=$((R+1)); else OFF=0; fi; say "Continuing $N from $((OFF/1048576)) MB of $((SIZE/1048576)) MB" ;;
      404|410) unlink "$HDR"; WHY="$WHY (Google dropped the upload session, so it starts again at the next run)"; break ;;
      *) OFF=0 ;;
    esac
    unlink "$HDR"
  done
  unlink "$B"; unlink "$E"
  if [ -z "$ID" ]; then say "The upload of $N did not finish: \${WHY:-Google gave no reason}"; FAILED=$((FAILED+1)); LASTWHY="\${WHY:-The upload of $N did not finish}"; return 1; fi
  echo "$N|$ID|$(date +%s)" >> "$S/uploaded.list"
  SENT=$((SENT+1))
  say "Uploaded $N ($(du -h "$F" | cut -f1))"
}
if [ "$INCLUDE_DB" = 1 ] && [ -d ${DB_DIR} ]; then
  for F in $OWN; do upload "$F"; done
  for F in $(find ${DB_DIR} -maxdepth 1 -name '*.sql.gz' -mmin +1 | sort); do upload "$F"; done
fi
for F in $(find ${ARCHIVES} -maxdepth 1 -name '*.tar.gz' | sort); do upload "$F"; done
if [ -d ${REMOTE_DIR} ]; then for F in $(find ${REMOTE_DIR} -maxdepth 1 -name 'remote-*.sql.gz' | sort); do upload "$F"; done; fi

# 5. Old copies leave Drive after the chosen number of days.
if [ "\${KEEP_DAYS:-0}" -gt 0 ]; then
  CUT=$(( $(date +%s) - KEEP_DAYS * 86400 ))
  K=$(mktemp)
  while IFS='|' read -r N ID AT; do
    [ -n "$ID" ] || continue
    if [ -n "$AT" ] && [ "$AT" -lt "$CUT" ]; then
      if curl -sS --max-time 40 -o /dev/null -X DELETE -H "$AUTH" "$API_URL/drive/v3/files/$ID" 2>>"$LOG"; then say "Removed $N from Drive (older than $KEEP_DAYS days)"; continue; fi
    fi
    echo "$N|$ID|$AT" >> "$K"
  done < "$S/uploaded.list"
  cat "$K" > "$S/uploaded.list"
  unlink "$K"
fi

if [ -n "$RDB" ] && [ -f ${REMOTE_CONF}/$RDB.conf ]; then
  if [ "$FAILED" -gt 0 ]; then echo "$(date +%s)|fail|\${RWHY:-\${LASTWHY:-The upload to Google Drive did not finish}}" > "$S/remote-$RDB.last"
  else echo "$(date +%s)|ok|$ROK database(s) backed up, $SENT file(s) uploaded" > "$S/remote-$RDB.last"; fi
fi
if [ "$FAILED" -gt 0 ]; then
  finish fail "$SENT uploaded, $FAILED failed\${LASTWHY:+. $LASTWHY}"
  [ -x /usr/local/bin/superdevops-alert.sh ] && /usr/local/bin/superdevops-alert.sh say "Google Drive backup: $FAILED item(s) failed on $(hostname). See $LOG" >/dev/null 2>&1
  echo "Finished with problems: $SENT uploaded, $FAILED failed."
  exit 1
fi
finish ok "$SENT uploaded"
echo "Finished: $SENT uploaded, nothing failed."
`

function clean(o: GdriveOptions): { folder: string; keepDays: number; includeDb: boolean; dumpDb: boolean; paths: string[]; everyHours: number; dailyHour: number } {
  const folder = (o.folder ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(folder)) throw new Error('Name the Drive folder with letters, numbers, spaces, dots, dashes or underscores, for example "Apsara Panel backups".')
  const keepDays = Math.floor(Number(o.keepDays))
  if (!(keepDays >= 0 && keepDays <= 3650)) throw new Error('Keep copies for 0 (for ever) to 3650 days.')
  const paths = [...new Set((o.paths ?? []).map((p) => String(p).trim().replace(/\/+$/, '')).filter(Boolean))]
  if (paths.length > 30) throw new Error('Choose at most 30 folders.')
  for (const p of paths) {
    if (!p.startsWith('/') || /[\0\n\r]/.test(p) || p.split('/').includes('..') || p.length > 500) throw new Error(`"${p}" is not a folder path. Use absolute paths such as /www/wwwroot/shop.`)
    if (['/', '/etc', '/usr', '/var', '/home', '/root', '/proc', '/sys', '/dev'].includes(p)) throw new Error(`${p} is a system folder and far too large to send every day. Choose the website's own folder.`)
  }
  if (!o.includeDb && paths.length === 0) throw new Error('Choose at least one thing to copy: database backups, or a folder.')
  const everyHours = o.everyHours === undefined ? 1 : Number(o.everyHours)
  if (![1, 6, 12, 24].includes(everyHours)) throw new Error('Upload every hour, every 6 hours, every 12 hours, or once a day.')
  const dailyHour = o.dailyHour === undefined ? 2 : Number(o.dailyHour)
  if (!(Number.isInteger(dailyHour) && dailyHour >= 0 && dailyHour <= 23)) throw new Error('The backup hour must be between 0 and 23.')
  return { folder, keepDays, includeDb: o.includeDb === true, dumpDb: o.dumpDb !== false, paths, everyHours, dailyHour }
}

/** The hour field of the cron line: every hour, or every 6 / 12 / 24 hours counted from the daily hour. */
function cronHours(every: number, hour: number): string {
  if (every === 1) return '*'
  const hours: number[] = []
  for (let h = hour % every; h < 24; h += every) hours.push(h)
  return hours.join(',')
}

export interface GoogleGrant {
  clientId: string
  clientSecret: string
  refreshToken: string
  email: string
}

async function install(client: Client, sudo: Sudo, o: ReturnType<typeof clean>, grant: GoogleGrant | null, log?: (s: string) => void): Promise<void> {
  const confLines = [grant ? `CLIENT_ID=${shq(grant.clientId)}` : '', grant ? `CLIENT_SECRET=${shq(grant.clientSecret)}` : '', grant ? `EMAIL=${shq(grant.email)}` : '', `FOLDER=${shq(o.folder)}`, `KEEP_DAYS=${o.keepDays}`, `INCLUDE_DB=${o.includeDb ? 1 : 0}`, `DB_DUMP=${o.dumpDb ? 1 : 0}`, `EVERY_HOURS=${o.everyHours}`, `DAILY_HOUR=${o.dailyHour}`, `OAUTH_URL=${shq(OAUTH_URL)}`, `API_URL=${shq(API_URL)}`].filter(Boolean)
  const upJob = await writeRemoteTemp(client, JOB_SCRIPT)
  const upPaths = await writeRemoteTemp(client, o.paths.join('\n') + (o.paths.length ? '\n' : ''))
  const upToken = grant ? await writeRemoteTemp(client, grant.refreshToken + '\n') : ''
  const script = `export LC_ALL=C
${PATH_EXPORT}
command -v curl >/dev/null 2>&1 || { echo "curl is not installed on this server. Install it first (apt install curl)."; exit 61; }
umask 077
mkdir -p ${DIR} ${STATE} /var/log/superdevops
OLD_FOLDER=$( [ -f ${DIR}/conf ] && . ${DIR}/conf && echo "$FOLDER" )
${
  grant
    ? `cat > ${DIR}/conf <<'SDEOF'\n${confLines.join('\n')}\nSDEOF\ncat ${shq(upToken)} > ${DIR}/token; unlink ${shq(upToken)}`
    : `[ -f ${DIR}/conf ] && [ -f ${DIR}/token ] || { echo "Google Drive is not connected on this server."; exit 62; }
# Keep the sign-in; replace the choices.
grep -E '^(CLIENT_ID|CLIENT_SECRET|EMAIL)=' ${DIR}/conf > ${DIR}/conf.new
cat >> ${DIR}/conf.new <<'SDEOF'\n${confLines.join('\n')}\nSDEOF\nmv ${DIR}/conf.new ${DIR}/conf`
}
# A different folder name means a new folder in Drive, so the list of what is there starts again.
if [ "$OLD_FOLDER" != ${shq(o.folder)} ]; then for f in ${STATE}/folder_id ${STATE}/uploaded.list; do [ -e "$f" ] && unlink "$f"; done; fi
cat ${shq(upPaths)} > ${DIR}/paths; unlink ${shq(upPaths)}
chmod 600 ${DIR}/conf ${DIR}/token ${DIR}/paths
umask 022
cat ${shq(upJob)} > ${JOB}; unlink ${shq(upJob)}
chmod 755 ${JOB}
printf '%s\\n' '# Managed by SuperDevops. Backups to Google Drive.' '23 ${cronHours(o.everyHours, o.dailyHour)} * * * root ${JOB} >/dev/null 2>&1' > ${CRON}
chmod 644 ${CRON}
echo "==> Installed. ${o.everyHours === 24 ? `Uploads run once a day at ${String(o.dailyHour).padStart(2, '0')}:23` : o.everyHours === 1 ? 'Uploads run every hour at 23 minutes past' : `Uploads run every ${o.everyHours} hours`} (server time: $(date '+%H:%M %Z'))."`
  try {
    await runPrivileged(client, script, sudo, log, 60000)
  } finally {
    // Normally removed by the script; this covers the cases where it stops early.
    await exec(client, `for f in ${[upJob, upPaths, upToken].filter(Boolean).map(shq).join(' ')}; do [ -e "$f" ] && unlink "$f"; done; true`, { timeoutMs: 10000 }).catch(() => undefined)
  }
}

/** Connect this server to Google Drive with a sign-in that was just approved, and start the hourly job. */
export async function enable(client: Client, sudo: Sudo, options: GdriveOptions, grant: GoogleGrant, log: (s: string) => void): Promise<void> {
  const o = clean(options)
  await install(client, sudo, o, grant, log)
  log('\n==> First upload\n')
  await runNow(client, sudo, log)
}

/** Change what is copied and for how long, keeping the Google sign-in already on the server. */
export async function update(client: Client, sudo: Sudo, options: GdriveOptions): Promise<void> {
  await install(client, sudo, clean(options), null)
}

/** Bring the job script on the server up to date (servers connected with an older app get new steps). False = Drive is not connected there. */
export async function refreshJob(client: Client, sudo: Sudo): Promise<boolean> {
  const up = await writeRemoteTemp(client, JOB_SCRIPT)
  try {
    const res = await runPrivileged(client, `if [ ! -f ${DIR}/conf ] || [ ! -f ${DIR}/token ]; then unlink ${shq(up)}; echo "@@off"; exit 0; fi\ncat ${shq(up)} > ${JOB}; unlink ${shq(up)}; chmod 755 ${JOB}; echo "@@on"`, sudo, undefined, 60000)
    return res.stdout.includes('@@on')
  } finally {
    await exec(client, `[ -e ${shq(up)} ] && unlink ${shq(up)}; true`, { timeoutMs: 10000 }).catch(() => undefined)
  }
}

export async function runNow(client: Client, sudo: Sudo, log: (s: string) => void): Promise<void> {
  // The job script on the server is brought up to date first, so servers connected with an older app get fixes.
  const up = await writeRemoteTemp(client, JOB_SCRIPT)
  try {
    await runPrivileged(client, `if [ ! -f ${DIR}/conf ]; then unlink ${shq(up)}; echo "Google Drive is not connected on this server."; exit 62; fi\ncat ${shq(up)} > ${JOB}; unlink ${shq(up)}; chmod 755 ${JOB}\n${JOB} now`, sudo, log, 4 * 60 * 60 * 1000)
  } finally {
    await exec(client, `[ -e ${shq(up)} ] && unlink ${shq(up)}; true`, { timeoutMs: 10000 }).catch(() => undefined)
  }
}

/** Stop uploading and remove the sign-in from the server. What is already in Drive stays there. */
export async function disable(client: Client, sudo: Sudo): Promise<void> {
  await runPrivileged(client, `for f in ${CRON} ${JOB} ${DIR}/conf ${DIR}/token ${DIR}/paths ${STATE}/folder_id ${STATE}/uploaded.list ${STATE}/last ${STATE}/last_ok; do [ -e "$f" ] && unlink "$f"; done; true`, sudo, undefined, 30000)
}

export async function status(client: Client, sudo: Sudo): Promise<GdriveStatus> {
  const script = `export LC_ALL=C
if [ ! -f ${DIR}/conf ] || [ ! -f ${DIR}/token ]; then echo "@@off"; exit 0; fi
. ${DIR}/conf
echo "email=$EMAIL"
echo "folder=$FOLDER"
echo "keep=$KEEP_DAYS"
echo "db=$INCLUDE_DB"
echo "every=\${EVERY_HOURS:-1}"
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
  if (res.stdout.includes('@@off')) return { enabled: false, includeDb: true, paths: [], keepDays: 30, folder: '', uploaded: 0, recent: [] }
  const [head, rest = ''] = res.stdout.split('@@paths\n')
  const [pathText, logText = ''] = rest.split('@@log\n')
  const kv: Record<string, string> = {}
  for (const line of head.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim()
  }
  const [at, result, message] = (kv.last ?? '').split('|')
  const [newestName, , newestAt] = (kv.newest ?? '').split('|')
  return {
    enabled: true,
    email: kv.email || undefined,
    folder: kv.folder ?? '',
    keepDays: Number(kv.keep) || 0,
    includeDb: kv.db === '1',
    everyHours: Number(kv.every) || 1,
    dailyHour: /^\d+$/.test(kv.hour ?? '') ? Number(kv.hour) : 2,
    serverTime: kv.now || undefined,
    paths: pathText.split('\n').map((p) => p.trim()).filter(Boolean),
    uploaded: Number(kv.count) || 0,
    newest: newestName ? { name: newestName, at: Number(newestAt) * 1000 } : undefined,
    last: at ? { at: Number(at) * 1000, ok: result === 'ok', message: message ?? '' } : undefined,
    recent: logText.split('\n').filter(Boolean)
  }
}

// ---- bringing a copy back from Drive ---------------------------------------

export interface GdriveRemoteFile {
  id: string
  name: string
  size: number
  at: number
  kind: 'database' | 'folder'
}

const TOOL_HEAD = `export LC_ALL=C
export PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin:/usr/local/bin"
D=${DIR}
S=${STATE}
[ -f "$D/conf" ] && [ -f "$D/token" ] || { echo "Google Drive is not connected on this server."; exit 62; }
. "$D/conf"
${SH_HELPERS}
T=$(curl -sS --max-time 40 -d "client_id=$CLIENT_ID" -d "client_secret=$CLIENT_SECRET" --data-urlencode "refresh_token=$(cat "$D/token")" -d grant_type=refresh_token "$OAUTH_URL/token" 2>&1)
ACCESS=$(echo "$T" | field access_token)
if [ -z "$ACCESS" ]; then
  WHY=$(echo "$T" | field error_description); [ -n "$WHY" ] || WHY=$(echo "$T" | field error); [ -n "$WHY" ] || WHY="no answer from Google"
  echo "Google did not accept the sign-in: $WHY. Press Use another Google account."
  exit 63
fi
AUTH="Authorization: Bearer $ACCESS"
`

const BACKUP_NAME = /^[A-Za-z0-9._-]{1,200}\.(sql|tar)\.gz$/

/** What this app has put in the Drive folder of that name, newest first. Works on a fresh server too. */
export async function remoteFiles(client: Client, sudo: Sudo): Promise<GdriveRemoteFile[]> {
  const script = `${TOOL_HEAD}
R=$(curl -sS -G --max-time 40 -H "$AUTH" --data-urlencode "q=name = '$FOLDER' and mimeType = 'application/vnd.google-apps.folder' and trashed = false" --data-urlencode "fields=files(id,name)" "$API_URL/drive/v3/files" 2>&1)
FIDS="$(cat "$S/folder_id" 2>/dev/null) $(echo "$R" | parse | cut -d'|' -f1 | tr '\\n' ' ')"
if [ -z "$(echo $FIDS)" ]; then
  case "$R" in *'"error"'*) echo "Could not look in Google Drive: $(explain "$R")"; exit 64 ;; esac
  exit 0
fi
for F in $(echo $FIDS | tr ' ' '\\n' | sort -u); do
  curl -sS -G --max-time 60 -H "$AUTH" --data-urlencode "q='$F' in parents and trashed = false" --data-urlencode "fields=files(id,name,size,createdTime)" --data-urlencode "pageSize=1000" --data-urlencode "orderBy=createdTime desc" "$API_URL/drive/v3/files" 2>/dev/null | parse | sed 's/^/@@f|/'
done`
  const res = await runPrivileged(client, script, sudo, undefined, 120000)
  const seen = new Set<string>()
  const files: GdriveRemoteFile[] = []
  for (const line of res.stdout.split('\n')) {
    if (!line.startsWith('@@f|')) continue
    const [, id, name, size, created] = line.split('|')
    if (!id || seen.has(id) || !BACKUP_NAME.test(name ?? '')) continue
    seen.add(id)
    files.push({ id, name, size: Number(size) || 0, at: Date.parse(created ?? '') || 0, kind: name.endsWith('.sql.gz') ? 'database' : 'folder' })
  }
  return files.sort((a, b) => b.at - a.at)
}

/**
 * Copy one file from Drive back onto the server. A database backup lands in the
 * backup list of the Databases page (restoring it there asks for the code). A
 * folder archive is unpacked beside the others in ${FROM_DRIVE}; nothing live is touched.
 */
export async function fetchRemote(client: Client, sudo: Sudo, id: string, name: string, log: (s: string) => void): Promise<void> {
  if (!/^[A-Za-z0-9_-]{5,200}$/.test(id) || !BACKUP_NAME.test(name)) throw new Error('That is not a backup this app put in the Drive.')
  const isDb = name.endsWith('.sql.gz')
  // A backup of a database on another machine goes back beside the others of its kind, not into this server's own list.
  const isRemoteDb = isDb && name.startsWith('remote-')
  const dest = `${isRemoteDb ? REMOTE_DIR : isDb ? DB_DIR : FROM_DRIVE}/${name}`
  const out = `${FROM_DRIVE}/${name.replace(/\.tar\.gz$/, '')}`
  const script = `${TOOL_HEAD}
umask 077
mkdir -p ${isRemoteDb ? REMOTE_DIR : isDb ? DB_DIR : FROM_DRIVE}
DEST=${shq(dest)}
if [ -f "$DEST" ]; then
  echo "==> ${name} is already on this server"
else
  echo "==> Fetching ${name} from Google Drive"
  CODE=$(curl -sS --max-time 14400 -H "$AUTH" -o "$DEST.part" -w '%{http_code}' "$API_URL/drive/v3/files/${id}?alt=media" 2>&1)
  if [ "$CODE" != 200 ]; then
    WHY=$(explain "$(head -c 2000 "$DEST.part" 2>/dev/null)")
    [ -e "$DEST.part" ] && unlink "$DEST.part"
    echo "Google did not hand over the file: $WHY"
    exit 65
  fi
  if ! gzip -t "$DEST.part" 2>/dev/null; then
    unlink "$DEST.part"
    echo "The file that came from Drive is damaged (not a complete backup), so it was not kept."
    exit 66
  fi
  mv "$DEST.part" "$DEST"
  echo "Saved $(du -h "$DEST" | cut -f1) as $DEST"
fi
${
  isDb
    ? isRemoteDb
      ? `echo; echo "==> It is on this server again. Open Database Remote, Backup, Scheduled backups, and copy it to this computer to restore it."`
      : `echo; echo "==> It is now in the backup list on the Databases page. Restore it from there."`
    : `OUT=${shq(out)}
mkdir -p "$OUT"
tar -xzf "$DEST" -C "$OUT" || { echo "The archive could not be unpacked."; exit 67; }
echo; echo "==> Unpacked into $OUT"
echo "Nothing on the live site was changed. Open the Files page to copy what you need."`
}`
  await runPrivileged(client, script, sudo, log, 4 * 60 * 60 * 1000)
}
