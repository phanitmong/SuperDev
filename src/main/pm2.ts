// PM2 process manager: list, control, logs, start new apps, start on boot.
// PM2 keeps one process list per Linux user, so every call names the user.
import type { Client } from 'ssh2'
import type { Pm2Action, Pm2Overview, Pm2Process, Pm2StartInput } from '@shared/types'
import type { Sudo } from './deploy'
import { PATH_EXPORT, checkServerPath, runPrivileged } from './deploy'
import { shq } from './ssh'

const RE_USER = /^[a-z_][a-z0-9_-]{0,31}$/
const RE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,48}$/
const RE_COMMAND = /^[A-Za-z0-9._/:=@+-][A-Za-z0-9._/:=@+ -]{0,200}$/

function checkUser(user: string): string {
  if (!RE_USER.test(user)) throw new Error('Unknown user.')
  return user
}

/**
 * Shell prelude defining run(): execute a command as the PM2 user with a login
 * environment, and with the usual Node install locations on PATH (nvm included).
 */
function prelude(user: string): string {
  return `${PATH_EXPORT}
U=${shq(checkUser(user))}
H=$(getent passwd "$U" | cut -d: -f6)
[ -n "$H" ] || { echo "The user $U does not exist on this server."; exit 60; }
# Wherever root finds node, npm and pm2 (and npm's global bin folder) is offered to the user too.
EXTRA=""
for b in pm2 node npm; do p=$(command -v "$b" 2>/dev/null) && EXTRA="$EXTRA:$(dirname "$p")"; done
G=$(npm prefix -g 2>/dev/null) && [ -d "$G/bin" ] && EXTRA="$EXTRA:$G/bin"
NODEPATH='export PATH="$PATH:/usr/local/bin'"$EXTRA"':$HOME/.npm-global/bin:$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)"; cd "$HOME"; '
run() {
  if [ "$U" = "$(id -un)" ]; then HOME="$H" bash -lc "$NODEPATH$1"
  else runuser -l "$U" -c "$NODEPATH$1"
  fi
}`
}

