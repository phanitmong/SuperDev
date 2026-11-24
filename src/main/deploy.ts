// Deploy engine: validates a site, generates its nginx config and runs the
// deployment on the server. No Electron imports, so it can be tested with Node.
import type { Client } from 'ssh2'
import type { BackendStatus, DeployRecord, ServerEnv, Site, UploadSource } from '@shared/types'
import { FRAMEWORKS } from '@shared/types'
import { exec, openSftp, shq, uploadDir, uploadFile, wrapScript, writeRemoteTemp } from './ssh'
import type { ExecResult, SudoMode } from './ssh'

import { SUP_SHELL } from './supshell'

export interface Sudo {
  mode: SudoMode
  /** Password line fed to `sudo -S`. */
  stdin?: string
}

export const PATH_EXPORT = 'export PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin:/usr/local/bin:/usr/local/nginx/sbin:/www/server/nginx/sbin"'

const RE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/
const RE_DOMAIN = /^(_|(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*)$/
const RE_PATH = /^\/[A-Za-z0-9._/-]+$/
const RE_SUBDIR = /^[A-Za-z0-9._/-]*$/
const RE_UPSTREAM = /^(unix:\/[A-Za-z0-9._/-]+|[A-Za-z0-9.-]+:\d{1,5})$/
const RE_BRANCH = /^[A-Za-z0-9._/-]+$/
const RE_BACKEND = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?:\d{1,5}$/
const RE_HASH = /^[0-9a-f]{7,40}$/
const RE_HEALTH = /^\/[A-Za-z0-9._~/?&=%-]*$/
const SNAPSHOT_DIR = '/var/backups/superdevops/sites'
const RE_REPO = /^[A-Za-z0-9@:/._~+%=-]+$/
const PROTECTED = new Set(['/', '/etc', '/usr', '/var', '/root', '/home', '/bin', '/sbin', '/lib', '/boot', '/opt', '/www', '/srv', '/tmp', '/var/www', '/www/wwwroot'])

/** True for an IPv4/IPv6 address, optionally with a /prefix when allowCidr is set. */
export function isIp(value: string, allowCidr = false): boolean {
  const [addr, prefix, extra] = value.split('/')
  if (extra !== undefined || (prefix !== undefined && !allowCidr)) return false
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr)
  if (v4) {
    if (v4.slice(1).some((n) => Number(n) > 255)) return false
    return prefix === undefined || (/^\d{1,2}$/.test(prefix) && Number(prefix) <= 32)
  }
  if (!/^[0-9A-Fa-f:]{2,39}$/.test(addr) || !addr.includes(':')) return false
  return prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= 128)
}

/** Validate an absolute server path. Returns it without a trailing slash. */
export function checkServerPath(input: string, label: string, refuseSystemFolders: boolean): string {
  const p = (input ?? '').trim().replace(/\/+$/, '')
  if (!RE_PATH.test(p) || p.includes('..') || p.includes('//')) {
    throw new Error(`${label} must be an absolute path without spaces, for example /www/wwwroot/shop.`)
  }
  if (refuseSystemFolders && PROTECTED.has(p)) throw new Error(`${label}: "${p}" is a system folder. Choose a sub-folder.`)
  return p
}

export function validateSite(site: Site): void {
  const fail = (msg: string): never => {
    throw new Error(msg)
  }
  if (!RE_NAME.test(site.name)) fail('Site name may only contain letters, numbers, dot, dash and underscore.')
  const domains = site.domain.trim().split(/\s+/).filter(Boolean)
  if (domains.length === 0) fail('Enter at least one domain (or the server IP).')
  for (const d of domains) if (!RE_DOMAIN.test(d)) fail(`"${d}" is not a valid domain.`)

  const root = site.rootPath.replace(/\/+$/, '')
  if (!RE_PATH.test(root) || root.includes('..') || root.includes('//')) fail('Root path must be an absolute path without spaces.')
  if (PROTECTED.has(root)) fail(`"${root}" is a system folder. Use a sub-folder such as ${root === '/' ? '' : root}/${site.name}.`)
  if (!RE_SUBDIR.test(site.publicDir) || site.publicDir.includes('..') || site.publicDir.startsWith('/')) {
    fail('Public folder must be a relative path such as "public".')
  }
  if (!FRAMEWORKS[site.framework]) fail('Unknown framework.')
  if (site.appType === 'php' && site.phpUpstream && !RE_UPSTREAM.test(site.phpUpstream)) {
    fail('PHP upstream must look like unix:/run/php/php8.3-fpm.sock or 127.0.0.1:9000.')
  }
  if (site.appType === 'proxy' && !(Number.isInteger(site.proxyPort) && site.proxyPort > 0 && site.proxyPort < 65536)) {
    fail('Enter the local port your app listens on (1-65535).')
  }
  if (site.appType === 'proxy' && site.runner) {
    const r = site.runner
    if (!['python', 'java', 'command'].includes(r.kind)) fail('Unknown way to start the app.')
    const cmd = String(r.command ?? '').trim()
    if (!cmd) fail('Type the command that starts the app.')
    if (/[\r\n\0]/.test(cmd) || cmd.length > 1000) fail('The start command must be one line, up to 1000 characters.')
    if (r.user && !/^[a-z_][a-z0-9_-]{0,31}$/.test(r.user)) fail('That is not a valid user name to run the app as.')
  }
  validateNginxExtras(site, domains)
  if (site.healthPath && !RE_HEALTH.test(site.healthPath)) fail('The health check path must start with / and contain no spaces, for example /health.')
  if (site.maintenance && site.maintenanceAllowIp && !isIp(site.maintenanceAllowIp)) fail('The allowed IP for maintenance mode is not a valid IP address.')
  if (site.appType === 'balancer') {
    const backends = site.backends ?? []
    if (backends.length === 0) fail('Add at least one backend server.')
    for (const b of backends) {
      const port = Number(b.address.split(':').pop())
      if (!RE_BACKEND.test(b.address) || port < 1 || port > 65535) fail(`"${b.address}" is not a valid backend. Use host:port, for example 10.0.0.2:8080.`)
      if (!(Number.isInteger(b.weight) && b.weight >= 1 && b.weight <= 100)) fail('Backend weight must be between 1 and 100.')
    }
    if (new Set(backends.map((b) => b.address)).size !== backends.length) fail('Each backend address can only be listed once.')
    if (backends.every((b) => b.backup)) fail('At least one backend must be a normal (not backup) server.')
    if (!['round_robin', 'least_conn', 'ip_hash'].includes(site.lbMethod ?? 'round_robin')) fail('Unknown balancing method.')
    if (site.lbMethod === 'ip_hash' && backends.some((b) => b.backup)) fail('"Sticky by client IP" cannot be combined with backup servers (an nginx limit).')
    return
  }
  if (site.source === 'git') {
    if (!site.repoUrl || !RE_REPO.test(site.repoUrl) || site.repoUrl.startsWith('-')) fail('Enter a valid git repository URL.')
    if (!RE_BRANCH.test(site.branch) || site.branch.startsWith('-') || site.branch.includes('..')) fail('Enter a valid branch name.')
  }
}

function rewriteBlock(site: Site): string {
  switch (site.framework) {
    case 'laravel':
    case 'codeigniter':
      return `    location / {\n        try_files $uri $uri/ /index.php?$query_string;\n    }`
    case 'wordpress':
    case 'yii2':
      return `    location / {\n        try_files $uri $uri/ /index.php?$args;\n    }`
    case 'symfony':
      return `    location / {\n        try_files $uri /index.php$is_args$args;\n    }`
    case 'thinkphp':
      return `    location / {\n        if (!-e $request_filename) {\n            rewrite ^(.*)$ /index.php?s=$1 last;\n        }\n    }`
    case 'spa':
      return `    location / {\n        try_files $uri $uri/ /index.html;\n    }`
    default:
      return `    location / {\n        try_files $uri $uri/ =404;\n    }`
  }
}

export function webRoot(site: Site): string {
  const root = site.rootPath.replace(/\/+$/, '')
  const pub = site.publicDir.replace(/^\/+|\/+$/g, '')
  return pub ? `${root}/${pub}` : root
}

/** Sites whose files can get a preview: uploaded static and PHP sites (one folder nginx serves). */
export function canPreview(site: Site): boolean {
  return site.source === 'upload' && (site.appType === 'static' || site.appType === 'php')
}

/** Folder that holds the preview, beside the live one. */
export function previewRoot(site: Site): string {
  return `${site.rootPath.replace(/\/+$/, '')}.preview`
}

function previewWebRoot(site: Site): string {
  const pub = site.publicDir.replace(/^\/+|\/+$/g, '')
  return pub ? `${previewRoot(site)}/${pub}` : previewRoot(site)
}

const RE_TOKEN = /^[a-f0-9]{32}$/

function cacheDaysOf(site: Site): number {
  return site.nginx?.staticCacheDays ?? (site.appType === 'php' ? 0 : 7)
}

/**
 * Preview routing: /preview gives the browser a cookie and from then on the same addresses are served from the
 * preview folder, so links and pictures with absolute paths work; /preview/exit goes back to the live site.
 */
