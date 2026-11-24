// System firewall (ufw or firewalld) and the nginx-level firewall
// (IP blocklist + request rate limit).
import type { Client } from 'ssh2'
import type { FirewallRule, FirewallRuleInput, FirewallStatus, NginxFirewall } from '@shared/types'
import type { Sudo } from './deploy'
import { PATH_EXPORT, isIp, preflight, runPrivileged } from './deploy'
import { exec, shq } from './ssh'

const HEAD = `export LC_ALL=C\n${PATH_EXPORT}`

/** The port sshd answered on for the session this app is using. */
async function sessionSshPort(client: Client, fallback: number): Promise<number> {
  const res = await exec(client, 'echo "$SSH_CONNECTION"', { timeoutMs: 10000 })
  const port = Number(res.stdout.trim().split(/\s+/)[3])
  return Number.isInteger(port) && port > 0 ? port : fallback
}

export function parseUfw(text: string): { active: boolean; rules: FirewallRule[] } {
  const active = /^Status:\s*active/m.test(text)
  const rules: FirewallRule[] = []
  for (const line of text.split('\n')) {
    const m = /^\[\s*(\d+)\]\s+(.+?)\s{2,}((?:ALLOW|DENY|REJECT|LIMIT)(?:\s+(?:IN|OUT|FWD))?)\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const rule = { to: m[2].trim(), action: m[3].replace(/\s+/g, ' '), from: m[4].trim() }
    // The id carries the rule text, so a delete can confirm it still targets the same rule.
    rules.push({ id: `ufw:${m[1]}:${rule.to}|${rule.action}|${rule.from}`, ...rule })
  }
  return { active, rules }
}

export async function status(client: Client, sudo: Sudo, projectPort: number): Promise<FirewallStatus> {
  const sshPort = await sessionSshPort(client, projectPort)
  const script = `${HEAD}
PM=""; for p in apt-get dnf yum; do if command -v "$p" >/dev/null 2>&1; then PM="$p"; break; fi; done
echo "@@pm"; echo "$PM"
if command -v ufw >/dev/null 2>&1; then
  echo "@@kind"; echo ufw
  echo "@@ufw"; ufw status numbered
elif command -v firewall-cmd >/dev/null 2>&1; then
  echo "@@kind"; echo firewalld
  echo "@@state"; firewall-cmd --state 2>&1 || true
  echo "@@ports"; firewall-cmd --list-ports 2>/dev/null || true
  echo "@@services"; firewall-cmd --list-services 2>/dev/null || true
  echo "@@rich"; firewall-cmd --list-rich-rules 2>/dev/null || true
else
  echo "@@kind"; echo none
fi`
  const res = await runPrivileged(client, script, sudo, undefined, 30000)
  const sections: Record<string, string> = {}
  let cur = ''
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('@@')) {
      cur = line.slice(2)
      sections[cur] = ''
    } else if (cur) sections[cur] += line + '\n'
  }
  const kind = (sections.kind ?? 'none').trim() as FirewallStatus['kind']
  const packageManager = (sections.pm ?? '').trim()
  if (kind === 'ufw') return { kind, sshPort, packageManager, ...parseUfw(sections.ufw ?? '') }
  if (kind === 'firewalld') {
    const rules: FirewallRule[] = []
    for (const p of (sections.ports ?? '').split(/\s+/).filter(Boolean)) rules.push({ id: `fwd:port:${p}`, to: p, action: 'ALLOW', from: 'Anywhere' })
    for (const s of (sections.services ?? '').split(/\s+/).filter(Boolean)) {
      rules.push({ id: `fwd:service:${s}`, to: `${s} (service)`, action: 'ALLOW', from: 'Anywhere' })
    }
    for (const r of (sections.rich ?? '').split('\n').filter((l) => l.trim())) {
      const src = /source address="([^"]+)"/.exec(r)?.[1] ?? ''
      rules.push({ id: `fwd:rich:${r.trim()}`, to: 'All ports', action: /drop|reject/.test(r) ? 'DENY' : 'RULE', from: src || r.trim() })
    }
    return { kind, sshPort, packageManager, active: /running/.test(sections.state ?? ''), rules }
  }
  return { kind: 'none', sshPort, packageManager, active: false, rules: [] }
}

function checkRule(rule: FirewallRuleInput, sshPort: number): { port: string; from: string } {
  const port = rule.port.trim().replace('-', ':')
  const from = rule.from.trim()
  if (port && !/^\d{1,5}(:\d{1,5})?$/.test(port)) throw new Error('Port must be a number like 80, or a range like 8000:8100.')
  const [a, b] = port ? port.split(':').map(Number) : [0, 0]
  if (port && (a < 1 || a > 65535 || (b !== undefined && (b < a || b > 65535)))) throw new Error('Port numbers must be between 1 and 65535.')
  if (from && !isIp(from, true)) throw new Error('"From" must be an IP address or a range like 203.0.113.0/24.')
  if (!port && !from) throw new Error('Enter a port, a source IP, or both.')
  if (!['allow', 'deny'].includes(rule.action) || !['tcp', 'udp', 'both'].includes(rule.proto)) throw new Error('Unknown rule type.')
  if (port.includes(':') && rule.proto === 'both') throw new Error('Choose TCP or UDP for a port range.')
  const coversSsh = port ? sshPort >= a && sshPort <= (b ?? a) : true
  if (rule.action === 'deny' && !from && coversSsh && rule.proto !== 'udp') {
    throw new Error(`That would block SSH (port ${sshPort}) for everyone, including this app. Not applied.`)
  }
  return { port, from }
}

