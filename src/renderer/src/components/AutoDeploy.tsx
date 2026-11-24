import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Modal, Space, Spin, Switch, Tag } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import type { AutoDeployStatus, Site } from '@shared/types'
import { errText } from '../util'

/** Switch for "the server deploys new commits by itself", with what happened lately. */
export default function AutoDeploy({ site, onClose, onChanged }: { site: Site; onClose: () => void; onChanged: () => Promise<void> }) {
  const { message, modal } = AntApp.useApp()
  const [status, setStatus] = useState<AutoDeployStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setStatus(await window.api.sites.autoStatus(site.id))
      setError('')
    } catch (err) {
      setError(errText(err))
    }
  }, [site.id])

  useEffect(() => void load(), [load])

  const set = async (on: boolean): Promise<void> => {
    setBusy(true)
    try {
      await window.api.sites.autoDeploy(site.id, on)
      await onChanged()
      message.success(on ? 'Auto deploy is on. The first check runs within 2 minutes.' : 'Auto deploy is off. Its files and token were removed from the server.')
    } catch (err) {
      message.error(errText(err), 8)
    } finally {
      setBusy(false)
      void load()
    }
  }

  const toggle = (on: boolean): void => {
    if (!on) return void set(false)
    modal.confirm({
      title: `Turn on auto deploy for ${site.name}?`,
      width: 520,
      content: (
        <div>
          <p>
            Every 2 minutes the server looks at the <b>{site.branch}</b> branch. When there is a new commit it deploys it, checks that the site still answers, and puts the previous version back if it does not.
          </p>
          {site.gitAccountId ? (
            <p>
              For this the access token of the site's Git account is <b>stored on this server</b>, in a file only root can read. Anyone with root on the server could read it. Turning auto deploy off removes it.
            </p>
          ) : (
            <p>The server uses its own access to the repository (a public repository, or the server's SSH key added as a deploy key).</p>
          )}
          <p>If Telegram alerts are set up on this server, you get a message after every automatic deploy.</p>
        </div>
      ),
      okText: 'Turn on',
      onOk: () => set(true)
    })
  }

  const runNow = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.sites.autoRun(site.id)
      await onChanged()
      message.success('Checked')
    } catch (err) {
      message.error(errText(err), 8)
    } finally {
      setBusy(false)
      void load()
    }
  }

  const tone = status?.last?.result === 'ok' ? 'green' : status?.last ? 'red' : undefined
  return (
    <Modal open title={`Auto deploy: ${site.name}`} width={760} onCancel={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      {!status && !error ? (
        <Spin />
      ) : (
        status && (
          <>
            <div className="auto-head">
              <Space size={12}>
                <Switch checked={status.enabled} loading={busy} onChange={toggle} aria-label="Auto deploy" />
                <b>{status.enabled ? `On. Watching ${site.branch} every 2 minutes.` : 'Off. Deploy by hand with the Deploy button.'}</b>
              </Space>
              {status.enabled && (
                <Space>
                  <Button icon={<ReloadOutlined />} onClick={() => void load()}>
                    Refresh
                  </Button>
                  <Button loading={busy} onClick={() => void runNow()}>
                    Check now
                  </Button>
                </Space>
              )}
            </div>
            {status.unreachable && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="The server cannot read the repository. Check its address, the branch, and that the access token is still valid. After changing the Git account's token, turn auto deploy off and on again." />}
            {status.last && (
              <p style={{ margin: '0 0 12px' }}>
                Last automatic deploy: <Tag color={tone}>{status.last.result === 'ok' ? 'Deployed' : status.last.result === 'rolled-back' ? 'Failed, previous version put back' : 'Failed'}</Tag>
                <span className="mono">{status.last.commit}</span> {status.last.note} <span style={{ color: 'var(--muted)' }}>({status.last.time}, server time)</span>
              </p>
            )}
            <pre className="log-box" style={{ height: 300 }}>
              {status.log.trim() || (status.enabled ? 'Nothing has been deployed automatically yet.' : 'No automatic deploys recorded.')}
            </pre>
            <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: '10px 0 0' }}>Automatic deploys happen on the server, so they appear here and not in "Deploy history and rollback".</p>
          </>
        )
      )}
    </Modal>
  )
}
