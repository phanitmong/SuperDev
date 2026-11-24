// GitHub's API, called from this computer with a saved access token.

export interface GithubRepo {
  /** "owner/name" */
  fullName: string
  cloneUrl: string
  private: boolean
  defaultBranch: string
  pushedAt: number
}

// Overridable for GitHub Enterprise and for tests.
const WEB = (process.env.SUPERDEVOPS_GITHUB_WEB || 'https://github.com').replace(/\/+$/, '')
const API = (process.env.SUPERDEVOPS_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '')

async function api<T>(token: string, path: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'ApsaraPanel' },
      signal: AbortSignal.timeout(20000)
    })
  } catch {
    throw new Error('GitHub could not be reached from this computer. Check your internet connection.')
  }
  if (res.status === 401) throw new Error('GitHub did not accept this token. It may be mistyped, expired or revoked.')
  if (res.status === 403 || res.status === 429) throw new Error('GitHub refused the request: the token lacks permission for this, or too many requests were made. Try again in a few minutes.')
  if (res.status === 404) throw new Error('GitHub cannot find that with this token. The token may not have access to the repository.')
  if (!res.ok) throw new Error(`GitHub answered with an error (${res.status}).`)
  return (await res.json()) as T
}

/** The account a token belongs to. Throws when GitHub rejects the token. */
export async function whoAmI(token: string): Promise<string> {
  return (await api<{ login: string }>(token, '/user')).login
}

/** Repositories the token can read, most recently pushed first (up to 300). */
export async function repos(token: string): Promise<GithubRepo[]> {
  const out: GithubRepo[] = []
  for (let page = 1; page <= 3; page++) {
    const batch = await api<{ full_name: string; clone_url: string; private: boolean; default_branch: string; pushed_at: string | null }[]>(token, `/user/repos?per_page=100&sort=pushed&page=${page}`)
    for (const r of batch) out.push({ fullName: r.full_name, cloneUrl: r.clone_url, private: r.private, defaultBranch: r.default_branch, pushedAt: r.pushed_at ? Date.parse(r.pushed_at) : 0 })
    if (batch.length < 100) break
  }
  return out
}

export async function branches(token: string, fullName: string): Promise<string[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new Error('That is not a GitHub repository name.')
  return (await api<{ name: string }[]>(token, `/repos/${fullName}/branches?per_page=100`)).map((b) => b.name)
}

export async function tags(token: string, fullName: string): Promise<string[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new Error('That is not a GitHub repository name.')
  return (await api<{ name: string }[]>(token, `/repos/${fullName}/tags?per_page=100`)).map((t) => t.name)
}

// ---------------------------------------------------------------- "Connect GitHub" (OAuth device flow)
// The person approves this app on github.com with a short code; no password or token is typed here.
// It needs the Client ID of an OAuth App registered on GitHub, with "Device Flow" enabled. No client secret is involved.

export interface DeviceStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  /** Seconds until the code stops working. */
  expiresIn: number
  /** Seconds to wait between checks. */
  interval: number
}

async function form(path: string, fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response
  try {
    res = await fetch(`${WEB}${path}`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'ApsaraPanel' }, body: new URLSearchParams(fields).toString(), signal: AbortSignal.timeout(20000) })
  } catch {
    throw new Error('GitHub could not be reached from this computer. Check your internet connection.')
  }
  let body: Record<string, unknown> = {}
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    /* an error page instead of JSON */
  }
  return { status: res.status, body }
}

export async function deviceStart(clientId: string): Promise<DeviceStart> {
  const { status, body } = await form('/login/device/code', { client_id: clientId, scope: 'repo' })
  if (body.error === 'device_flow_disabled') throw new Error('Device Flow is turned off for this OAuth App. On GitHub, open the app\'s settings, tick "Enable Device Flow" and save.')
  if (status === 404 || body.error === 'incorrect_client_credentials' || body.error === 'Not Found') throw new Error('GitHub does not know this Client ID. Copy it again from the OAuth App page.')
  if (typeof body.device_code !== 'string' || typeof body.user_code !== 'string') throw new Error(`GitHub did not start the sign-in (${String(body.error_description ?? body.error ?? status)}).`)
  return { deviceCode: body.device_code, userCode: body.user_code, verificationUri: String(body.verification_uri ?? `${WEB}/login/device`), expiresIn: Number(body.expires_in) || 900, interval: Math.max(1, Number(body.interval) || 5) }
}

export type DevicePoll = { state: 'done'; token: string } | { state: 'pending'; slower?: boolean } | { state: 'expired' } | { state: 'denied' }

/** One check on whether the person has approved yet. */
export async function devicePoll(clientId: string, deviceCode: string): Promise<DevicePoll> {
  const { body } = await form('/login/oauth/access_token', { client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
  if (typeof body.access_token === 'string' && body.access_token) return { state: 'done', token: body.access_token }
  if (body.error === 'authorization_pending') return { state: 'pending' }
  if (body.error === 'slow_down') return { state: 'pending', slower: true }
  if (body.error === 'expired_token' || body.error === 'incorrect_device_code') return { state: 'expired' }
  if (body.error === 'access_denied') return { state: 'denied' }
  throw new Error(`GitHub refused the sign-in (${String(body.error_description ?? body.error ?? 'no reason given')}).`)
}

/** "owner/name" from a GitHub address, or null when the address is not on github.com. */
export function repoName(url: string): string | null {
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return m ? m[1] : null
}
