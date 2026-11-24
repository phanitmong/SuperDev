// Signing in to Google from a desktop app, for Google Drive backups.
// The person approves on google.com with a short code ("device" sign-in); no Google password is typed here.
// It needs an OAuth client of the type "TVs and Limited Input devices" from the Google Cloud Console.

// Overridable for tests.
const OAUTH = (process.env.SUPERDEVOPS_GOOGLE_OAUTH || 'https://oauth2.googleapis.com').replace(/\/+$/, '')

/** drive.file: the app can only see and change the files it uploads itself, nothing else in the Drive. */
const SCOPE = 'openid email https://www.googleapis.com/auth/drive.file'

export interface GoogleDeviceStart {
  deviceCode: string
  userCode: string
  verificationUrl: string
  expiresIn: number
  interval: number
}

async function form(path: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(`${OAUTH}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(fields).toString(), signal: AbortSignal.timeout(20000) })
  } catch {
    throw new Error('Google could not be reached from this computer. Check your internet connection.')
  }
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return { error: `http_${res.status}` }
  }
}

function explain(body: Record<string, unknown>): string {
  const e = String(body.error ?? '')
  if (e === 'invalid_client' || e === 'unauthorized_client') return 'Google does not accept this Client ID or secret. Copy both again from the OAuth client page, and check that its type is "TVs and Limited Input devices".'
  if (e === 'invalid_scope') return 'This OAuth client is not allowed to ask for Google Drive. Create it with the type "TVs and Limited Input devices".'
  if (e === 'access_denied') return 'Google refused: the Google account is not allowed to use this app. While the app is in "Testing", add the account under Audience → Test users.'
  return `Google did not start the sign-in (${String(body.error_description ?? body.error ?? 'no reason given')}).`
}

export async function deviceStart(clientId: string): Promise<GoogleDeviceStart> {
  const body = await form('/device/code', { client_id: clientId, scope: SCOPE })
  if (typeof body.device_code !== 'string' || typeof body.user_code !== 'string') throw new Error(explain(body))
  return { deviceCode: body.device_code, userCode: body.user_code, verificationUrl: String(body.verification_url ?? body.verification_uri ?? 'https://www.google.com/device'), expiresIn: Number(body.expires_in) || 1800, interval: Math.max(1, Number(body.interval) || 5) }
}

export type GoogleDevicePoll = { state: 'done'; refreshToken: string; email: string } | { state: 'pending'; slower?: boolean } | { state: 'expired' } | { state: 'denied' }

function emailFrom(idToken: unknown): string {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')) as { email?: string }
    return typeof payload.email === 'string' ? payload.email : ''
  } catch {
    return ''
  }
}

export async function devicePoll(clientId: string, clientSecret: string, deviceCode: string): Promise<GoogleDevicePoll> {
  const body = await form('/token', { client_id: clientId, client_secret: clientSecret, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
  if (typeof body.refresh_token === 'string' && body.refresh_token) return { state: 'done', refreshToken: body.refresh_token, email: emailFrom(body.id_token) }
  if (body.error === 'authorization_pending') return { state: 'pending' }
  if (body.error === 'slow_down') return { state: 'pending', slower: true }
  if (body.error === 'expired_token') return { state: 'expired' }
  if (body.error === 'access_denied') return { state: 'denied' }
  if (typeof body.access_token === 'string') throw new Error('Google signed in but gave no long-lived permission. Remove this app under myaccount.google.com → Security → Third-party access, then connect again.')
  throw new Error(explain(body))
}
