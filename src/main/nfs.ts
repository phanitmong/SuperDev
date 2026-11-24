// NFS: one server shares folders, others mount them and use the same files (shared uploads,
// media, a folder of reports). NFS version 4 only, so a single port (2049) is used.
//
// Shares made here live in /etc/exports.d/superdevops.exports; /etc/exports is read and shown
// but not changed. Mounts made here are /etc/fstab lines marked with a comment, mounted with
// "nofail" so a server that cannot reach its share still starts.
//
// NFS has no password and no encryption: access is decided by the client's address. So a share
// is only ever opened to listed addresses, never to everyone, and is meant for a private network.
import type { Client } from 'ssh2'
import type { NfsMount, NfsOverview, NfsOwner, NfsShare } from '@shared/types'
import type { Sudo } from './deploy'
import { PATH_EXPORT, checkServerPath, runPrivileged } from './deploy'
import { shq } from './ssh'

const EXPORTS = '/etc/exports.d/superdevops.exports'
const MARK = '# superdevops-nfs'
const FW = 'superdevops-nfs'
const RE_IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const RE_HOST = /^[A-Za-z0-9.-]{1,253}$/

/** Folders that must never be shared or mounted over: the system, and the app's own secrets. */
const NEVER = [/^\/(etc|root|boot|proc|sys|dev|run|bin|sbin|lib|lib64|usr|var|tmp|home|srv|opt|mnt|media)$/, /^\/(etc|root|boot|proc|sys|dev|run)\//, /^\/var\/lib\/superdevops/, /^\/var\/lib\/(mysql|postgresql|mongodb|docker|redis)(\/|$)/]

function checkFolder(input: string, label: string): string {
  const p = checkServerPath(input, label, true)
  if (p === '/' || NEVER.some((r) => r.test(p))) throw new Error(`${label}: "${p}" holds the system or a database's own files. Choose a folder of your own, such as /www/shared.`)
  return p
}

/** A client address: one IPv4 address or a range. Everyone (*, 0.0.0.0/0) is refused: NFS trusts addresses only. */
export function checkClient(input: string): string {
  const c = String(input ?? '').trim()
  const [ip, bits, extra] = c.split('/')
  if (extra !== undefined || !RE_IPV4.test(ip ?? '')) throw new Error(`"${c}" is not an IPv4 address or range such as 10.0.0.5 or 10.0.0.0/24.`)
  if (bits !== undefined) {
    const n = Number(bits)
    if (!/^\d{1,2}$/.test(bits) || n > 32) throw new Error(`"${c}" has a range that is not a number from 8 to 32.`)
    if (n < 8) throw new Error(`"${c}" is too wide. NFS has no password: list your servers' addresses, or a private range such as 10.0.0.0/16.`)
  }
  if (ip === '0.0.0.0') throw new Error('Sharing with every address is not allowed. NFS has no password: list your servers\' addresses.')
  return bits === undefined || bits === '32' ? ip : `${ip}/${Number(bits)}`
}

export function isPrivate(ip: string): boolean {
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)
}

function exportLine(s: NfsShare, webUid: string, webGid: string): string {
  const opts = [s.readOnly ? 'ro' : 'rw', 'sync', 'no_subtree_check', 'secure']
  if (s.owner === 'web') opts.push('all_squash', `anonuid=${webUid}`, `anongid=${webGid}`)
  else if (s.owner === 'root') opts.push('no_root_squash')
  else opts.push('root_squash')
  return `${s.path} ${s.clients.map((c) => `${c}(${opts.join(',')})`).join(' ')}`
}

function parseExport(line: string): NfsShare | null {
  const m = /^(\/\S*)\s+(.+)$/.exec(line.trim())
  if (!m) return null
  const clients: string[] = []
  let opts = ''
  for (const part of m[2].trim().split(/\s+/)) {
    const c = /^([^(\s]+)\(([^)]*)\)$/.exec(part)
    if (!c) continue
    clients.push(c[1])
    opts = c[2]
  }
  const o = opts.split(',')
  const owner: NfsOwner = o.includes('all_squash') ? 'web' : o.includes('no_root_squash') ? 'root' : 'keep'
  return { path: m[1], clients, readOnly: o.includes('ro'), owner }
}

