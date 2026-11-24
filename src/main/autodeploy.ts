// Auto deploy: the managed server looks at the repository every two minutes and
// deploys a new commit by itself, with nobody at the app. What it needs is kept
// on that server in /etc/superdevops/autodeploy (root only): the deploy script
// for the site, a few settings, and, for a private repository, the access token.
import type { Client } from 'ssh2'
import type { AutoDeployStatus, Site } from '@shared/types'
import { shq, writeRemoteTemp } from './ssh'
import { buildDeployScript, runnerProgram, buildNginxConf, preflight, resolvePhpUpstream, runPrivileged, validateSite, type GitSignIn, type Sudo } from './deploy'

const DIR = '/etc/superdevops/autodeploy'
const RUNNER = '/usr/local/bin/superdevops-autodeploy.sh'
const CRON = '/etc/cron.d/superdevops-autodeploy'
const LOGDIR = '/var/log/superdevops'

const RUNNER_SCRIPT = `#!/bin/bash
# Managed by SuperDevops. Deploys a site when its git branch has a new commit.
export LC_ALL=C
export PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin:/usr/local/bin"
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND='ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes'
D=${DIR}
mkdir -p ${LOGDIR}
say() { [ -x /usr/local/bin/superdevops-alert.sh ] && /usr/local/bin/superdevops-alert.sh say "$1" >/dev/null 2>&1; true; }

for conf in "$D"/*.conf; do
  [ -f "$conf" ] || continue
  NAME=$(basename "$conf" .conf)
  REPO=""; BRANCH=""; ROOT=""; DOMAIN=""; HEALTH="/"; GITUSER=""; PROG=""
  . "$conf"
  LOG="${LOGDIR}/autodeploy-$NAME.log"
  # One run at a time per site; a long deploy must not be started twice.
  exec 9>"$D/$NAME.lock"
  flock -n 9 || continue

  ASK=""
  if [ -f "$D/$NAME.token" ]; then
    ASK=$(mktemp /tmp/superdevops-ask-XXXXXX)
    printf '%s\\n' '#!/bin/sh' 'case "$1" in Username*) printf "%s\\n" "$SD_GIT_USER" ;; *) cat "$SD_GIT_TOKEN_FILE" ;; esac' > "$ASK"
    chmod 700 "$ASK"
    export GIT_ASKPASS="$ASK" SD_GIT_USER="$GITUSER" SD_GIT_TOKEN_FILE="$D/$NAME.token"
  else
    unset GIT_ASKPASS
  fi

  REMOTE=$(timeout 60 git -c credential.helper= ls-remote "$REPO" "refs/heads/$BRANCH" 2>/dev/null | cut -f1)
  [ -n "$ASK" ] && unlink "$ASK"
  if [ -z "$REMOTE" ]; then
    # Tell once, not every two minutes.
    if [ ! -f "$D/$NAME.unreachable" ]; then
      echo "[$(date '+%F %T')] Could not read $REPO ($BRANCH). Check the address, the branch and the access token." >> "$LOG"
      say "Auto deploy of $NAME cannot read its repository. Check the address, the branch and the access token."
      : > "$D/$NAME.unreachable"
    fi
    flock -u 9; continue
  fi
  [ -f "$D/$NAME.unreachable" ] && unlink "$D/$NAME.unreachable"
  LOCAL=$(git -c safe.directory="$ROOT" -C "$ROOT" rev-parse HEAD 2>/dev/null)
  LAST=$(cat "$D/$NAME.last" 2>/dev/null)
  # Nothing new, or this exact commit was already tried (and failed): wait for the next push.
  if [ "$REMOTE" = "$LOCAL" ] || [ "$REMOTE" = "$LAST" ]; then flock -u 9; continue; fi
  echo "$REMOTE" > "$D/$NAME.last"

  {
    echo
    echo "[$(date '+%F %T')] New commit \${REMOTE:0:7} on $BRANCH. Deploying."
    bash "$D/$NAME.deploy.sh"
    RC=$?
    CODE=""
    if [ "$RC" -eq 0 ]; then
      for i in 1 2 3 4 5 6; do
        sleep 2
        CODE=$(curl -s -o /dev/null -m 8 -w '%{http_code}' -H "Host: $DOMAIN" "http://127.0.0.1$HEALTH" 2>/dev/null)
        [ "$CODE" != "000" ] && [ "$CODE" -lt 500 ] 2>/dev/null && break
      done
    fi
    if [ "$RC" -eq 0 ] && [ "$CODE" != "000" ] && [ "$CODE" -lt 500 ] 2>/dev/null; then
      MSG=$(git -c safe.directory="$ROOT" -C "$ROOT" log -1 --format=%s 2>/dev/null)
      echo "[$(date '+%F %T')] RESULT ok \${REMOTE:0:7} $MSG"
      say "Auto deploy of $NAME: now at \${REMOTE:0:7} ($MSG)."
    else
      if [ "$RC" -ne 0 ]; then WHY="the deploy script failed (exit $RC)"; else WHY="the site answered with status $CODE afterwards"; fi
      if [ -n "$LOCAL" ] && [ -d "$ROOT/.git" ]; then
        git -c safe.directory="$ROOT" -C "$ROOT" checkout -f -B "$BRANCH" "$LOCAL" >/dev/null 2>&1
        # A site whose app the deploy starts: start it again on the code that was put back.
        if [ -n "$PROG" ]; then supervisorctl restart "$PROG" >/dev/null 2>&1; fi
        if [ -d /run/systemd/system ]; then
          for svc in $(systemctl list-units --type=service --state=running --no-legend 'php*fpm*' 2>/dev/null | awk '{print $1}'); do systemctl reload "$svc" 2>/dev/null; done
        else
          for pid in $(pgrep -f "php-fpm: master process" 2>/dev/null); do kill -USR2 "$pid" 2>/dev/null; done
        fi
        echo "[$(date '+%F %T')] RESULT rolled-back \${REMOTE:0:7} $WHY; put back \${LOCAL:0:7}"
        say "Auto deploy of $NAME FAILED: $WHY. The previous version (\${LOCAL:0:7}) was put back."
      else
        echo "[$(date '+%F %T')] RESULT failed \${REMOTE:0:7} $WHY"
        say "Auto deploy of $NAME FAILED: $WHY."
      fi
    fi
  } >> "$LOG" 2>&1
  # Keep the log from growing without end.
  if [ "$(wc -c < "$LOG")" -gt 2000000 ]; then tail -c 1000000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
  flock -u 9
done
exit 0
`

