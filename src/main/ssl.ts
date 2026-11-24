// HTTPS with Let's Encrypt (certbot, HTTP-01 through a shared webroot).
import type { Client } from 'ssh2'
import type { Site, SslStatus } from '@shared/types'
import type { Sudo } from './deploy'
import { ACME_ROOT, PATH_EXPORT, certName, isIp, runDeploy, runPrivileged, validateSite } from './deploy'
import { shq } from './ssh'

/**
 * The names of a site that a certificate can cover. An IP address, a wildcard or the catch-all name can sit
 * beside real names on a site; they are simply not in the certificate.
 */
export function sslDomains(site: Site): string[] {
  const domains = site.domain
    .trim()
    .split(/\s+/)
    .filter((d) => d && d !== '_' && !d.includes('*') && !isIp(d) && d.includes('.'))
  if (domains.length === 0) throw new Error("This site has no domain name a certificate can be made for. Let's Encrypt needs a real name such as app.example.com, not an IP address or a wildcard.")
  return domains
}

/** Shell that asks Let's Encrypt for one certificate covering these names (new, or widened to more names). */
function certScript(site: Site, domains: string[], email: string): string {
  return `${PATH_EXPORT}
set -e
if ! command -v certbot >/dev/null 2>&1; then
  echo; echo "==> Installing certbot"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y certbot
  elif command -v dnf >/dev/null 2>&1; then dnf install -y certbot
  elif command -v yum >/dev/null 2>&1; then yum install -y certbot
  else echo "certbot is not installed and no supported package manager was found."; exit 40
  fi
fi
mkdir -p ${ACME_ROOT}
chmod 755 /var/lib/superdevops ${ACME_ROOT}
echo; echo "==> Requesting a certificate for ${domains.join(', ')}"
certbot certonly --webroot -w ${ACME_ROOT} --cert-name ${shq(certName(site))} ${domains.map((d) => `-d ${shq(d)}`).join(' ')} \\
  --non-interactive --agree-tos ${email ? `-m ${shq(email)}` : '--register-unsafely-without-email'} --expand --keep-until-expiring \\
  --deploy-hook 'systemctl reload nginx 2>/dev/null || nginx -s reload'
# certbot's own timer normally renews; this is a second safety net.
printf '%s\\n' '# Managed by SuperDevops' '41 3 * * * root certbot renew -q' > /etc/cron.d/superdevops-certrenew
chmod 644 /etc/cron.d/superdevops-certrenew`
}

/**
 * After the names of an HTTPS site changed: widen its certificate to the new list. The site stays on HTTPS with
 * the certificate it has whatever happens; a failure is told, not thrown, because the site itself is fine.
 */
