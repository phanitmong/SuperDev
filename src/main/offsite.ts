// Copies of database backups on another server. The database server gets its
// own SSH key and pushes new backup files, once an hour, to a locked-down
// account on the other server. A dead disk then no longer takes the backups
// with it.
import type { Client } from 'ssh2'
import type { OffsiteStatus } from '@shared/types'
import { shq } from './ssh'
import { runPrivileged, type Sudo } from './deploy'

const CONF_DIR = '/etc/superdevops/offsite'
const JOB = '/usr/local/bin/superdevops-offsite.sh'
const CRON = '/etc/cron.d/superdevops-offsite'
const LOG = '/var/log/superdevops/offsite.log'
const SOURCE_DIR = '/var/backups/superdevops/mysql'
/** On the receiving server. */
const INBOX = '/var/lib/sdbackup'
const ACCOUNT = 'sdbackup'

const JOB_SCRIPT = `#!/bin/bash
# Managed by SuperDevops. Sends new database backups to another server.
export LC_ALL=C
export PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin:/usr/local/bin"
C=${CONF_DIR}
[ -f "$C/target.conf" ] || exit 0
. "$C/target.conf"
mkdir -p /var/log/superdevops
touch "$C/sent.list"
exec 9>"$C/lock"
flock -n 9 || exit 0
SSH_OPTS="-i $C/id_ed25519 -o UserKnownHostsFile=$C/known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=20"
say() { [ -x /usr/local/bin/superdevops-alert.sh ] && /usr/local/bin/superdevops-alert.sh say "$1" >/dev/null 2>&1; true; }
sent=0; failed=0
for f in ${SOURCE_DIR}/*.sql.gz; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  grep -qxF -- "$name" "$C/sent.list" && continue
  # Sent under a temporary name first, so a half-copied file is never mistaken for a backup.
  if scp -q -P "$PORT" $SSH_OPTS "$f" "$RUSER@$HOST:$DIR/$name.part" 2>>${LOG} && ssh -p "$PORT" $SSH_OPTS "$RUSER@$HOST" "mv -f '$DIR/$name.part' '$DIR/$name'" 2>>${LOG}; then
    echo "$name" >> "$C/sent.list"; sent=$((sent+1))
  else
    failed=$((failed+1))
  fi
done
if [ "$failed" -gt 0 ]; then
  echo "[$(date '+%F %T')] RESULT failed: $failed backup(s) could not be copied to $HOST, $sent copied" >> ${LOG}
  if [ ! -f "$C/failing" ]; then say "Database backups could NOT be copied to $HOST ($failed file(s)). The copies there are getting old."; : > "$C/failing"; fi
else
  [ -f "$C/failing" ] && { unlink "$C/failing"; say "Database backups are being copied to $HOST again."; }
  [ "$sent" -gt 0 ] && echo "[$(date '+%F %T')] RESULT ok: $sent backup(s) copied to $HOST" >> ${LOG}
  # Old copies are removed on the other server after KEEP days.
  ssh -p "$PORT" $SSH_OPTS "$RUSER@$HOST" "find '$DIR' -maxdepth 1 -name '*.sql.gz' -mtime +$KEEP -delete; find '$DIR' -maxdepth 1 -name '*.part' -mmin +120 -delete" 2>>${LOG}
fi
# The list only needs names of files that still exist here.
ls ${SOURCE_DIR} 2>/dev/null | grep -xFf - "$C/sent.list" > "$C/sent.tmp" 2>/dev/null; mv -f "$C/sent.tmp" "$C/sent.list"
if [ "$(wc -c < ${LOG} 2>/dev/null || echo 0)" -gt 500000 ]; then tail -c 200000 ${LOG} > ${LOG}.tmp && mv -f ${LOG}.tmp ${LOG}; fi
exit 0
`

export interface OffsiteTarget {
  client: Client
  sudo: Sudo
  /** Address the database server uses to reach the other server. */
  host: string
  port: number
  /** Shown in the app. */
  label: string
}

/**
 * Set up the copy: a key on the sending server, a locked-down account on the
 * receiving one, and an hourly job. Runs one copy at once so problems show now.
 */
