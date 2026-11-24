// Node.js versions and Composer.
//
// Node.js: official builds from nodejs.org, unpacked side by side under
// /opt/superdevops/node/<version>. One of them is the default: the commands
// node, npm, npx and corepack in /usr/local/bin point at it.
//
// Composer: the official composer.phar in /usr/local/bin/composer.
//
// Every download is checked against the checksum the publisher lists.
import type { Client } from 'ssh2'
import type { ComposerOverview, NodeOverview } from '@shared/types'
import type { Sudo } from './deploy'
import { PATH_EXPORT, runPrivileged } from './deploy'
import { exec, shq, wrapScript } from './ssh'

/** The release lines offered for install. */
export const NODE_LINES = [24, 22, 20, 18]

const ROOT = '/opt/superdevops/node'
const BIN = '/usr/local/bin'
const TOOLS = ['node', 'npm', 'npx', 'corepack']
// Overridable so tests can stand in for the download sites.
const NODE_DIST = (): string => (process.env.SUPERDEVOPS_NODE_DIST || 'https://nodejs.org/dist').replace(/\/+$/, '')
const COMPOSER_DIST = (): string => (process.env.SUPERDEVOPS_COMPOSER_DIST || 'https://getcomposer.org').replace(/\/+$/, '')
const RE_VERSION = /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/

export async function nodeOverview(client: Client): Promise<NodeOverview> {
  const script = `${PATH_EXPORT}
case "$(uname -m)" in x86_64|amd64) echo "@@arch=x64" ;; aarch64|arm64) echo "@@arch=arm64" ;; *) echo "@@arch=" ;; esac
echo "@@versions"; ls -1 ${ROOT} 2>/dev/null | grep -E '^v[0-9]+\\.[0-9]+\\.[0-9]+$' | sort -t. -k1.2,1n -k2,2n -k3,3n
echo "@@current"; basename "$(readlink ${ROOT}/current 2>/dev/null)" 2>/dev/null
echo "@@which"; W=$(command -v node 2>/dev/null); echo "$W"; [ -n "$W" ] && readlink -f "$W"
echo "@@running"; node -v 2>/dev/null
echo "@@npm"; npm -v 2>/dev/null
echo "@@end"`
  const res = await exec(client, wrapScript(script), { timeoutMs: 30000 })
  const sec: Record<string, string[]> = {}
  let cur = ''
  for (const line of res.stdout.split('\n')) {
    const kv = /^@@arch=(.*)$/.exec(line)
    if (kv) sec.arch = [kv[1]]
    else if (line.startsWith('@@')) { cur = line.slice(2); sec[cur] = [] } // prettier-ignore
    else if (cur && line.trim()) sec[cur].push(line.trim())
  }
  const versions = (sec.versions ?? []).filter((v) => RE_VERSION.test(v)).reverse()
  const current = RE_VERSION.test(sec.current?.[0] ?? '') ? sec.current[0] : ''
  const real = sec.which?.[1] ?? ''
  return {
    supported: !!sec.arch?.[0],
    arch: sec.arch?.[0] ?? '',
    versions,
    current,
    running: sec.running?.[0] ?? '',
    npm: sec.npm?.[0] ?? '',
    // A node that was put there some other way (apt, nvm, by hand) and is the one that answers.
    foreign: !!sec.which?.[0] && !real.startsWith(`${ROOT}/`) ? (sec.which[0] ?? '') : '',
    lines: NODE_LINES
  }
}

/** Shell that makes VERSION the default: the commands in /usr/local/bin point at it. */
const LINK = `
ln -sfn "${ROOT}/$VERSION" ${ROOT}/current
for t in ${TOOLS.join(' ')}; do
  if [ -e "${ROOT}/current/bin/$t" ]; then ln -sfn "${ROOT}/current/bin/$t" "${BIN}/$t"; fi
done
hash -r 2>/dev/null || true
echo "==> The default is now Node.js $("${BIN}/node" -v 2>/dev/null || echo "$VERSION")"`