// The pill a browser in preview mode sees on every page, so nobody mistakes the preview for the live site.
// Small, on one line, and draggable with a finger or the mouse (the place is kept for the tab), so it never hides the page's own buttons.
// Inside an nginx string: no single quotes and no dollar signs.
const PREVIEW_BAR =
  '<div id="apsara-preview" title="Drag to move" style="position:fixed;z-index:2147483647;right:12px;bottom:88px;display:flex;gap:10px;align-items:center;white-space:nowrap;background:#5b21b6;color:#fff;font:600 12px/1 system-ui,-apple-system,sans-serif;padding:8px 12px;border-radius:999px;box-shadow:0 6px 18px rgba(0,0,0,.35);touch-action:none;user-select:none;-webkit-user-select:none;cursor:grab">' +
  '<span>&#9679; Preview</span><a href="/preview/exit" style="color:#fff;text-decoration:underline">Exit</a></div>' +
  '<script>(function(){var b=document.getElementById("apsara-preview");if(!b)return;var k="apsaraPreviewPos";' +
  'function put(x,y){x=Math.min(Math.max(0,x),innerWidth-b.offsetWidth);y=Math.min(Math.max(0,y),innerHeight-b.offsetHeight);b.style.left=x+"px";b.style.top=y+"px";b.style.right="auto";b.style.bottom="auto"}' +
  'try{var p=JSON.parse(sessionStorage.getItem(k)||"null");if(p)put(p.x,p.y)}catch(e){}' +
  'var sx,sy,ox,oy;b.addEventListener("pointerdown",function(e){if(e.target.tagName==="A")return;var r=b.getBoundingClientRect();sx=e.clientX;sy=e.clientY;ox=r.left;oy=r.top;b.setPointerCapture(e.pointerId);b.style.cursor="grabbing"});' +
  'b.addEventListener("pointermove",function(e){if(sx===undefined)return;put(ox+e.clientX-sx,oy+e.clientY-sy)});' +
  'function end(){if(sx===undefined)return;sx=undefined;b.style.cursor="grab";try{sessionStorage.setItem(k,JSON.stringify({x:parseInt(b.style.left)||0,y:parseInt(b.style.top)||0}))}catch(e){}}' +
  'b.addEventListener("pointerup",end);b.addEventListener("pointercancel",end)})();</script>'

function previewLines(site: Site, banner = false): string[] {
  const p = site.preview
  if (!p || !canPreview(site) || !RE_TOKEN.test(p.token)) return [`    root ${webRoot(site)};`]
  const bar = banner
    ? [
        `    # Pages seen in preview mode get a bar saying so (empty on the live site).`,
        `    sub_filter '</body>' '\${sd_bar}</body>';`,
        `    sub_filter_once on;`
      ]
    : []
  return [
    `    # Preview: /preview shows it to this browser for a day, /preview/exit goes back to the live site.`,
    `    set $sd_root ${webRoot(site)};`,
    `    set $sd_expires ${Math.max(1, cacheDaysOf(site))}d;`,
    `    set $sd_cc '';`,
    ...(banner ? [`    set $sd_bar '';`] : []),
    `    if ($cookie_apsara_preview = "${p.token}") {`,
    `        set $sd_root ${previewWebRoot(site)};`,
    `        set $sd_expires epoch;`,
    `        set $sd_cc no-store;`,
    ...(banner ? [`        set $sd_bar '${PREVIEW_BAR}';`] : []),
    `    }`,
    `    root $sd_root;`,
    // The browser keeps no preview page, and does not show a live page it kept when the preview is asked for.
    `    add_header Cache-Control $sd_cc;`,
    `    add_header Vary Cookie;`,
    ...bar,
    // The address after the redirect is new (time in the query), so a page the browser kept from before is not reused.
    `    location = /preview {`,
    `        absolute_redirect off;`,
    `        add_header Set-Cookie "apsara_preview=${p.token}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax" always;`,
    `        add_header Cache-Control "no-store" always;`,
    `        return 302 /?apsara_preview=$msec;`,
    `    }`,
    `    location = /preview/exit {`,
    `        absolute_redirect off;`,
    `        add_header Set-Cookie "apsara_preview=; Path=/; Max-Age=0" always;`,
    `        add_header Cache-Control "no-store" always;`,
    `        return 302 /?apsara_live=$msec;`,
    `    }`
  ]
}

export function confFileName(site: Site): string {
  return `superdevops-${site.name}.conf`
}

// ---------------------------------------------------------------- pages visitors see
// One calm page design for maintenance, a stopped site, and the errors nginx itself answers (403, 404, 500, 502, 504).
// Visitors of the owner's site see these, so they carry no panel branding. They sit inside nginx strings:
// no single quotes, and "$" only for nginx variables ($host shows the site's own name).
type VisitorPage = { status: number; chip: string; title: string; text: string; tone: string; pulse?: boolean; action?: 'home' | 'retry'; refresh?: number }

const VISITOR_PAGES = {
  maintenance: { status: 503, chip: 'Maintenance', title: 'We are making a few improvements', text: 'The site is down for planned work and will be back shortly. This page checks again every minute.', tone: '#d97706', pulse: true, action: 'retry', refresh: 60 },
  stopped: { status: 503, chip: 'Offline', title: 'This site is not available right now', text: 'It has been switched off for the moment. Please check back later.', tone: '#8a8f98' },
  403: { status: 403, chip: '403 · No access', title: 'This page is not open to visitors', text: 'You do not have permission to view it.', tone: '#dc2626', action: 'home' },
  404: { status: 404, chip: '404 · Not found', title: 'This page does not exist', text: 'The address may be mistyped, or the page has moved.', tone: '#2563eb', action: 'home' },
  500: { status: 500, chip: '500 · Server error', title: 'Something went wrong on our side', text: 'The site could not finish this request. Please try again in a moment.', tone: '#dc2626', action: 'retry' },
  502: { status: 502, chip: '502 · Not answering', title: 'The site is not answering', text: 'The application behind this address did not respond. It may be restarting, so please try again shortly.', tone: '#dc2626', action: 'retry' },
  504: { status: 504, chip: '504 · Timed out', title: 'The site took too long to answer', text: 'The request was waiting longer than allowed. Please try again in a moment.', tone: '#dc2626', action: 'retry' }
} satisfies Record<string, VisitorPage>

const PAGE_CSS =
  ':root{--bg:#f6f5f2;--ink:#17181c;--mute:#666a73;--line:#e3e1db}' +
  '@media (prefers-color-scheme:dark){:root{--bg:#121316;--ink:#ecebe6;--mute:#9a9ca3;--line:#2a2c31}}' +
  '*{box-sizing:border-box}html,body{height:100%}' +
  'body{margin:0;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}' +
  'main{width:100%;max-width:440px}' +
  '.chip{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--mute);border:1px solid var(--line);border-radius:999px;padding:5px 12px 5px 10px}' +
  '.dot{width:8px;height:8px;border-radius:50%;background:var(--tone)}' +
  '.pulse .dot{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}' +
  'h1{font-size:clamp(26px,6.4vw,34px);line-height:1.15;letter-spacing:-.02em;margin:20px 0 10px;font-weight:700;text-wrap:balance}' +
  'p{margin:0;color:var(--mute)}' +
  '.row{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;align-items:center;margin-top:28px;padding-top:18px;border-top:1px solid var(--line);font-size:13px;color:var(--mute)}' +
  '.row a{color:var(--ink);font-weight:600;text-decoration:none;border-bottom:1px solid currentColor;padding-bottom:1px}' +
  '.row a:focus-visible{outline:2px solid var(--tone);outline-offset:3px}' +
  '@media (prefers-reduced-motion:reduce){.pulse .dot{animation:none}}'

export function visitorPage(kind: keyof typeof VISITOR_PAGES): string {
  const v: VisitorPage = VISITOR_PAGES[kind]
  const action = v.action === 'home' ? '<a href="/">Go to the home page</a>' : v.action === 'retry' ? '<a href="">Try again</a>' : ''
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
    (v.refresh ? `<meta http-equiv="refresh" content="${v.refresh}">` : '') +
    `<title>${v.title}</title><style>${PAGE_CSS}</style></head>` +
    `<body style="--tone:${v.tone}"><main><span class="chip${v.pulse ? ' pulse' : ''}"><span class="dot"></span>${v.chip}</span>` +
    `<h1>${v.title}</h1><p>${v.text}</p><div class="row"><span>$host</span>${action}</div></main></body></html>`
  )
}

/** nginx answers its own errors with the pages above; an app's own error pages (PHP, proxied apps) pass through unchanged. */
function errorPageLines(): string[] {
  const out: string[] = [`    # Error pages nginx itself answers (a missing file, a stopped app).`]
  for (const code of [403, 404, 500, 502, 504] as const) {
    out.push(`    error_page ${code} @sd_error_${code};`, `    location @sd_error_${code} {`, `        default_type text/html;`, `        add_header Cache-Control "no-store" always;`, `        return ${code} '${visitorPage(code)}';`, `    }`)
  }
  out.push(``)
  return out
}

const RE_PROXY_PATH = /^\/[A-Za-z0-9._~\/-]{1,200}$/
const RE_PROXY_TARGET = /^(https?):\/\/([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:]{2,45}\])(?::(\d{1,5}))?(\/[A-Za-z0-9._~\/-]{0,200})?$/