export async function enable(src: { client: Client; sudo: Sudo }, dst: OffsiteTarget, keepDays: number, log: (s: string) => void): Promise<void> {
  if (!(Number.isInteger(keepDays) && keepDays >= 1 && keepDays <= 3650)) throw new Error('Days to keep must be between 1 and 3650.')
  if (!/^[A-Za-z0-9.:_-]{1,253}$/.test(dst.host)) throw new Error('That is not a valid server address.')
  if (!(Number.isInteger(dst.port) && dst.port > 0 && dst.port < 65536)) throw new Error('That is not a valid SSH port.')

  log('==> Preparing a key on this server\n')
  const key = await runPrivileged(
    src.client,
    `set -e
umask 077
mkdir -p ${CONF_DIR}
command -v scp >/dev/null 2>&1 || { echo "scp is not installed on this server (package openssh-client)."; exit 80; }
[ -f ${CONF_DIR}/id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -C superdevops-offsite -f ${CONF_DIR}/id_ed25519
echo "@@host=$(hostname)"
echo "@@key=$(cat ${CONF_DIR}/id_ed25519.pub)"`,
    src.sudo,
    undefined,
    30000
  )
  const pub = /^@@key=(ssh-ed25519 [A-Za-z0-9+/=]+)/m.exec(key.stdout)?.[1]
  const from = (/^@@host=(.*)$/m.exec(key.stdout)?.[1] ?? 'server').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'server'
  if (!pub) throw new Error('The key could not be created on this server.')
  const dir = `${INBOX}/${from}`

  log(`==> Preparing ${dst.label} to receive the copies\n`)
  await runPrivileged(
    dst.client,
    `set -e
export PATH="$PATH:/usr/sbin:/sbin"
# An account that owns nothing but the backup folder.
id ${ACCOUNT} >/dev/null 2>&1 || useradd --system --create-home --home-dir ${INBOX} --shell /bin/sh ${ACCOUNT}
# No password, but not "locked": some SSH setups refuse key sign-in for locked accounts.
usermod -p '*' ${ACCOUNT}
mkdir -p ${INBOX}/.ssh ${shq(dir)}
# "restrict" turns off terminals and every kind of forwarding for this key.
LINE=${shq(`restrict ${pub}`)}
touch ${INBOX}/.ssh/authorized_keys
grep -qxF -- "$LINE" ${INBOX}/.ssh/authorized_keys || echo "$LINE" >> ${INBOX}/.ssh/authorized_keys
chown -R ${ACCOUNT}: ${INBOX}
chmod 700 ${INBOX} ${INBOX}/.ssh ${shq(dir)}
chmod 600 ${INBOX}/.ssh/authorized_keys
echo "Folder: ${dir}"`,
    dst.sudo,
    log,
    40000
  )

  log('==> Connecting the two servers\n')
  const conf = [`HOST=${shq(dst.host)}`, `PORT=${dst.port}`, `RUSER=${ACCOUNT}`, `DIR=${shq(dir)}`, `KEEP=${keepDays}`, `LABEL=${shq(dst.label)}`].join('\n') + '\n'
  await runPrivileged(
    src.client,
    `set -e
umask 077
command -v flock >/dev/null 2>&1 || { echo "The flock tool is missing on this server (package util-linux)."; exit 81; }
# Remember the other server's identity now; later runs refuse a different one.
ssh-keyscan -T 15 -p ${dst.port} ${shq(dst.host)} 2>/dev/null > ${CONF_DIR}/known_hosts || true
[ -s ${CONF_DIR}/known_hosts ] || { echo "This server cannot reach ${dst.host} on port ${dst.port}. Check the address and the firewall of the other server."; exit 82; }
ssh -p ${dst.port} -i ${CONF_DIR}/id_ed25519 -o UserKnownHostsFile=${CONF_DIR}/known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=20 ${ACCOUNT}@${shq(dst.host)} "test -w ${shq(dir)}" || { echo "The other server did not accept the key. Its SSH settings may not allow key sign-in for new accounts."; exit 83; }
echo ${Buffer.from(conf).toString('base64')} | base64 -d > ${CONF_DIR}/target.conf
echo ${Buffer.from(JOB_SCRIPT).toString('base64')} | base64 -d > ${JOB}
chmod 700 ${JOB}
printf '%s\\n' '# Managed by SuperDevops' '30 * * * * root ${JOB} >/dev/null 2>&1' > ${CRON}
chmod 644 ${CRON}
echo "Connected."
echo "==> Copying what is there now"
${JOB}
tail -n 1 ${LOG} 2>/dev/null || true
( pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1 ) || echo "Note: the cron service is not running on this server, so the hourly copy will not happen until it is started."`,
    src.sudo,
    log,
    30 * 60 * 1000
  )
}

/** Stop copying. What was already copied stays on the other server. */
export async function disable(client: Client, sudo: Sudo): Promise<void> {
  await runPrivileged(client, `for f in ${CRON} ${CONF_DIR}/target.conf ${CONF_DIR}/sent.list ${CONF_DIR}/failing; do [ -e "$f" ] && unlink "$f"; done; true`, sudo, undefined, 20000)
}

export async function runNow(client: Client, sudo: Sudo, log: (s: string) => void): Promise<void> {
  await runPrivileged(client, `[ -f ${CONF_DIR}/target.conf ] || { echo "Copies to another server are not set up."; exit 84; }
${JOB}
tail -n 3 ${LOG} 2>/dev/null || true`, sudo, log, 30 * 60 * 1000)
}

export async function status(client: Client, sudo: Sudo): Promise<OffsiteStatus> {
  const res = await runPrivileged(
    client,
    `if [ -f ${CONF_DIR}/target.conf ] && [ -f ${CRON} ]; then
  . ${CONF_DIR}/target.conf
  echo "@@on"; echo "@@host=$HOST"; echo "@@port=$PORT"; echo "@@keep=$KEEP"; echo "@@dir=$DIR"; echo "@@label=$LABEL"
  echo "@@sent=$(wc -l < ${CONF_DIR}/sent.list 2>/dev/null || echo 0)"
  echo "@@local=$(ls ${SOURCE_DIR}/*.sql.gz 2>/dev/null | wc -l)"
  [ -f ${CONF_DIR}/failing ] && echo "@@failing"
fi
echo "@@last=$(grep RESULT ${LOG} 2>/dev/null | tail -n 1)"
true`,
    sudo,
    undefined,
    20000
  )
  const v = (k: string): string => new RegExp(`^@@${k}=(.*)$`, 'm').exec(res.stdout)?.[1].trim() ?? ''
  return {
    enabled: res.stdout.includes('@@on'),
    host: v('host'),
    port: Number(v('port')) || 22,
    label: v('label'),
    folder: v('dir'),
    keepDays: Number(v('keep')) || 30,
    copied: Number(v('sent')) || 0,
    local: Number(v('local')) || 0,
    failing: res.stdout.includes('@@failing'),
    last: v('last')
  }
}
