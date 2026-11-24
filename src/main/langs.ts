// Python and Java on the server, from the system's own packages.
//
// Python: the system's python3 with pip and the venv module, which is what a
// Python site needs to make its own environment.
// Java: OpenJDK builds side by side; one of them is what the java command runs.
import type { Client } from 'ssh2'
import type { JavaOverview, PythonOverview } from '@shared/types'
import type { Sudo } from './deploy'
import { PATH_EXPORT, runPrivileged } from './deploy'
import { exec, shq, wrapScript } from './ssh'

/** OpenJDK releases offered for install. */
export const JAVA_LINES = [21, 17, 11, 8]

function parse(stdout: string): { kv: Record<string, string>; sec: Record<string, string[]> } {
  const kv: Record<string, string> = {}
  const sec: Record<string, string[]> = {}
  let cur = ''
  for (const line of stdout.split('\n')) {
    const m = /^@@(\w+)=(.*)$/.exec(line)
    if (m) kv[m[1]] = m[2].trim()
    else if (line.startsWith('@@')) { cur = line.slice(2); sec[cur] = [] } // prettier-ignore
    else if (cur && line.trim()) sec[cur].push(line.trim())
  }
  return { kv, sec }
}

const PM = `PM=""; for p in apt-get dnf yum; do if command -v "$p" >/dev/null 2>&1; then PM="$p"; break; fi; done`

// ---- Python -----------------------------------------------------------------

export async function pythonOverview(client: Client): Promise<PythonOverview> {
  const script = `${PATH_EXPORT}
${PM}
echo "@@pm=$PM"
P=$(command -v python3 2>/dev/null)
echo "@@path=$P"
if [ -n "$P" ]; then
  echo "@@version=$(python3 -c 'import platform; print(platform.python_version())' 2>/dev/null)"
  if python3 -c 'import venv, ensurepip' >/dev/null 2>&1; then echo "@@venv=1"; else echo "@@venv=0"; fi
  echo "@@pip=$(python3 -m pip --version 2>/dev/null | awk '{print $2}')"
fi
echo "@@others"
for f in /usr/bin/python3.[0-9]* /usr/local/bin/python3.[0-9]*; do
  case "$f" in *-config|*m) continue ;; esac
  [ -x "$f" ] && echo "$f $("$f" -c 'import platform; print(platform.python_version())' 2>/dev/null)"
done
echo "@@end"`
  const res = await exec(client, wrapScript(script), { timeoutMs: 40000 })
  const { kv, sec } = parse(res.stdout)
  return {
    installed: !!kv.path,
    packageManager: kv.pm ?? '',
    path: kv.path ?? '',
    version: kv.version ?? '',
    venv: kv.venv === '1',
    pip: kv.pip ?? '',
    others: (sec.others ?? []).map((l) => l.split(' ')).filter((p) => p[1]).map(([path, version]) => ({ path, version }))
  }
}

/** Install python3 with pip and venv, or add whichever of them is missing. */
export async function pythonInstall(client: Client, sudo: Sudo, log: (s: string) => void): Promise<void> {
  const script = `${PATH_EXPORT}
set -e
${PM}
if [ "$PM" = apt-get ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y || echo "Some package lists could not be refreshed; carrying on with the ones already here."
  apt-get install -y python3 python3-venv python3-pip
elif [ -n "$PM" ]; then "$PM" install -y python3 python3-pip
else echo "No supported package manager found."; exit 40
fi
python3 -c 'import venv, ensurepip' || { echo "Python is installed, but it still cannot make virtual environments."; exit 81; }
echo; echo "==> Python $(python3 -c 'import platform; print(platform.python_version())') is ready, with pip and virtual environments."`
  await runPrivileged(client, script, sudo, log, 20 * 60 * 1000)
}

// ---- Java -------------------------------------------------------------------