function validateNginxExtras(site: Site, domains: string[]): void {
  const fail = (m: string): never => {
    throw new Error(m)
  }
  const rules = site.proxyRules ?? []
  if (rules.length > 30) fail('At most 30 reverse proxy rules per site.')
  const seen = new Set<string>()
  for (const r of rules) {
    const raw = String(r.path ?? '').trim()
    if (!raw) fail('A reverse proxy rule needs a path: / for the whole site, or one such as /api.')
    const path = raw.replace(/\/+$/, '') || '/'
    if (path === '/') {
      // The whole site goes to the target; longer paths (other rules, certificate renewal) still win.
      if (site.appType === 'balancer') fail('A load balancer already sends the whole site to its servers. Use a path such as /api here.')
    } else if (!RE_PROXY_PATH.test(path) || path.includes('//') || path.split('/').includes('..')) fail(`"${r.path}" is not a path. Use / for the whole site, or something like /api or /files/reports.`)
    if (path.startsWith('/.well-known/acme-challenge')) fail('That path is used to renew the certificate and cannot be sent elsewhere.')
    if (seen.has(path)) fail(`The path ${path} is listed twice.`)
    seen.add(path)
    const m = RE_PROXY_TARGET.exec(String(r.target ?? '').trim())
    if (!m) fail(`"${r.target}" is not a target address. Use http://127.0.0.1:3000 or https://api.example.com.`)
    else if (m[3] && (Number(m[3]) < 1 || Number(m[3]) > 65535)) fail(`The port in ${r.target} must be between 1 and 65535.`)
    if (r.hostHeader && !['visitor', 'target'].includes(r.hostHeader)) fail('Unknown choice for the name sent to the target.')
  }
  const n = site.nginx
  if (!n) return
  if (n.maxBodyMb !== undefined && !(Number.isInteger(n.maxBodyMb) && n.maxBodyMb >= 1 && n.maxBodyMb <= 51200)) fail('The largest upload must be between 1 and 51200 MB.')
  if (n.staticCacheDays !== undefined && !(Number.isInteger(n.staticCacheDays) && n.staticCacheDays >= 0 && n.staticCacheDays <= 365)) fail('Browser caching must be between 0 and 365 days.')
  if (n.redirectWww && n.redirectWww !== 'none') {
    if (!['to-www', 'to-bare'].includes(n.redirectWww)) fail('Unknown www redirect.')
    if (!wwwPair(domains)) fail('The www redirect needs both names among the site\'s domains, for example example.com and www.example.com. Add the missing one under Domains first.')
  }
  const headers = n.headers ?? []
  if (headers.length > 20) fail('At most 20 extra headers.')
  for (const h of headers) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(String(h.name))) fail(`"${h.name}" is not a header name. Use letters, numbers and dashes, for example X-Frame-Options.`)
    if (!/^[\x20-\x7e]{1,500}$/.test(String(h.value)) || /["\\$;{}]/.test(h.value)) fail(`The value of ${h.name} may not contain " \\ $ ; { or }.`)
  }
  const extra = String(n.extra ?? '')
  if (extra.length > 8000) fail('The extra directives are limited to 8000 characters.')
  if (/\0/.test(extra)) fail('The extra directives contain a character that is not allowed.')
  let depth = 0
  for (const ch of extra.replace(/#[^\n]*/g, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '')) {
    if (ch === '{') depth += 1
    if (ch === '}') depth -= 1
    if (depth < 0) fail('The extra directives close a block ( } ) that they did not open. They are placed inside this site\'s server block and must stay inside it.')
  }
  if (depth !== 0) fail('The extra directives open a block ( { ) without closing it.')
}

/** The bare name and its www twin, when the site answers to both. */
function wwwPair(domains: string[]): { bare: string; www: string } | null {
  for (const d of domains) {
    if (!d.startsWith('www.') && domains.includes(`www.${d}`)) return { bare: d, www: `www.${d}` }
  }
  return null
}

/** A rule for "/" sends the whole site to its target, in place of the site's own files or app. */
function hasRootRule(site: Site): boolean {
  return (site.proxyRules ?? []).some((r) => String(r.path ?? '').trim().replace(/\/+$/, '') === '')
}

/** Lines for the server block from the reverse proxy rules and the settings made in the app. */
function nginxExtras(site: Site): string[] {
  const out: string[] = []
  const n = site.nginx ?? {}
  const pair = wwwPair(site.domain.trim().split(/\s+/).filter(Boolean))
  if (pair && n.redirectWww === 'to-www') out.push(`    if ($host = ${pair.bare}) {`, `        return 301 $scheme://${pair.www}$request_uri;`, `    }`, ``)
  if (pair && n.redirectWww === 'to-bare') out.push(`    if ($host = ${pair.www}) {`, `        return 301 $scheme://${pair.bare}$request_uri;`, `    }`, ``)
  if (n.gzip) {
    out.push(`    gzip on;`, `    gzip_comp_level 5;`, `    gzip_min_length 1024;`, `    gzip_vary on;`, `    gzip_proxied any;`, `    gzip_types text/plain text/css text/xml application/json application/javascript application/xml application/rss+xml image/svg+xml;`, ``)
  }
  if (n.hsts && site.ssl) out.push(`    add_header Strict-Transport-Security "max-age=31536000" always;`)
  for (const h of n.headers ?? []) out.push(`    add_header ${h.name} "${h.value}" always;`)
  if ((n.hsts && site.ssl) || (n.headers ?? []).length) out.push(``)
  for (const r of site.proxyRules ?? []) {
    const path = r.path.trim().replace(/\/+$/, '')
    const m = RE_PROXY_TARGET.exec(r.target.trim())
    if (!m) continue
    const local = /^(127\.|localhost$|\[::1\]$)/.test(m[2])
    const host = (r.hostHeader ?? (local ? 'visitor' : 'target')) === 'visitor' ? '$host' : m[2] + (m[3] ? `:${m[3]}` : '')
    // With a path after the address nginx swaps the matched prefix for it; without one the request path is passed on unchanged.
    const base = r.target.trim().replace(/\/+$/, '')
    const pass = (tail: string): string => (m[4] && m[4] !== '/' ? `${base}${tail}` : r.stripPath ? `${base}${tail || '/'}` : base)
    const body = (tail: string): string[] => [
      `        proxy_pass ${pass(tail)};`,
      `        proxy_http_version 1.1;`,
      `        proxy_set_header Host ${host};`,
      `        proxy_set_header X-Real-IP $remote_addr;`,
      `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
      `        proxy_set_header X-Forwarded-Proto $scheme;`,
      ...(r.websocket ? [`        proxy_set_header Upgrade $http_upgrade;`, `        proxy_set_header Connection "upgrade";`] : []),
      ...(m[1] === 'https' ? [`        proxy_ssl_server_name on;`] : []),
      `        proxy_connect_timeout 10s;`,
      `        proxy_read_timeout 120s;`
    ]
    // "^~ /" is the shortest prefix: longer ones (other rules, certificate renewal) still win, and no file or PHP rule takes a path from it.
    if (!path) out.push(`    # Reverse proxy: the whole site -> ${r.target.trim()}`, `    location ^~ / {`, ...body('/'), `    }`, ``)
    else out.push(`    # Reverse proxy: ${path} -> ${r.target.trim()}`, `    location = ${path} {`, ...body(''), `    }`, `    location ^~ ${path}/ {`, ...body('/'), `    }`, ``)
  }
  const extra = String(n.extra ?? '').replace(/\r/g, '').trim()
  if (extra) out.push(`    # Extra directives from the app (Reverse proxy & Nginx, Advanced)`, ...extra.split('\n').map((l) => `    ${l}`), ``)
  return out
}


function maintenanceBlock(site: Site): string[] {
  if (!site.maintenance) return []
  const lines = [`    # Maintenance mode`, `    set $sd_maintenance 1;`]
  // Certificate renewal must keep working while the site is in maintenance.
  lines.push(`    if ($request_uri ~ "^/\\.well-known/acme-challenge/") {`, `        set $sd_maintenance 0;`, `    }`)
  if (site.maintenanceAllowIp) lines.push(`    if ($remote_addr = "${site.maintenanceAllowIp}") {`, `        set $sd_maintenance 0;`, `    }`)
  lines.push(
    `    if ($sd_maintenance) {`,
    `        return 503;`,
    `    }`,
    `    error_page 503 @sd_maintenance;`,
    `    location @sd_maintenance {`,
    `        default_type text/html;`,
    `        add_header Retry-After 600 always;`,
    `        return 503 '${visitorPage('maintenance')}';`,
    `    }`,
    ``
  )
  return lines
}

export const ACME_ROOT = '/var/lib/superdevops/acme'

export function certName(site: Site): string {
  return `superdevops-${site.name}`
}

/** Lets Let's Encrypt verify the domain over plain HTTP for every site type. */
const ACME_LOCATION = [`    location ^~ /.well-known/acme-challenge/ {`, `        root ${ACME_ROOT};`, `        default_type text/plain;`, `    }`, ``]

export function buildNginxConf(site: Site, phpUpstream: string, env?: ServerEnv): string {
  const conf = buildMainServer(site, phpUpstream, env?.subFilter === true)
  if (!(site.ssl && site.forceHttps)) return conf
  const [first, ...rest] = conf.split('\n')
  return [
    first,
    `server {`,
    `    listen 80;`,
    `    server_name ${site.domain.trim().split(/\s+/).join(' ')};`,
    ...ACME_LOCATION.slice(0, -1),
    `    location / {`,
    `        return 301 https://$host$request_uri;`,
    `    }`,
    `}`,
    ``,
    ...rest
  ].join('\n')
}

function buildMainServer(site: Site, phpUpstream: string, banner = false): string {
  const live = `/etc/letsencrypt/live/${certName(site)}`
  const listen = site.ssl ? [...(site.forceHttps ? [] : [`    listen 80;`]), `    listen 443 ssl http2;`] : [`    listen 80;`]
  const tls = site.ssl
    ? [
        `    ssl_certificate ${live}/fullchain.pem;`,
        `    ssl_certificate_key ${live}/privkey.pem;`,
        `    ssl_protocols TLSv1.2 TLSv1.3;`,
        `    ssl_session_cache shared:SSL:10m;`,
        `    ssl_session_timeout 1d;`,
        ``
      ]
    : []
  const domains = site.domain.trim().split(/\s+/).join(' ')
  const head = [
    `# Managed by SuperDevops - site "${site.name}". Changes made here are overwritten on the next deploy.`,
    `server {`,
    ...listen,
    `    server_name ${domains};`,
    `    charset utf-8;`,
    `    client_max_body_size ${site.nginx?.maxBodyMb ?? 64}m;`,
    `    access_log /var/log/nginx/${site.name}.access.log;`,
    `    error_log  /var/log/nginx/${site.name}.error.log;`,
    ``,
    ...tls,
    ...ACME_LOCATION,
    ...maintenanceBlock(site)
  ]
  const hidden = `    location ~ /\\.(?!well-known) {\n        deny all;\n    }`

  // A stopped site keeps its names, its certificate and its renewal, and answers every request with one page.
  if (site.stopped) {
    return [
      ...head.slice(0, -maintenanceBlock(site).length || undefined),
      `    # Stopped from the app. Start the site there to bring it back.`,
      `    location / {`,
      `        default_type text/html;`,
      `        add_header Retry-After 3600 always;`,
      `        return 503 '${visitorPage('stopped')}';`,
      `    }`,
      `}`,
      ``
    ].join('\n')
  }

  head.push(...nginxExtras(site), ...errorPageLines())

  if (site.appType === 'balancer') {
    const pool = `superdevops_${site.name.replace(/[^A-Za-z0-9]/g, '_')}`
    const method = site.lbMethod === 'least_conn' ? ['    least_conn;'] : site.lbMethod === 'ip_hash' ? ['    ip_hash;'] : []
    const servers = (site.backends ?? []).map((b) => {
      const flags = [b.weight > 1 ? `weight=${b.weight}` : '', 'max_fails=3', 'fail_timeout=15s', b.backup ? 'backup' : ''].filter(Boolean)
      return `    server ${b.address} ${flags.join(' ')};`
    })
    return [
      head[0],
      `upstream ${pool} {`,
      ...method,
      ...servers,
      `}`,
      ``,
      ...head.slice(1),
      `    location / {`,
      `        proxy_pass http://${pool};`,
      `        proxy_http_version 1.1;`,
      `        proxy_set_header Host $host;`,
      `        proxy_set_header X-Real-IP $remote_addr;`,
      `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
      `        proxy_set_header X-Forwarded-Proto $scheme;`,
      `        proxy_set_header Upgrade $http_upgrade;`,
      `        proxy_set_header Connection "upgrade";`,
      `        proxy_connect_timeout 5s;`,
      `        proxy_read_timeout 120s;`,
      `        # A failed server is skipped and the request is retried on the next one.`,
      `        proxy_next_upstream error timeout http_502 http_503 http_504;`,
      `        proxy_next_upstream_tries 3;`,
      `    }`,
      `}`,
      ``
    ].join('\n')
  }

  if (site.appType === 'proxy' && hasRootRule(site)) return [...head, `}`, ``].join('\n')
  if (site.appType === 'proxy') {
    return [
      ...head,
      `    location / {`,
      `        proxy_pass http://127.0.0.1:${site.proxyPort};`,
      `        proxy_http_version 1.1;`,
      `        proxy_set_header Host $host;`,
      `        proxy_set_header X-Real-IP $remote_addr;`,
      `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
      `        proxy_set_header X-Forwarded-Proto $scheme;`,
      `        proxy_set_header Upgrade $http_upgrade;`,
      `        proxy_set_header Connection "upgrade";`,
      `        proxy_read_timeout 120s;`,
      `    }`,
      `}`,
      ``
    ].join('\n')
  }

  const lines = [
    ...head,
    ...previewLines(site, banner),
    `    index ${site.appType === 'php' ? 'index.php index.html index.htm' : 'index.html index.htm'};`,
    ``,
    // With a rule for "/" the proxy answers the whole site instead.
    ...(hasRootRule(site) ? [] : [rewriteBlock(site), ``])
  ]
  if (site.appType === 'php') {
    lines.push(
      `    location ~ \\.php$ {`,
      `        try_files $uri =404;`,
      `        fastcgi_pass ${phpUpstream};`,
      `        fastcgi_index index.php;`,
      `        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;`,
      `        include fastcgi_params;`,
      `    }`,
      ``
    )
  }
  // Browser caching of pictures, styles and scripts: 7 days on a static site unless set otherwise, off on a PHP site unless asked for.
  const cacheDays = cacheDaysOf(site)
  if (cacheDays > 0) {
    lines.push(
      `    location ~* \\.(?:css|js|mjs|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf)$ {`,
      // While a preview exists, the browser keeps live and preview copies apart and does not keep preview ones.
      ...(previewLines(site).length > 1 ? [`        expires $sd_expires;`, `        add_header Vary Cookie;`] : [`        expires ${cacheDays}d;`]),
      `        access_log off;`,
      `    }`,
      ``
    )
  }
  lines.push(hidden, `}`, ``)
  return lines.join('\n')
}

const PREFLIGHT = `
${PATH_EXPORT}
echo "os=$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")"
if command -v nginx >/dev/null 2>&1; then echo "nginx=$(nginx -v 2>&1 | sed 's#.*/##' | head -1)"; else echo "nginx="; fi
if command -v php >/dev/null 2>&1; then echo "php=$(php -r 'echo PHP_VERSION;' 2>/dev/null)"; else echo "php="; fi
if command -v git >/dev/null 2>&1; then echo "git=$(git --version | awk '{print $3}')"; else echo "git="; fi
if command -v node >/dev/null 2>&1; then echo "node=$(node -v 2>/dev/null)"; else echo "node="; fi
command -v unzip >/dev/null 2>&1 && echo "unzip=1" || echo "unzip="
command -v composer >/dev/null 2>&1 && echo "composer=1" || echo "composer="
nginx -V 2>&1 | grep -q http_sub_module && echo "subfilter=1"
CONFDIR=""
for d in /etc/nginx/conf.d /www/server/panel/vhost/nginx /usr/local/nginx/conf/conf.d; do
  if [ -d "$d" ]; then CONFDIR="$d"; break; fi
done
echo "confdir=$CONFDIR"
echo "phpsock=$(ls /run/php/php*-fpm.sock /run/php-fpm/*.sock /var/run/php-fpm/*.sock /tmp/php-cgi-*.sock 2>/dev/null | sort -uV | tr '\\n' ',')"
WEBUSER=$(ps -eo user,comm 2>/dev/null | awk '$2=="nginx" && $1!="root"{print $1; exit}')
if [ -z "$WEBUSER" ]; then for u in www-data nginx www apache; do if id "$u" >/dev/null 2>&1; then WEBUSER="$u"; break; fi; done; fi
echo "webuser=$WEBUSER"
PM=""
for p in apt-get dnf yum; do if command -v "$p" >/dev/null 2>&1; then PM="$p"; break; fi; done
echo "pm=$PM"
`

export async function preflight(client: Client): Promise<ServerEnv> {
  const res = await exec(client, wrapScript(PREFLIGHT), { timeoutMs: 20000 })
  const kv: Record<string, string> = {}
  for (const line of res.stdout.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim()
  }
  if (!('nginx' in kv)) throw new Error(res.stderr.trim() || 'Could not inspect the server.')
  return {
    os: kv.os ?? '',
    nginx: kv.nginx ?? '',
    php: kv.php ?? '',
    git: kv.git ?? '',
    node: kv.node ?? '',
    unzip: kv.unzip === '1',
    composer: kv.composer === '1',
    confDir: kv.confdir ?? '',
    phpSockets: (kv.phpsock ?? '').split(',').filter(Boolean),
    webUser: kv.webuser ?? '',
    packageManager: kv.pm ?? '',
    subFilter: kv.subfilter === '1'
  }
}

export function resolvePhpUpstream(site: Site, env: ServerEnv): string {
  if (site.phpUpstream) return site.phpUpstream
  const sock = env.phpSockets[env.phpSockets.length - 1]
  return sock ? `unix:${sock}` : '127.0.0.1:9000'
}

function archiveKind(file: string): 'zip' | 'tar' | null {
  const f = file.toLowerCase()
  if (f.endsWith('.zip')) return 'zip'
  if (f.endsWith('.tar.gz') || f.endsWith('.tgz')) return 'tar'
  return null
}

/** Name of the Supervisor program that runs a site's app. It shows on the Supervisor page under this name. */
export function runnerProgram(site: Site): string {
  return `site-${site.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`.slice(0, 40).replace(/-+$/, '')
}

const RUN_DIR = '/etc/superdevops/run'
// How long a freshly started app may take before it listens. Overridable so tests do not wait.
const START_WAIT = (): number => Math.max(5, Number(process.env.SUPERDEVOPS_START_WAIT) || 90)

/** Shell that takes a site's program away again (site removed, or switched back to "I start it myself"). */
function runnerRemoveLines(site: Site): string[] {
  const prog = runnerProgram(site)
  return [
    SUP_SHELL,
    `PROG=${shq(prog)}`,
    'if [ -n "$DIR" ] && [ -f "$DIR/superdevops-$PROG.$EXT" ]; then',
    '  supervisorctl stop "$PROG:*" >/dev/null 2>&1 || true',
    '  unlink "$DIR/superdevops-$PROG.$EXT"',
    '  supervisorctl reread >/dev/null 2>&1 || true; supervisorctl update "$PROG" >/dev/null 2>&1 || true',
    '  echo "Stopped and removed the program $PROG"',
    'fi',
    `if [ -f ${RUN_DIR}/${prog}.sh ]; then unlink ${RUN_DIR}/${prog}.sh; fi`
  ]
}

/** Shell that (re)starts a site's app under Supervisor and waits until it runs and listens. */
function runnerStartLines(site: Site, env: ServerEnv): string[] {
  const r = site.runner!
  const root = site.rootPath.replace(/\/+$/, '')
  const prog = runnerProgram(site)
  const user = r.user || env.webUser || 'www-data'
  const port = site.proxyPort
  const command = r.command.trim().replace(/\{port\}/g, String(port))
  const launcher = [
    '#!/bin/sh',
    `# Managed by SuperDevops: starts the site ${site.name}. Change the command in the app, on the site's settings.`,
    `cd ${shq(root)} || exit 1`,
    `export PORT=${port}`,
    ...(r.kind === 'python' ? [`export VIRTUAL_ENV=${shq(`${root}/.venv`)}`, `export PATH=${shq(`${root}/.venv/bin`)}:"$PATH"`, 'export PYTHONUNBUFFERED=1'] : []),
    'export PATH="$PATH:/usr/local/bin"',
    // exec makes the app itself the program Supervisor watches; a chain of commands cannot be exec'ed.
    /[;&|]/.test(command) ? command : `exec ${command}`
  ]
  const conf = [
    `; Managed by SuperDevops for the site ${site.name}. It is rewritten on every deploy.`,
    `[program:${prog}]`,
    `command=/bin/sh ${RUN_DIR}/${prog}.sh`,
    `directory=${root}`,
    `user=${user}`,
    'autostart=true',
    'autorestart=true',
    'startsecs=2',
    'stopasgroup=true',
    'killasgroup=true',
    'stopwaitsecs=30',
    'redirect_stderr=true',
    `stdout_logfile=/var/log/supervisor/superdevops-${prog}.log`,
    'stdout_logfile_maxbytes=10MB',
    'stdout_logfile_backups=3'
  ]
  const b64 = (lines: string[]): string => Buffer.from(lines.join('\n') + '\n', 'utf8').toString('base64')
  return [
    'step "Starting the app"',
    SUP_SHELL,
    'command -v supervisorctl >/dev/null 2>&1 || { echo "Supervisor is not installed on this server. Install it first: App Store, Supervisor."; exit 32; }',
    '[ -n "$DIR" ] || { echo "Supervisor\'s include folder was not found on this server."; exit 32; }',
    ...(r.kind === 'java' ? ['command -v java >/dev/null 2>&1 || { echo "Java is not installed on this server. Install it first: App Store, Java."; exit 34; }'] : []),
    `RUNUSER=${shq(user)}`,
    'id "$RUNUSER" >/dev/null 2>&1 || { echo "There is no user $RUNUSER on this server to run the app as."; exit 33; }',
    `PROG=${shq(prog)}`,
    `LOG=/var/log/supervisor/superdevops-$PROG.log`,
    `mkdir -p ${RUN_DIR} /var/log/supervisor`,
    `echo ${b64(launcher)} | base64 -d > ${RUN_DIR}/${prog}.sh`,
    `chmod 755 ${RUN_DIR} ${RUN_DIR}/${prog}.sh`,
    // The app writes its own files (uploads, caches, the Python environment), so the folder is its user's.
    'chown -R "$RUNUSER":"$(id -gn "$RUNUSER")" "$ROOT"',
    'sup_start || { echo "Supervisor is not running and could not be started."; exit 32; }',
    `echo ${b64(conf)} | base64 -d > "$DIR/superdevops-$PROG.$EXT"`,
    'supervisorctl reread >/dev/null 2>&1 || true',
    'supervisorctl update "$PROG" >/dev/null 2>&1 || true',
    'supervisorctl restart "$PROG" >/dev/null 2>&1 || true',
    'STARTFAIL=0',
    'UP=0',
    'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do',
    '  sleep 1',
    `  STATE=$(supervisorctl status "$PROG" 2>/dev/null | awk '{print $2}' || true)`,
    '  if [ "$STATE" = RUNNING ]; then UP=1; break; fi',
    '  if [ "$STATE" = FATAL ]; then break; fi',
    'done',
    'if [ "$UP" != 1 ]; then',
    '  echo "The app did not stay running. The end of its output:"',
    '  tail -n 40 "$LOG" 2>/dev/null || true',
    '  STARTFAIL=1',
    'else',
    '  echo "The app is running as $RUNUSER (Supervisor program $PROG)."',
    // Some apps (Java) need a while before they listen; visitors get an error page until then.
    '  LISTEN=0',
    `  for i in $(seq 1 ${START_WAIT()}); do`,
    `    if (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null; then LISTEN=1; break; fi`,
    `    STATE=$(supervisorctl status "$PROG" 2>/dev/null | awk '{print $2}' || true)`,
    '    if [ "$STATE" != RUNNING ] && [ "$STATE" != STARTING ]; then echo "The app stopped again. The end of its output:"; tail -n 40 "$LOG" 2>/dev/null || true; STARTFAIL=1; break; fi',
    '    sleep 1',
    '  done',
    '  if [ "$STARTFAIL" = 0 ]; then',
    `    if [ "$LISTEN" = 1 ]; then echo "It answers on port ${port}."; else echo "It runs, but after ${START_WAIT()} seconds nothing listens on port ${port}. Check that the start command uses this port. The end of its output:"; tail -n 20 "$LOG" 2>/dev/null || true; STARTFAIL=1; fi`,
    '  fi',
    'fi',
    // Said on a line of its own so the app can put the previous version back; the deploy still fails at its end.
    'if [ "$STARTFAIL" = 1 ]; then echo "@@startfailed=1"; fi'
  ]
}

/**
 * Shell that opens ports 80 and 443 in the server's own firewall when it is switched on and they are closed.
 * A port someone has deliberately denied is left alone. A cloud provider's firewall is out of reach from here.
 */
const WEB_PORTS = [
  'if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "^Status: active"; then',
  '  for P in 80 443; do',
  '    RULES=$(ufw status | grep -E "^$P(/tcp)?[[:space:]]" || true)',
  '    if echo "$RULES" | grep -Eq "DENY|REJECT"; then echo "Port $P is blocked by a firewall rule on this server; it was left as it is."',
  '    elif ! echo "$RULES" | grep -Eq "ALLOW[[:space:]]+Anywhere"; then',
  "      if ufw allow $P/tcp comment 'superdevops-web' >/dev/null 2>&1; then echo \"Opened port $P in the server's firewall\"; fi",
  '    fi',
  '  done',
  'elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then',
  '  FWCH=0',
  '  for S in http https; do',
  "    if ! firewall-cmd -q --query-service=$S; then if firewall-cmd -q --permanent --add-service=$S; then FWCH=1; echo \"Opened $S in the server's firewall\"; fi; fi",
  '  done',
  '  if [ "$FWCH" = 1 ]; then firewall-cmd -q --reload || true; fi',
  'fi'
]

/** Keep a copy of what is live now, so this deploy can be undone. */
function snapshotLines(site: Site): string[] {
  return [
    `SNAPDIR=${shq(`${SNAPSHOT_DIR}/${site.name}`)}`,
    'if [ -d "$ROOT" ] && [ -n "$(ls -A "$ROOT" 2>/dev/null)" ]; then',
    '  step "Saving the current version for rollback"',
    '  SIZE=$(du -sm "$ROOT" 2>/dev/null | cut -f1)',
    '  if [ "${SIZE:-0}" -gt 2048 ]; then',
    '    echo "Skipped: the site is larger than 2 GB, so no rollback copy was made."',
    '  else',
    '    umask 077; mkdir -p "$SNAPDIR"',
    '    SNAP="$SNAPDIR/$(date +%Y%m%d-%H%M%S).tar.gz"',
    '    tar -czf "$SNAP" -C "$ROOT" . && echo "@@snapshot=$SNAP" && echo "Saved ($(du -h "$SNAP" | cut -f1))"',
    '    ls -1t "$SNAPDIR"/*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f',
    '    umask 022',
    '  fi',
    'fi'
  ]
}

/**
 * Unpack the upload waiting in $TMP into a folder. An upload that holds only one folder with the site in it
 * (a zip of "dist/" or "web/") is unwrapped, so the site's files land at the site's root and not one folder down.
 */
function unpackLines(kind: 'folder' | 'zip' | 'tar' | undefined, into: string, publicDir: string): string[] {
  const dest = `"${into}"`
  const out: string[] = []
  if (kind === 'folder') out.push('STAGE="$TMP"')
  else out.push('STAGE=$(mktemp -d /tmp/superdevops-unpack-XXXXXX)')
  if (kind === 'zip') {
    out.push(
      'command -v unzip >/dev/null 2>&1 || { echo "unzip is not installed on the server."; exit 22; }',
      '# Mac leftovers ("._name" files, __MACOSX, .DS_Store) are not part of a site. A pattern with nothing to skip is not an error.\nunzip_clean() { local out rc; if out=$(unzip -oq -- "$1" -d "$2" -x "__MACOSX/*" "._*" "*/._*" ".DS_Store" "*/.DS_Store" 2>&1); then rc=0; else rc=$?; fi; printf \'%s\\n\' "$out" | grep -v -e \'^caution: excluded filename not matched\' -e \'^$\' || true; return $rc; }',
      'unzip_clean "$TMP" "$STAGE"'
    )
  } else if (kind === 'tar') {
    // Mac leftovers ("._name" files, __MACOSX, .DS_Store) are not part of a site.
    out.push('tar -xzf "$TMP" -C "$STAGE" --exclude="._*" --exclude=__MACOSX --exclude=.DS_Store')
  }
  out.push(
    `PUB=${shq(publicDir.replace(/^\/+|\/+$/g, ''))}`,
    'SRC="$STAGE"',
    'TOP=$(ls -A "$STAGE")',
    // Not when that one folder is the site's own public folder (a Laravel "public/").
    'if [ -n "$TOP" ] && [ "$(printf \'%s\\n\' "$TOP" | wc -l)" -eq 1 ] && [ -d "$STAGE/$TOP" ] && [ "$TOP" != "${PUB%%/*}" ] && ! ls "$STAGE"/index.* >/dev/null 2>&1; then',
    '  if ls "$STAGE/$TOP"/index.* >/dev/null 2>&1 || { [ -n "$PUB" ] && [ -d "$STAGE/$TOP/$PUB" ]; }; then',
    '    SRC="$STAGE/$TOP"',
    '    echo "The upload holds one folder, \"$TOP\", with the site in it: its contents were used as the site\'s files."',
    '  fi',
    'fi',
    `mkdir -p ${dest}`,
    `cp -a "$SRC/." ${dest}/`,
    '[ "$STAGE" = "$TMP" ] || rm -rf "$STAGE"',
    `if [ -z "$PUB" ] && ! ls ${dest}/index.* >/dev/null 2>&1; then echo "Note: there is no index.html or index.php at the top of the site's folder, so its address answers 403 until one is there."; fi`
  )
  return out
}

export function buildDeployScript(opts: {
  site: Site
  env: ServerEnv
  nginxConf: string
  /** Remote temp path that holds the uploaded folder or archive. */
  uploadTmp?: string
  uploadKind?: 'folder' | 'zip' | 'tar'
  /** Only write the nginx config; leave the code alone. */
  configOnly?: boolean
  /** Rollback, git sites: check out this commit instead of fetching. */
  checkoutCommit?: string
  /** Rollback, upload sites: unpack this snapshot over the site. */
  restoreSnapshot?: string
  /** Sign in to the Git host with this name and the token waiting in this temporary file. */
  gitAuth?: { username: string; tokenFile: string; /** The token file belongs to the server (auto deploy) and must stay. */ keep?: boolean }
  /** preview: the upload goes to "<root>.preview" (a copy of the live files plus the upload); promote: that preview becomes the live files. */
  mode?: 'preview' | 'promote'
}): string {
  const { site, env } = opts
  const root = site.rootPath.replace(/\/+$/, '')
  const conf = `${env.confDir}/${confFileName(site)}`
  const confB64 = Buffer.from(opts.nginxConf, 'utf8').toString('base64')
  const out: string[] = [
    'set -e',
    PATH_EXPORT,
    'export GIT_TERMINAL_PROMPT=0',
    `ROOT=${shq(root)}`,
    'step() { echo; echo "==> $1"; }'
  ]

  const hasCode = site.appType !== 'balancer' && !opts.configOnly

  if (site.appType === 'balancer') {
    out.push('step "Load balancer: no code to deploy"')
  } else if (opts.configOnly) {
    out.push('step "Keeping the files that are already in place"', 'mkdir -p "$ROOT"')
  } else if (opts.restoreSnapshot) {
    out.push(
      'step "Restoring the saved version"',
      `SNAP=${shq(opts.restoreSnapshot)}`,
      '[ -f "$SNAP" ] || { echo "That saved version is no longer on the server."; exit 24; }',
      'mkdir -p "$ROOT"',
      'tar -xzf "$SNAP" -C "$ROOT"',
      'echo "Files restored. Files created after that version were left in place."'
    )
  } else if (site.source === 'git' && opts.checkoutCommit) {
    out.push(
      `step "Going back to version ${opts.checkoutCommit.slice(0, 7)}"`,
      'g() { git -c safe.directory="$ROOT" "$@"; }',
      `BRANCH=${shq(site.branch)}`,
      `WANT=${shq(opts.checkoutCommit)}`,
      '[ -d "$ROOT/.git" ] || { echo "$ROOT is not a git checkout."; exit 23; }',
      'cd "$ROOT"',
      'g cat-file -e "$WANT^{commit}" 2>/dev/null || { echo "That version is no longer in the repository on the server."; exit 23; }',
      'echo "@@prev=$(g rev-parse HEAD 2>/dev/null)"',
      'g checkout -q -f -B "$BRANCH" "$WANT"',
      `echo "@@commit=$(g log -1 --format='%H|%s')"`,
      'echo "Now at: $(g log -1 --format="%h %s")"'
    )
  } else if (site.source === 'git') {
    out.push(
      'step "Fetching code from git"',
      'command -v git >/dev/null 2>&1 || { echo "git is not installed on the server."; exit 20; }',
      `REPO=${shq(site.repoUrl)}`,
      `BRANCH=${shq(site.branch)}`,
      `export GIT_SSH_COMMAND='ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes'`,
      ...(opts.gitAuth
        ? [
            // The token is answered to git when it asks and is never written into the repository or its config.
            `export SD_GIT_USER=${shq(opts.gitAuth.username)} SD_GIT_TOKEN_FILE=${shq(opts.gitAuth.tokenFile)}`,
            'ASK=$(mktemp /tmp/superdevops-ask-XXXXXX)',
            opts.gitAuth.keep ? `trap 'rm -f "$ASK"' EXIT` : `trap 'rm -f "$ASK" "$SD_GIT_TOKEN_FILE"' EXIT`,
            `printf '%s\\n' '#!/bin/sh' 'case "$1" in Username*) printf "%s\\n" "$SD_GIT_USER" ;; *) cat "$SD_GIT_TOKEN_FILE" ;; esac' > "$ASK"`,
            'chmod 700 "$ASK"',
            'export GIT_ASKPASS="$ASK"',
            'echo "Signing in to the Git host with the saved account."',
            'g() { git -c safe.directory="$ROOT" -c credential.helper= "$@"; }'
          ]
        : ['g() { git -c safe.directory="$ROOT" "$@"; }']),
      'if [ -d "$ROOT/.git" ]; then',
      '  cd "$ROOT"',
      '  echo "@@prev=$(g rev-parse HEAD 2>/dev/null)"',
      '  g remote set-url origin "$REPO"',
      '  g fetch --prune origin "$BRANCH"',
      '  g checkout -f -B "$BRANCH" FETCH_HEAD',
      'else',
      '  if [ -d "$ROOT" ] && [ -n "$(ls -A "$ROOT" 2>/dev/null)" ]; then',
      '    echo "$ROOT already contains files but is not a git checkout. Empty it or choose another root path."; exit 21',
      '  fi',
      '  mkdir -p "$ROOT"',
      '  g clone --branch "$BRANCH" "$REPO" "$ROOT"',
      'fi',
      `echo "@@commit=$(g -C "$ROOT" log -1 --format='%H|%s')"`,
      'echo "Now at: $(g -C "$ROOT" log -1 --format="%h %s")"'
    )
  } else if (opts.mode === 'promote') {
    out.push(`PREV=${shq(previewRoot(site))}`, '[ -d "$PREV" ] || { echo "There is no preview on the server to push to production."; exit 26; }')
    out.push(...snapshotLines(site))
    out.push(
      'step "Putting the preview live"',
      'mkdir -p "$ROOT"',
      'if command -v rsync >/dev/null 2>&1; then',
      '  rsync -a --delete "$PREV/" "$ROOT/"',
      'else',
      '  find "$ROOT" -mindepth 1 -maxdepth 1 -exec rm -rf {} +',
      '  cp -a "$PREV/." "$ROOT/"',
      'fi',
      'echo "The live files are now the preview\'s files."'
    )
  } else if (opts.uploadTmp && opts.mode === 'preview') {
    // The preview starts as a copy of the live files, so an upload of only some files previews what a production deploy would give.
    out.push(
      `PREV=${shq(previewRoot(site))}`,
      'step "Making the preview from the live files"',
      'rm -rf "$PREV.new"; mkdir -p "$PREV.new"',
      'if [ -d "$ROOT" ]; then cp -a "$ROOT/." "$PREV.new/"; fi',
      'step "Installing uploaded files into the preview"',
      `TMP=${shq(opts.uploadTmp)}`
    )
    out.push(...unpackLines(opts.uploadKind, '$PREV.new', site.publicDir))
    out.push('rm -rf "$TMP"', 'rm -rf "$PREV"', 'mv "$PREV.new" "$PREV"', 'echo "Preview ready in $PREV. The live site is unchanged."')
  } else if (opts.uploadTmp) {
    out.push(...snapshotLines(site))
    out.push('step "Installing uploaded files"', `TMP=${shq(opts.uploadTmp)}`, 'mkdir -p "$ROOT"')
    out.push(...unpackLines(opts.uploadKind, '$ROOT', site.publicDir))
    out.push('rm -rf "$TMP"', 'echo "Files copied to $ROOT"')
  } else {
    out.push('step "Keeping existing files (no new upload)"', 'mkdir -p "$ROOT"')
  }

  const runner = site.appType === 'proxy' ? site.runner : undefined
  if (hasCode && runner?.kind === 'python') {
    out.push(
      'step "Python environment"',
      'command -v python3 >/dev/null 2>&1 || { echo "Python is not installed on this server. Install it first: App Store, Python."; exit 36; }',
      'if [ ! -x "$ROOT/.venv/bin/python" ]; then',
      '  python3 -m venv "$ROOT/.venv" || { echo "Python could not make the site\'s environment. Open App Store, Python and press Install to add what is missing."; exit 36; }',
      '  echo "Made the environment in $ROOT/.venv"',
      'fi',
      'if [ -f "$ROOT/requirements.txt" ]; then',
      '  "$ROOT/.venv/bin/python" -m pip install --disable-pip-version-check -q -r "$ROOT/requirements.txt" || { echo "Installing the packages in requirements.txt failed."; exit 37; }',
      '  echo "Packages from requirements.txt are installed"',
      'else',
      '  echo "No requirements.txt in the site folder, so no packages were installed."',
      'fi'
    )
  }

  if (hasCode && site.postDeploy.trim() && opts.mode === 'preview') {
    // Post-deploy commands often change the database (migrations), which the preview shares with the live site.
    out.push('step "Post-deploy commands"', 'echo "Not run for a preview: they run when the preview is pushed to production."')
  } else if (hasCode && site.postDeploy.trim()) {
    out.push('step "Running post-deploy commands"', '(', 'cd "$ROOT"', ...(runner?.kind === 'python' ? ['export VIRTUAL_ENV="$ROOT/.venv" PATH="$ROOT/.venv/bin:$PATH"'] : []), site.postDeploy.trim(), ')')
  }

  if (runner) out.push(...runnerStartLines(site, env))
  else if (site.appType === 'proxy') out.push(...runnerRemoveLines(site))

  if (site.appType === 'php' || site.appType === 'static') {
    out.push(
      'step "Setting permissions"',
      `WEBUSER=${shq(env.webUser)}`,
      'if [ -n "$WEBUSER" ] && id "$WEBUSER" >/dev/null 2>&1; then',
      '  chown -R "$WEBUSER":"$(id -gn "$WEBUSER")" "$ROOT"',
      '  if [ -n "${PREV:-}" ] && [ -d "$PREV" ]; then chown -R "$WEBUSER":"$(id -gn "$WEBUSER")" "$PREV"; fi',
      '  echo "Owner set to $WEBUSER"',
      'else',
      '  echo "No web user found, leaving ownership unchanged."',
      'fi'
    )
  }

  if (site.appType === 'php' && hasCode) {
    // PHP's opcache can keep serving the old code after a deploy; reloading PHP-FPM clears it.
    out.push(
      'if [ -d /run/systemd/system ]; then',
      "  for svc in $(systemctl list-units --type=service --state=running --no-legend 'php*fpm*' 2>/dev/null | awk '{print $1}'); do",
      '    systemctl reload "$svc" 2>/dev/null && echo "Reloaded $svc" || true',
      '  done',
      'else',
      '  for pid in $(pgrep -f "php-fpm: master process" 2>/dev/null); do kill -USR2 "$pid" 2>/dev/null && echo "Reloaded PHP-FPM (pid $pid)" || true; done',
      'fi'
    )
  }

  out.push(
    'step "Writing nginx config"',
    `CONF=${shq(conf)}`,
    'mkdir -p /var/log/nginx',
    'if [ -f "$CONF" ]; then cp "$CONF" "$CONF.bak"; fi',
    `echo ${confB64} | base64 -d > "$CONF"`,
    'if ! nginx -t 2>&1; then',
    '  echo "nginx rejected the config. Rolling back."',
    '  if [ -f "$CONF.bak" ]; then mv "$CONF.bak" "$CONF"; else rm -f "$CONF"; fi',
    '  exit 30',
    'fi',
    'rm -f "$CONF.bak"',
    'systemctl reload nginx 2>/dev/null || nginx -s reload',
    'echo "nginx reloaded"',
    ...WEB_PORTS,
    'if [ "${STARTFAIL:-0}" = 1 ]; then echo; echo "The files are in place, but the app is not running."; exit 35; fi',
    'step "Deploy finished"'
  )
  return out.join('\n') + '\n'
}

function sudoHint(output: string, sudo: Sudo): string | null {
  if (sudo.mode === 'none') return null
  if (/a password is required|a terminal is required/i.test(output)) {
    return 'This user needs a password for sudo. Edit the project to use password login, log in as root, or allow passwordless sudo.'
  }
  if (/incorrect password|Sorry, try again|is not in the sudoers/i.test(output)) {
    return 'sudo refused this user. Check the password, or that the user is allowed to use sudo.'
  }
  return null
}

export async function runPrivileged(
  client: Client,
  script: string,
  sudo: Sudo,
  log?: (s: string) => void,
  timeoutMs?: number
): Promise<ExecResult> {
  const res = await exec(client, wrapScript(script, sudo.mode), { stdin: sudo.stdin, onData: log, timeoutMs })
  if (res.code !== 0) {
    const hint = sudoHint(res.stdout + res.stderr, sudo)
    // Our scripts print their own explanation to stdout before exiting; prefer it over raw tool noise on stderr.
    const last = (res.stdout.trim() || res.stderr.trim()).split('\n').pop() ?? ''
    throw new Error(hint ?? (log ? `The server reported an error (exit code ${res.code}). See the log above.` : last || (res.code === null ? `The server stopped the command before it could finish${res.signal ? ` (signal ${res.signal})` : ''} and sent no answer. A security tool on the server may be blocking it.` : `The server reported an error (exit code ${res.code}).`)))
  }
  return res
}

export async function runDeploy(opts: {
  client: Client
  sudo: Sudo
  site: Site
  upload?: UploadSource
  /** Saved Git account to fetch the code with. */
  git?: GitSignIn
  configOnly?: boolean
  /** Rollback: put this commit (git sites) or saved copy (upload sites) back instead of deploying. */
  checkoutCommit?: string
  restoreSnapshot?: string
  mode?: 'preview' | 'promote'
  log: (chunk: string) => void
}): Promise<DeployOutcome> {
  const { client, sudo, site, upload } = opts
  if (opts.mode && !canPreview(site)) throw new Error('Previews are for uploaded static and PHP sites.')
  if (opts.mode === 'preview' && !upload) throw new Error('Choose the files for the preview.')
  validateSite(site)
  if (opts.checkoutCommit && !RE_HASH.test(opts.checkoutCommit)) throw new Error('Unknown version.')
  if (opts.restoreSnapshot && !new RegExp(`^${SNAPSHOT_DIR}/${site.name.replace(/[.]/g, '\\.')}/\\d{8}-\\d{6}\\.tar\\.gz$`).test(opts.restoreSnapshot)) {
    throw new Error('Unknown saved version.')
  }
  // The script reports facts for the history on lines starting with "@@"; keep those out of the visible log.
  let pending = ''
  let seen = ''
  const log = (chunk: string): void => {
    seen = (seen + chunk).slice(-200000)
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    const shown = lines.filter((l) => !l.startsWith('@@'))
    if (shown.length > 0) opts.log(shown.join('\n') + '\n')
  }

  log('==> Checking server environment\n')
  const env = await preflight(client)
  if (!env.nginx) throw new Error('nginx is not installed on this server. Use "Install nginx, git, unzip" first.')
  if (!env.confDir) throw new Error('Could not find the nginx config folder (looked for /etc/nginx/conf.d).')
  log(`nginx ${env.nginx} · config folder ${env.confDir}\n`)

  const upstream = resolvePhpUpstream(site, env)
  if (site.appType === 'php') {
    if (!site.phpUpstream && env.phpSockets.length === 0) {
      log('Warning: no PHP-FPM socket found. Using 127.0.0.1:9000 - PHP pages will fail until PHP-FPM is installed.\n')
    } else {
      log(`PHP-FPM upstream: ${upstream}\n`)
    }
  }

  let uploadTmp: string | undefined
  let uploadKind: 'folder' | 'zip' | 'tar' | undefined
  if (site.source === 'upload' && upload && !opts.configOnly) {
    const base = `/tmp/superdevops-${site.id.replace(/[^A-Za-z0-9-]/g, '')}-${Date.now()}`
    const sftp = await openSftp(client)
    try {
      if (upload.kind === 'archive') {
        const kind = archiveKind(upload.path)
        if (!kind) throw new Error('Archive must be a .zip, .tar.gz or .tgz file.')
        uploadKind = kind
        uploadTmp = `${base}.${kind === 'zip' ? 'zip' : 'tar.gz'}`
        log(`\n==> Uploading archive\n${upload.path}\n`)
        await uploadFile(sftp, upload.path, uploadTmp)
      } else {
        uploadKind = 'folder'
        uploadTmp = base
        log(`\n==> Uploading folder\n${upload.path}\n`)
        const total = await uploadDir(sftp, upload.path, uploadTmp, (_rel, count) => {
          if (count % 25 === 0) log(`  ${count} files...\n`)
        })
        log(`  ${total} files uploaded\n`)
      }
    } finally {
      sftp.end()
    }
  }

  // A saved Git account: park the token in a private temporary file that the script reads once and removes.
  let gitAuth: { username: string; tokenFile: string } | undefined
  if (opts.git && site.source === 'git' && !opts.configOnly && !opts.checkoutCommit && !opts.restoreSnapshot) {
    if (!/^https?:\/\//i.test(site.repoUrl)) throw new Error('A saved Git account works with an https:// repository URL. Change the URL, or choose "Server\'s own access".')
    gitAuth = { username: opts.git.username, tokenFile: await writeRemoteTemp(client, opts.git.token + '\n') }
  }

  const script = buildDeployScript({
    site,
    env,
    gitAuth,
    nginxConf: buildNginxConf(site, upstream, env),
    uploadTmp,
    uploadKind,
    configOnly: opts.configOnly,
    checkoutCommit: opts.checkoutCommit,
    restoreSnapshot: opts.restoreSnapshot,
    mode: opts.mode
  })
  let res: ExecResult
  try {
    res = await runPrivileged(client, script, sudo, log)
  } catch (err) {
    // The code arrived but the app would not start: say which version was live before, so it can be put back.
    if (/^@@startfailed=1$/m.test(seen)) throw new StartFailed(outcomeOf(seen))
    throw err
  } finally {
    if (gitAuth) await exec(client, `rm -f -- ${shq(gitAuth.tokenFile)}`, { timeoutMs: 15000 }).catch(() => undefined)
  }
  if (pending && !pending.startsWith('@@')) opts.log(pending)
  return outcomeOf(res.stdout)
}

function outcomeOf(stdout: string): DeployOutcome {
  const fact = (key: string): string | undefined => new RegExp(`^@@${key}=(.*)$`, 'm').exec(stdout)?.[1].trim() || undefined
  const commitLine = fact('commit')
  return {
    prevCommit: fact('prev'),
    commit: commitLine?.split('|')[0],
    commitMessage: commitLine?.includes('|') ? commitLine.slice(commitLine.indexOf('|') + 1) : undefined,
    snapshot: fact('snapshot')
  }
}

/** A deploy whose files arrived but whose app (started by the deploy) did not come up. */
export class StartFailed extends Error {
  constructor(public outcome: DeployOutcome) {
    super('The app did not start after this deploy. See the log above.')
  }
}

/** Name and token for the Git host, used for one deploy. */
export interface GitSignIn {
  username: string
  token: string
}

export interface DeployOutcome {
  prevCommit?: string
  commit?: string
  commitMessage?: string
  snapshot?: string
}

// ---------------------------------------------------------------- health check and safe deploy
/** Ask the site for a page from the server itself. Returns the HTTP status, 0 when nothing answers. */
export async function healthCheck(client: Client, site: Site, cookie?: string): Promise<number> {
  const jar = cookie ? ` -H ${shq(`Cookie: ${cookie}`)}` : ''
  const domain = site.domain.trim().split(/\s+/).find((d) => d !== '_' && !d.includes('*')) ?? 'localhost'
  const path = site.healthPath && RE_HEALTH.test(site.healthPath) ? site.healthPath : '/'
  const cmd =
    site.ssl && site.forceHttps
      ? `curl -sk${jar} -o /dev/null -m 8 -w '%{http_code}' --resolve ${shq(`${domain}:443:127.0.0.1`)} ${shq(`https://${domain}${path}`)}`
      : `curl -s${jar} -o /dev/null -m 8 -w '%{http_code}' -H ${shq(`Host: ${domain}`)} ${shq(`http://127.0.0.1${path}`)}`
  const res = await exec(client, `${cmd} 2>/dev/null || true`, { timeoutMs: 15000 })
  const code = Number(res.stdout.trim().slice(-3))
  return Number.isInteger(code) ? code : 0
}

/** A site counts as failing when nothing answers or it answers with a server error. */
export function isHealthy(code: number): boolean {
  return code > 0 && code < 500
}

/** nginx and PHP reload in the background, so give the site a few seconds to settle. */
async function settleHealth(client: Client, site: Site, cookie?: string): Promise<number> {
  let code = 0
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 800 : 1200))
    code = await healthCheck(client, site, cookie)
    if (isHealthy(code)) break
  }
  return code
}