function safeName(site: Site): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(site.name)) throw new Error('This site has a name that cannot be used for auto deploy.')
  return site.name
}

/** Put (or refresh) everything the server needs to deploy this site by itself, and schedule the check. */
export async function enable(client: Client, sudo: Sudo, site: Site, git?: GitSignIn): Promise<void> {
  validateSite(site)
  if (site.source !== 'git') throw new Error('Auto deploy needs a site that takes its code from git.')
  if (git && !/^https?:\/\//i.test(site.repoUrl)) throw new Error('A saved Git account works with an https:// repository URL.')
  const name = safeName(site)
  const env = await preflight(client)
  if (!env.nginx || !env.confDir) throw new Error('nginx is not installed on this server.')
  if (!env.git) throw new Error('git is not installed on this server. Use "Install nginx, git, unzip" first.')
  const tokenFile = `${DIR}/${name}.token`
  const script = buildDeployScript({ site, env, nginxConf: buildNginxConf(site, resolvePhpUpstream(site, env), env), gitAuth: git ? { username: git.username, tokenFile, keep: true } : undefined })
  const domain = site.domain.trim().split(/\s+/).find((d) => d !== '_' && !d.includes('*')) ?? 'localhost'
  const conf = [`REPO=${shq(site.repoUrl)}`, `BRANCH=${shq(site.branch)}`, `ROOT=${shq(site.rootPath.replace(/\/+$/, ''))}`, `DOMAIN=${shq(domain)}`, `HEALTH=${shq(site.healthPath || '/')}`, `GITUSER=${shq(git?.username ?? '')}`, `PROG=${shq(site.appType === 'proxy' && site.runner ? runnerProgram(site) : '')}`].join('\n') + '\n'
  // The token travels in a private temporary file, never inside a command line.
  const tokenTmp = git ? await writeRemoteTemp(client, git.token + '\n') : ''
  const install = `set -e
umask 077
mkdir -p ${DIR} ${LOGDIR}
chmod 700 ${DIR}
command -v flock >/dev/null 2>&1 || { echo "The flock tool is missing on this server (package util-linux)."; exit 70; }
echo ${Buffer.from(script).toString('base64')} | base64 -d > ${DIR}/${name}.deploy.sh
echo ${Buffer.from(conf).toString('base64')} | base64 -d > ${DIR}/${name}.conf
${git ? `cat ${shq(tokenTmp)} > ${tokenFile}; unlink ${shq(tokenTmp)}` : `[ -f ${tokenFile} ] && unlink ${tokenFile}; true`}
chmod 600 ${DIR}/${name}.*
[ -f ${DIR}/${name}.last ] && unlink ${DIR}/${name}.last
[ -f ${DIR}/${name}.unreachable ] && unlink ${DIR}/${name}.unreachable
echo ${Buffer.from(RUNNER_SCRIPT).toString('base64')} | base64 -d > ${RUNNER}
chmod 700 ${RUNNER}
printf '%s\\n' '# Managed by SuperDevops' '*/2 * * * * root ${RUNNER} >/dev/null 2>&1' > ${CRON}
chmod 644 ${CRON}
( pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1 ) || echo "@@nocron"
true`
  let res
  try {
    res = await runPrivileged(client, install, sudo, undefined, 40000)
  } finally {
    if (tokenTmp) await runPrivileged(client, `[ -f ${shq(tokenTmp)} ] && unlink ${shq(tokenTmp)}; true`, sudo, undefined, 15000).catch(() => undefined)
  }
  if (res.stdout.includes('@@nocron')) throw new Error('Auto deploy was set up, but the cron service is not running on this server, so nothing will happen. Start cron (see the Cron jobs page) and it begins by itself.')
}

/** Remove a site's auto deploy from the server, token included. The schedule goes when no site is left. */
export async function disable(client: Client, sudo: Sudo, site: Site): Promise<void> {
  const name = safeName(site)
  const script = `for f in ${DIR}/${name}.deploy.sh ${DIR}/${name}.conf ${DIR}/${name}.token ${DIR}/${name}.last ${DIR}/${name}.lock ${DIR}/${name}.unreachable; do [ -e "$f" ] && unlink "$f"; done
ls ${DIR}/*.conf >/dev/null 2>&1 || { [ -f ${CRON} ] && unlink ${CRON}; }
true`
  await runPrivileged(client, script, sudo, undefined, 20000)
}

export async function status(client: Client, sudo: Sudo, site: Site): Promise<AutoDeployStatus> {
  const name = safeName(site)
  const script = `[ -f ${DIR}/${name}.conf ] && [ -f ${CRON} ] && echo "@@on"
[ -f ${DIR}/${name}.token ] && echo "@@token"
[ -f ${DIR}/${name}.unreachable ] && echo "@@unreachable"
echo "@@log"
[ -f ${LOGDIR}/autodeploy-${name}.log ] && tail -n 200 ${LOGDIR}/autodeploy-${name}.log
true`
  const res = await runPrivileged(client, script, sudo, undefined, 20000)
  const [head, ...rest] = res.stdout.split('@@log\n')
  // Lines starting with "@@" are notes the deploy script leaves for the app; they mean nothing to a reader.
  const log = rest
    .join('@@log\n')
    .split('\n')
    .filter((l) => !l.startsWith('@@'))
    .join('\n')
  const results = [...log.matchAll(/^\[([\d-]+ [\d:]+)\] RESULT (ok|rolled-back|failed) (\S+) ?(.*)$/gm)]
  const last = results[results.length - 1]
  return {
    enabled: head.includes('@@on'),
    tokenOnServer: head.includes('@@token'),
    unreachable: head.includes('@@unreachable'),
    last: last ? { time: last[1], result: last[2] as 'ok' | 'rolled-back' | 'failed', commit: last[3], note: last[4] } : undefined,
    log
  }
}

/** Run the check now instead of waiting for the next two-minute mark. */
export async function runNow(client: Client, sudo: Sudo): Promise<void> {
  await runPrivileged(client, `[ -x ${RUNNER} ] || { echo "Auto deploy is not set up on this server."; exit 71; }; ${RUNNER}`, sudo, undefined, 15 * 60 * 1000)
}
