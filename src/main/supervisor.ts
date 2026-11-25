// Supervisor: keeps long-running programs (queue workers, schedulers, small
// services) running and restarts them when they stop.
//
// Programs made here live in their own file, superdevops-<name>.conf (or .ini),
// in Supervisor's include folder. Programs from other files are listed but
// left alone.
import type { Client } from 'ssh2'
import type { SupervisorOverview, SupervisorProgram, SupervisorProgramInput } from '@shared/types'
import type { Sudo } from './deploy'
import { PATH_EXPORT, runPrivileged } from './deploy'
import { shq } from './ssh'
import { SUP_SHELL } from './supshell'

const RE_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/
const RE_USER = /^[a-z_][a-z0-9_-]{0,31}$/

/** Shell helpers: where Supervisor keeps its files, and how to start it with or without systemd. */
const PRELUDE = `${PATH_EXPORT}
export LC_ALL=C
${SUP_SHELL}`

export async function overview(client: Client, sudo: Sudo): Promise<SupervisorOverview> {
  const script = `${PRELUDE}
if ! command -v supervisorctl >/dev/null 2>&1; then echo "@@installed=0"; exit 0; fi
echo "@@installed=1"
echo "@@version=$(supervisord --version 2>/dev/null | head -1)"
if sup_running; then echo "@@running=1"; else echo "@@running=0"; fi
echo "@@dir=$DIR"
echo "@@status"; supervisorctl status 2>/dev/null
echo "@@ours"
if [ -n "$DIR" ]; then
  for f in "$DIR"/superdevops-*."$EXT"; do
    [ -f "$f" ] || continue
    n=$(basename "$f" ."$EXT"); n=\${n#superdevops-}
    get() { sed -n "s/^$1=//p" "$f" | head -1; }
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$n" "$(get user)" "$(get numprocs)" "$(get autostart)" "$(get directory)" "$(get stdout_logfile)" "$(get command)"
  done
fi
echo "@@end"`
  const res = await runPrivileged(client, script, sudo, undefined, 40000)
  const kv: Record<string, string> = {}
  const sec: Record<string, string[]> = {}
  let cur = ''
  for (const line of res.stdout.split('\n')) {
    const m = /^@@(\w+)=(.*)$/.exec(line)
    if (m) kv[m[1]] = m[2].trim()
    else if (line.startsWith('@@')) { cur = line.slice(2); sec[cur] = [] } // prettier-ignore
    else if (cur && line.trim()) sec[cur].push(line)
  }
  if (kv.installed !== '1') return { installed: false, running: false, version: '', programs: [] }
  // "name  STATE  description", where name is group:process when a program has several processes.
  const states = new Map<string, { state: string; detail: string }[]>()
  for (const line of sec.status ?? []) {
    const m = /^(\S+)\s+([A-Z]+)\s*(.*)$/.exec(line.trim())
    if (!m) continue
    const group = m[1].split(':')[0]
    const list = states.get(group) ?? []
    list.push({ state: m[2], detail: m[3] })
    states.set(group, list)
  }
  const summarise = (list: { state: string; detail: string }[] | undefined): { state: string; detail: string } => {
    if (!list || list.length === 0) return { state: 'UNKNOWN', detail: 'Not loaded. Press Start.' }
    if (list.length === 1) return list[0]
    const up = list.filter((p) => p.state === 'RUNNING').length
    return { state: up === list.length ? 'RUNNING' : up === 0 ? list[0].state : 'PARTLY', detail: `${up} of ${list.length} processes running` }
  }
  const programs: SupervisorProgram[] = []
  const ours = new Set<string>()
  for (const line of sec.ours ?? []) {
    const [name, user, numprocs, autostart, directory, logfile, ...cmd] = line.split('\t')
    if (!RE_NAME.test(name)) continue
    ours.add(name)
    programs.push({
      name,
      managed: true,
      command: cmd.join('\t').replace(/%%/g, '%'),
      directory: directory ?? '',
      user: user || 'root',
      numprocs: Number(numprocs) || 1,
      autostart: autostart !== 'false',
      logfile: logfile ?? '',
      ...summarise(states.get(name))
    })
  }
  for (const [name, list] of states) {
    if (ours.has(name)) continue
    programs.push({ name, managed: false, command: '', directory: '', user: '', numprocs: list.length, autostart: true, logfile: '', ...summarise(list) })
  }
  programs.sort((a, b) => Number(b.managed) - Number(a.managed) || a.name.localeCompare(b.name))
  return { installed: true, running: kv.running === '1', version: /(\d+\.\d+[\w.]*)/.exec(kv.version ?? '')?.[1] ?? '', programs }
}

