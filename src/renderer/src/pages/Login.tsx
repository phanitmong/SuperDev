import { DEFAULT_SERVICE } from '@shared/brand'
import { useEffect, useState } from 'react'
import { Alert, Button, ConfigProvider, Form, Input, Typography, theme } from 'antd'
import { LockOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import QRCode from 'qrcode'
import type { LoginStep, SessionState } from '@shared/team'
import { PASSWORD_RULES } from '@shared/team'
import { errText, cssUrl } from '../util'
import iconUrl from '../assets/icon.png'
import artUrl from '../assets/login-art.jpg'

// Optional moving background: put login-video.mp4 (or .webm) in the assets folder and it plays over the picture.
const videoUrl = Object.values(import.meta.glob('../assets/login-video.{mp4,webm}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>)[0]
const calm = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
const moving = !!videoUrl && !calm

type Stage = { name: 'credentials' } | { name: 'enroll'; secret: string; uri: string } | { name: 'totp' } | { name: 'password'; reason: string }

/** Sign-in: service address, username and password, then the authenticator code. */
export default function Login({ session }: { session: SessionState }) {
  const [stage, setStage] = useState<Stage>({ name: 'credentials' })
  // The service address is kept out of sight once one is known (saved from before, or built into this app).
  const knownService = session.serverUrl || DEFAULT_SERVICE
  const [showService, setShowService] = useState(!knownService)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [qr, setQr] = useState<string | null>(null)
  const [form] = Form.useForm()
  const isMac = window.api.platform === 'darwin'

  useEffect(() => {
    if (stage.name !== 'enroll') return
    QRCode.toDataURL(stage.uri, { margin: 1, width: 196 })
      .then(setQr)
      .catch(() => setQr(null))
  }, [stage])

  const advance = (step: LoginStep): void => {
    form.resetFields(['code', 'newPassword', 'repeat'])
    if (step.next === 'enroll') setStage({ name: 'enroll', secret: step.secret, uri: step.uri })
    else if (step.next === 'totp') setStage({ name: 'totp' })
    else if (step.next === 'password') setStage({ name: 'password', reason: step.reason })
    // 'done' needs nothing here: the app is told the session started and replaces this screen.
  }

  const run = async (fn: () => Promise<LoginStep>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      advance(await fn())
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  const submit = async (): Promise<void> => {
    let v: { server: string; username: string; password: string; code: string; newPassword: string }
    try {
      v = await form.validateFields()
    } catch {
      return
    }
    if (stage.name === 'credentials') {
      await run(async () => {
        await window.api.session.connect(v.server)
        return window.api.auth.login(v.username, v.password)
      })
    } else if (stage.name === 'enroll' || stage.name === 'totp') {
      await run(() => window.api.auth.totp(v.code))
    } else {
      await run(() => window.api.auth.setPassword(v.newPassword))
    }
  }

  const startOver = (): void => {
    setStage({ name: 'credentials' })
    setError(null)
    form.resetFields(['password', 'code'])
    void window.api.auth.logout()
  }

  return (
    <div className="login">
      {/* The picture (or the video, when there is one) fills the whole window; the form floats over its quiet side. */}
      <div className="login-bg" style={{ backgroundImage: cssUrl(artUrl) }} aria-hidden="true">
        {moving && <video src={videoUrl} poster={artUrl} autoPlay loop muted playsInline />}
      </div>
      <div className="login-art" aria-hidden="true">
        <div className="login-art-text">
          <div className="login-art-title">Every server, one console</div>
          <div className="login-art-sub">Deploy, protect and watch your servers with your team.</div>
        </div>
      </div>
      <div className={`login-drag ${isMac ? '' : 'with-buttons'}`}>
        {!isMac && (
          <div className="win-btns no-drag" style={{ marginRight: 8 }}>
            <button className="win-btn" style={{ color: '#fff' }} aria-label="Minimize" onClick={() => window.api.window.minimize()}>
              &#8211;
            </button>
            <button className="win-btn close" style={{ color: '#fff' }} aria-label="Close" onClick={() => window.api.window.close()}>
              &#10005;
            </button>
          </div>
        )}
      </div>
      <div className="login-side">
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { colorBgContainer: 'rgba(255, 255, 255, 0.06)', colorBorder: 'rgba(255, 255, 255, 0.16)', colorText: '#f4f3ff', colorTextPlaceholder: 'rgba(255, 255, 255, 0.38)', colorPrimary: '#7b6cff', borderRadius: 10, controlHeight: 40 } }}>
      <div className="login-card">
        <div className="login-brand">
          <img src={iconUrl} alt="" width={44} height={44} />
          <div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>Apsara Panel</div>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>
              {stage.name === 'credentials' ? 'Sign in to your team service' : stage.name === 'password' ? 'Choose your password' : 'Two-step verification'}
            </div>
          </div>
        </div>

        <Form form={form} layout="vertical" requiredMark={false} onFinish={() => void submit()} initialValues={{ server: knownService, username: session.lastUsername }}>
          {stage.name === 'credentials' && (
            <>
              <Form.Item name="server" label="Service address" hidden={!showService} rules={[{ required: true, message: 'Enter the address of your Apsara Panel service' }]}>
                <Input placeholder="devops.yourcompany.com" spellCheck={false} autoFocus={showService && !knownService} />
              </Form.Item>
              <Form.Item name="username" label="Username" rules={[{ required: true, message: 'Enter your username' }]}>
                <Input spellCheck={false} autoComplete="off" autoFocus={!!knownService && !session.lastUsername} />
              </Form.Item>
              <Form.Item name="password" label="Password" rules={[{ required: true, message: 'Enter your password' }]}>
                <Input.Password autoComplete="off" autoFocus={!!knownService && !!session.lastUsername} />
              </Form.Item>
            </>
          )}

          {stage.name === 'enroll' && (
            <>
              <Alert
                type="info"
                showIcon
                icon={<SafetyCertificateOutlined />}
                style={{ marginBottom: 16 }}
                message="Set up Google Authenticator"
                description="Open Google Authenticator on your phone, tap +, and scan this code. Then type the 6 digits it shows."
              />
              <div style={{ textAlign: 'center', marginBottom: 12 }}>
                {qr ? <img src={qr} alt="QR code for the authenticator app" width={196} height={196} style={{ borderRadius: 10, background: '#fff', padding: 6 }} /> : null}
                <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>Cannot scan? Enter this key by hand:</div>
                <Typography.Text className="mono" copyable style={{ fontSize: 12.5, userSelect: 'text' }}>
                  {stage.secret.replace(/(.{4})/g, '$1 ').trim()}
                </Typography.Text>
              </div>
            </>
          )}

          {(stage.name === 'enroll' || stage.name === 'totp') && (
            <Form.Item
              name="code"
              label={stage.name === 'totp' ? 'Code from Google Authenticator' : '6-digit code'}
              rules={[{ required: true, pattern: /^\s*\d{3}\s?\d{3}\s*$/, message: 'Enter the 6 digits' }]}
            >
              <Input className="mono" inputMode="numeric" maxLength={7} placeholder="123 456" autoFocus autoComplete="off" style={{ fontSize: 20, letterSpacing: 4, textAlign: 'center' }} />
            </Form.Item>
          )}

          {stage.name === 'password' && (
            <>
              <Alert type="info" showIcon icon={<LockOutlined />} style={{ marginBottom: 16 }} message={stage.reason} description={PASSWORD_RULES} />
              <Form.Item name="newPassword" label="New password" rules={[{ required: true, message: 'Enter a new password' }]}>
                <Input.Password autoComplete="off" autoFocus />
              </Form.Item>
              <Form.Item
                name="repeat"
                label="Repeat it"
                dependencies={['newPassword']}
                rules={[
                  { required: true, message: 'Repeat the new password' },
                  ({ getFieldValue }) => ({
                    validator: (_r, value) => (!value || value === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('The two passwords are different')))
                  })
                ]}
              >
                <Input.Password autoComplete="off" />
              </Form.Item>
            </>
          )}

          {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}

          <Button type="primary" htmlType="submit" block size="large" loading={busy}>
            {stage.name === 'credentials' ? 'Continue' : stage.name === 'password' ? 'Save password and sign in' : 'Verify'}
          </Button>
          {stage.name !== 'credentials' && (
            <Button type="link" block style={{ marginTop: 8 }} onClick={startOver}>
              Back to sign-in
            </Button>
          )}
        </Form>
        {stage.name === 'credentials' && !showService && (
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <button type="button" className="link-btn" style={{ fontSize: 12, opacity: 0.75 }} onClick={() => setShowService(true)}>
              Use another service
            </button>
          </div>
        )}
      </div>
      </ConfigProvider>
      <div className="login-foot">Every action in this app is recorded in your company's audit log.</div>
      </div>
    </div>
  )
}
