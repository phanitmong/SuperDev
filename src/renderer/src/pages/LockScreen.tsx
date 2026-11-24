import { useState } from 'react'
import { Alert, Button } from 'antd'
import { LockOutlined, ScanOutlined } from '@ant-design/icons'
import { errText, cssUrl } from '../util'
import iconUrl from '../assets/icon.png'
import artUrl from '../assets/lock-art.jpg'

// A moving background when there is one: lock-video.mp4 (or .webm) in the assets folder, otherwise the sign-in video.
const pick = (found: Record<string, unknown>): string | undefined => Object.values(found as Record<string, string>)[0]
const lockVideo = pick(import.meta.glob('../assets/lock-video.{mp4,webm}', { eager: true, query: '?url', import: 'default' }))
const loginVideo = pick(import.meta.glob('../assets/login-video.{mp4,webm}', { eager: true, query: '?url', import: 'default' }))
const loginStill = pick(import.meta.glob('../assets/login-art.jpg', { eager: true, query: '?url', import: 'default' }))
const videoUrl = lockVideo ?? loginVideo
// The still that goes with the video in use, so nothing jumps while it loads.
const stillUrl = lockVideo ? artUrl : loginVideo && loginStill ? loginStill : artUrl
const calm = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** Covers the whole window while the app is locked. The main process refuses requests until the fingerprint is accepted. */
export default function LockScreen({ name }: { name: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const unlock = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await window.api.app.unlock()
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`lock ${lockVideo ? 'lock-own' : ''}`} role="dialog" aria-label="App locked">
      <div className="lock-bg" style={{ backgroundImage: cssUrl(stillUrl) }} aria-hidden="true">
        {videoUrl && !calm && <video src={videoUrl} poster={stillUrl} autoPlay loop muted playsInline />}
      </div>
      <div className="login-drag" />
      <div className="login-card lock-card">
        <img src={iconUrl} alt="" width={56} height={56} />
        <h2>
          <LockOutlined /> Apsara Panel is locked
        </h2>
        <p>Signed in as {name}. Your terminals and connections are kept while the app is locked.</p>
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 14, textAlign: 'left' }} />}
        <Button type="primary" size="large" block icon={<ScanOutlined />} loading={busy} autoFocus onClick={() => void unlock()}>
          Unlock with Touch ID
        </Button>
        <Button type="link" style={{ marginTop: 10 }} onClick={() => void window.api.auth.logout()}>
          Sign out instead
        </Button>
      </div>
    </div>
  )
}