const DETECT = `${PATH_EXPORT}
export LC_ALL=C
if command -v apt-get >/dev/null 2>&1; then PM=apt; elif command -v dnf >/dev/null 2>&1; then PM=dnf; elif command -v yum >/dev/null 2>&1; then PM=yum; else PM=none; fi
nfs_unit() { for u in nfs-server nfs-kernel-server; do systemctl list-unit-files "$u.service" 2>/dev/null | grep -q "^$u" && { echo "$u"; return; }; done; echo nfs-server; }
`

export async function overview(client: Client, sudo: Sudo): Promise<NfsOverview> {
  const script = `${DETECT}
if command -v exportfs >/dev/null 2>&1; then echo "@@server=1"; else echo "@@server=0"; fi
if command -v mount.nfs4 >/dev/null 2>&1 || command -v mount.nfs >/dev/null 2>&1; then echo "@@client=1"; else echo "@@client=0"; fi
U=$(nfs_unit); if systemctl is-active --quiet "$U" 2>/dev/null; then echo "@@running=1"; else echo "@@running=0"; fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then echo "@@fw=ufw"; elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then echo "@@fw=firewalld"; else echo "@@fw=none"; fi
echo "@@addr=$(hostname -I 2>/dev/null)"
echo "@@ours"; [ -f ${EXPORTS} ] && grep -v '^\\s*#' ${EXPORTS} | grep -v '^\\s*$'
echo "@@other"; for f in /etc/exports /etc/exports.d/*.exports; do [ -f "$f" ] && [ "$f" != ${EXPORTS} ] && grep -v '^\\s*#' "$f" | grep -v '^\\s*$'; done
echo "@@fstab"; awk -v m=${shq(MARK)} 'prev == m { print } { prev = $0 }' /etc/fstab
echo "@@mounted"; awk '$3 ~ /^nfs/ { print $2 }' /proc/mounts
echo "@@usage"; awk '$3 ~ /^nfs/ { print $2 }' /proc/mounts | while read -r d; do df -B1 --output=size,used "$d" 2>/dev/null | tail -1 | sed "s|^|$d |"; done
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
  const mounted = new Set(sec.mounted ?? [])
  const usage = new Map<string, { size: number; used: number }>()
  for (const line of sec.usage ?? []) {
    const [d, size, used] = line.trim().split(/\s+/)
    usage.set(d, { size: Number(size) || 0, used: Number(used) || 0 })
  }
  const mounts: NfsMount[] = []
  for (const line of sec.fstab ?? []) {
    const [src, local, , opts] = line.trim().split(/\s+/)
    const i = src?.lastIndexOf(':') ?? -1
    if (!src || i < 1 || !local) continue
    const u = usage.get(local)
    mounts.push({ server: src.slice(0, i), remote: src.slice(i + 1), local, readOnly: (opts ?? '').split(',').includes('ro'), mounted: mounted.has(local), size: u?.size, used: u?.used })
  }
  const addresses = (kv.addr ?? '').split(/\s+/).filter((a) => RE_IPV4.test(a))
  addresses.sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)))
  return {
    serverInstalled: kv.server === '1',
    serverRunning: kv.running === '1',
    clientInstalled: kv.client === '1',
    shares: (sec.ours ?? []).map(parseExport).filter((s): s is NfsShare => !!s),
    otherExports: sec.other ?? [],
    mounts,
    addresses,
    firewall: kv.fw === 'ufw' ? 'ufw' : kv.fw === 'firewalld' ? 'firewalld' : 'none'
  }
}

/** Install what sharing (server) or mounting (client) needs, and start the NFS server. */
export async function install(client: Client, sudo: Sudo, role: 'server' | 'client', log: (s: string) => void): Promise<void> {
  const script = `${DETECT}
set -e
export DEBIAN_FRONTEND=noninteractive
case "$PM" in
  apt) apt-get update -qq; apt-get install -y -qq ${role === 'server' ? 'nfs-kernel-server' : 'nfs-common'} ;;
  dnf|yum) $PM install -y -q nfs-utils ;;
  *) echo "This server has neither apt nor dnf: install NFS by hand."; exit 2 ;;