export type DeployResult = Omit<DeployRecord, 'id' | 'siteId' | 'time'>

/**
 * Deploy, then check the site still answers. If this deploy broke it and an
 * earlier version is available, go back to that version.
 */
export async function safeDeploy(opts: { client: Client; sudo: Sudo; site: Site; upload?: UploadSource; git?: GitSignIn; mode?: 'promote'; log: (chunk: string) => void }): Promise<DeployResult> {
  const { client, sudo, site, upload, log } = opts
  validateSite(site)
  const check = site.appType !== 'balancer' && !site.maintenance && !site.stopped
  const before = check ? await healthCheck(client, site) : null
  let out: DeployOutcome
  try {
    out = await runDeploy({ client, sudo, site, upload, git: opts.git, mode: opts.mode, log })
  } catch (err) {
    if (!(err instanceof StartFailed)) throw err
    // The new version would not start. Put the previous one back, the same way as when a deploy breaks the site.
    const o = err.outcome
    const failed: DeployResult = { kind: 'deploy', status: 'failed', ...o }
    const canGoBack = (!!o.prevCommit && o.prevCommit !== o.commit) || !!o.snapshot
    if (site.autoRollback === false || !canGoBack) {
      const why = site.autoRollback === false ? 'Automatic rollback is switched off for this site.' : 'There is no earlier version to go back to.'
      log(`${why}\n`)
      return { ...failed, note: `The new version did not start. ${why}` }
    }
    log('\n==> The new version did not start. Rolling back\n')
    try {
      await runDeploy({ client, sudo, site, checkoutCommit: o.snapshot ? undefined : o.prevCommit, restoreSnapshot: o.snapshot, log })
    } catch (again) {
      log(`The previous version could not be started either: ${(again as Error).message}\n`)
      return { ...failed, note: 'The new version did not start, and the previous one could not be started either.' }
    }
    const restored = check ? await settleHealth(client, site) : undefined
    if (check) log(restored ? `After the rollback the site answers with HTTP ${restored}\n` : 'After the rollback the site still does not answer\n')
    return { ...failed, status: 'rolled_back', health: restored, note: 'The new version did not start, so the previous version was put back.' }
  }
  const base: DeployResult = { kind: opts.mode === 'promote' ? 'promote' : 'deploy', status: 'success', ...out }
  if (!check) return base

  log('\n==> Checking that the site answers\n')
  const after = await settleHealth(client, site)
  log(after ? `The site answered with HTTP ${after}\n` : 'The site did not answer\n')
  if (isHealthy(after)) return { ...base, health: after }

  if (before !== null && !isHealthy(before)) {
    log('The site was already failing before this deploy, so nothing was rolled back.\n')
    return { ...base, health: after, note: 'The site was already failing before this deploy.' }
  }
  const canGoBack = (!!out.prevCommit && out.prevCommit !== out.commit) || !!out.snapshot
  if (site.autoRollback === false || !canGoBack) {
    const why = site.autoRollback === false ? 'Automatic rollback is switched off for this site.' : 'There is no earlier version to go back to.'
    log(`${why}\n`)
    return { ...base, status: 'failed', health: after, note: `Deployed, but the site answers with ${after ? `HTTP ${after}` : 'nothing'}. ${why}` }
  }

  log('\n==> This deploy broke the site. Rolling back\n')
  await runDeploy({ client, sudo, site, checkoutCommit: out.snapshot ? undefined : out.prevCommit, restoreSnapshot: out.snapshot, log })
  const restored = await settleHealth(client, site)
  log(restored ? `After the rollback the site answers with HTTP ${restored}\n` : 'After the rollback the site still does not answer\n')
  return {
    ...base,
    status: 'rolled_back',
    health: restored,
    note: `The new version answered with ${after ? `HTTP ${after}` : 'nothing'}, so the previous version was put back.`
  }
}

