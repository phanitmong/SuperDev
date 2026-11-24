import { useEffect, useRef } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { StreamLanguage } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { php } from '@codemirror/lang-php'
import { javascript } from '@codemirror/lang-javascript'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { markdown } from '@codemirror/lang-markdown'
import { xml } from '@codemirror/lang-xml'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { go } from '@codemirror/legacy-modes/mode/go'

/** The language of a file, from its name. Returns a label for the status line and the highlighter. */
export function languageOf(path: string): { label: string; ext: Extension } {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  const legacy = (label: string, mode: Parameters<typeof StreamLanguage.define>[0]): { label: string; ext: Extension } => ({ label, ext: StreamLanguage.define(mode) })
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return legacy('Dockerfile', dockerFile)
  if (name === '.env' || name.startsWith('.env.') || ['ini', 'env', 'properties', 'cnf'].includes(ext) || name === '.user.ini') return legacy('Settings', properties)
  if (name === 'nginx.conf' || path.includes('/nginx/') || path.includes('/vhost/') || (ext === 'conf' && /superdevops-|sites-|conf\.d/.test(path))) return legacy('Nginx', nginx)
  if (name === '.htaccess') return legacy('Apache', properties)
  switch (ext) {
    case 'php':
    case 'phtml':
      return { label: 'PHP', ext: php() }
    case 'js':
    case 'mjs':
    case 'cjs':
      return { label: 'JavaScript', ext: javascript() }
    case 'jsx':
      return { label: 'JavaScript (JSX)', ext: javascript({ jsx: true }) }
    case 'ts':
      return { label: 'TypeScript', ext: javascript({ typescript: true }) }
    case 'tsx':
      return { label: 'TypeScript (TSX)', ext: javascript({ typescript: true, jsx: true }) }
    case 'html':
    case 'htm':
    case 'vue':
    case 'twig':
      return { label: 'HTML', ext: html() }
    case 'css':
    case 'scss':
    case 'less':
      return { label: 'CSS', ext: css() }
    case 'json':
    case 'lock':
      return { label: 'JSON', ext: json() }
    case 'py':
      return { label: 'Python', ext: python() }
    case 'sql':
      return { label: 'SQL', ext: sql() }
    case 'yml':
    case 'yaml':
      return { label: 'YAML', ext: yaml() }
    case 'md':
    case 'markdown':
      return { label: 'Markdown', ext: markdown() }
    case 'xml':
    case 'svg':
      return { label: 'XML', ext: xml() }
    case 'sh':
    case 'bash':
    case 'zsh':
      return legacy('Shell', shell)
    case 'toml':
      return legacy('TOML', toml)
    case 'rb':
      return legacy('Ruby', ruby)
    case 'go':
      return legacy('Go', go)
    case 'conf':
      return legacy('Config', nginx)
    default:
      if (['.bashrc', '.profile', '.bash_profile', '.zshrc'].includes(name)) return legacy('Shell', shell)
      return { label: 'Plain text', ext: [] }
  }
}

export const lightTheme = EditorView.theme({
  '&': { backgroundColor: '#fbfcff', color: '#171c33' },
  '.cm-gutters': { backgroundColor: '#f2f4fa', color: '#8a93ad', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(51, 102, 255, 0.06)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(51, 102, 255, 0.1)' }
})

interface Props {
  /** Changing this loads a new document. */
  docKey: string
  path: string
  value: string
  dark: boolean
  onChange: (text: string) => void
  onSave: () => void
  onCursor?: (line: number, column: number) => void
}

/** Code editor with line numbers, syntax colours, bracket matching, folding, search (Ctrl/Cmd+F) and multi-cursor. */
export default function CodeEditor({ docKey, path, value, dark, onChange, onSave, onCursor }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const themeBox = useRef(new Compartment())
  const handlers = useRef({ onChange, onSave, onCursor })
  handlers.current = { onChange, onSave, onCursor }

  useEffect(() => {
    if (!host.current) return
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          // Ahead of the built-in keys, which use Ctrl/Cmd+Enter for "insert a blank line".
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-Enter',
                preventDefault: true,
                run: () => {
                  handlers.current.onSave()
                  return true
                }
              }
            ])
          ),
          basicSetup,
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                handlers.current.onSave()
                return true
              }
            },
            indentWithTab
          ]),
          languageOf(path).ext,
          themeBox.current.of(dark ? oneDark : lightTheme),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString())
            if (u.selectionSet || u.docChanged) {
              const head = u.state.selection.main.head
              const line = u.state.doc.lineAt(head)
              handlers.current.onCursor?.(line.number, head - line.from + 1)
            }
          })
        ]
      })
    })
    view.current = v
    v.focus()
    return () => {
      v.destroy()
      view.current = null
    }
    // The document is replaced only when another file is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey])

  useEffect(() => {
    view.current?.dispatch({ effects: themeBox.current.reconfigure(dark ? oneDark : lightTheme) })
  }, [dark])

  return <div ref={host} className="code-editor" />
}
