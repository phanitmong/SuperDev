import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Input, InputNumber, Modal, Select, Switch, Tabs } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import type { NginxSettings, ProxyRule, Site } from '@shared/types'

interface Draft {
  rules: ProxyRule[]
  maxBodyMb: number
  gzip: boolean
  staticCacheDays: number
  redirectWww: 'none' | 'to-www' | 'to-bare'
  hsts: boolean
  headers: { name: string; value: string }[]
  extra: string
}

function draftOf(site: Site): Draft {
  const n: NginxSettings = site.nginx ?? {}
  return {
    rules: (site.proxyRules ?? []).map((r) => ({ ...r })),
    maxBodyMb: n.maxBodyMb ?? 64,
    gzip: n.gzip === true,
    staticCacheDays: n.staticCacheDays ?? (site.appType === 'php' ? 0 : 7),
    redirectWww: n.redirectWww ?? 'none',
    hsts: n.hsts === true,
    headers: (n.headers ?? []).map((h) => ({ ...h })),
    extra: n.extra ?? ''
  }
}

const isLocal = (target: string): boolean => /^https?:\/\/(127\.|localhost|\[::1\])/i.test(target.trim())

/** Reverse proxy rules and nginx settings of one site, applied without a deploy. */
export default function SiteNginx({ site, onClose, onApply }: { site: Site | null; onClose: () => void; onApply: (site: Site, input: { proxyRules: ProxyRule[]; nginx: NginxSettings }) => void }) {
  const [d, setD] = useState<Draft | null>(null)
  const [tab, setTab] = useState('proxy')
  useEffect(() => {
    if (site) {
      setD(draftOf(site))
      setTab('proxy')
    }
  }, [site])
  if (!site || !d) return null

  const set = (patch: Partial<Draft>): void => setD({ ...d, ...patch })
  const setRule = (i: number, patch: Partial<ProxyRule>): void => set({ rules: d.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  const names = site.domain.trim().split(/\s+/).filter(Boolean)
  const pair = names.find((n) => !n.startsWith('www.') && names.includes(`www.${n}`))
  const first = names[0]
  const serves = site.appType === 'static' || site.appType === 'php'
  const ready = d.rules.every((r) => r.path.trim() && r.target.trim()) && d.headers.every((h) => h.name.trim() && h.value.trim())

  const apply = (): void =>
    onApply(site, {
      proxyRules: d.rules.map((r) => ({ ...r, path: r.path.trim(), target: r.target.trim() })),
      nginx: { maxBodyMb: d.maxBodyMb, gzip: d.gzip, staticCacheDays: serves ? d.staticCacheDays : undefined, redirectWww: d.redirectWww, hsts: d.hsts, headers: d.headers, extra: d.extra }
    })

  return (
    <Modal open title={`Reverse proxy and Nginx · ${site.name}`} width={860} okText="Save and apply" okButtonProps={{ disabled: !ready }} onOk={apply} onCancel={onClose} destroyOnClose>
      {site.stopped && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="This site is stopped" description="Changes are saved and take effect when the site is started again." />}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'proxy',
            label: `Reverse proxy${d.rules.length ? ` (${d.rules.length})` : ''}`,
            children: (
              <div className="gd-form">
                <p className="db-hint" style={{ margin: 0 }}>
                  Send a path of this site to another address: an app on this server, or another server. Example: <span className="mono">/api</span> to <span className="mono">http://127.0.0.1:3000</span>, or{' '}
                  <span className="mono">/</span> to send the whole site there. Longer paths still go to their own rules.
                </p>
                {d.rules.map((r, i) => (
                  <div key={i} className="nx-rule">
                    <div className="gd-row">
                      <div className="gd-field" style={{ flex: 'none', width: 220 }}>
                        <label htmlFor={`nx-path-${i}`}>
                          <b>Path on this site</b>
                        </label>
                        <Input id={`nx-path-${i}`} value={r.path} spellCheck={false} placeholder="/ or /api" onChange={(e) => setRule(i, { path: e.target.value.trim() })} />
                      </div>
                      <div className="gd-field">
                        <label htmlFor={`nx-target-${i}`}>
                          <b>Send to</b>
                        </label>
                        <Input id={`nx-target-${i}`} value={r.target} spellCheck={false} placeholder="http://127.0.0.1:3000 or https://api.example.com" onChange={(e) => setRule(i, { target: e.target.value.trim() })} />
                      </div>
                      <Button type="text" danger icon={<DeleteOutlined />} aria-label="Remove this rule" style={{ alignSelf: 'flex-end' }} onClick={() => set({ rules: d.rules.filter((_, j) => j !== i) })} />
                    </div>
                    <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
                      {r.path.replace(/\/+$/, '') !== '' && (
                        <Checkbox checked={r.stripPath === true} onChange={(e) => setRule(i, { stripPath: e.target.checked })}>
                          Remove the path before sending
                        </Checkbox>
                      )}
                      <Checkbox checked={r.websocket === true} onChange={(e) => setRule(i, { websocket: e.target.checked })}>
                        WebSocket
                      </Checkbox>
                      <Select
                        size="small"
                        style={{ width: 300 }}
                        value={r.hostHeader ?? (isLocal(r.target) || !r.target ? 'visitor' : 'target')}
                        onChange={(v) => setRule(i, { hostHeader: v })}
                        aria-label="Name told to the target"
                        options={[
                          { value: 'visitor', label: `Tell it the visitor's domain (${first})` },
                          { value: 'target', label: "Tell it the target's own name" }
                        ]}
                      />
                    </div>
                    {r.path && r.target && (
                      <p className="db-hint" style={{ margin: 0 }}>
                        {first}
                        {r.path.replace(/\/+$/, '')}/users goes to <span className="mono">{r.target.replace(/\/+$/, '')}{/^https?:\/\/[^/]+\/.+/.test(r.target) || r.stripPath ? '' : r.path.replace(/\/+$/, '')}/users</span>
                      </p>
                    )}
                  </div>
                ))}
                <div>
                  <Button icon={<PlusOutlined />} onClick={() => set({ rules: [...d.rules, { path: '', target: '', stripPath: false, websocket: false }] })}>
                    Add a rule
                  </Button>
                </div>
              </div>
            )
          },
          {
            key: 'settings',
            label: 'Settings',
            children: (
              <div className="gd-form">
                <div className="gd-row">
                  <div className="gd-field" style={{ flex: 'none' }}>
                    <label htmlFor="nx-body">
                      <b>Largest upload</b>
                    </label>
                    <InputNumber id="nx-body" min={1} max={51200} value={d.maxBodyMb} onChange={(v) => set({ maxBodyMb: v ?? 64 })} addonAfter="MB" style={{ width: 170 }} />
                  </div>
                  {serves && (
                    <div className="gd-field" style={{ flex: 'none' }}>
                      <label htmlFor="nx-cache">
                        <b>Browsers keep pictures, styles and scripts</b>
                      </label>
                      <InputNumber id="nx-cache" min={0} max={365} value={d.staticCacheDays} onChange={(v) => set({ staticCacheDays: v ?? 0 })} addonAfter="days" style={{ width: 170 }} />
                    </div>
                  )}
                  <div className="gd-field">
                    <label htmlFor="nx-www">
                      <b>www</b>
                    </label>
                    <Select
                      id="nx-www"
                      value={d.redirectWww}
                      onChange={(v) => set({ redirectWww: v })}
                      disabled={!pair && d.redirectWww === 'none'}
                      options={[
                        { value: 'none', label: 'Answer on both names' },
                        { value: 'to-www', label: pair ? `Send ${pair} to www.${pair}` : 'Send the bare name to www' },
                        { value: 'to-bare', label: pair ? `Send www.${pair} to ${pair}` : 'Send www to the bare name' }
                      ]}
                    />
                  </div>
                </div>
                {!pair && <p className="db-hint" style={{ margin: 0 }}>The www choice needs both names among this site's domains (for example example.com and www.example.com). Add the missing one under More, Domains.</p>}
                {serves && <p className="db-hint" style={{ margin: 0 }}>0 days switches browser caching off. With it on, a changed file can take that long to reach returning visitors unless its name changes.</p>}
                <div className="guard-switch" style={{ marginTop: 4 }}>
                  <Switch checked={d.gzip} onChange={(v) => set({ gzip: v })} aria-label="Compress text" />
                  <span>Compress text answers (gzip): pages, styles, scripts and JSON travel smaller.</span>
                </div>
                <div className="guard-switch" style={{ marginTop: 4 }}>
                  <Switch checked={d.hsts} onChange={(v) => set({ hsts: v })} aria-label="HTTPS only in browsers" />
                  <span>
                    Tell browsers to use HTTPS only for this site (HSTS, one year). {site.ssl ? 'Browsers that visited once will refuse plain HTTP, so only switch it on when HTTPS stays.' : 'It takes effect once HTTPS is on for this site.'}
                  </span>
                </div>
                <div className="gd-field">
                  <b>Extra response headers</b>
                  {d.headers.map((h, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8 }}>
                      <Input style={{ width: 260 }} value={h.name} spellCheck={false} placeholder="X-Frame-Options" aria-label="Header name" onChange={(e) => set({ headers: d.headers.map((x, j) => (j === i ? { ...x, name: e.target.value.trim() } : x)) })} />
                      <Input style={{ flex: 1 }} value={h.value} spellCheck={false} placeholder="SAMEORIGIN" aria-label="Header value" onChange={(e) => set({ headers: d.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                      <Button type="text" icon={<DeleteOutlined />} aria-label="Remove this header" onClick={() => set({ headers: d.headers.filter((_, j) => j !== i) })} />
                    </div>
                  ))}
                  <div>
                    <Button size="small" icon={<PlusOutlined />} onClick={() => set({ headers: [...d.headers, { name: '', value: '' }] })}>
                      Add a header
                    </Button>
                  </div>
                </div>
              </div>
            )
          },
          {
            key: 'advanced',
            label: 'Advanced',
            children: (
              <div className="gd-form">
                <p className="db-hint" style={{ margin: 0 }}>
                  Nginx directives for what the form does not cover. They are placed inside this site's <span className="mono">server</span> block and kept on every deploy. Nginx checks the whole configuration before it is used: with a
                  mistake nothing changes and you see nginx's message.
                </p>
                <Input.TextArea
                  value={d.extra}
                  onChange={(e) => set({ extra: e.target.value })}
                  spellCheck={false}
                  autoSize={{ minRows: 10, maxRows: 18 }}
                  className="mono"
                  style={{ fontSize: 12.5 }}
                  aria-label="Extra nginx directives"
                  placeholder={'location = /robots.txt {\n    return 200 "User-agent: *\\nDisallow: /admin\\n";\n}\n\nlocation /old-page {\n    return 301 /new-page;\n}'}
                />
                <p className="db-hint" style={{ margin: 0 }}>To see the whole result, save and then open More, View nginx config.</p>
              </div>
            )
          }
        ]}
      />
    </Modal>
  )
}