/** Go back to the version recorded in an earlier deploy. */
export async function rollbackTo(opts: { client: Client; sudo: Sudo; site: Site; record: DeployRecord; log: (chunk: string) => void }): Promise<DeployResult> {
  const { client, sudo, site, record, log } = opts
  if (site.source === 'git' ? !record.commit : !record.snapshot) throw new Error('That deploy has no saved version to go back to.')
  const out = await runDeploy({
    client,
    sudo,
    site,
    checkoutCommit: site.source === 'git' ? record.commit : undefined,
    restoreSnapshot: site.source === 'git' ? undefined : record.snapshot,
    log
  })
  const result: DeployResult = { kind: 'rollback', status: 'success', ...out }
  if (site.appType === 'balancer' || site.maintenance || site.stopped) return result
  log('\n==> Checking that the site answers\n')
  const code = await settleHealth(client, site)
  log(code ? `The site answered with HTTP ${code}\n` : 'The site did not answer\n')
  return { ...result, health: code, status: isHealthy(code) ? 'success' : 'failed', note: isHealthy(code) ? undefined : 'Rolled back, but the site is still failing.' }
}

/** From the load balancer itself, test whether each backend accepts TCP connections. */
export async function checkBackends(client: Client, site: Site): Promise<BackendStatus[]> {
  validateSite(site)
  const backends = site.backends ?? []
  const lines = backends.map((b) => {
    const i = b.address.lastIndexOf(':')
    const host = b.address.slice(0, i)
    const port = b.address.slice(i + 1)
    return `if timeout 3 bash -c ${shq(`exec 3<>/dev/tcp/${host}/${port}`)} 2>/dev/null; then echo ${shq(b.address + '=up')}; else echo ${shq(b.address + '=down')}; fi`
  })
  const res = await exec(client, wrapScript(lines.join('\n')), { timeoutMs: 10000 + backends.length * 4000 })
  return backends.map((b) => ({ address: b.address, up: res.stdout.includes(`${b.address}=up`) }))
}

