import { useEffect, useState } from 'react'
import { Button, Select, Space } from 'antd'
import type { VersionApp, VersionChoice } from '@shared/types'

/**
 * "Install" with a choice of version: the system's own package, or a release from the project's own
 * repository. The list comes from the server, which checks what exists for its system.
 */
export default function VersionInstall({ projectId, app, name, disabled, onInstall }: { projectId: string; app: VersionApp; name: string; disabled?: boolean; onInstall: (version: string, label: string) => void }) {
  const [choices, setChoices] = useState<VersionChoice[] | null>(null)
  const [picked, setPicked] = useState('system')

  useEffect(() => {
    let stale = false
    window.api.versions
      .list(projectId, app)
      .then((list) => !stale && setChoices(list))
      // Without the list, the system's package can still be installed.
      .catch(() => !stale && setChoices([{ id: 'system', label: `${name} from this system's own packages`, note: '' }]))
    return () => {
      stale = true
    }
  }, [projectId, app, name])

  const current = choices?.find((c) => c.id === picked) ?? choices?.[0]
  return (
    <div>
      <Space wrap style={{ justifyContent: 'center' }}>
        <Select
          style={{ minWidth: 340, textAlign: 'left' }}
          loading={!choices}
          disabled={disabled || !choices}
          value={choices ? (current?.id ?? 'system') : undefined}
          placeholder="Checking which versions this server can install..."
          onChange={setPicked}
          aria-label={`${name} version`}
          options={(choices ?? []).map((c) => ({ value: c.id, label: c.label }))}
        />
        <Button type="primary" disabled={disabled || !current} onClick={() => current && onInstall(current.id, current.label)}>
          Install
        </Button>
      </Space>
      {current?.note && <p className="db-hint" style={{ margin: '10px 0 0' }}>{current.note}</p>}
      {choices && choices.length === 1 && <p className="db-hint" style={{ margin: '6px 0 0' }}>Other versions are offered on Ubuntu and Debian servers that can reach the project's download site.</p>}
    </div>
  )
}
