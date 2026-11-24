import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Input, InputNumber, Select, Space, Spin, Switch, Tag } from 'antd'
import { SafetyOutlined, SendOutlined } from '@ant-design/icons'
import type { GuardView } from '@shared/team'
import { APPROVAL_MINUTES } from '@shared/team'
import { errText } from '../util'
import ConfirmIdentity from './ConfirmIdentity'

/** Admin settings that protect the service itself: who may sign in from where, alerts, and approval by a second admin. */
export default function Protection() {
  const { message } = AntApp.useApp()
  const [saved, setSaved] = useState<GuardView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ips, setIps] = useState<string[]>([])
  const [token, setToken] = useState('')
  const [removeToken, setRemoveToken] = useState(false)
  const [chat, setChat] = useState('')
  const [alertSignIn, setAlertSignIn] = useState(true)
  const [alertDanger, setAlertDanger] = useState(true)
  const [approvals, setApprovals] = useState(false)
  const [recordingDays, setRecordingDays] = useState(90)
  const [idleHours, setIdleHours] = useState(8)
  const [maxDays, setMaxDays] = useState(7)
  const [confirming, setConfirming] = useState(false)
  const [testing, setTesting] = useState(false)

  const show = (v: GuardView): void => {
    setSaved(v)
    setIps(v.allowedIps)
    setChat(v.telegramChat)
    setAlertSignIn(v.alertSignIn)
    setAlertDanger(v.alertDanger)
    setApprovals(v.approvals)
    setRecordingDays(v.recordingDays)
    setIdleHours(v.sessionIdleHours)
    setMaxDays(v.sessionMaxDays)
    setToken('')
    setRemoveToken(false)
  }

  const load = useCallback(async () => {
    try {
      show(await window.api.guard.get())
      setError(null)
    } catch (err) {
      setError(errText(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (error) return <Alert type="error" showIcon message="The protection settings could not be loaded" description={error} />
  if (!saved) return <Spin />

  const dirty =
    ips.join(',') !== saved.allowedIps.join(',') || token !== '' || removeToken || chat.trim() !== saved.telegramChat || alertSignIn !== saved.alertSignIn || alertDanger !== saved.alertDanger || approvals !== saved.approvals || recordingDays !== saved.recordingDays || idleHours !== saved.sessionIdleHours || maxDays !== saved.sessionMaxDays
  const telegramReady = saved.telegramSet && !!saved.telegramChat
  const hidden = saved.yourAddress === '127.0.0.1' || saved.yourAddress === '::1'

  const test = async (): Promise<void> => {
    setTesting(true)
    try {
      await window.api.guard.test()
      message.success('Test message sent. Check the Telegram chat.')
    } catch (err) {
      message.error(errText(err))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="card">
      <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>
          <SafetyOutlined style={{ marginInlineEnd: 8 }} />
          Protection
        </span>
        <Button type="primary" disabled={!dirty} onClick={() => setConfirming(true)}>
          Save protection
        </Button>
      </div>

      <div className="guard-row">
        <div className="guard-head">
          <strong>Addresses that may sign in</strong>
          {saved.allowedIps.length === 0 ? <Tag>Anyone</Tag> : <Tag color="green">{saved.allowedIps.length} allowed</Tag>}
        </div>
        <p className="guard-about">
          Leave empty to allow any address. With addresses listed, sign-in from anywhere else is refused before the password is checked, and sessions from other addresses end at once. The service sees you as{' '}
          <span className="mono">{saved.yourAddress}</span>.
        </p>
        {hidden && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 10 }}
            message="The service cannot see real addresses yet"
            description="Everyone appears as 127.0.0.1 because a proxy (nginx) sits in front. Start the service with TRUST_PROXY=1 and make the proxy send X-Forwarded-For. Until then a list cannot be saved."
          />
        )}
        <Select
          mode="tags"
          style={{ width: '100%' }}
          value={ips}
          onChange={(v) => setIps(v.map((x) => x.trim()).filter(Boolean))}
          tokenSeparators={[',', ' ', '\n']}
          open={false}
          suffixIcon={null}
          placeholder="203.0.113.7 or 203.0.113.0/24, then Enter"
          aria-label="Addresses that may sign in"
        />
        {!hidden && !ips.includes(saved.yourAddress) && (
          <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={() => setIps([...ips, saved.yourAddress])}>
            Add my address ({saved.yourAddress})
          </Button>
        )}
        <p className="guard-about" style={{ marginTop: 6 }}>
          Locked out after your address changed? On the machine that runs the service: <span className="mono">node server.js security-reset</span>
        </p>
      </div>

      <div className="guard-row">
        <div className="guard-head">
          <strong>Telegram alerts</strong>
          {telegramReady ? <Tag color="green">Connected</Tag> : <Tag>Not set up</Tag>}
        </div>
        <p className="guard-about">Create a bot with @BotFather, add it to your group (or start a chat with it), and enter the token and the chat ID. The token is stored encrypted on the service and never shown again.</p>
        {saved.telegramError && <Alert type="error" showIcon style={{ marginBottom: 10 }} message="The last alert was not delivered" description={saved.telegramError} />}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 10 }}>
          <Input.Password
            value={token}
            disabled={removeToken}
            onChange={(e) => setToken(e.target.value.trim())}
            placeholder={saved.telegramSet ? 'A token is stored. Type a new one to replace it' : 'Bot token, such as 123456789:AAE...'}
            autoComplete="off"
            aria-label="Telegram bot token"
          />
          <Input value={chat} onChange={(e) => setChat(e.target.value)} placeholder="Chat ID, such as -1001234567890" aria-label="Telegram chat ID" />
        </div>
        <Space style={{ marginTop: 10 }} wrap>
          <Button icon={<SendOutlined />} loading={testing} disabled={!telegramReady || dirty} onClick={() => void test()}>
            Send a test message
          </Button>
          {saved.telegramSet && (
            <Button danger type={removeToken ? 'primary' : 'default'} onClick={() => setRemoveToken(!removeToken)}>
              {removeToken ? 'Token will be removed on save' : 'Remove the token'}
            </Button>
          )}
          {dirty && telegramReady && <span className="guard-about">Save first, then test.</span>}
        </Space>
        <div className="guard-switch">
          <Switch checked={alertSignIn} onChange={setAlertSignIn} aria-label="Alert on sign-ins" />
          <span>Sign-in from an address a person has not used before, a locked account, and attempts from an address that is not allowed</span>
        </div>
        <div className="guard-switch">
          <Switch checked={alertDanger} onChange={setAlertDanger} aria-label="Alert on dangerous actions" />
          <span>Dangerous actions: deleting or restoring a database, restoring a folder, restarting or shutting down a server, removing a site or a server, switching a firewall off, deleting backups, and changes to accounts or to these settings</span>
        </div>
      </div>

      <div className="guard-row">
        <div className="guard-head">
          <strong>Approval by a second admin</strong>
          {saved.approvals ? <Tag color="green">On</Tag> : <Tag>Off</Tag>}
        </div>
        <div className="guard-switch" style={{ marginTop: 0 }}>
          <Switch checked={approvals} onChange={setApprovals} aria-label="Approval by a second admin" />
          <span>
            Deleting or restoring a database, restoring a folder, restarting or shutting down a server, removing a site or a server, and switching a firewall off wait until another admin approves in their app. A request
            runs out after {APPROVAL_MINUTES} minutes, and nobody can approve their own. This applies to admins too.
          </span>
        </div>
      </div>

      <div className="guard-row">
        <div className="guard-head">
          <strong>How long a sign-in lasts</strong>
        </div>
        <p className="guard-about">
          The app stays signed in through sleep, a network change or a restart of the service, and remembers the sign-in on each computer (kept in the system's keychain; on a Mac with Touch ID it opens locked). It signs out after this long without use, and asks for the password and authenticator code again at least this often.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <InputNumber min={1} max={168} value={idleHours} onChange={(v) => setIdleHours(v ?? 8)} addonBefore="Sign out after" addonAfter="hours unused" style={{ width: 300 }} aria-label="Hours without use before signing out" />
          <InputNumber min={1} max={90} value={maxDays} onChange={(v) => setMaxDays(v ?? 7)} addonBefore="Sign in again every" addonAfter="days" style={{ width: 300 }} aria-label="Days before signing in again" />
        </div>
      </div>

      <div className="guard-row" style={{ borderBottom: 0, paddingBottom: 0 }}>
        <div className="guard-head">
          <strong>Terminal recordings</strong>
        </div>
        <p className="guard-about">Everything typed and shown in a terminal is recorded on the service for the audit log. Recordings older than this are removed so the disk does not fill up. 0 keeps them for ever. The audit log itself is never removed; it is kept in one file per month.</p>
        <InputNumber min={0} max={3650} value={recordingDays} onChange={(v) => setRecordingDays(v ?? 90)} addonBefore="Keep for" addonAfter="days" style={{ width: 240 }} aria-label="Days to keep terminal recordings" />
      </div>

      <ConfirmIdentity
        open={confirming}
        title="Save the protection settings"
        about="These settings decide who can reach the service and what needs a second person. The change is written to the audit log and sent to Telegram."
        okText="Save"
        onCancel={() => setConfirming(false)}
        onProof={async (proof) => {
          const next = await window.api.guard.save({ allowedIps: ips, telegramToken: removeToken ? '' : token || undefined, telegramChat: chat.trim(), alertSignIn, alertDanger, approvals, recordingDays, sessionIdleHours: idleHours, sessionMaxDays: maxDays }, proof)
          setConfirming(false)
          show(next)
          message.success('Protection settings saved.')
        }}
      />
    </div>
  )
}