/** Remove a site's nginx config. The site's files stay on the server. */
export async function removeSiteConfig(client: Client, sudo: Sudo, site: Site, log: (s: string) => void): Promise<void> {
  validateSite(site)
  const env = await preflight(client)
  if (!env.confDir) return
  const script = [
    'set -e',
    PATH_EXPORT,
    `CONF=${shq(`${env.confDir}/${confFileName(site)}`)}`,
    'if [ -f "$CONF" ]; then',
    '  rm -f "$CONF"',
    '  nginx -t 2>&1 && (systemctl reload nginx 2>/dev/null || nginx -s reload)',
    '  echo "Removed $CONF"',
    'fi'
    ,...(site.appType === 'proxy' ? runnerRemoveLines(site) : [])
  ].join('\n')
  await runPrivileged(client, script, sudo, log)
}

export async function installPackages(
  client: Client,
  sudo: Sudo,
  group: 'base' | 'php',
  log: (s: string) => void
): Promise<void> {
  const apt = group === 'base' ? 'nginx git unzip curl' : 'php-fpm php-cli php-mysql php-mbstring php-xml php-curl php-zip php-gd'
  const rpm = group === 'base' ? 'nginx git unzip curl' : 'php-fpm php-cli php-mysqlnd php-mbstring php-xml php-gd php-zip'
  const service = group === 'base' ? 'nginx' : ''
  const script = [
    'set -e',
    PATH_EXPORT,
    'if command -v apt-get >/dev/null 2>&1; then',
    '  export DEBIAN_FRONTEND=noninteractive',
    '  apt-get update -y',
    `  apt-get install -y ${apt}`,
    'elif command -v dnf >/dev/null 2>&1; then',
    `  dnf install -y ${rpm}`,
    'elif command -v yum >/dev/null 2>&1; then',
    `  yum install -y ${rpm}`,
    'else',
    '  echo "No supported package manager (apt, dnf, yum) found."; exit 40',
    'fi',
    service
      ? `systemctl enable --now ${service} 2>/dev/null || true`
      : 'for s in $(systemctl list-unit-files 2>/dev/null | awk \'/^php.*fpm\\.service/{print $1}\'); do systemctl enable --now "$s" 2>/dev/null || true; done',
    'echo; echo "==> Install finished"'
  ].join('\n')
  await runPrivileged(client, script, sudo, log)
}