export async function install(client: Client, sudo: Sudo, log: (s: string) => void): Promise<void> {
  const script = `${PRELUDE}
set -e
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y || echo "Some package lists could not be refreshed; carrying on with the ones already here."
  apt-get install -y supervisor
elif command -v dnf >/dev/null 2>&1; then dnf install -y supervisor
elif command -v yum >/dev/null 2>&1; then yum install -y supervisor
else echo "No supported package manager found."; exit 40
fi
set +e
if [ -d /etc/supervisor/conf.d ]; then DIR=/etc/supervisor/conf.d; elif [ -d /etc/supervisord.d ]; then DIR=/etc/supervisord.d; fi
sup_start || { echo "Supervisor is installed but did not start. Look at /var/log/supervisor/supervisord.log on the server."; exit 61; }
echo; echo "==> Supervisor $(supervisord --version 2>/dev/null | head -1) is installed and running. It starts with the server."`
  await runPrivileged(client, script, sudo, log, 15 * 60 * 1000)
}

function clean(p: SupervisorProgramInput): Required<SupervisorProgramInput> {
  const name = String(p.name ?? '').trim().toLowerCase()
  if (!RE_NAME.test(name)) throw new Error('The name may use small letters, numbers, - and _, and must start with a letter or number (up to 40).')
  const command = String(p.command ?? '').trim()
  if (!command) throw new Error('Type the command to run.')
  if (/[\r\n\0]/.test(command) || command.length > 1000) throw new Error('The command must be one line, up to 1000 characters.')
  const directory = String(p.directory ?? '').trim()
  if (directory && (!directory.startsWith('/') || /[\r\n\0;]/.test(directory) || directory.includes('..'))) throw new Error('The folder must be a full path, such as /www/wwwroot/shop.')
  const user = String(p.user ?? '').trim() || 'www-data'
  if (!RE_USER.test(user)) throw new Error('That is not a valid user name.')
  const numprocs = Math.floor(Number(p.numprocs ?? 1))
  if (!(numprocs >= 1 && numprocs <= 20)) throw new Error('Run between 1 and 20 processes.')
  return { name, command, directory, user, numprocs, autostart: p.autostart !== false }
}

/** Create or change a program, then load it. */
export async function saveProgram(client: Client, sudo: Sudo, input: SupervisorProgramInput): Promise<void> {
  const p = clean(input)
  // Supervisor reads % as the start of a placeholder; a literal one is written twice.
  const lines = [
    `; Managed by SuperDevops. Changes made here are overwritten when the program is saved in the app.`,
    `[program:${p.name}]`,
    `command=${p.command.replace(/%/g, '%%')}`,
    ...(p.directory ? [`directory=${p.directory}`] : []),
    `user=${p.user}`,
    `numprocs=${p.numprocs}`,
    ...(p.numprocs > 1 ? ['process_name=%(program_name)s_%(process_num)02d'] : []),
    `autostart=${p.autostart ? 'true' : 'false'}`,
    'autorestart=true',
    'startsecs=1',
    'stopasgroup=true',
    'killasgroup=true',
    'stopwaitsecs=30',
    'redirect_stderr=true',
    `stdout_logfile=/var/log/supervisor/superdevops-${p.name}.log`,
    'stdout_logfile_maxbytes=10MB',
    'stdout_logfile_backups=3'
  ]
  const b64 = Buffer.from(lines.join('\n') + '\n').toString('base64')
  const script = `${PRELUDE}
command -v supervisorctl >/dev/null 2>&1 || { echo "Supervisor is not installed."; exit 60; }
[ -n "$DIR" ] || { echo "Supervisor's include folder was not found on this server."; exit 62; }
id ${shq(p.user)} >/dev/null 2>&1 || { echo "There is no user ${p.user} on this server."; exit 63; }
${p.directory ? `[ -d ${shq(p.directory)} ] || { echo "The folder ${p.directory} does not exist on this server."; exit 64; }` : ''}
sup_start || { echo "Supervisor is not running and could not be started."; exit 61; }
PRE=$(supervisorctl reread 2>&1)
if echo "$PRE" | grep -qi "^error"; then echo "Supervisor's settings on this server already have a mistake, so nothing was changed. Fix it first: $(echo "$PRE" | tr '\\n' ' ')"; exit 68; fi
F="$DIR/superdevops-${p.name}.$EXT"
OLD=""; [ -f "$F" ] && OLD=$(cat "$F")
mkdir -p /var/log/supervisor
echo ${b64} | base64 -d > "$F"
chmod 644 "$F"
OUT=$(supervisorctl reread 2>&1); RC=$?
if [ $RC -ne 0 ] || echo "$OUT" | grep -qi "error"; then
  # Put back what was there, so one bad program cannot stop the others from loading.
  if [ -n "$OLD" ]; then printf '%s\\n' "$OLD" > "$F"; else unlink "$F"; fi
  supervisorctl reread >/dev/null 2>&1
  echo "Supervisor did not accept this program: $(echo "$OUT" | tr '\\n' ' ')"; exit 65
fi
supervisorctl update ${shq(p.name)} 2>&1
echo saved`
  const res = await runPrivileged(client, script, sudo, undefined, 90000)
  if (!res.stdout.includes('saved')) throw new Error('The program could not be saved.')
}

