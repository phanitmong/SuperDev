import { useEffect, useRef, useState } from 'react'
import { Alert, App as AntApp, Button, Input, Modal, Spin } from 'antd'
import { CopyOutlined, GithubOutlined } from '@ant-design/icons'
import type { GitAccount, GithubConnectStart, GithubStatus } from '@shared/types'
import { errText } from '../util'

type Step = 'loading' | 'setup' | 'ask-admin' | 'code' | 'expired' | 'denied'

/**
 * "Connect GitHub": the person approves this app on github.com with a short code, and the account is saved for deploys.
 * The first time, an admin enters the Client ID of the team's GitHub OAuth App.
 */
export default function GithubConnect({ open, onClose, onConnected }: { open: boolean; onClose: () => void; onConnected: (account: GitAccount) => void }) {
  const { message } = AntApp.useApp()
  const [step, setStep] = useState<Step>('loading')
  const [status, setStatus] = useState<GithubStatus | null>(null)
  const [clientId, setClientId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [flow, setFlow] = useState<GithubConnectStart | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const alive = useRef(false)

  const begin = async (): Promise<void> => {
    setError('')
    setStep('loading')
    try {
      const f = await window.api.github.connectStart()
      if (!alive.current) return
      setFlow(f)
      setStep('code')
      window.open(f.verificationUri, '_blank')
      const check = async (): Promise<void> => {
        if (!alive.current) return
        try {
          const r = await window.api.github.connectPoll()
          if (!alive.current) return
          if (r.state === 'done' && r.account) {
            message.success(`GitHub connected: ${r.account.login ?? r.account.name}`)
            onConnected(r.account)
            return
          }
          if (r.state === 'pending') timer.current = setTimeout(() => void check(), ((r.interval ?? f.interval) + 1) * 1000)
          else setStep(r.state === 'denied' ? 'denied' : 'expired')
        } catch (err) {
          setError(errText(err))
          setStep('expired')
        }
      }
      timer.current = setTimeout(() => void check(), (f.interval + 1) * 1000)
    } catch (err) {
      if (!alive.current) return
      setError(errText(err))
      setStep('expired')
    }
  }

  useEffect(() => {
    if (!open) return
    alive.current = true
    setError('')
    setFlow(null)
    setStep('loading')
    window.api.github
      .status()
      .then((s) => {
        if (!alive.current) return
        setStatus(s)
        setClientId(s.clientId ?? '')
        if (s.configured) void begin()
        else setStep(s.canSetup ? 'setup' : 'ask-admin')
      })
      .catch((err) => {
        setError(errText(err))
        setStep('expired')
      })
    return () => {
      alive.current = false
      clearTimeout(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const saveSetup = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await window.api.github.setup(clientId.trim())
      await begin()
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (): Promise<void> => {
    if (!flow) return
    await navigator.clipboard.writeText(flow.userCode).catch(() => undefined)
    message.success('Code copied')
  }

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={500} destroyOnClose maskClosable={false} title={<span><GithubOutlined /> Connect GitHub</span>}>
      {step === 'loading' && (
        <div className="empty" style={{ padding: 30 }}>
          <Spin />
        </div>
      )}

      {step === 'ask-admin' && <Alert type="info" showIcon message="Not set up yet" description="An admin of this team has to set up the GitHub connection once. Ask them to open a site, press Connect GitHub and follow the steps. After that, everyone connects with one click." />}

      {step === 'setup' && (
        <>
          <p className="gh-lead">One-time setup for the whole team. GitHub needs to know this app before it can ask people to approve it. It takes about two minutes and is free.</p>
          <ol className="gh-steps">
            <li>
              On GitHub, open <b>Settings → Developer settings → OAuth Apps → New OAuth App</b>.{' '}
              <a href="https://github.com/settings/applications/new" target="_blank" rel="noreferrer">
                Open that page
              </a>
            </li>
            <li>
              Application name: <span className="mono">Apsara Panel</span>. Homepage URL and Authorization callback URL: <span className="mono">http://localhost</span> (they are not used). Tick <b>Enable Device Flow</b>, then Register application.
            </li>
            <li>
              Copy the <b>Client ID</b> shown on the next page and paste it here. No client secret is needed.
            </li>
          </ol>
          <Input className="mono" placeholder="Ov23li..." value={clientId} onChange={(e) => setClientId(e.target.value)} onPressEnter={() => void saveSetup()} spellCheck={false} aria-label="Client ID" />
          {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}
          <div className="gh-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="primary" loading={busy} disabled={!clientId.trim()} onClick={() => void saveSetup()}>
              Save and connect
            </Button>
          </div>
        </>
      )}

      {step === 'code' && flow && (
        <>
          <p className="gh-lead">GitHub has opened in your browser. Enter this code there and approve. This window notices by itself when you are done.</p>
          <div className="gh-code">
            <span className="mono">{flow.userCode}</span>
            <Button icon={<CopyOutlined />} onClick={() => void copy()}>
              Copy
            </Button>
          </div>
          <div className="gh-wait">
            <Spin size="small" /> Waiting for your approval on GitHub…
          </div>
          <div className="gh-actions">
            <Button onClick={() => window.open(flow.verificationUri, '_blank')}>Open GitHub again</Button>
            <Button onClick={onClose}>Cancel</Button>
          </div>
          <p className="db-hint" style={{ marginTop: 12 }}>
            The app gets permission to read your repositories, private ones included, so the server can download the code. GitHub offers no narrower permission for private repositories. You can take it back at any time on GitHub under Settings → Applications.
          </p>
        </>
      )}

      {(step === 'expired' || step === 'denied') && (
        <>
          <Alert type={step === 'denied' ? 'warning' : 'error'} showIcon message={step === 'denied' ? 'You declined on GitHub, so nothing was connected.' : error || 'The code ran out before it was approved.'} />
          <div className="gh-actions">
            {status?.canSetup && <Button onClick={() => { setError(''); setStep('setup') }}>Change Client ID</Button>}
            <Button onClick={onClose}>Close</Button>
            <Button type="primary" onClick={() => void begin()}>
              Try again
            </Button>
          </div>
        </>
      )}
    </Modal>
  )
}