export async function addRule(client: Client, sudo: Sudo, kind: FirewallStatus['kind'], rule: FirewallRuleInput, projectPort: number): Promise<void> {
  const sshPort = await sessionSshPort(client, projectPort)
  const { port, from } = checkRule(rule, sshPort)
  let cmd: string
  if (kind === 'ufw') {
    if (from) {
      cmd = `ufw ${rule.action === 'deny' ? 'insert 1 deny' : 'allow'} from ${from}`
      if (port) cmd += ` to any port ${port}${rule.proto !== 'both' ? ` proto ${rule.proto}` : ''}`
    } else {
      cmd = `ufw ${rule.action} ${port}${rule.proto !== 'both' ? `/${rule.proto}` : ''}`
    }
  } else if (kind === 'firewalld') {
    const protos = rule.proto === 'both' ? ['tcp', 'udp'] : [rule.proto]
    const fwPort = port.replace(':', '-')
    if (!from && rule.action === 'allow') {
      cmd = protos.map((p) => `firewall-cmd --permanent --add-port=${fwPort}/${p}`).join(' && ')
    } else {
      const family = from.includes(':') ? 'ipv6' : 'ipv4'
      const verb = rule.action === 'allow' ? 'accept' : 'drop'
      const targets = port ? protos.map((p) => ` port port="${fwPort}" protocol="${p}"`) : ['']
      if (!from) throw new Error('With firewalld, closing a port means removing its allow rule from the list.')
      cmd = targets.map((t) => `firewall-cmd --permanent --add-rich-rule=${shq(`rule family="${family}" source address="${from}"${t} ${verb}`)}`).join(' && ')
    }
    cmd += ' && firewall-cmd --reload'
  } else {
    throw new Error('No firewall is installed on this server.')
  }
  await runPrivileged(client, `${HEAD}\nset -e\n${cmd}`, sudo, undefined, 60000)
}

