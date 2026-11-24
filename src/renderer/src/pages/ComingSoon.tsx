import { ScheduleOutlined } from '@ant-design/icons'

const PLANNED: { group: string; items: string[] }[] = [
  { group: 'Security', items: ['SSH hardening and Fail2ban', 'Wildcard certificates (DNS challenge)'] },
  { group: 'Operations', items: ['Start / stop / restart services', 'Node and Python version management', 'PHP-FPM pool tuning (workers)', 'PM2 cluster mode and environment variables'] },
  { group: 'Deploy', items: ['Zero-downtime releases', 'Auto deploy on git push', '.env editor', 'Docker and Docker Compose'] },
  { group: 'Data', items: ['PostgreSQL', 'Redis key browser', 'Copy a database between servers', 'Long-term monitor history'] },
  { group: 'App', items: ['Installers (.dmg / .exe) and auto-update', 'App lock and export / import', 'Khmer and Chinese interface'] }
]

/** What is not built yet. */
export default function ComingSoon() {
  return (
    <div className="card">
      <div className="card-title">
        <span>
          <ScheduleOutlined /> Planned, not built yet
        </span>
      </div>
      <div className="grid cols-3">
        {PLANNED.map((p) => (
          <div key={p.group}>
            <div style={{ fontWeight: 600 }}>{p.group}</div>
            <ul className="soon-list" style={{ marginTop: 6 }}>
              {p.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}