export async function extend(opts: { client: Client; sudo: Sudo; site: Site; log: (chunk: string) => void }): Promise<{ ok: boolean; message?: string }> {
  const { client, sudo, site, log } = opts
  let domains: string[]
  try {
    domains = sslDomains(site)
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
  try {
    await runPrivileged(client, `${certScript(site, domains, site.sslEmail ?? '')}\nsystemctl reload nginx 2>/dev/null || nginx -s reload`, sudo, log)
    return { ok: true }
  } catch (err) {
    const message = 'The certificate could not be widened to the new names, so they show a certificate warning for now. Usual cause: a new name does not point to this server yet. The names that were covered before still are.'
    log(`\n${message}\n`)
    return { ok: false, message: `${message} (${(err as Error).message})` }
  }
}

export async function status(client: Client, sudo: Sudo, site: Site): Promise<SslStatus> {
  validateSite(site)
  const cert = `/etc/letsencrypt/live/${certName(site)}/fullchain.pem`
  const script = `${PATH_EXPORT}
command -v certbot >/dev/null 2>&1 && echo "certbot=1"
if [ -f ${shq(cert)} ]; then
  echo "cert=1"
  echo "end=$(openssl x509 -enddate -noout -in ${shq(cert)} 2>/dev/null | cut -d= -f2)"
  echo "names=$(openssl x509 -noout -ext subjectAltName -in ${shq(cert)} 2>/dev/null | grep -oE 'DNS:[^, ]+' | cut -d: -f2 | tr '\\n' ' ')"
  echo "start=$(openssl x509 -startdate -noout -in ${shq(cert)} 2>/dev/null | cut -d= -f2)"
  echo "issuer=$(openssl x509 -noout -issuer -nameopt RFC2253 -in ${shq(cert)} 2>/dev/null | sed 's/^issuer=//')"
  echo "fp=$(openssl x509 -noout -fingerprint -sha256 -in ${shq(cert)} 2>/dev/null | cut -d= -f2)"
  echo "pem=$(openssl x509 -in ${shq(cert)} 2>/dev/null | base64 -w0)"
  if systemctl is-enabled certbot.timer >/dev/null 2>&1 || systemctl is-enabled snap.certbot.renew.timer >/dev/null 2>&1 || [ -f /etc/cron.d/certbot ]; then echo "auto=1"; fi
fi
true`
  const res = await runPrivileged(client, script, sudo, undefined, 20000)
  const kv: Record<string, string> = {}
  for (const line of res.stdout.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim()
  }
  const end = kv.end ? Date.parse(kv.end) : NaN
  const start = kv.start ? Date.parse(kv.start) : NaN
  // "CN=R11,O=Let's Encrypt,C=US" → "Let's Encrypt (R11)"
  const part = (k: string): string | undefined => new RegExp(`(?:^|,)${k}=([^,]+)`).exec(kv.issuer ?? '')?.[1]
  const issuer = kv.issuer ? [part('O'), part('CN') ? `(${part('CN')})` : ''].filter(Boolean).join(' ') || kv.issuer : undefined
  let pem: string | undefined
  try {
    pem = kv.pem ? Buffer.from(kv.pem, 'base64').toString('utf8') : undefined
  } catch {
    pem = undefined
  }
  return {
    certbot: kv.certbot === '1',
    hasCert: kv.cert === '1',
    expires: Number.isFinite(end) ? end : undefined,
    domains: (kv.names ?? '').split(/\s+/).filter(Boolean),
    starts: Number.isFinite(start) ? start : undefined,
    issuer,
    fingerprint: kv.fp || undefined,
    pem: pem && pem.includes('BEGIN CERTIFICATE') && !pem.includes('PRIVATE KEY') ? pem : undefined,
    autoRenew: kv.auto === '1',
    path: kv.cert === '1' ? `/etc/letsencrypt/live/${certName(site)}` : undefined
  }
}

/** Ask Let's Encrypt for a fresh certificate now, whatever its expiry, and load it. */
export async function renew(client: Client, sudo: Sudo, site: Site, log: (chunk: string) => void): Promise<void> {
  validateSite(site)
  const name = certName(site)
  await runPrivileged(
    client,
    `${PATH_EXPORT}
[ -f /etc/letsencrypt/renewal/${name}.conf ] || { echo "This site has no certificate from Let's Encrypt to renew."; exit 3; }
certbot renew --cert-name ${shq(name)} --force-renewal --non-interactive
nginx -t && (systemctl reload nginx 2>/dev/null || nginx -s reload)
echo "Certificate renewed and loaded."`,
    sudo,
    log
  )
}

/** Expiry of every site certificate on a server, by certificate name. One call for the whole site list. */
export async function expiries(client: Client, sudo: Sudo): Promise<Record<string, number>> {
  const res = await runPrivileged(
    client,
    `${PATH_EXPORT}
for d in /etc/letsencrypt/live/superdevops-*/; do
  [ -f "$d/fullchain.pem" ] || continue
  echo "$(basename "$d")|$(openssl x509 -enddate -noout -in "$d/fullchain.pem" 2>/dev/null | cut -d= -f2)"
done
true`,
    sudo,
    undefined,
    20000
  )
  const out: Record<string, number> = {}
  for (const line of res.stdout.split('\n')) {
    const [name, end] = line.split('|')
    const t = Date.parse(end ?? '')
    if (name && Number.isFinite(t)) out[name.trim()] = t
  }
  return out
}

/**
 * Get (or extend) the certificate, then switch the site to HTTPS.
 * If anything fails, the site keeps working over HTTP as before.
 */
export async function enable(opts: {
  client: Client
  sudo: Sudo
  site: Site
  email: string
  forceHttps: boolean
  log: (chunk: string) => void
}): Promise<Site> {
  const { client, sudo, log } = opts
  // The email is optional: without one the certificate is the same, there are only no reminder mails.
  const email = (opts.email ?? '').trim()
  if (email && !/^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/.test(email)) throw new Error('That email address is not valid. Leave it empty to go without one.')
  const domains = sslDomains(opts.site)

  // 1. Make sure the HTTP config with the verification path is live.
  const plain: Site = { ...opts.site, ssl: false }
  await runDeploy({ client, sudo, site: plain, configOnly: true, log })

  // 2. Ask Let's Encrypt for the certificate.
  const script = certScript(opts.site, domains, email)
  try {
    await runPrivileged(client, script, sudo, log)
  } catch (err) {
    log(
      '\nThe certificate was not issued. Usual causes: the domain does not point to this server yet, or port 80 is closed in a firewall. The site still works over HTTP.\n'
    )
    throw err
  }

  // 3. Switch the site to HTTPS.
  log('\n')
  const secured: Site = { ...opts.site, ssl: true, sslEmail: email || undefined, forceHttps: opts.forceHttps }
  await runDeploy({ client, sudo, site: secured, configOnly: true, log })
  return secured
}

/** Go back to HTTP only. The certificate stays on the server. */
export async function disable(client: Client, sudo: Sudo, site: Site, log: (chunk: string) => void): Promise<Site> {
  const plain: Site = { ...site, ssl: false, forceHttps: false }
  await runDeploy({ client, sudo, site: plain, configOnly: true, log })
  return plain
}

/** The certificate's private key, read from the server. Only after an authenticator code; see AFTER_CODE in the service. */
export async function privateKey(client: Client, sudo: Sudo, site: Site): Promise<string> {
  validateSite(site)
  const key = `/etc/letsencrypt/live/${certName(site)}/privkey.pem`
  const res = await runPrivileged(client, `if [ -f ${shq(key)} ]; then cat ${shq(key)}; else echo "@@nokey"; fi`, sudo, undefined, 20000)
  if (res.stdout.includes('@@nokey')) throw new Error('This site has no private key on the server. Turn HTTPS on first.')
  const pem = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/.exec(res.stdout)?.[0]
  if (!pem) throw new Error('The key file on the server could not be read as a PEM key.')
  return pem + '\n'
}