export async function overview(client: Client, sudo: Sudo, user: string): Promise<Pm2Overview> {
  const script = `${prelude(user)}
PM=""; for p in apt-get dnf yum; do if command -v "$p" >/dev/null 2>&1; then PM="$p"; break; fi; done
echo "@@pm"; echo "$PM"
echo "@@users"
for d in /root /home/*; do [ -d "$d/.pm2" ] && stat -c %U "$d"; done 2>/dev/null
echo "@@node"; run 'node -v 2>/dev/null' 2>/dev/null || true
echo "@@pm2"
# Read the version from PM2's package.json: running "pm2 --version" would create a PM2 home for this user.
run ${shq(`P=$(readlink -f "$(command -v pm2)") && grep -m1 '"version"' "$(dirname "$P")/../package.json" | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+'`)} 2>/dev/null || true
echo "@@list"
# Listing would create a PM2 home for a user who never used it, so only list when one exists.
if [ -d "$H/.pm2" ]; then run 'command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null' 2>/dev/null || true; fi
echo
echo "@@end"`
  const res = await runPrivileged(client, script, sudo, undefined, 40000)
  const sec: Record<string, string> = {}
  let cur = ''
  for (const line of res.stdout.split('\n')) {
    if (/^@@[a-z0-9]+$/.test(line)) {
      cur = line.slice(2)
      sec[cur] = ''
    } else if (cur) sec[cur] += line + '\n'
  }
  const pm2Version = (sec.pm2 ?? '').trim().split('\n').pop() ?? ''
  let processes: Pm2Process[] = []
  const raw = sec.list ?? ''
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start >= 0 && end > start) {
    try {
      const list = JSON.parse(raw.slice(start, end + 1)) as any[]
      processes = list.map((p) => ({
        id: Number(p.pm_id),
        name: String(p.name ?? ''),
        status: String(p.pm2_env?.status ?? 'unknown'),
        pid: Number(p.pid) || 0,
        cpu: Number(p.monit?.cpu) || 0,
        memory: Number(p.monit?.memory) || 0,
        restarts: Number(p.pm2_env?.restart_time) || 0,
        startedAt: Number(p.pm2_env?.pm_uptime) || 0,
        mode: String(p.pm2_env?.exec_mode ?? '').replace('_mode', ''),
        cwd: String(p.pm2_env?.pm_cwd ?? ''),
        script: String(p.pm2_env?.pm_exec_path ?? '')
      }))
    } catch {
      processes = []
    }
  }
  const users = [...new Set((sec.users ?? '').split('\n').map((u) => u.trim()).filter((u) => RE_USER.test(u)))]
  return {
    installed: /^\d+\.\d+/.test(pm2Version),
    pm2Version: /^\d+\.\d+/.test(pm2Version) ? pm2Version : '',
    nodeVersion: (sec.node ?? '').trim().split('\n').pop() ?? '',
    user,
    users,
    processes,
    packageManager: (sec.pm ?? '').trim()
  }
}

export async function action(client: Client, sudo: Sudo, user: string, id: number, what: Pm2Action): Promise<void> {
  if (!Number.isInteger(id) || id < 0) throw new Error('Unknown process.')
  if (!['restart', 'reload', 'stop', 'start', 'delete'].includes(what)) throw new Error('Unknown action.')
  // Saving after each change means a reboot brings back exactly what is running now.
  const script = `${prelude(user)}
set -e
run 'pm2 ${what} ${id} >/dev/null 2>&1 || { pm2 ${what} ${id} 2>&1 | tail -3; exit 1; }'
run 'pm2 save --force >/dev/null 2>&1' || true`
  await runPrivileged(client, script, sudo, undefined, 60000)
}

export async function logs(client: Client, sudo: Sudo, user: string, id: number, lines: number): Promise<string> {
  if (!Number.isInteger(id) || id < 0) throw new Error('Unknown process.')
  const n = Math.max(20, Math.min(2000, Math.floor(lines) || 200))
  const res = await runPrivileged(client, `${prelude(user)}\nrun 'pm2 logs ${id} --lines ${n} --nostream --raw 2>&1' || true`, sudo, undefined, 40000)
  return res.stdout
}

export async function start(client: Client, sudo: Sudo, user: string, input: Pm2StartInput, log: (s: string) => void): Promise<void> {
  const name = input.name.trim()
  const command = input.command.trim()
  if (!RE_NAME.test(name)) throw new Error('App name may only use letters, numbers, dot, dash and underscore.')
  const cwd = checkServerPath(input.cwd, 'App folder', false)
  if (!RE_COMMAND.test(command)) throw new Error('Enter a script file such as app.js, or an npm command such as "npm run start".')
  // "npm run start" must be handed to PM2 as: pm2 start npm --name x -- run start
  const npm = /^(npm|yarn|pnpm)\s+(.+)$/.exec(command)
  const pm2cmd = npm ? `pm2 start ${npm[1]} --name ${shq(name)} -- ${npm[2]}` : `pm2 start ${shq(command)} --name ${shq(name)}`
  const script = `${prelude(user)}
set -e
run 'command -v pm2 >/dev/null 2>&1' || { echo "PM2 is not installed for $U."; exit 61; }
run ${shq(`[ -d ${shq(cwd)} ] || { echo "The folder ${cwd} does not exist."; exit 62; }`)}
echo "==> Starting ${name} in ${cwd}"
run ${shq(`set -o pipefail; cd ${shq(cwd)} && ${pm2cmd} 2>&1 | tail -n 25`)}
run 'pm2 save --force >/dev/null 2>&1' || true
echo "==> Started"`
  await runPrivileged(client, script, sudo, log)
}

/** Register PM2 with systemd so the saved process list comes back after a reboot. */
export async function startOnBoot(client: Client, sudo: Sudo, user: string, log: (s: string) => void): Promise<void> {
  const script = `${prelude(user)}
set -e -o pipefail
P=$(run 'command -v pm2' | tail -1)
[ -n "$P" ] || { echo "PM2 is not installed for $U."; exit 61; }
{ command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; } || { echo "This server does not use systemd, so start-on-boot cannot be set up automatically."; exit 63; }
echo "==> Registering PM2 for $U with systemd"
env PATH="$PATH:$(dirname "$P")" "$P" startup systemd -u "$U" --hp "$H" 2>&1 | tail -n 12
run 'pm2 save --force 2>&1 | tail -n 2'
echo "==> Done. The apps running now will start again after a reboot."`
  await runPrivileged(client, script, sudo, log)
}

export async function install(client: Client, sudo: Sudo, log: (s: string) => void): Promise<void> {
  const script = `${PATH_EXPORT}
set -e
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "==> Installing Node.js"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y nodejs npm
  elif command -v dnf >/dev/null 2>&1; then dnf install -y nodejs npm
  elif command -v yum >/dev/null 2>&1; then yum install -y nodejs npm
  else echo "No supported package manager found."; exit 40
  fi
fi
echo "==> Installing PM2"
npm install -g pm2 2>&1 | tail -n 5
echo "==> PM2 $(pm2 --version 2>/dev/null | tail -1) installed"`
  await runPrivileged(client, script, sudo, log)
}