/** Download the newest build of one release line and unpack it next to the others. */
export async function nodeInstall(client: Client, sudo: Sudo, line: number, log: (s: string) => void): Promise<void> {
  if (!NODE_LINES.includes(Number(line))) throw new Error(`Choose one of these Node.js versions: ${NODE_LINES.join(', ')}.`)
  const script = `${PATH_EXPORT}
set -e
case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "Node.js builds exist for 64-bit Intel/AMD and ARM servers; this one is $(uname -m)."; exit 41 ;; esac
command -v curl >/dev/null 2>&1 || { echo "curl is not installed on this server. Install it first (apt install curl)."; exit 42; }
BASE=${shq(NODE_DIST())}/latest-v${Number(line)}.x
echo "==> Looking up the newest Node.js ${Number(line)}"
SUMS=$(curl -fsSL --max-time 60 "$BASE/SHASUMS256.txt") || { echo "Could not reach the Node.js download site from this server."; exit 43; }
ROW=$(echo "$SUMS" | grep -E "  node-v[0-9.]+-linux-$ARCH\\.tar\\.gz$" | head -1)
FILE=$(echo "$ROW" | awk '{print $2}'); WANT=$(echo "$ROW" | awk '{print $1}')
[ -n "$FILE" ] && [ -n "$WANT" ] || { echo "No Linux $ARCH build is listed for Node.js ${Number(line)}."; exit 44; }
VERSION=$(echo "$FILE" | sed -n 's/^node-\\(v[0-9.]*\\)-linux-.*$/\\1/p')
echo "$VERSION" | grep -Eq '^v[0-9]+\\.[0-9]+\\.[0-9]+$' || { echo "Unexpected file name: $FILE"; exit 44; }
mkdir -p ${ROOT}
if [ -x "${ROOT}/$VERSION/bin/node" ]; then
  echo "==> Node.js $VERSION is already installed"
else
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  echo "==> Downloading $FILE"
  curl -fsSL --max-time 900 -o "$TMP/$FILE" "$BASE/$FILE" || { echo "The download failed."; exit 45; }
  GOT=$(sha256sum "$TMP/$FILE" | awk '{print $1}')
  [ "$GOT" = "$WANT" ] || { echo "The downloaded file does not match the checksum published by Node.js, so it was not installed."; exit 46; }
  echo "==> Checksum matches. Unpacking"
  mkdir -p "$TMP/x" && tar -xzf "$TMP/$FILE" -C "$TMP/x" --strip-components=1
  [ -x "$TMP/x/bin/node" ] || { echo "The archive does not contain node."; exit 47; }
  rm -rf "${ROOT}/$VERSION.new"; mv "$TMP/x" "${ROOT}/$VERSION.new"; chown -R root:root "${ROOT}/$VERSION.new"; chmod 755 "${ROOT}/$VERSION.new"
  mv "${ROOT}/$VERSION.new" "${ROOT}/$VERSION"
  echo "==> Installed Node.js $VERSION in ${ROOT}/$VERSION"
fi
if [ ! -e ${ROOT}/current ]; then
${LINK}
else
  echo "The default stays $(basename "$(readlink ${ROOT}/current)"). Use \\"Make default\\" to switch."
fi`
  await runPrivileged(client, script, sudo, log, 20 * 60 * 1000)
}

export async function nodeUse(client: Client, sudo: Sudo, version: string): Promise<void> {
  if (!RE_VERSION.test(String(version))) throw new Error('Unknown Node.js version.')
  const script = `${PATH_EXPORT}
set -e
VERSION=${shq(version)}
[ -x "${ROOT}/$VERSION/bin/node" ] || { echo "Node.js $VERSION is not installed."; exit 48; }
${LINK}`
  await runPrivileged(client, script, sudo, undefined, 60000)
}

export async function nodeRemove(client: Client, sudo: Sudo, version: string): Promise<void> {
  if (!RE_VERSION.test(String(version))) throw new Error('Unknown Node.js version.')
  const script = `${PATH_EXPORT}
set -e
VERSION=${shq(version)}
[ -d "${ROOT}/$VERSION" ] || { echo "Node.js $VERSION is not installed."; exit 48; }
CUR=$(basename "$(readlink ${ROOT}/current 2>/dev/null)" 2>/dev/null || true)
OTHERS=$(ls -1 ${ROOT} | grep -E '^v[0-9]+\\.[0-9]+\\.[0-9]+$' | grep -vx "$VERSION" | wc -l)
if [ "$CUR" = "$VERSION" ] && [ "$OTHERS" -gt 0 ]; then
  echo "Node.js $VERSION is the default. Make another version the default first."; exit 49
fi
rm -rf "${ROOT}/$VERSION"
if [ "$CUR" = "$VERSION" ]; then
  # It was the only one: take the commands away too, but only the ones that are ours.
  for t in ${TOOLS.join(' ')}; do
    case "$(readlink "${BIN}/$t" 2>/dev/null)" in ${ROOT}/*) unlink "${BIN}/$t" ;; esac
  done
  unlink ${ROOT}/current
fi
echo removed`
  await runPrivileged(client, script, sudo, undefined, 120000)
}