esac
${
  role === 'server'
    ? `mkdir -p /etc/exports.d
U=$(nfs_unit)
systemctl enable --now "$U" >/dev/null 2>&1 || systemctl restart "$U"
systemctl is-active --quiet "$U" || { echo "The NFS server did not start. The server's own log says:"; journalctl -u "$U" -n 15 --no-pager 2>/dev/null | tail -n 15; exit 3; }
echo "NFS server installed and running."`
    : 'echo "NFS client installed. This server can now mount shared folders."'
}`
  await runPrivileged(client, script, sudo, log, 10 * 60 * 1000)
}

/**
 * Lines that open port 2049 for exactly the listed clients. Only rules this app made are removed:
 * ufw rules carry a comment; firewalld rules cannot, so the addresses opened last time are kept in a list.
 */
function firewallLines(clients: string[]): string {
  const list = clients.map(shq).join(' ')
  return `
FWLIST=/etc/exports.d/.superdevops-firewall
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  for n in $(ufw status numbered | sed -n 's/^\\[ *\\([0-9]*\\)\\].*${FW}.*/\\1/p' | sort -rn); do ufw --force delete "$n" >/dev/null 2>&1; done
  for c in ${list}; do ufw allow from "$c" to any port 2049 proto tcp comment '${FW}' >/dev/null && echo "Firewall: port 2049 is open to $c."; done
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  [ -f "$FWLIST" ] && while read -r c; do [ -n "$c" ] && firewall-cmd --permanent --remove-rich-rule="rule family=ipv4 source address=$c port port=2049 protocol=tcp accept" >/dev/null 2>&1; done < "$FWLIST"
  for c in ${list}; do firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=$c port port=2049 protocol=tcp accept" >/dev/null && echo "Firewall: port 2049 is open to $c."; done
  firewall-cmd --reload >/dev/null
fi
printf '%s\\n' ${list || "''"} | grep . > "$FWLIST" || rm -f "$FWLIST"
echo "If this server is in a cloud (AWS, Tencent, Alibaba…), also allow TCP 2049 from these servers in its security group."`
}

/** Write every share of this server at once, load them, and open the firewall for exactly their clients. */
export async function saveShares(client: Client, sudo: Sudo, input: NfsShare[], log: (s: string) => void): Promise<void> {
  if (input.length > 50) throw new Error('At most 50 shared folders.')
  const seen = new Set<string>()
  const shares: NfsShare[] = input.map((s) => {
    const path = checkFolder(s.path, 'Folder')
    if (seen.has(path)) throw new Error(`${path} is listed twice.`)
    seen.add(path)
    const clients = [...new Set((s.clients ?? []).map(checkClient))]
    if (clients.length === 0) throw new Error(`${path}: list at least one server that may use it.`)
    if (clients.length > 50) throw new Error(`${path}: at most 50 addresses.`)
    const owner: NfsOwner = s.owner === 'web' || s.owner === 'root' ? s.owner : 'keep'
    return { path, clients, readOnly: s.readOnly === true, owner }
  })
  const allClients = [...new Set(shares.flatMap((s) => s.clients))]
  const script = `${DETECT}
