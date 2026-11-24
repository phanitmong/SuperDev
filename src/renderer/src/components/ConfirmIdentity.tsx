import { useEffect, useState } from 'react'
import { Alert, Input, Modal } from 'antd'
import { SafetyCertificateOutlined } from '@ant-design/icons'
import { errText } from '../util'

/**
 * Asks for a fresh authenticator code before something sensitive goes ahead.
 * Accounts without an authenticator (development sign-in) are asked for their account password instead.
 * `onProof` gets what was typed and does the work; if it throws, the message is shown and the person can try again.
 */
export default function ConfirmIdentity({ open, title, about, okText, danger, onCancel, onProof }: { open: boolean; title: string; about: string; okText: string; danger?: boolean; onCancel: () => void; onProof: (proof: string) => Promise<void> }) {
  const [kind, setKind] = useState<'totp' | 'password' | null>(null)
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setValue('')
    setError('')
    setKind(null)
    window.api.session
      .proofKind()
      .then(setKind)
      .catch((err) => setError(errText(err)))
  }, [open])

  const ready = kind === 'totp' ? /^\d{6}$/.test(value.replace(/\s/g, '')) : value.length > 0
  const go = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setError('')
    try {
      await onProof(kind === 'totp' ? value.replace(/\s/g, '') : value)
    } catch (err) {
      setError(errText(err))
      setValue('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} title={<span><SafetyCertificateOutlined /> {title}</span>} okText={okText} okButtonProps={{ disabled: !ready, danger }} confirmLoading={busy} onCancel={onCancel} onOk={() => void go()} destroyOnClose maskClosable={false} width={440}>
      <p style={{ marginTop: 0 }}>{about}</p>
      {kind === 'password' ? (
        <>
          <label htmlFor="proof" style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
            Your Apsara Panel password
          </label>
          <Input.Password id="proof" autoFocus value={value} onChange={(e) => setValue(e.target.value)} onPressEnter={() => void go()} autoComplete="off" />
          <p className="db-hint" style={{ margin: '8px 0 0' }}>This account has no authenticator set up (development sign-in), so the password is asked instead.</p>
        </>
      ) : (
        <>
          <label htmlFor="proof" style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
            Code from Google Authenticator
          </label>
          <Input id="proof" className="mono proof-code" autoFocus inputMode="numeric" maxLength={7} placeholder="000000" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d ]/g, ''))} onPressEnter={() => void go()} autoComplete="one-time-code" disabled={!kind} />
          <p className="db-hint" style={{ margin: '8px 0 0' }}>A code works once. If you just signed in with it, wait for the next one (up to 30 seconds).</p>
        </>
      )}
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}
    </Modal>
  )
}