export async function deleteRule(client: Client, sudo: Sudo, id: string): Promise<void> {
  let script: string
  const ufw = /^ufw:(\d+):(.*)$/s.exec(id)
  if (ufw) {
    const [to, action, from] = ufw[2].split('|')
    // Rule numbers shift when rules change, so confirm the numbered line still matches before deleting.
    script = `set -e
LINE=$(ufw status numbered | grep -E '^\\[ *${ufw[1]}\\]' || true)
case "$LINE" in
  *${shq(to)}*${shq(action.split(' ')[0])}*${shq(from)}*) ufw --force delete ${ufw[1]} ;;
  *) echo "The rule list changed. Refresh and try again."; exit 3 ;;
esac`
  } else if (id.startsWith('fwd:port:') && /^fwd:port:\d{1,5}(-\d{1,5})?\/(tcp|udp)$/.test(id)) {
    script = `set -e\nfirewall-cmd --permanent --remove-port=${id.slice(9)}\nfirewall-cmd --reload`
  } else if (id.startsWith('fwd:service:') && /^fwd:service:[A-Za-z0-9_-]+$/.test(id)) {
    if (id === 'fwd:service:ssh') throw new Error('Removing the ssh service could lock this app out. Not applied.')
    script = `set -e\nfirewall-cmd --permanent --remove-service=${id.slice(12)}\nfirewall-cmd --reload`
  } else if (id.startsWith('fwd:rich:') && /^[A-Za-z0-9 ="./:_-]+$/.test(id.slice(9))) {
    script = `set -e\nfirewall-cmd --permanent --remove-rich-rule=${shq(id.slice(9))}\nfirewall-cmd --reload`
  } else {
    throw new Error('Unknown rule.')
  }
  await runPrivileged(client, `${HEAD}\n${script}`, sudo, undefined, 60000)
}

export async function setEnabled(client: Client, sudo: Sudo, kind: FirewallStatus['kind'], on: boolean, projectPort: number): Promise<void> {
  const sshPort = await sessionSshPort(client, projectPort)
  let script: string
  if (kind === 'ufw') {
    // Always keep SSH open before switching on, so this session and future logins survive.
    // The web ports are opened too: a server managed here is there to serve sites.
    script = on ? `ufw allow ${sshPort}/tcp\nufw allow 80/tcp comment 'superdevops-web'\nufw allow 443/tcp comment 'superdevops-web'\nufw --force enable` : 'ufw disable'
  } else if (kind === 'firewalld') {
    script = on
      ? `systemctl enable --now firewalld\nfirewall-cmd --permanent --add-port=${sshPort}/tcp\nfirewall-cmd --permanent --add-service=http --add-service=https\nfirewall-cmd --reload`
      : 'systemctl disable --now firewalld'
  } else {
    throw new Error('No firewall is installed on this server.')
  }
  await runPrivileged(client, `${HEAD}\nset -e\n${script}`, sudo, undefined, 60000)
}

export async function install(client: Client, sudo: Sudo, log: (s: string) => void): Promise<void> {
  const script = `${HEAD}
set -e
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ufw
elif command -v dnf >/dev/null 2>&1; then dnf install -y firewalld
elif command -v yum >/dev/null 2>&1; then yum install -y firewalld
else echo "No supported package manager found."; exit 40
fi
echo; echo "==> Installed. The firewall stays off until you switch it on."`
  await runPrivileged(client, script, sudo, log)
}

// ---------------------------------------------------------------- nginx firewall
const NGX_FILE = 'superdevops-00-firewall.conf'

export async function getNginx(client: Client): Promise<NginxFirewall> {
  const env = await preflight(client)
  const empty: NginxFirewall = { available: !!env.nginx && !!env.confDir, blocked: [], rateLimit: false, rate: 10, burst: 20 }
  if (!empty.available) return empty
  const res = await exec(client, `cat ${shq(`${env.confDir}/${NGX_FILE}`)} 2>/dev/null || true`, { timeoutMs: 15000 })
  const blocked = [...res.stdout.matchAll(/^deny\s+([^;\s]+);/gm)].map((m) => m[1])
  const rate = /rate=(\d+)r\/s/.exec(res.stdout)
  const burst = /burst=(\d+)/.exec(res.stdout)
  return { available: true, blocked, rateLimit: !!rate, rate: rate ? Number(rate[1]) : 10, burst: burst ? Number(burst[1]) : rate ? 0 : 20 }
}

export async function setNginx(client: Client, sudo: Sudo, cfg: Pick<NginxFirewall, 'blocked' | 'rateLimit' | 'rate' | 'burst'>): Promise<void> {
  const env = await preflight(client)
  if (!env.nginx || !env.confDir) throw new Error('nginx is not installed on this server.')
  const blocked = [...new Set(cfg.blocked.map((b) => b.trim()).filter(Boolean))]
  for (const ip of blocked) if (!isIp(ip, true)) throw new Error(`"${ip}" is not a valid IP address or range.`)
  if (cfg.rateLimit) {
    if (!(Number.isInteger(cfg.rate) && cfg.rate >= 1 && cfg.rate <= 10000)) throw new Error('Rate must be between 1 and 10000 requests per second.')
    if (!(Number.isInteger(cfg.burst) && cfg.burst >= 0 && cfg.burst <= 100000)) throw new Error('Burst must be between 0 and 100000.')
  }
  const lines = ['# Managed by SuperDevops - nginx firewall. Applies to every site on this server.']
  if (cfg.rateLimit) {
    lines.push(
      `limit_req_zone $binary_remote_addr zone=superdevops_rl:10m rate=${cfg.rate}r/s;`,
      // nginx rejects burst=0, so leave it out when no burst is wanted.
      `limit_req zone=superdevops_rl${cfg.burst > 0 ? ` burst=${cfg.burst} nodelay` : ''};`,
      'limit_req_status 429;'
    )
  }
  for (const ip of blocked) lines.push(`deny ${ip};`)
  const b64 = Buffer.from(lines.join('\n') + '\n').toString('base64')
  const script = `${HEAD}
set -e
CONF=${shq(`${env.confDir}/${NGX_FILE}`)}
if [ -f "$CONF" ]; then cp "$CONF" "$CONF.bak"; fi
echo ${b64} | base64 -d > "$CONF"
if ! nginx -t 2>&1; then
  if [ -f "$CONF.bak" ]; then mv "$CONF.bak" "$CONF"; else rm -f "$CONF"; fi
  echo "nginx rejected the firewall rules. Nothing was changed."
  exit 30
fi
rm -f "$CONF.bak"
systemctl reload nginx 2>/dev/null || nginx -s reload`
  await runPrivileged(client, script, sudo, undefined, 60000)
}

/** Block one IP everywhere we can: the system firewall when it is on, and nginx. */
export async function blockIp(client: Client, sudo: Sudo, ip: string, projectPort: number): Promise<string[]> {
  if (!isIp(ip)) throw new Error('Not a valid IP address.')
  // Never block the address this app itself is connected from.
  const me = (await exec(client, 'echo "$SSH_CONNECTION"', { timeoutMs: 10000 })).stdout.trim().split(/\s+/)[0]
  if (me && me === ip.trim()) throw new Error('That is the address this app is connected from. Blocking it would lock you out of the server.')
  const done: string[] = []
  const fw = await status(client, sudo, projectPort)
  if (fw.active && fw.kind !== 'none') {
    await addRule(client, sudo, fw.kind, { action: 'deny', port: '', proto: 'both', from: ip }, projectPort)
    done.push('system firewall')
  }
  const ngx = await getNginx(client)
  if (ngx.available) {
    if (!ngx.blocked.includes(ip)) await setNginx(client, sudo, { ...ngx, blocked: [...ngx.blocked, ip] })
    done.push('nginx')
  }
  if (done.length === 0) throw new Error('There is no active firewall or nginx on this server to block with.')
  return done
}
