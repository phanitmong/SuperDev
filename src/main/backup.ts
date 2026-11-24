// Back up a server folder to a git repository. Each job keeps its own git
// metadata outside the folder (so a site that is itself a git checkout is
// not disturbed) and can run from cron.
import type { Client } from 'ssh2'
import type { BackupCommit, BackupJob } from '@shared/types'
import type { Sudo } from './deploy'
import { PATH_EXPORT, checkServerPath, runPrivileged } from './deploy'
import { shq } from './ssh'

const CONF_DIR = '/etc/superdevops/backup'
const GIT_DIR = '/var/lib/superdevops/backup'
const RUNNER = '/usr/local/bin/superdevops-gitbackup.sh'
const RE_NAME = /^[A-Za-z0-9_-]{1,40}$/
const RE_REPO = /^[A-Za-z0-9@:/._~+%=-]+$/
const RE_BRANCH = /^[A-Za-z0-9._/-]+$/
const RE_HASH = /^[0-9a-f]{7,40}$/

const RUNNER_SCRIPT = `#!/bin/bash
# Managed by SuperDevops. Usage: superdevops-gitbackup.sh <job name>
export PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin:/usr/local/bin"
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND='ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes'
set -e
. "${CONF_DIR}/$1.conf"
GD="${GIT_DIR}/$1.git"
g() { git --git-dir="$GD" --work-tree="$FOLDER" "$@"; }
[ -d "$FOLDER" ] || { echo "The folder $FOLDER does not exist."; exit 2; }
command -v git >/dev/null 2>&1 || { echo "git is not installed on the server."; exit 3; }
if [ ! -d "$GD" ]; then
  mkdir -p "$GD"
  git --git-dir="$GD" init -q
  g symbolic-ref HEAD "refs/heads/$BRANCH"
fi
g config user.name "Apsara Panel backup"
g config user.email "backup@$(hostname)"
g config core.bare false
# GitHub, GitLab and Bitbucket HTTPS addresses become SSH ones: backups sign in with the server's SSH key.
case "$REPO" in
  https://github.com/*|https://gitlab.com/*|https://bitbucket.org/*|https://www.github.com/*)
    H=\${REPO#https://}; H=\${H#www.}; P=\${H#*/}; H=\${H%%/*}; P=\${P%/}; P=\${P%.git}
    REPO="git@$H:$P.git";;
esac
g remote remove origin 2>/dev/null || true
g remote add origin "$REPO"
echo "==> Collecting changes in $FOLDER"
g add -A
if g diff --cached --quiet 2>/dev/null && g rev-parse HEAD >/dev/null 2>&1; then
  echo "Nothing changed since the last backup."
else
  g commit -q -m "Backup $(date '+%Y-%m-%d %H:%M')"
  echo "Saved: $(g log -1 --format='%h %s')"
fi
echo "==> Pushing to $REPO"
if ! OUT=$(g push -q origin "HEAD:refs/heads/$BRANCH" 2>&1); then
  echo "$OUT"
  case "$OUT" in
    *"could not read Username"*|*"Authentication failed"*)
      echo "This address uses HTTPS, which needs a password, and backups sign in with the server's SSH key. Use the SSH address instead (git@host:owner/repo.git).";;
    *"Connection refused"*|*"Connection timed out"*|*"Could not resolve"*|*"Network is unreachable"*)
      echo "This server cannot reach the git host over SSH (port 22). Check the server's outgoing firewall or the cloud security group.";;
    *"Permission denied (publickey)"*|*"Could not read from remote"*|*"denied to deploy key"*|*"ERROR: The key you are authenticating with"*)
      echo "The git host refused this server's SSH key. Add the key shown under Server key to the repository as a deploy key, with write access allowed.";;
  esac
  exit 128
fi
echo "==> Backup finished"
`

function checkJob(job: BackupJob): string {
  if (!RE_NAME.test(job.name)) throw new Error('Job name may only use letters, numbers, dash and underscore.')
  const folder = checkServerPath(job.folder, 'Folder', true)
  if (!job.repo || !RE_REPO.test(job.repo) || job.repo.startsWith('-')) throw new Error('Enter a valid git repository URL.')
  if (!RE_BRANCH.test(job.branch) || job.branch.startsWith('-') || job.branch.includes('..')) throw new Error('Enter a valid branch name.')
  if (!['off', 'hourly', 'daily'].includes(job.schedule)) throw new Error('Unknown schedule.')
  if (!(Number.isInteger(job.hour) && job.hour >= 0 && job.hour <= 23)) throw new Error('Hour must be between 0 and 23.')
  return folder
}

function cronFile(name: string): string {
  // cron ignores files in cron.d whose names contain a dot.
  return `/etc/cron.d/superdevops-backup-${name}`
}

export async function list(client: Client, sudo: Sudo): Promise<BackupJob[]> {
  const script = `${PATH_EXPORT}
for f in ${CONF_DIR}/*.conf; do
  [ -f "$f" ] || continue
  n=$(basename "$f" .conf)
  echo "@@job $n"
  cat "$f"
  echo "CRON=$(grep -v '^#' /etc/cron.d/superdevops-backup-$n 2>/dev/null | head -1 | awk '{print $1, $2}')"
  echo "LAST=$(git --git-dir=${GIT_DIR}/$n.git log -1 --format='%ct|%s' 2>/dev/null)"
done
true`
  const res = await runPrivileged(client, script, sudo, undefined, 30000)
  const jobs: BackupJob[] = []
  let cur: BackupJob | null = null
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('@@job ')) {
      cur = { name: line.slice(6).trim(), folder: '', repo: '', branch: 'main', schedule: 'off', hour: 3 }
      jobs.push(cur)
      continue
    }
    const m = /^([A-Z]+)=(.*)$/.exec(line)
    if (!cur || !m) continue
    const v = m[2].replace(/^'(.*)'$/, '$1')
    if (m[1] === 'FOLDER') cur.folder = v
    if (m[1] === 'REPO') cur.repo = v
    if (m[1] === 'BRANCH') cur.branch = v
    if (m[1] === 'CRON' && v) {
      const [min, hour] = v.split(' ')
      if (hour === '*') cur.schedule = 'hourly'
      else if (/^\d+$/.test(hour) && min !== undefined) {
        cur.schedule = 'daily'
        cur.hour = Number(hour)
      }
    }
    if (m[1] === 'LAST' && v.includes('|')) {
      cur.lastTime = Number(v.split('|')[0]) * 1000
      cur.lastMessage = v.slice(v.indexOf('|') + 1)
    }
  }
  return jobs
}