set -e
command -v exportfs >/dev/null 2>&1 || { echo "The NFS server is not installed. Install it first."; exit 2; }
WEBU=$(id -u www-data 2>/dev/null || id -u nginx 2>/dev/null || id -u apache 2>/dev/null || echo 65534)
WEBG=$(id -g www-data 2>/dev/null || id -g nginx 2>/dev/null || id -g apache 2>/dev/null || echo 65534)
${shares.map((s) => `[ -d ${shq(s.path)} ] || { mkdir -p ${shq(s.path)}; echo "Made the folder ${s.path}."; }${s.owner === 'web' ? `; chown "$WEBU:$WEBG" ${shq(s.path)}` : ''}`).join('\n')}
mkdir -p /etc/exports.d
OLD=$(mktemp); [ -f ${EXPORTS} ] && cp ${EXPORTS} "$OLD"
cat > ${EXPORTS} <<EXP
# Managed by Apsara Panel. Shares are changed from the app; this file is rewritten.
${shares.map((s) => exportLine(s, '$WEBU', '$WEBG')).join('\n')}
EXP
${shares.length === 0 ? `rm -f ${EXPORTS}` : ''}
if ! OUT=$(exportfs -ra 2>&1); then
  echo "The NFS server refused the shares: $OUT"
  if [ -s "$OLD" ]; then cp "$OLD" ${EXPORTS}; else rm -f ${EXPORTS}; fi
  exportfs -ra >/dev/null 2>&1 || true
  rm -f "$OLD"; exit 4
fi
rm -f "$OLD"
[ -n "$OUT" ] && echo "$OUT"
echo "Shares loaded: ${shares.length}."
${firewallLines(allClients)}
true`
  await runPrivileged(client, script, sudo, log, 120000)
}

/** Mount a folder another server shares, now and after every restart. */
export async function addMount(client: Client, sudo: Sudo, m: { server: string; remote: string; local: string; readOnly: boolean }, log: (s: string) => void): Promise<void> {
  const server = String(m.server ?? '').trim()
  if (!RE_HOST.test(server) || server.startsWith('-')) throw new Error('Server: an address such as 10.0.0.5 or a host name.')
  const remote = checkServerPath(m.remote, 'Shared folder', false)
  const local = checkFolder(m.local, 'Folder on this server')
  const opts = [m.readOnly ? 'ro' : 'rw', 'nfsvers=4.2', 'hard', 'timeo=600', 'retrans=2', 'noatime', '_netdev', 'nofail']
  const line = `${server}:${remote} ${local} nfs4 ${opts.join(',')} 0 0`
  const script = `${DETECT}
set -e
command -v mount.nfs4 >/dev/null 2>&1 || command -v mount.nfs >/dev/null 2>&1 || { echo "The NFS client is not installed. Install it first."; exit 2; }
if awk '{print $2}' /proc/mounts | grep -qx ${shq(local)}; then echo "Something is already mounted at ${local}."; exit 3; fi
if awk -v m=${shq(MARK)} 'prev == m { print $2 } { prev = $0 }' /etc/fstab | grep -qx ${shq(local)}; then echo "${local} is already in the list of shared folders."; exit 3; fi
mkdir -p ${shq(local)}
if [ -n "$(ls -A ${shq(local)} 2>/dev/null)" ]; then echo "${local} is not empty. Its files would be hidden under the shared folder; choose an empty or new folder."; exit 3; fi
echo "Mounting ${server}:${remote} at ${local}…"
if ! OUT=$(timeout 30 mount -t nfs4 -o ${shq(opts.filter((o) => o !== '_netdev' && o !== 'nofail').join(','))} ${shq(`${server}:${remote}`)} ${shq(local)} 2>&1); then
  echo "Could not mount: $OUT"
  case "$OUT" in
    *"access denied"*|*"Permission denied"*) echo "The other server does not share ${remote} with this server's address. Add it on that server's NFS page.";;
    *"No such file"*) echo "The other server does not share ${remote}. Check the folder name on its NFS page.";;
    *"unknown filesystem"*|*"wrong fs type"*|*"bad option"*) echo "This server cannot mount NFS yet. Install the NFS client on this page, then try again (a container server may not support NFS at all).";;
    *) echo "This server cannot reach ${server} on port 2049. Check that the NFS server runs there and that both firewalls (and the cloud's security group) allow it.";;
  esac
  exit 5
