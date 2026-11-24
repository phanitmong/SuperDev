// Team → Integrations (admins): the Google client used for Drive backups, and the team's own Google account,
// so a server's Drive backups can be turned on without signing in to Google again each time.
import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Input, Space, Spin, Tag } from 'antd'
import { GoogleOutlined } from '@ant-design/icons'
import type { GoogleStatus } from '@shared/types'
import { GoogleConnect } from './GdriveCard'
import { ago, errText } from '../util'

export default function Integrations() {
  const { message, modal } = AntApp.useApp()
  const [st, setSt] = useState<GoogleStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [steps, setSteps] = useState(false)

  const load = useCallback(async () => {
    try {
      const s = await window.api.google.status()
      setSt(s)
      setClientId(s.clientId ?? '')
      setSecret('')
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (error) return <Alert type="error" showIcon message="The integrations could not be loaded" description={error} />
  if (!st) return <Spin />

  const changed = clientId.trim() !== (st.clientId ?? '') || secret.trim() !== ''
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.google.setup(clientId.trim(), secret.trim())
      message.success('Google client saved.')
      await load()
    } catch (err) {
      message.error(errText(err))
    } finally {
      setBusy(false)
    }
  }
  const clear = (): void => {
    modal.confirm({
      title: 'Remove the Google client?',
      content: 'Nobody can connect Google Drive on a new server until a client is entered again. The team Google account is removed too. Servers already backing up to Drive keep their own sign-in and carry on.',
      okText: 'Remove',
      okButtonProps: { danger: true },
      onOk: async () => {
        await window.api.google.clear()
        await load()
      }
    })
  }
  const removeTeam = (): void => {
    modal.confirm({
      title: `Remove the team Google account ${st.team?.email ?? ''}?`,
      content: 'New Drive set-ups will ask for a Google sign-in again. Servers already backing up with this account keep their own copy of the sign-in and carry on; to stop them, turn Drive off on each server or take the permission back at myaccount.google.com.',
      okText: 'Remove',
      okButtonProps: { danger: true },
      onOk: async () => {
        await window.api.google.teamRemove()
        await load()
      }
    })
  }

  return (
    <div className="card">
      <div className="card-title">Integrations</div>
      <div className="guard-row" style={{ borderBottom: 0 }}>
        <div className="guard-head">
          <GoogleOutlined /> <strong>Google Drive backups</strong>
          {st.configured ? <Tag color="green">Set up</Tag> : <Tag>Not set up</Tag>}
        </div>
        <p className="guard-about">
          The Google OAuth client (type "TVs and Limited Input devices") every server uses to sign in to Google Drive.{' '}
          <a onClick={() => setSteps(!steps)}>{steps ? 'Hide the steps' : 'How to make one'}</a>
        </p>
        {steps && (
          <ol className="gh-steps">
            <li>
              Open{' '}
              <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">
                console.cloud.google.com
              </a>{' '}
              and create a project, for example <span className="mono">Apsara Panel</span>.
            </li>
            <li>
              <b>APIs &amp; Services → Library</b>: find <b>Google Drive API</b> and press Enable.
            </li>
            <li>
              <b>OAuth consent screen</b>: External, a name and your e-mail, then <b>Publish app</b> (in "Testing" Google ends sign-ins after 7 days).
            </li>
            <li>
              <b>Credentials → Create credentials → OAuth client ID</b>, type <b>TVs and Limited Input devices</b>. Copy the Client ID and secret here.
            </li>
          </ol>
        )}
        <div style={{ display: 'grid', gap: 8, maxWidth: 620 }}>
          <Input className="mono" placeholder="1234567890-abc...apps.googleusercontent.com" value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} aria-label="Google Client ID" addonBefore="Client ID" />
          <Input.Password className="mono" placeholder={st.secretSet ? 'Stored. Leave empty to keep it' : 'Client secret'} value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="Google client secret" autoComplete="off" addonBefore="Secret" />
          <Space>
            <Button type="primary" loading={busy} disabled={!changed || !clientId.trim() || (!secret.trim() && !(st.secretSet && clientId.trim() === st.clientId))} onClick={() => void save()}>
              Save
            </Button>
            {st.configured && (
              <Button danger onClick={clear}>
                Remove
              </Button>
            )}
          </Space>
        </div>

        <div className="guard-head" style={{ marginTop: 18 }}>
          <strong>Team Google account</strong>
          {st.team ? <Tag color="green">Connected</Tag> : <Tag>None</Tag>}
        </div>
        <p className="guard-about">Connect one Google account for the whole team. Admins and IT Support can then turn on Drive backups on any server with it, without signing in to Google each time. The account only lets the app see the files it uploads.</p>
        {st.team ? (
          <Space wrap>
            <span>
              <b className="mono">{st.team.email || '(address not given)'}</b>
              <span className="db-hint" style={{ marginLeft: 8 }}>
                connected by {st.team.by ?? 'an admin'} {ago(st.team.at)}
              </span>
            </span>
            <Button onClick={() => setConnecting(true)}>Connect another account</Button>
            <Button danger onClick={removeTeam}>
              Remove
            </Button>
          </Space>
        ) : (
          <Button icon={<GoogleOutlined />} disabled={!st.configured} onClick={() => setConnecting(true)}>
            Connect the team Google account
          </Button>
        )}
        {!st.configured && <div className="db-hint" style={{ marginTop: 6 }}>Save the Google client first.</div>}
      </div>
      <GoogleConnect
        open={connecting}
        team
        onClose={() => setConnecting(false)}
        onConnected={(email) => {
          setConnecting(false)
          message.success(`Team Google account connected: ${email || 'done'}`)
          void load()
        }}
      />
    </div>
  )
}