export async function javaOverview(client: Client): Promise<JavaOverview> {
  const script = `${PATH_EXPORT}
${PM}
echo "@@pm=$PM"
ver() { "$1" -version 2>&1 | sed -n 's/.* version "\\([^"]*\\)".*/\\1/p' | head -1; }
J=$(command -v java 2>/dev/null)
if [ -n "$J" ]; then echo "@@current=$(readlink -f "$J")"; echo "@@version=$(ver "$J")"; fi
echo "@@jdks"
for d in /usr/lib/jvm/*; do
  [ -L "$d" ] && continue
  [ -x "$d/bin/java" ] || continue
  if [ -x "$d/bin/javac" ]; then K=jdk; else K=jre; fi
  echo "$d $(ver "$d/bin/java") $K"
done
echo "@@end"`
  const res = await exec(client, wrapScript(script), { timeoutMs: 40000 })
  const { kv, sec } = parse(res.stdout)
  const current = kv.current ?? ''
  return {
    installed: !!current,
    packageManager: kv.pm ?? '',
    version: kv.version ?? '',
    current,
    jdks: (sec.jdks ?? [])
      .map((l) => l.split(' '))
      .filter((p) => p[1])
      .map(([home, version, kind]) => ({ home, version, line: lineOf(version), compiler: kind === 'jdk', isDefault: current.startsWith(`${home}/`) }))
      .sort((a, b) => b.line - a.line),
    lines: JAVA_LINES
  }
}

/** "1.8.0_412" is Java 8; "17.0.11" is Java 17. */
function lineOf(version: string): number {
  const p = version.split(/[._-]/).map(Number)
  return (p[0] === 1 ? p[1] : p[0]) || 0
}

function checkLine(line: number): number {
  if (!JAVA_LINES.includes(Number(line))) throw new Error(`Choose one of these Java versions: ${JAVA_LINES.join(', ')}.`)
  return Number(line)
}

export async function javaInstall(client: Client, sudo: Sudo, line: number, log: (s: string) => void): Promise<void> {
  const n = checkLine(line)
  const script = `${PATH_EXPORT}
set -e
${PM}
if [ "$PM" = apt-get ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y || echo "Some package lists could not be refreshed; carrying on with the ones already here."
  apt-get install -y openjdk-${n}-jdk-headless || { echo "This system's packages have no OpenJDK ${n}. Try another version."; exit 82; }
elif [ -n "$PM" ]; then
  "$PM" install -y java-${n === 8 ? '1.8.0' : n}-openjdk-devel || { echo "This system's packages have no OpenJDK ${n}. Try another version."; exit 82; }
else echo "No supported package manager found."; exit 40
fi
echo; echo "==> OpenJDK ${n} is installed. The java command runs: $(java -version 2>&1 | grep version | head -1)"`
  await runPrivileged(client, script, sudo, log, 20 * 60 * 1000)
}

/** Make one installed Java the one the java command runs. */
export async function javaUse(client: Client, sudo: Sudo, home: string): Promise<void> {
  if (!/^\/usr\/lib\/jvm\/[A-Za-z0-9._+-]+$/.test(String(home))) throw new Error('Unknown Java installation.')
  const script = `${PATH_EXPORT}
HOME_DIR=${shq(home)}
[ -x "$HOME_DIR/bin/java" ] || { echo "That Java is no longer installed."; exit 83; }
ALT=$(command -v update-alternatives || command -v alternatives) || { echo "This system has no way to switch the default Java."; exit 84; }
# Some builds keep java under jre/bin (Java 8).
for tool in java javac jar; do
  for cand in "$HOME_DIR/bin/$tool" "$HOME_DIR/jre/bin/$tool"; do
    if "$ALT" --list "$tool" 2>/dev/null | grep -qx "$cand" || "$ALT" --display "$tool" 2>/dev/null | grep -q "^$cand "; then "$ALT" --set "$tool" "$cand" >/dev/null 2>&1 && break; fi
  done
done
NOW=$(readlink -f "$(command -v java)")
case "$NOW" in "$HOME_DIR"/*) echo switched ;; *) echo "The default Java could not be switched; it is still $NOW."; exit 85 ;; esac`
  await runPrivileged(client, script, sudo, undefined, 60000)
}

export async function javaRemove(client: Client, sudo: Sudo, line: number, log: (s: string) => void): Promise<void> {
  const n = checkLine(line)
  const script = `${PATH_EXPORT}
set -e
${PM}
if [ "$PM" = apt-get ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get remove -y "openjdk-${n}-jdk*" "openjdk-${n}-jre*"
elif [ -n "$PM" ]; then "$PM" remove -y "java-${n === 8 ? '1.8.0' : n}-openjdk*"
else echo "No supported package manager found."; exit 40
fi
echo; echo "==> OpenJDK ${n} removed"`
  await runPrivileged(client, script, sudo, log, 10 * 60 * 1000)
}