fi
cp /etc/fstab /etc/fstab.superdevops-bak
printf '%s\\n%s\\n' ${shq(MARK)} ${shq(line)} >> /etc/fstab
systemctl daemon-reload >/dev/null 2>&1 || true
echo "Mounted. It comes back by itself after a restart."
df -h ${shq(local)} | tail -1`
  await runPrivileged(client, script, sudo, log, 120000)
}

/** Unmount and forget a shared folder. The files stay on the server that shares them. */
export async function removeMount(client: Client, sudo: Sudo, localInput: string, log: (s: string) => void): Promise<void> {
  const local = checkFolder(localInput, 'Folder on this server')
  const script = `${DETECT}
set -e
if awk '{print $2}' /proc/mounts | grep -qx ${shq(local)}; then
  if ! OUT=$(umount ${shq(local)} 2>&1); then
    case "$OUT" in *busy*) echo "${local} is in use (a program or terminal is inside it). Stop that, or restart the server, then try again."; exit 3;; esac
    echo "Could not unmount: $OUT"; exit 3
  fi
  echo "Unmounted ${local}."
fi
cp /etc/fstab /etc/fstab.superdevops-bak
awk -v m=${shq(MARK)} -v d=${shq(local)} '
  $0 == m { held = $0; next }
  held != "" { split($0, f, /[ \\t]+/); if (f[2] == d) { held = ""; next } print held; held = "" }
  { print }
  END { if (held != "") print held }' /etc/fstab.superdevops-bak > /etc/fstab.superdevops-new
cat /etc/fstab.superdevops-new > /etc/fstab
rm -f /etc/fstab.superdevops-new
systemctl daemon-reload >/dev/null 2>&1 || true
rmdir ${shq(local)} 2>/dev/null && echo "Removed the empty folder ${local}." || true
echo "Done. The files are still on the server that shares them."`
  await runPrivileged(client, script, sudo, log, 60000)
}

/** Mount again a shared folder that is in the list but not mounted (the other server was down, for example). */
export async function remount(client: Client, sudo: Sudo, localInput: string, log: (s: string) => void): Promise<void> {
  const local = checkFolder(localInput, 'Folder on this server')
  await runPrivileged(
    client,
    `${DETECT}