export async function action(client: Client, sudo: Sudo, name: string, what: 'start' | 'stop' | 'restart'): Promise<void> {
  if (!/^[A-Za-z0-9][\w.-]{0,80}$/.test(String(name))) throw new Error('Unknown program.')
  if (!['start', 'stop', 'restart'].includes(what)) throw new Error('Unknown action.')
  const script = `${PRELUDE}
sup_start || { echo "Supervisor is not running and could not be started."; exit 61; }
supervisorctl reread >/dev/null 2>&1; supervisorctl add ${shq(name)} >/dev/null 2>&1
OUT=$(supervisorctl ${what} ${shq(name + ':*')} 2>&1); echo "$OUT"
echo "$OUT" | grep -Eqi "ERROR|no such" && { echo "$OUT" | grep -qi "already started" || exit 66; }
true`
  await runPrivileged(client, script, sudo, undefined, 90000)
}

export async function removeProgram(client: Client, sudo: Sudo, name: string): Promise<void> {
  if (!RE_NAME.test(String(name))) throw new Error('Unknown program.')
  const script = `${PRELUDE}
[ -n "$DIR" ] || { echo "Supervisor's include folder was not found."; exit 62; }
F="$DIR/superdevops-${name}.$EXT"
[ -f "$F" ] || { echo "That program was not made in this app, so it is left alone."; exit 67; }
supervisorctl stop ${shq(name + ':*')} >/dev/null 2>&1
unlink "$F"
supervisorctl reread >/dev/null 2>&1; supervisorctl update ${shq(name)} >/dev/null 2>&1
echo removed`
  await runPrivileged(client, script, sudo, undefined, 90000)
}

// Programs made outside this app can have any name Supervisor accepts.
const RE_ANY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/**
 * The end of a program's output, for any program Supervisor runs (made here or not).
 * stream: stdout or stderr (a program with redirect_stderr has everything in stdout).
 * Several processes (numprocs > 1) are shown one after the other.
 */
export async function logs(client: Client, sudo: Sudo, name: string, stream: 'stdout' | 'stderr' = 'stdout', lines = 300): Promise<string> {
  if (!RE_ANY.test(String(name))) throw new Error('Unknown program.')
  const which = stream === 'stderr' ? 'stderr' : 'stdout'
  const n = Math.min(Math.max(Math.floor(Number(lines)) || 300, 20), 5000)
  const script = `${PRELUDE}
N=${shq(name)}
PROCS=$(supervisorctl status 2>/dev/null | awk '{print $1}' | grep -E "^$N(:|\$)" || true)
if [ -z "$PROCS" ]; then
  F=/var/log/supervisor/superdevops-$N.log
  if [ "${which}" = stdout ] && [ -f "$F" ]; then tail -n ${n} "$F"; else echo "(Supervisor does not run $N right now, so there is no output to show.)"; fi
  exit 0
fi
COUNT=$(echo "$PROCS" | wc -l)
for P in $PROCS; do
  [ "$COUNT" -gt 1 ] && echo "===== $P ====="
  OUT=$(supervisorctl tail -$((${n} * 400)) "$P" ${which} 2>&1)
  case "$OUT" in
    *"ERROR (no log file)"*|*"No such file"*) if [ "${which}" = stderr ]; then echo "(No separate error log: this program writes its errors into the normal output.)"; else echo "(This program keeps no output log.)"; fi ;;
    "") echo "(no output yet)" ;;
    *) printf '%s\n' "$OUT" | tail -n ${n} ;;
  esac
done`
  const res = await runPrivileged(client, script, sudo, undefined, 30000)
  return res.stdout
}