/** GitHub, GitLab and Bitbucket HTTPS addresses as SSH ones: backups sign in with the server's SSH key, not a password. */
export function sshUrl(repo: string): string {
  const m = /^https:\/\/(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org)\/([^?#]+?)(?:\.git)?\/?$/.exec(repo.trim())
  return m ? `git@${m[1]}:${m[2]}.git` : repo.trim()
}

export async function save(client: Client, sudo: Sudo, job: BackupJob): Promise<void> {
  job = { ...job, repo: sshUrl(String(job.repo ?? '')) }
  const folder = checkJob(job)
  const conf = [`FOLDER=${shq(folder)}`, `REPO=${shq(job.repo.trim())}`, `BRANCH=${shq(job.branch.trim())}`].join('\n') + '\n'
  const log = `/var/log/superdevops-backup-${job.name}.log`
  const cronLine =
    job.schedule === 'hourly'
      ? `17 * * * * root ${RUNNER} ${job.name} >> ${log} 2>&1`
      : `23 ${job.hour} * * * root ${RUNNER} ${job.name} >> ${log} 2>&1`
  const script = `set -e
umask 077
mkdir -p ${CONF_DIR} ${GIT_DIR}
echo ${Buffer.from(conf).toString('base64')} | base64 -d > ${CONF_DIR}/${job.name}.conf
echo ${Buffer.from(RUNNER_SCRIPT).toString('base64')} | base64 -d > ${RUNNER}
chmod 700 ${RUNNER}
${
  job.schedule === 'off'
    ? `rm -f ${cronFile(job.name)}`
    : `printf '%s\\n' '# Managed by SuperDevops' ${shq(cronLine)} > ${cronFile(job.name)}; chmod 644 ${cronFile(job.name)}`
}`
  await runPrivileged(client, script, sudo, undefined, 20000)
}

export async function remove(client: Client, sudo: Sudo, name: string): Promise<void> {
  if (!RE_NAME.test(name)) throw new Error('Unknown job.')
  // Removes the schedule and the local history copy. The folder and the remote repository are untouched.
  await runPrivileged(client, `rm -f ${CONF_DIR}/${name}.conf ${cronFile(name)}\nrm -rf ${GIT_DIR}/${name}.git`, sudo, undefined, 30000)
}

export async function run(client: Client, sudo: Sudo, name: string, log: (s: string) => void): Promise<void> {
  if (!RE_NAME.test(name)) throw new Error('Unknown job.')
  // The runner is written again first, so a server set up with an older one gets its fixes.
  await runPrivileged(client, `umask 077\necho ${Buffer.from(RUNNER_SCRIPT).toString('base64')} | base64 -d > ${RUNNER}\nchmod 700 ${RUNNER}\n${RUNNER} ${name} 2>&1`, sudo, log)
}

export async function history(client: Client, sudo: Sudo, name: string): Promise<BackupCommit[]> {
  if (!RE_NAME.test(name)) throw new Error('Unknown job.')
  const res = await runPrivileged(
    client,
    `${PATH_EXPORT}\ngit --git-dir=${GIT_DIR}/${name}.git log -30 --format='%h|%ct|%s' 2>/dev/null || true`,
    sudo,
    undefined,
    20000
  )
  return res.stdout
    .split('\n')
    .filter((l) => l.includes('|'))
    .map((l) => {
      const [hash, time, ...rest] = l.split('|')
      return { hash, time: Number(time) * 1000, message: rest.join('|') }
    })
}

/** Put the folder's files back to how they were in one backup. Files created later are kept. */
export async function restore(client: Client, sudo: Sudo, name: string, hash: string, log: (s: string) => void): Promise<void> {
  if (!RE_NAME.test(name) || !RE_HASH.test(hash)) throw new Error('Unknown backup.')
  const script = `${PATH_EXPORT}
set -e
. ${CONF_DIR}/${name}.conf
echo "==> Restoring $FOLDER to backup ${hash}"
git --git-dir=${GIT_DIR}/${name}.git --work-tree="$FOLDER" checkout ${hash} -- .
echo "==> Restore finished"`
  await runPrivileged(client, script, sudo, log)
}

/** The server's own SSH public key (created if missing), to add as a deploy key on the git host. */
export async function serverKey(client: Client, sudo: Sudo): Promise<string> {
  // Deploys and backups run as root, so it is root's key that the git host must trust.
  const script = `set -e
H=$(getent passwd root | cut -d: -f6)
mkdir -p "$H/.ssh" && chmod 700 "$H/.ssh"
[ -f "$H/.ssh/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C "superdevops@$(hostname)" -f "$H/.ssh/id_ed25519"
cat "$H/.ssh/id_ed25519.pub"`
  const res = await runPrivileged(client, script, sudo, undefined, 20000)
  return res.stdout.trim().split('\n').pop() ?? ''
}
