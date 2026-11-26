// The online code editor, like a hosting panel's: a folder tree, several files in tabs, a toolbar,
// search across files and a status line. One CodeMirror view; each tab keeps its own document,
// undo history and cursor, so switching tabs loses nothing.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { App as AntApp, Button, Checkbox, Empty, Input, Select, Spin, Tooltip } from 'antd'
import {
  ArrowUpOutlined,
  CloseOutlined,
  DownOutlined,
  FileAddOutlined,
  FileOutlined,
  FileSearchOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  NumberOutlined,
  ReloadOutlined,
  RightOutlined,
  SaveOutlined,
  SearchOutlined,
  SwapOutlined,
  ZoomInOutlined,
  ZoomOutOutlined
} from '@ant-design/icons'
import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { gotoLine, openSearchPanel } from '@codemirror/search'
import { oneDark } from '@codemirror/theme-one-dark'
import type { FileEntry, FileSearchResult } from '@shared/types'
import { IMAGE_FILE_RE, MAX_EDIT_BYTES, MAX_IMAGE_BYTES } from '@shared/types'
import { languageOf, lightTheme } from './CodeEditor'
import { fileIconUrl } from '../fileIcons'
import { bytes, errText } from '../util'

/** The languages the highlighter can be switched to, each with a file name that selects it. */
const LANGUAGES: [string, string][] = [
  ['Plain text', 'x.txt'],
  ['PHP', 'x.php'],
  ['JavaScript', 'x.js'],
  ['TypeScript', 'x.ts'],
  ['HTML', 'x.html'],
  ['CSS', 'x.css'],
  ['JSON', 'x.json'],
  ['Python', 'x.py'],
  ['SQL', 'x.sql'],
  ['YAML', 'x.yml'],
  ['Markdown', 'x.md'],
  ['XML', 'x.xml'],
  ['Shell', 'x.sh'],
  ['Nginx', '/etc/nginx/nginx.conf'],
  ['Settings', '.env'],
  ['Dockerfile', 'Dockerfile'],
  ['TOML', 'x.toml'],
  ['Ruby', 'x.rb'],
  ['Go', 'x.go']
]

function language(path: string, override?: string): { label: string; ext: Extension } {
  const pick = override ? LANGUAGES.find((l) => l[0] === override) : undefined
  return languageOf(pick ? pick[1] : path)
}

interface Tab {
  path: string
  version: string
  mode: string
  owner: string
  group: string
  crlf: boolean
  dirty: boolean
  saving: boolean
  lang?: string
  /** A picture shown instead of the editor: its data: URL and size. */
  image?: string
  size?: number
}

interface Prefs {
  fontSize: number
  wrap: boolean
}

const PREFS_KEY = 'editor.prefs'

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>
    return { fontSize: Math.min(22, Math.max(11, Number(p.fontSize) || 13)), wrap: p.wrap === true }
  } catch {
    return { fontSize: 13, wrap: false }
  }
}

const parentOf = (p: string): string => (p === '/' ? '/' : p.replace(/\/[^/]+\/?$/, '') || '/')
const joinPath = (dir: string, name: string): string => (dir === '/' ? `/${name}` : `${dir}/${name}`)
const baseName = (p: string): string => p.split('/').pop() || p

type DirState = { entries: FileEntry[]; truncated: boolean } | { error: string } | 'loading'

interface Props {
  projectId: string
  /** The folder the tree starts at. */
  root: string
  /** A file to open straight away. */
  openPath?: string
  dark: boolean
  onClose: () => void
}

