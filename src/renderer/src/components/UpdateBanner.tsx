// "A new version is ready": shown once the update is downloaded and checked. The person picks the moment.
import { useEffect, useState } from 'react'
import { App as AntApp, Button } from 'antd'
import { CloudDownloadOutlined } from '@ant-design/icons'
import type { UpdateState } from '@shared/team'
import { errText } from '../util'

export default function UpdateBanner() {
  const { modal } = AntApp.useApp()
  const [s, setS] = useState<UpdateState | null>(null)
  const [later, setLater] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.update.state().then(setS)
    return window.api.update.onState(setS)
  }, [])

  if (!s?.ready || !s.available || later === s.available) return null

  const restart = (): void => {
    modal.confirm({
      title: `Restart to update to ${s.available}?`,
      content: 'The app closes, installs the new version and opens again. A running terminal or task in this window is closed; work running on the servers carries on.',
      okText: 'Restart now',
      onOk: async () => {
        setBusy(true)
        try {
          await window.api.update.install()
        } catch (err) {
          setBusy(false)
          modal.error({ title: 'The update could not be installed', content: errText(err) })
        }
      }
    })
  }

  return (
    <div className="update-card" role="status">
      <CloudDownloadOutlined className="update-icon" />
      <div className="update-text">
        <div className="update-title">Apsara Panel {s.available} is ready</div>
        <div className="update-sub">{s.notes ? s.notes : `You have ${s.current}.`}</div>
      </div>
      <Button size="small" onClick={() => setLater(s.available!)}>
        Later
      </Button>
      <Button size="small" type="primary" loading={busy} onClick={restart}>
        Restart to update
      </Button>
    </div>
  )
}