if awk '{print $2}' /proc/mounts | grep -qx ${shq(local)}; then echo "Already mounted."; exit 0; fi
if OUT=$(timeout 30 mount ${shq(local)} 2>&1); then echo "Mounted ${local}."; df -h ${shq(local)} | tail -1; else echo "Could not mount: $OUT"; exit 5; fi`,
    sudo,
    log,
    60000
  )
}

/** Can the client server open a connection to this address on the NFS port? */
async function reaches(client: Client, sudo: Sudo, addr: string): Promise<boolean> {
  const res = await runPrivileged(client, `if timeout 6 bash -c ${shq(`</dev/tcp/${addr}/2049`)} 2>/dev/null; then echo "@@ok"; fi; true`, sudo, undefined, 20000)
  return res.stdout.includes('@@ok')
}

function sameNet(a: string, b: string): boolean {
  return a.split('.').slice(0, 2).join('.') === b.split('.').slice(0, 2).join('.')
}

export interface JoinSide {
  client: Client
  sudo: Sudo
  name: string
  /** The address the app uses to reach this server over SSH. */
  host: string
}

/**
 * Connect one server to a folder another server shares, in one go: install what is missing on both,
 * share the folder with the client's address, open the firewall, then mount it on the client.
 * A private network is used when both servers are on one; the public internet only when allowed.
 */
export async function join(opts: { share: JoinSide; user: JoinSide; path: string; local: string; readOnly: boolean; owner: NfsOwner; allowPublic: boolean; log: (s: string) => void }): Promise<void> {
  const { share, user, log } = opts
  const path = checkFolder(opts.path, 'Shared folder')
  const local = checkFolder(opts.local, 'Folder on the other server')
  log(`Checking ${share.name} and ${user.name}…\n`)
  let [a, b] = await Promise.all([overview(share.client, share.sudo), overview(user.client, user.sudo)])
  if (b.mounts.some((m) => m.local === local)) throw new Error(`${user.name} already has a shared folder at ${local}.`)
  if (!a.serverInstalled || !a.serverRunning) {
    log(`\nInstalling the NFS server on ${share.name}…\n`)
    await install(share.client, share.sudo, 'server', log)
  }
  if (!b.clientInstalled) {
    log(`\nInstalling the NFS client on ${user.name}…\n`)
    await install(user.client, user.sudo, 'client', log)
  }
  a = await overview(share.client, share.sudo)
  b = await overview(user.client, user.sudo)

  // Ways to connect, best first: the two servers' private addresses on the same network, then the public ones.
  type Route = { serverAddr: string; clientAddr: string; private: boolean }
  const routes: Route[] = []
  const aPriv = a.addresses.filter(isPrivate)
  const bPriv = b.addresses.filter(isPrivate)
  for (const sa of aPriv) for (const ca of bPriv) if (sameNet(sa, ca)) routes.push({ serverAddr: sa, clientAddr: ca, private: true })
  for (const sa of aPriv) for (const ca of bPriv) if (!sameNet(sa, ca)) routes.push({ serverAddr: sa, clientAddr: ca, private: true })
  if (opts.allowPublic) {
    const aPub = RE_IPV4.test(share.host) ? share.host : a.addresses.find((x) => !isPrivate(x))
    const bPub = RE_IPV4.test(user.host) ? user.host : b.addresses.find((x) => !isPrivate(x))
    if (aPub && bPub) routes.push({ serverAddr: aPub, clientAddr: bPub, private: false })
  }
  if (routes.length === 0) {
    throw new Error(
      opts.allowPublic
        ? 'Could not find addresses for the two servers. Add the share and the mount by hand on each server\'s NFS page.'
        : `${share.name} and ${user.name} are not on a private network together. NFS sends files without encryption, so the public internet is only used when you allow it.`
    )
  }

  const before = a.shares
  let chosen: Route | null = null
  for (const r of routes.slice(0, 6)) {
    log(`\nTrying ${r.private ? 'the private network' : 'the public internet'}: ${user.name} (${r.clientAddr}) → ${share.name} (${r.serverAddr})…\n`)
    const shares = before.map((s) => ({ ...s, clients: [...s.clients] }))
    const mine = shares.find((s) => s.path === path)
    if (mine) {
      if (!mine.clients.includes(r.clientAddr)) mine.clients.push(r.clientAddr)
    } else shares.push({ path, clients: [r.clientAddr], readOnly: opts.readOnly, owner: opts.owner })
    await saveShares(share.client, share.sudo, shares, log)
    if (await reaches(user.client, user.sudo, r.serverAddr)) {
      chosen = r
      break
    }
    log(`${user.name} cannot reach ${r.serverAddr} on port 2049.\n`)
    await saveShares(share.client, share.sudo, before, () => undefined)
  }
  if (!chosen) {
    throw new Error(`${user.name} cannot reach ${share.name} on port 2049. If they are in a cloud, allow TCP 2049 between them in the security group, then try again.${opts.allowPublic ? '' : ' If they share no private network, allow the public internet.'}`)
  }
  log(`\nMounting on ${user.name}…\n`)
  try {
    await addMount(user.client, user.sudo, { server: chosen.serverAddr, remote: path, local, readOnly: opts.readOnly }, log)
  } catch (err) {
    log('\nPutting the shares back the way they were…\n')
    await saveShares(share.client, share.sudo, before, () => undefined).catch(() => undefined)
    throw err
  }
  log(`\nDone. ${user.name} uses ${share.name}:${path} at ${local}.${chosen.private ? '' : ' Files travel over the public internet without encryption.'}\n`)
}