/** Upload files as a preview. The live site is not touched; the preview's answer is reported but nothing is rolled back. */
export async function previewDeploy(opts: { client: Client; sudo: Sudo; site: Site; upload: UploadSource; log: (chunk: string) => void }): Promise<DeployResult> {
  const { client, site, log } = opts
  if (!site.preview || !RE_TOKEN.test(site.preview.token)) throw new Error('The preview has no key.')
  const out = await runDeploy({ client, sudo: opts.sudo, site, upload: opts.upload, mode: 'preview', log })
  log('\n==> Checking that the preview answers\n')
  const health = await settleHealth(client, site, `apsara_preview=${site.preview.token}`)
  log(health ? `The preview answered with HTTP ${health}\n` : 'The preview did not answer\n')
  const where = site.domain.trim().split(/\s+/).find((d) => d !== '_' && !d.includes('*'))
  if (where) log(`Open ${site.ssl ? 'https' : 'http'}://${where}/preview to see it; ${site.ssl ? 'https' : 'http'}://${where}/preview/exit goes back to the live site.\n`)
  return { kind: 'preview', status: isHealthy(health) ? 'success' : 'failed', commit: out.commit, commitMessage: out.commitMessage, health, note: isHealthy(health) ? undefined : `The preview answers with ${health ? `HTTP ${health}` : 'nothing'}. The live site is not affected.` }
}

/** Remove the preview folder. Its nginx routing must already be gone. */
export async function removePreviewFiles(client: Client, sudo: Sudo, site: Site): Promise<void> {
  validateSite(site)
  const dir = previewRoot(site)
  if (!dir.endsWith('.preview') || dir.split('/').filter(Boolean).length < 2) throw new Error('Unexpected preview folder.')
  await runPrivileged(client, `rm -rf -- ${shq(dir)}\necho "Removed ${dir}"`, sudo, undefined, 300000)
}