// ---- Composer ---------------------------------------------------------------

export async function composerOverview(client: Client): Promise<ComposerOverview> {
  const script = `${PATH_EXPORT}
echo "@@php=$(php -r 'echo PHP_VERSION;' 2>/dev/null)"
P=$(command -v composer 2>/dev/null)
echo "@@path=$P"
[ -n "$P" ] && echo "@@version=$(COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_HOME=/tmp/.sd-composer composer --version --no-ansi 2>/dev/null | head -1)"
true`
  const res = await exec(client, wrapScript(script), { timeoutMs: 40000 })
  const kv: Record<string, string> = {}
  for (const line of res.stdout.split('\n')) {
    const m = /^@@(\w+)=(.*)$/.exec(line)
    if (m) kv[m[1]] = m[2].trim()
  }
  return {
    installed: !!kv.path,
    path: kv.path ?? '',
    version: /(\d+\.\d+\.\d+[\w.-]*)/.exec(kv.version ?? '')?.[1] ?? '',
    php: kv.php ?? ''
  }
}

/** Install Composer, or replace it with the newest stable release. */
export async function composerInstall(client: Client, sudo: Sudo, log: (s: string) => void): Promise<void> {
  const script = `${PATH_EXPORT}
set -e
command -v php >/dev/null 2>&1 || { echo "Composer needs PHP, and PHP is not installed on this server. Install PHP first (App Store, PHP)."; exit 51; }
command -v curl >/dev/null 2>&1 || { echo "curl is not installed on this server. Install it first (apt install curl)."; exit 42; }
BASE=${shq(COMPOSER_DIST())}/download/latest-stable
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
echo "==> Downloading the newest stable Composer"
curl -fsSL --max-time 300 -o "$TMP/composer.phar" "$BASE/composer.phar" || { echo "Could not reach the Composer download site from this server."; exit 52; }
WANT=$(curl -fsSL --max-time 60 "$BASE/composer.phar.sha256sum" | awk '{print $1}') || { echo "Could not read Composer's checksum."; exit 52; }
GOT=$(sha256sum "$TMP/composer.phar" | awk '{print $1}')
[ -n "$WANT" ] && [ "$GOT" = "$WANT" ] || { echo "The downloaded file does not match the checksum published by Composer, so it was not installed."; exit 53; }
echo "==> Checksum matches"
COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_HOME="$TMP/home" php "$TMP/composer.phar" --version --no-ansi >/dev/null 2>&1 || { echo "The downloaded Composer does not run with this server's PHP ($(php -r 'echo PHP_VERSION;'))."; exit 54; }
install -m 755 -o root -g root "$TMP/composer.phar" ${BIN}/composer
echo "==> $(COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_HOME="$TMP/home" ${BIN}/composer --version --no-ansi 2>/dev/null | head -1) is installed as ${BIN}/composer"`
  await runPrivileged(client, script, sudo, log, 10 * 60 * 1000)
}

export async function composerRemove(client: Client, sudo: Sudo): Promise<void> {
  const script = `${PATH_EXPORT}
P=$(command -v composer 2>/dev/null)
[ -n "$P" ] || { echo "Composer is not installed."; exit 55; }
case "$P" in ${BIN}/composer|/usr/bin/composer) ;; *) echo "Composer is at $P, which this app did not put there. Remove it by hand if you mean to."; exit 56 ;; esac
if [ "$P" = /usr/bin/composer ] && command -v dpkg >/dev/null 2>&1 && dpkg -S /usr/bin/composer >/dev/null 2>&1; then
  echo "This Composer came from the system's packages. Remove it with: apt remove composer"; exit 57
fi
unlink "$P" && echo removed`
  await runPrivileged(client, script, sudo, undefined, 60000)
}