export default function CodeWorkspace({ projectId, root: startRoot, openPath, dark, onClose }: Props) {
  const { modal, message } = AntApp.useApp()
  const [root, setRoot] = useState(startRoot)
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set([startRoot]))
  const [target, setTarget] = useState(startRoot)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [cursor, setCursor] = useState({ line: 1, col: 1, size: 0 })
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [side, setSide] = useState<'files' | 'search'>('files')
  const [query, setQuery] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [include, setInclude] = useState('')
  const [everything, setEverything] = useState(false)
  const [found, setFound] = useState<(FileSearchResult & { query: string; dir: string }) | null>(null)
  const [searching, setSearching] = useState(false)
  const [asking, setAsking] = useState<null | { kind: 'file' | 'dir'; dir: string; name: string }>(null)

  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const states = useRef(new Map<string, EditorState>())
  const activeRef = useRef<string | null>(null)
  const tabsRef = useRef<Tab[]>([])
  tabsRef.current = tabs
  activeRef.current = active
  const comp = useRef({ lang: new Compartment(), theme: new Compartment(), wrap: new Compartment(), font: new Compartment(), eol: new Compartment() })
  const actions = useRef({ save: (): void => undefined, saveAll: (): void => undefined })

  const fontTheme = (n: number): Extension => EditorView.theme({ '&': { fontSize: `${n}px` } })
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      /* preferences are a convenience */
    }
  }, [prefs])

  // ---------------------------------------------------------------- the tree
  const loadDir = useCallback(
    async (dir: string): Promise<void> => {
      setDirs((d) => ({ ...d, [dir]: 'loading' }))
      try {
        const l = await window.api.files.list(projectId, dir)
        const entries = [...l.entries].sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
        setDirs((d) => ({ ...d, [dir]: { entries, truncated: l.truncated } }))
      } catch (err) {
        setDirs((d) => ({ ...d, [dir]: { error: errText(err) } }))
      }
    },
    [projectId]
  )

  useEffect(() => {
    void loadDir(root)
  }, [root, loadDir])

  const toggleDir = (dir: string): void => {
    setTarget(dir)
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(dir)) next.delete(dir)
      else {
        next.add(dir)
        if (!dirs[dir] || 'error' in (dirs[dir] as object)) void loadDir(dir)
      }
      return next
    })
  }

  const goUp = (): void => {
    const up = parentOf(root)
    if (up === root) return
    setRoot(up)
    setTarget(up)
    setExpanded((s) => new Set([...s, up]))
  }

  // ---------------------------------------------------------------- the editor
  const baseExtensions = (path: string, crlf: boolean, lang?: string): Extension[] => [
    basicSetup,
    keymap.of([indentWithTab]),
    comp.current.lang.of(language(path, lang).ext),
    comp.current.theme.of(dark ? oneDark : lightTheme),
    comp.current.wrap.of(prefs.wrap ? EditorView.lineWrapping : []),
    comp.current.font.of(fontTheme(prefs.fontSize)),
    // A Windows file stays a Windows file: its line endings are kept when it is saved.
    comp.current.eol.of(crlf ? EditorState.lineSeparator.of('\r\n') : []),
    EditorView.updateListener.of((u) => {
      const path = activeRef.current
      if (!path) return
      if (u.docChanged) setTabs((ts) => ts.map((t) => (t.path === path && !t.dirty ? { ...t, dirty: true } : t)))
      if (u.selectionSet || u.docChanged) {
        const head = u.state.selection.main.head
        const line = u.state.doc.lineAt(head)
        setCursor({ line: line.number, col: head - line.from + 1, size: u.state.doc.length })
      }
    })
  ]

  // One view for every tab: created once, given each tab's state in turn.
  useEffect(() => {
    if (!host.current) return
    const v = new EditorView({ parent: host.current, state: EditorState.create({ doc: '' }) })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
  }, [])

  /** The settings that apply to every tab, put on the one being shown. */
  const applyPrefs = (v: EditorView): void => {
    v.dispatch({
      effects: [
        comp.current.theme.reconfigure(dark ? oneDark : lightTheme),
        comp.current.wrap.reconfigure(prefs.wrap ? EditorView.lineWrapping : []),
        comp.current.font.reconfigure(fontTheme(prefs.fontSize))
      ]
    })
  }

  useEffect(() => {
    if (view.current && active) applyPrefs(view.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark, prefs])

  const show = (path: string, line?: number): void => {
    const v = view.current
    if (!v) return
    const current = activeRef.current
    if (current && current !== path && states.current.has(current)) states.current.set(current, v.state)
    if (tabsRef.current.find((t) => t.path === path)?.image) {
      activeRef.current = path
      setActive(path)
      return
    }
    const st = states.current.get(path)
    if (!st) return
    activeRef.current = path
    setActive(path)
    if (current !== path) v.setState(st)
    applyPrefs(v)
    if (line && line >= 1 && line <= v.state.doc.lines) {
      const pos = v.state.doc.line(line).from
      v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
    }
    const head = v.state.selection.main.head
    const l = v.state.doc.lineAt(head)
    setCursor({ line: l.number, col: head - l.from + 1, size: v.state.doc.length })
    v.focus()
  }

  const openFile = async (path: string, line?: number): Promise<void> => {
    if (states.current.has(path) || tabsRef.current.some((t) => t.path === path)) return show(path, line)
    setOpening(path)
    try {
      if (IMAGE_FILE_RE.test(path)) {
        const img = await window.api.files.image(projectId, path)
        const t: Tab = { path, version: '', mode: img.mode, owner: img.owner, group: img.group, crlf: false, dirty: false, saving: false, image: img.url, size: img.size }
        tabsRef.current = [...tabsRef.current, t]
        setTabs((ts) => [...ts, t])
        show(path)
        return
      }
      const f = await window.api.files.read(projectId, path)
      const crlf = f.content.includes('\r\n')
      states.current.set(path, EditorState.create({ doc: f.content, extensions: baseExtensions(path, crlf) }))
      setTabs((ts) => [...ts, { path, version: f.version, mode: f.mode, owner: f.owner, group: f.group, crlf, dirty: false, saving: false }])
      show(path, line)
    } catch (err) {
      message.error(errText(err), 6)
    } finally {
      setOpening(null)
    }
  }

  useEffect(() => {
    if (openPath) void openFile(openPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const textOf = (path: string): string => {
    const st = path === activeRef.current && view.current ? view.current.state : states.current.get(path)
    // sliceDoc joins lines with the file's own line break (CRLF for a Windows file); doc.toString() always uses LF.
    return st ? st.sliceDoc() : ''
  }

  const saveTab = async (path: string): Promise<boolean> => {
    const tab = tabsRef.current.find((t) => t.path === path)
    if (!tab || tab.saving) return false
    if (tab.image) return true
    setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, saving: true } : t)))
    try {
      const version = await window.api.files.write(projectId, path, textOf(path), tab.version)
      setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, version, dirty: false, saving: false } : t)))
      return true
    } catch (err) {
      setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, saving: false } : t)))
      message.error(`${baseName(path)}: ${errText(err)}`, 8)
      return false
    }
  }

  const save = async (): Promise<void> => {
    const path = activeRef.current
    if (path && (await saveTab(path))) message.success(`Saved ${baseName(path)}`, 1.5)
  }

  const saveAll = async (): Promise<void> => {
    const dirty = tabsRef.current.filter((t) => t.dirty)
    let n = 0
    for (const t of dirty) if (await saveTab(t.path)) n += 1
    if (n) message.success(`Saved ${n} file${n === 1 ? '' : 's'}`, 1.5)
  }
  actions.current = { save: () => void save(), saveAll: () => void saveAll() }

  // Save works anywhere in the editor window (after a dialog the focus is no longer in the text).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 's') return
      // Typing in a dialog (a new file name, a confirmation) is not a save.
      if ((document.activeElement as HTMLElement | null)?.closest('.ant-modal')) return
      e.preventDefault()
      e.stopPropagation()
      if (e.shiftKey) actions.current.saveAll()
      else actions.current.save()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const closeTab = (path: string): void => {
    const go = (): void => {
      const list = tabsRef.current
      const i = list.findIndex((t) => t.path === path)
      const rest = list.filter((t) => t.path !== path)
      states.current.delete(path)
      setTabs(rest)
      if (activeRef.current === path) {
        const next = rest[Math.min(i, rest.length - 1)]
        activeRef.current = null
        if (next) show(next.path)
        else {
          setActive(null)
          view.current?.setState(EditorState.create({ doc: '' }))
        }
      }
    }
    if (tabsRef.current.find((t) => t.path === path)?.dirty) {
      modal.confirm({ title: `Close ${baseName(path)} without saving?`, content: 'Your changes to this file will be lost.', okText: 'Close without saving', okButtonProps: { danger: true }, onOk: go })
    } else go()
  }

  const closeAll = (): void => {
    const dirty = tabsRef.current.filter((t) => t.dirty)
    if (dirty.length === 0) return onClose()
    modal.confirm({
      title: `${dirty.length} file${dirty.length === 1 ? ' has' : 's have'} unsaved changes`,
      content: dirty.map((t) => baseName(t.path)).join(', '),
      okText: 'Close without saving',
      okButtonProps: { danger: true },
      onOk: onClose
    })
  }

  const setLanguage = (label: string): void => {
    const path = activeRef.current
    if (!path || !view.current) return
    setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, lang: label } : t)))
    view.current.dispatch({ effects: comp.current.lang.reconfigure(language(path, label).ext) })
  }

  // ---------------------------------------------------------------- new files and folders
  const create = async (): Promise<void> => {
    if (!asking) return
    const name = asking.name.trim()
    if (!name) return
    try {
      await window.api.files.create(projectId, asking.dir, name, asking.kind)
      setAsking(null)
      setExpanded((s) => new Set([...s, asking.dir]))
      await loadDir(asking.dir)
      if (asking.kind === 'file') void openFile(joinPath(asking.dir, name))
    } catch (err) {
      message.error(errText(err), 6)
    }
  }

  // ---------------------------------------------------------------- search across files
  const runSearch = async (): Promise<void> => {
    if (!query.trim()) return
    setSearching(true)
    try {
      const r = await window.api.files.search(projectId, root, query, { caseSensitive: matchCase, include, everything })
      setFound({ ...r, query, dir: root })
    } catch (err) {
      message.error(errText(err), 6)
    } finally {
      setSearching(false)
    }
  }

  const grouped = useMemo(() => {
    const m = new Map<string, FileSearchResult['hits']>()
    for (const h of found?.hits ?? []) m.set(h.path, [...(m.get(h.path) ?? []), h])
    return [...m.entries()]
  }, [found])

  const rel = (p: string, base: string): string => (p.startsWith(base === '/' ? '/' : base + '/') ? p.slice(base === '/' ? 1 : base.length + 1) : p)

  const mark = (text: string, q: string): ReactNode => {
    const i = matchCase ? text.indexOf(q) : text.toLowerCase().indexOf(q.toLowerCase())
    if (i < 0 || !q) return text
    return (
      <>
        {text.slice(0, i)}
        <mark>{text.slice(i, i + q.length)}</mark>
        {text.slice(i + q.length)}
      </>
    )
  }

  // ---------------------------------------------------------------- drawing
  const renderDir = (dir: string, depth: number): ReactNode => {
    const st = dirs[dir]
    if (!st || st === 'loading') return <div className="ws-tree-note" style={{ paddingLeft: 12 + depth * 14 }}><Spin size="small" /> Loading…</div>
    if ('error' in st) return <div className="ws-tree-note ws-tree-error" style={{ paddingLeft: 12 + depth * 14 }}>{st.error}</div>
    if (st.entries.length === 0) return <div className="ws-tree-note" style={{ paddingLeft: 12 + depth * 14 }}>Empty folder</div>
    return (
      <>
        {st.entries.map((e) => {
          const path = joinPath(dir, e.name)
          if (e.isDir) {
            const open = expanded.has(path)
            return (
              <div key={path}>
                <button type="button" className={`ws-node${target === path ? ' ws-node-target' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggleDir(path)} title={path}>
                  {open ? <DownOutlined className="ws-caret" /> : <RightOutlined className="ws-caret" />}
                  {open ? <FolderOpenOutlined className="ws-folder" /> : <FolderOutlined className="ws-folder" />}
                  <span>{e.name}</span>
                </button>
                {open && renderDir(path, depth + 1)}
              </div>
            )
          }
          const big = e.size > (IMAGE_FILE_RE.test(e.name) ? MAX_IMAGE_BYTES : MAX_EDIT_BYTES)
          return (
            <button
              key={path}
              type="button"
              className={`ws-node${active === path ? ' ws-node-active' : ''}${big ? ' ws-node-big' : ''}`}
              style={{ paddingLeft: 22 + depth * 14 }}
              title={big ? `${path} · ${bytes(e.size)}, too large to edit here` : `${path} · ${bytes(e.size)}`}
              onClick={() => {
                setTarget(dir)
                if (big) message.info(`${e.name} is too large to open here. Download it from Files.`)
                else void openFile(path)
              }}
            >
              <img className="ws-file-img" src={fileIconUrl(e.name)} alt="" draggable={false} />
              <span>{e.name}</span>
              {opening === path && <Spin size="small" />}
            </button>
          )
        })}
        {st.truncated && <div className="ws-tree-note" style={{ paddingLeft: 12 + depth * 14 }}>Only the first 3000 items are shown.</div>}
      </>
    )
  }

  const tab = tabs.find((t) => t.path === active)
  const editTab = tab && !tab.image ? tab : undefined
  const lang = tab ? language(tab.path, tab.lang).label : ''
  const dirtyCount = tabs.filter((t) => t.dirty).length

  return (
    <div className={`ws${dark ? ' ws-dark' : ''}`} role="dialog" aria-label="Code editor">
      <div className="ws-head" style={isMac ? { paddingLeft: 88 } : undefined}>
        <span className="ws-title">Editor</span>
        <span className="ws-root mono" title={root}>{root}</span>
        <div className="ws-tools">
          <Tooltip title={`Save (${isMac ? '⌘' : 'Ctrl+'}S)`}>
            <Button size="small" icon={<SaveOutlined />} disabled={!tab?.dirty} loading={tab?.saving} onClick={() => void save()}>
              Save
            </Button>
          </Tooltip>
          <Tooltip title={`Save every changed file (${isMac ? '⇧⌘' : 'Ctrl+Shift+'}S)`}>
            <Button size="small" disabled={dirtyCount === 0} onClick={() => void saveAll()}>
              Save all{dirtyCount ? ` (${dirtyCount})` : ''}
            </Button>
          </Tooltip>
          <span className="ws-sep" />
          <Tooltip title={`Find (${isMac ? '⌘' : 'Ctrl+'}F)`}>
            <Button size="small" icon={<SearchOutlined />} disabled={!editTab} aria-label="Find" onClick={() => view.current && openSearchPanel(view.current)} />
          </Tooltip>
          <Tooltip title="Find and replace">
            <Button
              size="small"
              icon={<SwapOutlined />}
              disabled={!editTab}
              aria-label="Replace"
              onClick={() => {
                if (!view.current) return
                openSearchPanel(view.current)
                setTimeout(() => (view.current?.dom.querySelector('.cm-search input[name=replace]') as HTMLInputElement | null)?.focus(), 30)
              }}
            />
          </Tooltip>
          <Tooltip title={`Go to line (${isMac ? '⌥⌘' : 'Ctrl+Alt+'}G)`}>
            <Button size="small" icon={<NumberOutlined />} disabled={!editTab} aria-label="Go to line" onClick={() => view.current && gotoLine(view.current)} />
          </Tooltip>
          <span className="ws-sep" />
          <Tooltip title="Smaller text">
            <Button size="small" icon={<ZoomOutOutlined />} aria-label="Smaller text" disabled={prefs.fontSize <= 11} onClick={() => setPrefs((p) => ({ ...p, fontSize: p.fontSize - 1 }))} />
          </Tooltip>
          <span className="ws-font">{prefs.fontSize}px</span>
          <Tooltip title="Larger text">
            <Button size="small" icon={<ZoomInOutlined />} aria-label="Larger text" disabled={prefs.fontSize >= 22} onClick={() => setPrefs((p) => ({ ...p, fontSize: p.fontSize + 1 }))} />
          </Tooltip>
          <Checkbox checked={prefs.wrap} onChange={(e) => setPrefs((p) => ({ ...p, wrap: e.target.checked }))}>
            Wrap lines
          </Checkbox>
          <Select size="small" style={{ width: 140 }} value={lang || undefined} placeholder="Language" disabled={!editTab} onChange={setLanguage} options={LANGUAGES.map(([l]) => ({ value: l, label: l }))} aria-label="Language" />
          <span className="ws-sep" />
          <Button size="small" icon={<CloseOutlined />} onClick={closeAll}>
            Close
          </Button>
        </div>
      </div>

      <div className="ws-body">
        <aside className="ws-side">
          <div className="ws-side-tabs">
            <button type="button" className={side === 'files' ? 'on' : ''} onClick={() => setSide('files')}>
              <FolderOutlined /> Files
            </button>
            <button type="button" className={side === 'search' ? 'on' : ''} onClick={() => setSide('search')}>
              <FileSearchOutlined /> Search
            </button>
          </div>
          {side === 'files' ? (
            <>
              <div className="ws-side-bar">
                <Tooltip title="Up one folder">
                  <Button size="small" type="text" icon={<ArrowUpOutlined />} aria-label="Up one folder" disabled={root === '/'} onClick={goUp} />
                </Tooltip>
                <Tooltip title="Reload">
                  <Button size="small" type="text" icon={<ReloadOutlined />} aria-label="Reload" onClick={() => [...expanded].concat(root).forEach((d) => dirs[d] && void loadDir(d))} />
                </Tooltip>
                <Tooltip title={`New file in ${target}`}>
                  <Button size="small" type="text" icon={<FileAddOutlined />} aria-label="New file" onClick={() => setAsking({ kind: 'file', dir: target, name: '' })} />
                </Tooltip>
                <Tooltip title={`New folder in ${target}`}>
                  <Button size="small" type="text" icon={<FolderAddOutlined />} aria-label="New folder" onClick={() => setAsking({ kind: 'dir', dir: target, name: '' })} />
                </Tooltip>
              </div>
              {asking && (
                <div className="ws-ask">
                  <div className="ws-tree-note">
                    New {asking.kind === 'file' ? 'file' : 'folder'} in <span className="mono">{asking.dir}</span>
                  </div>
                  <Input
                    size="small"
                    autoFocus
                    value={asking.name}
                    placeholder={asking.kind === 'file' ? 'index.php' : 'folder name'}
                    onChange={(e) => setAsking({ ...asking, name: e.target.value })}
                    onPressEnter={() => void create()}
                    onKeyDown={(e) => e.key === 'Escape' && setAsking(null)}
                  />
                  <div className="ws-ask-buttons">
                    <Button size="small" onClick={() => setAsking(null)}>Cancel</Button>
                    <Button size="small" type="primary" disabled={!asking.name.trim()} onClick={() => void create()}>Create</Button>
                  </div>
                </div>
              )}
              <div className="ws-tree">
                <button type="button" className={`ws-node ws-node-root${target === root ? ' ws-node-target' : ''}`} onClick={() => setTarget(root)} title={root}>
                  <FolderOpenOutlined className="ws-folder" />
                  <span>{baseName(root) || '/'}</span>
                </button>
                {renderDir(root, 0)}
              </div>
            </>
          ) : (
            <div className="ws-search">
              <Input.Search size="small" placeholder="Text to find" value={query} onChange={(e) => setQuery(e.target.value)} onSearch={() => void runSearch()} loading={searching} enterButton aria-label="Text to find" />
              <Input size="small" placeholder="In files like *.php *.env (all if empty)" value={include} onChange={(e) => setInclude(e.target.value)} onPressEnter={() => void runSearch()} aria-label="File names to search in" />
              <Checkbox checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)}>Match case</Checkbox>
              <Checkbox checked={everything} onChange={(e) => setEverything(e.target.checked)}>Include node_modules, vendor, .git</Checkbox>
              <div className="ws-tree-note">In <span className="mono">{root}</span></div>
              <div className="ws-results">
                {found && found.hits.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`Nothing found for "${found.query}"`} />}
                {grouped.map(([file, hits]) => (
                  <div key={file} className="ws-hit-file">
                    <div className="ws-hit-name" title={file}>
                      <img className="ws-file-img" src={fileIconUrl(file.split('/').pop() ?? '')} alt="" draggable={false} /> {rel(file, found!.dir)} <span className="ws-count">{hits.length}</span>
                    </div>
                    {hits.map((h) => (
                      <button type="button" key={`${h.path}:${h.line}`} className="ws-hit" onClick={() => void openFile(h.path, h.line)} title={`Line ${h.line}`}>
                        <span className="ws-hit-line">{h.line}</span>
                        <span className="ws-hit-text mono">{mark(h.text.trim(), found!.query)}</span>
                      </button>
                    ))}
                  </div>
                ))}
                {found?.truncated && <div className="ws-tree-note">Only the first 500 matches are shown. Narrow the search with file names or a deeper folder.</div>}
              </div>
            </div>
          )}
        </aside>

        <section className="ws-main">
          <div className="ws-tabs" role="tablist">
            {tabs.map((t) => (
              <div
                key={t.path}
                role="tab"
                aria-selected={t.path === active}
                className={`ws-tab${t.path === active ? ' on' : ''}`}
                title={t.path}
                onClick={() => show(t.path)}
                onMouseDown={(e) => e.button === 1 && (e.preventDefault(), closeTab(t.path))}
              >
                <img className="ws-file-img" src={fileIconUrl(t.path.split('/').pop() ?? '')} alt="" draggable={false} />
                <span>{baseName(t.path)}</span>
                {tabs.some((o) => o !== t && baseName(o.path) === baseName(t.path)) && <span className="ws-tab-dir">{rel(parentOf(t.path), root) || parentOf(t.path)}</span>}
                {t.dirty ? <span className="ws-dot" aria-label="unsaved" /> : null}
                <button type="button" className="ws-tab-x" aria-label={`Close ${baseName(t.path)}`} onClick={(e) => (e.stopPropagation(), closeTab(t.path))}>
                  <CloseOutlined />
                </button>
              </div>
            ))}
          </div>
          <div className="ws-editor-wrap">
            <div ref={host} className="ws-editor" style={{ visibility: editTab ? 'visible' : 'hidden' }} />
            {tab?.image && (
              <div className="ws-image">
                <img src={tab.image} alt={baseName(tab.path)} draggable={false} />
              </div>
            )}
            {!tab && (
              <div className="ws-empty">
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Open a file from the tree, or search across files." />
              </div>
            )}
          </div>
          <div className="ws-status">
            {tab?.image ? (
              <>
                <span>Picture</span>
                <span>{bytes(tab.size ?? 0)}</span>
                <span>
                  {tab.mode} {tab.owner}:{tab.group}
                </span>
                <span className="mono ws-status-path">{tab.path}</span>
              </>
            ) : tab ? (
              <>
                <span>{lang}</span>
                <span>
                  Line {cursor.line}, column {cursor.col}
                </span>
                <span>{cursor.size.toLocaleString()} characters</span>
                <span>{tab.crlf ? 'CRLF' : 'LF'}</span>
                <span>UTF-8</span>
                <span>
                  {tab.mode} {tab.owner}:{tab.group}
                </span>
                <span className="mono ws-status-path">{tab.path}</span>
                <span className={tab.dirty ? 'ws-unsaved' : 'ws-saved'}>{tab.saving ? 'Saving…' : tab.dirty ? 'Unsaved changes' : 'Saved'}</span>
              </>
            ) : (
              <span>{tabs.length} open</span>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
