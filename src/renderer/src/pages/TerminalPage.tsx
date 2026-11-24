import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { CloseOutlined, PlusOutlined } from '@ant-design/icons'
import { errText } from '../util'

export interface TermTab {
  key: string
  projectId: string
  title: string
}

interface Props {
  visible: boolean
  tabs: TermTab[]
  active: string | null
  canAdd: boolean
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onAdd: () => void
}

const THEME = {
  background: 'rgba(0, 0, 0, 0)',
  foreground: '#d8dde8',
  cursor: '#7aa2ff',
  selectionBackground: 'rgba(122, 162, 255, 0.35)',
  black: '#1b1f29',
  red: '#f7768e',
  green: '#73daa0',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#c0caf5',
  brightBlack: '#565f7a'
}

function TermView({ tab, shown }: { tab: TermTab; shown: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, "Cascadia Mono", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      allowTransparency: true,
      theme: THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    termRef.current = term

    const safeFit = (): void => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        try {
          fit.fit()
        } catch {
          /* the pane is being torn down */
        }
      }
    }
    safeFit()

    let sessionId: string | null = null
    let disposed = false

    term.writeln('\x1b[90mConnecting…\x1b[0m')
    window.api.terminal
      .open(tab.projectId, term.cols, term.rows)
      .then((id) => {
        if (disposed) {
          void window.api.terminal.close(id).catch(() => undefined)
          return
        }
        sessionId = id
        term.clear()
        window.api.terminal.resize(id, term.cols, term.rows)
      })
      .catch((err) => term.writeln(`\x1b[31m${errText(err)}\x1b[0m`))

    const offData = window.api.terminal.onData((p) => {
      if (p.id === sessionId) term.write(p.data)
    })
    const offExit = window.api.terminal.onExit((p) => {
      if (p.id === sessionId) {
        sessionId = null
        term.writeln('\r\n\x1b[90m[Session closed. Close this tab and open a new one to reconnect.]\x1b[0m')
      }
    })
    const input = term.onData((d) => {
      if (sessionId) window.api.terminal.write(sessionId, d)
    })
    const resize = term.onResize(({ cols, rows }) => {
      if (sessionId) window.api.terminal.resize(sessionId, cols, rows)
    })
    const observer = new ResizeObserver(safeFit)
    observer.observe(el)

    return () => {
      disposed = true
      observer.disconnect()
      offData()
      offExit()
      input.dispose()
      resize.dispose()
      if (sessionId) void window.api.terminal.close(sessionId).catch(() => undefined)
      term.dispose()
      termRef.current = null
    }
  }, [tab.projectId])

  useEffect(() => {
    if (shown) termRef.current?.focus()
  }, [shown])

  return <div ref={host} className={`term-pane ${shown ? '' : 'hidden'}`} />
}

export default function TerminalPage({ visible, tabs, active, canAdd, onSelect, onClose, onAdd }: Props) {
  return (
    <div className={`term-wrap ${visible ? '' : 'hidden'}`}>
      <div className="term-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={t.key === active}
            className={`term-tab ${t.key === active ? 'active' : ''}`}
            onClick={() => onSelect(t.key)}
          >
            {t.title}
            <span
              className="x"
              role="button"
              aria-label={`Close ${t.title}`}
              onClick={(e) => {
                e.stopPropagation()
                onClose(t.key)
              }}
            >
              <CloseOutlined />
            </span>
          </button>
        ))}
        {canAdd && (
          <button className="term-add" aria-label="New terminal" onClick={onAdd}>
            <PlusOutlined />
          </button>
        )}
      </div>
      <div className="term-body">
        {tabs.length === 0 && <div className="term-empty">No terminal open. Press + to start one.</div>}
        {tabs.map((t) => (
          <TermView key={t.key} tab={t} shown={visible && t.key === active} />
        ))}
      </div>
    </div>
  )
}
