import { can, type Role } from '@shared/team'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MenuProps } from 'antd'
import { Alert, App as AntApp, Button, Checkbox, Dropdown, Empty, Form, Input, Modal, Select, Space, Spin, Table, Tabs, Tag, Tooltip } from 'antd'
import { CaretRightOutlined, DatabaseOutlined, DeleteOutlined, DisconnectOutlined, DownOutlined, EditOutlined, ExportOutlined, FolderOpenOutlined, HistoryOutlined, ImportOutlined, SaveOutlined, TeamOutlined, DownloadOutlined, EyeOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, TableOutlined } from '@ant-design/icons'
import type { DbConnection, DbGridPage, DbResultSet, DbRunResult, DbTableInfo, DbTableSummary, Project } from '@shared/types'
import CodeEditor from '../components/CodeEditor'
import DbConnectionForm from '../components/DbConnectionForm'
import TableDesigner from '../components/TableDesigner'
import DbRemoteSchedule from '../components/DbRemoteSchedule'
import ConfirmIdentity from '../components/ConfirmIdentity'
import { ago, bytes, errText } from '../util'

type Row = Record<string, string | null>

function csv(columns: string[], rows: (string | null)[][]): string {
  const cell = (v: string | null): string => (v === null ? '' : /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  // The first bytes tell spreadsheet programs that the file is UTF-8, so Khmer and Chinese text opens correctly.
  return '﻿' + [columns.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n') + '\r\n'
}

function Cell({ value }: { value: string | null }) {
  if (value === null) return <span className="db-null">NULL</span>
  if (value === '') return <span className="db-null">(empty)</span>
  const flat = value.length > 140 ? value.slice(0, 140) + '…' : value
  return <span title={value.length > 140 ? value.slice(0, 2000) : undefined}>{flat.replace(/\n/g, '↵')}</span>
}

function ResultGrid({ set, name }: { set: DbResultSet; name: string }) {
  const { message } = AntApp.useApp()
  const save = async (): Promise<void> => {
    try {
      const path = await window.api.dbc.saveText(`${name}.csv`, csv(set.columns, set.rows))
      if (path) message.success(`Saved to ${path}`)
    } catch (err) {
      message.error(errText(err))
    }
  }
  return (
    <div className="db-result">
      <div className="db-result-head">
        <span className="mono">{set.statement}</span>
        <Space size={10}>
          <span>
            {set.affected !== undefined ? `${set.affected} row${set.affected === 1 ? '' : 's'} affected` : `${set.total} row${set.total === 1 ? '' : 's'}`}
            {set.truncated ? `, first ${set.rows.length} shown` : ''}
          </span>
          {set.rows.length > 0 && (
            <Button size="small" icon={<DownloadOutlined />} onClick={() => void save()}>
              CSV
            </Button>
          )}
        </Space>
      </div>
      {set.rows.length > 0 && (
        <Table<(string | null)[]>
          size="small"
          className="db-grid"
          rowKey={(_, i) => String(i)}
          dataSource={set.rows}
          scroll={{ x: 'max-content' }}
          pagination={set.rows.length > 100 ? { pageSize: 100, showSizeChanger: false, size: 'small' } : false}
          columns={set.columns.map((c, i) => ({ title: c, key: String(i), render: (_: unknown, r: (string | null)[]) => <Cell value={r[i]} /> }))}
        />
      )}
    </div>
  )
}

const RISKY = /\b(drop|truncate)\s+(table|database|schema)\b|\bdelete\s+from\s+\S+\s*(;|$)|\bupdate\s+\S+\s+set\b(?![\s\S]*\bwhere\b)/i

interface SavedQuery {
  name: string
  sql: string
}

function readSaved(): SavedQuery[] {
  try {
    const list = JSON.parse(localStorage.getItem('sd.savedQueries') ?? '[]') as SavedQuery[]
    return Array.isArray(list) ? list.filter((q) => q && typeof q.name === 'string' && typeof q.sql === 'string') : []
  } catch {
    return []
  }
}

function writeSaved(list: SavedQuery[]): void {
  try {
    localStorage.setItem('sd.savedQueries', JSON.stringify(list.slice(0, 200)))
  } catch {
    /* storage unavailable: the query simply is not kept */
  }
}

/** One query tab: its own SQL text, results and saved-query menu. */
function QueryPane({ paneKey, target, db, where, as, dark, initialSql, onRan, onTitle }: { paneKey: string; target?: string; db?: string; where: string; as: string; dark: boolean; initialSql: string; onRan: () => void; onTitle: (title: string) => void }) {
  const { message, modal } = AntApp.useApp()
  const sql = useRef(initialSql)
  const [docKey, setDocKey] = useState(paneKey)
  const [run, setRun] = useState<DbRunResult | null>(null)
  const [running, setRunning] = useState(false)
  const [saved, setSaved] = useState<SavedQuery[]>(readSaved)
  const [naming, setNaming] = useState<string | null>(null)

  const execute = (): void => {
    const text = sql.current.trim()
    if (!text || !target) return
    const go = async (): Promise<void> => {
      setRunning(true)
      try {
        setRun(await window.api.dbc.query(target, db ?? null, text))
        onRan()
      } catch (err) {
        setRun({ sets: [], error: errText(err), ms: 0 })
      } finally {
        setRunning(false)
      }
    }
    if (RISKY.test(text)) {
      modal.confirm({ title: 'This statement removes or overwrites data', content: 'It drops something, or changes every row because it has no WHERE. There is no undo except restoring a backup. Run it?', okText: 'Run it', okButtonProps: { danger: true }, onOk: go })
    } else void go()
  }

  const save = (): void => {
    const name = (naming ?? '').trim()
    if (!name) return
    const list = [{ name, sql: sql.current }, ...readSaved().filter((q) => q.name !== name)]
    writeSaved(list)
    setSaved(list)
    setNaming(null)
    onTitle(name)
    message.success(`Saved as "${name}"`)
  }

  const openSaved = (q: SavedQuery): void => {
    sql.current = q.sql
    setDocKey(`${paneKey}:${q.name}:${Date.now()}`)
    onTitle(q.name)
  }

  const removeSaved = (q: SavedQuery): void => {
    const list = readSaved().filter((x) => x.name !== q.name)
    writeSaved(list)
    setSaved(list)
  }

  return (
    <>
      <div className="sql-editor">
        <CodeEditor docKey={docKey} path="query.sql" value={sql.current} dark={dark} onChange={(t) => (sql.current = t)} onSave={execute} />
      </div>
      <div className="db-tools" style={{ marginTop: 10 }}>
        <Button type="primary" icon={<CaretRightOutlined />} loading={running} disabled={!target} onClick={execute}>
          Run
        </Button>
        <Button icon={<SaveOutlined />} onClick={() => setNaming('')}>
          Save
        </Button>
        <Dropdown
          trigger={['click']}
          onOpenChange={(o) => o && setSaved(readSaved())}
          menu={{
            items: saved.length
              ? saved.map((q) => ({
                  key: q.name,
                  label: (
                    <span className="saved-q">
                      <span>{q.name}</span>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`Delete saved query ${q.name}`} onClick={(e) => { e.stopPropagation(); removeSaved(q) }} />
                    </span>
                  ),
                  onClick: () => openSaved(q)
                }))
              : [{ key: 'none', disabled: true, label: 'No saved queries yet' }]
          }}
        >
          <Button icon={<FolderOpenOutlined />}>
            Saved queries <DownOutlined />
          </Button>
        </Dropdown>
        <span className="db-hint">
          Ctrl/Cmd + Enter. Runs on <b>{where}</b>, in <b>{db ?? 'no database'}</b>
          {as}. Several statements separated by ";" are fine.
        </span>
        {run && !running && <span className="db-hint" style={{ marginLeft: 'auto' }}>{run.ms} ms</span>}
      </div>
      {run?.error && <Alert type="error" showIcon style={{ marginTop: 10 }} message={<span className="mono" style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{run.error}</span>} />}
      {run && !run.error && run.sets.length === 0 && <Alert type="success" showIcon style={{ marginTop: 10 }} message="Done. The statement returned no rows." />}
      {run?.sets.map((s, i) => <ResultGrid key={i} set={s} name={`result-${i + 1}`} />)}
      <Modal open={naming !== null} title="Save this query" okText="Save" onCancel={() => setNaming(null)} onOk={save} destroyOnClose>
        <Input autoFocus placeholder="A name you will recognise, e.g. Unpaid orders this month" value={naming ?? ''} onChange={(e) => setNaming(e.target.value)} onPressEnter={save} maxLength={80} />
        <p className="db-hint" style={{ margin: '8px 0 0' }}>Saved on this computer. A query saved under the same name is replaced.</p>
      </Modal>
    </>
  )
}

const SYSTEM = new Set(['information_schema', 'performance_schema', 'mysql', 'sys'])
const sortDbs = (names: string[]): string[] => [...names].sort((x, y) => Number(SYSTEM.has(x)) - Number(SYSTEM.has(y)) || x.localeCompare(y))

/**
 * A database client in the manner of a desktop tool: saved connections on the left (direct, or through an SSH tunnel),
 * their databases and tables under them, and data, structure and SQL on the right.
 * The server being managed is always there as a ready-made connection.
 */
export default function DbClient({ project, projects, me, dark }: { project: Project; projects: Project[]; me: { id: string; role: string }; dark: boolean }) {
  const { message, modal } = AntApp.useApp()
  const [conns, setConns] = useState<(DbConnection & { open: boolean })[]>([])
  const [opened, setOpened] = useState<Record<string, { dbs?: string[]; loading?: boolean; error?: string }>>({})
  const [scheduleFor, setScheduleFor] = useState<DbConnection | null>(null)
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [showSystem, setShowSystem] = useState<Record<string, boolean>>({})
  const [target, setTarget] = useState<string>()
  const [formOpen, setFormOpen] = useState(false)
  const [editingConn, setEditingConn] = useState<DbConnection | null>(null)
  const [tablesLoading, setTablesLoading] = useState(false)
  const id = target ?? ''
  const [db, setDb] = useState<string>()
  const [tables, setTables] = useState<DbTableSummary[]>([])
  const [tableFilter, setTableFilter] = useState('')
  const [table, setTable] = useState<string>()
  const [tab, setTab] = useState('data')
  const [info, setInfo] = useState<DbTableInfo | null>(null)
  const [grid, setGrid] = useState<DbGridPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<{ page: number; orderBy?: string; descending?: boolean; where: string }>({ page: 1, where: '' })
  const [whereDraft, setWhereDraft] = useState('')
  const [selected, setSelected] = useState<React.Key[]>([])
  const [editing, setEditing] = useState<{ row: (string | null)[]; column: string; value: string; isNull: boolean } | null>(null)
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [addForm] = Form.useForm<Record<string, string>>()
  const [queries, setQueries] = useState<{ key: string; title: string; sql: string }[]>([{ key: 'q1', title: 'Query 1', sql: 'SELECT 1;' }])
  const queryCount = useRef(1)
  const [designer, setDesigner] = useState<{ target: string; db: string; table: string | null } | null>(null)
  const [ask, setAsk] = useState<{ title: string; label: string; value: string; okText: string; flag?: string; flagOn?: boolean; danger?: boolean; mustMatch?: string; note?: string; run: (value: string, flag: boolean) => Promise<void> } | null>(null)
  const [asking, setAsking] = useState(false)
  const [working, setWorking] = useState('')
  const [backupsFor, setBackupsFor] = useState<string | null>(null)
  const [backupList, setBackupList] = useState<{ folder: string; files: { file: string; database: string; size: number; time: number }[] } | null>(null)
  const [restoring, setRestoring] = useState<{ target: string; file: string; into: string; ask: boolean } | null>(null)
  const [reload, setReload] = useState(0)

  const loadConns = useCallback(async () => {
    try {
      setConns(await window.api.dbconn.list())
    } catch (err) {
      message.error(errText(err))
    }
  }, [message])

  /** Connect (or refresh the database list) and make it the current connection. */
  const openTarget = useCallback(async (t: string, preferred?: string, keep = false) => {
    setOpened((o) => ({ ...o, [t]: { ...o[t], loading: true, error: undefined } }))
    try {
      const dbs = sortDbs(await window.api.dbc.databases(t))
      setOpened((o) => ({ ...o, [t]: { dbs } }))
      setFolded((f) => ({ ...f, [t]: false }))
      setTarget(t)
      if (!keep || !preferred || !dbs.includes(preferred)) setDb(preferred && dbs.includes(preferred) ? preferred : (dbs.find((d) => !SYSTEM.has(d)) ?? dbs[0]))
    } catch (err) {
      setOpened((o) => ({ ...o, [t]: { error: errText(err) } }))
    }
  }, [])

  // Nothing is opened by itself: the list starts with the connections people saved, and is empty until one is added.
  useEffect(() => {
    void loadConns()
  }, [loadConns])

  const closeTarget = async (t: string): Promise<void> => {
    if (t.startsWith('conn:')) await window.api.dbconn.close(t.slice(5)).catch(() => undefined)
    setOpened((o) => {
      const next = { ...o }
      delete next[t]
      return next
    })
    if (target === t) {
      setTarget(undefined)
      setDb(undefined)
    }
  }

  const removeConn = (c: DbConnection): void => {
    modal.confirm({
      title: `Delete the connection "${c.name}"?`,
      content: c.shared ? 'It is shared, so it disappears for the whole team. The database itself is not touched.' : 'Only the saved connection is removed. The database itself is not touched.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.api.dbconn.remove(c.id)
          await closeTarget(`conn:${c.id}`)
          await loadConns()
        } catch (err) {
          message.error(errText(err))
        }
      }
    })
  }

  const nodes = useMemo(
    () => conns.map((c) => ({ target: `conn:${c.id}`, name: c.name, sub: `${c.username}@${c.host}:${c.port}${c.useSsh ? ' · SSH' : ''}`, conn: c as DbConnection | undefined })),
    [conns]
  )
  const current = nodes.find((n) => n.target === target)

  const loadTables = useCallback(async () => {
    if (!db || !id) return
    setTablesLoading(true)
    try {
      setTables(await window.api.dbc.tables(id, db))
    } catch (err) {
      message.error(errText(err))
    } finally {
      setTablesLoading(false)
    }
  }, [id, db, message])

  useEffect(() => {
    setTable(undefined)
    setTables([])
    setTableFilter('')
    void loadTables()
  }, [loadTables])

  const loadGrid = useCallback(async () => {
    if (!db || !table) return
    setLoading(true)
    try {
      setGrid(await window.api.dbc.browse(id, db, table, { page: view.page, pageSize: 100, orderBy: view.orderBy, descending: view.descending, where: view.where }))
      setSelected([])
    } catch (err) {
      message.error(errText(err), 8)
    } finally {
      setLoading(false)
    }
  }, [id, db, table, view, message, reload])

  useEffect(() => {
    setInfo(null)
    setGrid(null)
    if (!db || !table) return
    window.api.dbc
      .tableInfo(id, db, table)
      .then(setInfo)
      .catch((err) => message.error(errText(err)))
  }, [id, db, table, message, reload])

  useEffect(() => void loadGrid(), [loadGrid])

  const pick = (name: string): void => {
    setTable(name)
    setView({ page: 1, where: '' })
    setWhereDraft('')
    if (tab === 'query') setTab('data')
  }

  const pk = info?.primaryKey ?? []
  const keyOf = (row: (string | null)[]): Row => Object.fromEntries(pk.map((c) => [c, row[grid?.columns.indexOf(c) ?? -1] ?? null]))
  const isView = tables.find((t) => t.name === table)?.view
  const editable = pk.length > 0 && !isView

  const saveCell = async (): Promise<void> => {
    if (!editing || !db || !table) return
    setSaving(true)
    try {
      const n = await window.api.dbc.update(id, db, table, keyOf(editing.row), { [editing.column]: editing.isNull ? null : editing.value })
      message.success(n ? 'Saved' : 'Nothing changed')
      setEditing(null)
      void loadGrid()
    } catch (err) {
      message.error(errText(err), 8)
    } finally {
      setSaving(false)
    }
  }

  const addRow = async (): Promise<void> => {
    if (!db || !table) return
    const v = addForm.getFieldsValue()
    const values: Row = {}
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string' && val !== '') values[k] = val
    setSaving(true)
    try {
      await window.api.dbc.insert(id, db, table, values)
      message.success('Row added')
      setAdding(false)
      void loadGrid()
    } catch (err) {
      message.error(errText(err), 8)
    } finally {
      setSaving(false)
    }
  }

  const removeRows = (): void => {
    if (!db || !table || !grid) return
    const keys = selected.map((i) => keyOf(grid.rows[Number(i)]))
    modal.confirm({
      title: `Delete ${keys.length} row${keys.length === 1 ? '' : 's'} from ${table}?`,
      content: 'This cannot be undone, except by restoring a backup.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const n = await window.api.dbc.remove(id, db, table, keys)
          message.success(`${n} row${n === 1 ? '' : 's'} deleted`)
        } catch (err) {
          message.error(errText(err), 8)
        }
        void loadGrid()
      }
    })
  }

  const exportPage = async (): Promise<void> => {
    if (!grid || !table) return
    const path = await window.api.dbc.saveText(`${table}.csv`, csv(grid.columns, grid.rows)).catch(() => null)
    if (path) message.success(`Saved to ${path}`)
  }

  const newQuery = (sql = ''): void => {
    const n = ++queryCount.current
    const key = `q${n}`
    setQueries((list) => [...list, { key, title: `Query ${n}`, sql }])
    setTab(key)
  }

  const closeQuery = (key: string): void => {
    setQueries((list) => list.filter((q) => q.key !== key))
    if (tab === key) setTab('data')
  }

  /** Make a connection and database current, as clicking them would. */
  const focusOn = (t: string, d?: string): void => {
    setTarget(t)
    if (d) setDb(d)
  }

  const refreshDbs = (t: string): void => void openTarget(t, t === target ? db : undefined, t === target)

  const submitAsk = async (): Promise<void> => {
    if (!ask) return
    const value = ask.value.trim()
    if (!value || (ask.mustMatch !== undefined && value !== ask.mustMatch)) return
    setAsking(true)
    try {
      await ask.run(value, ask.flagOn === true)
      setAsk(null)
    } catch (err) {
      message.error(errText(err), 8)
    } finally {
      setAsking(false)
    }
  }

  const newDatabase = (t: string): void =>
    setAsk({
      title: 'New database',
      label: 'Database name',
      value: '',
      okText: 'Create',
      note: 'Created with the utf8mb4 character set, which holds every language and emoji.',
      run: async (name) => {
        await window.api.dbc.createDatabase(t, name)
        message.success(`Database ${name} created`)
        await openTarget(t, name)
      }
    })

  const dropDatabase = (t: string, d: string): void =>
    setAsk({
      title: `Drop the database ${d}?`,
      label: `Every table and all data in it are deleted. There is no undo except restoring a backup. Type the name ${d} to confirm.`,
      value: '',
      okText: 'Drop database',
      danger: true,
      mustMatch: d,
      run: async () => {
        await window.api.dbc.dropDatabase(t, d)
        message.success(`Database ${d} dropped`)
        if (t === target && d === db) {
          setDb(undefined)
          setTable(undefined)
        }
        refreshDbs(t)
      }
    })

  const renameTable = (t: string, d: string, name: string): void =>
    setAsk({
      title: `Rename ${name}`,
      label: 'New name',
      value: name,
      okText: 'Rename',
      run: async (to) => {
        await window.api.dbc.renameTable(t, d, name, to)
        if (table === name) setTable(to)
        await loadTables()
      }
    })

  const duplicateTable = (t: string, d: string, name: string): void =>
    setAsk({
      title: `Duplicate ${name}`,
      label: 'Name of the copy',
      value: `${name}_copy`,
      okText: 'Duplicate',
      flag: 'Copy the rows too',
      flagOn: true,
      run: async (to, withData) => {
        await window.api.dbc.duplicateTable(t, d, name, to, withData)
        message.success(`${to} created`)
        await loadTables()
      }
    })

  const dropTable = (t: string, d: string, tb: DbTableSummary): void => {
    modal.confirm({
      title: `Drop the ${tb.view ? 'view' : 'table'} ${tb.name}?`,
      content: tb.view ? 'Only the view is removed; the tables it reads from stay.' : 'The table and every row in it are deleted. There is no undo except restoring a backup.',
      okText: 'Drop',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.api.dbc.dropTable(t, d, tb.name, tb.view)
          if (table === tb.name) setTable(undefined)
          await loadTables()
        } catch (err) {
          message.error(errText(err), 8)
        }
      }
    })
  }

  const truncateTable = (t: string, d: string, name: string): void => {
    modal.confirm({
      title: `Empty the table ${name}?`,
      content: 'Every row is deleted and automatic numbering starts again from 1. The table itself stays. There is no undo except restoring a backup.',
      okText: 'Empty table',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.api.dbc.truncateTable(t, d, name)
          message.success(`${name} emptied`)
          await loadTables()
          if (table === name) void loadGrid()
        } catch (err) {
          message.error(errText(err), 8)
        }
      }
    })
  }

  const exportSql = async (t: string, d: string, name: string | null, withData: boolean): Promise<void> => {
    setWorking(`Exporting ${name ?? d}…`)
    try {
      const path = await window.api.dbc.exportSql(t, d, name, withData)
      if (path) message.success(`Saved to ${path}`)
    } catch (err) {
      message.error(errText(err), 10)
    } finally {
      setWorking('')
    }
  }

  const nameOf = (t: string): string => nodes.find((n) => n.target === t)?.name ?? 'connection'

  const loadBackups = (t: string): void => {
    setBackupList(null)
    window.api.dbc
      .backups(t, nameOf(t))
      .then(setBackupList)
      .catch((err) => {
        setBackupsFor(null)
        message.error(errText(err), 8)
      })
  }

  /** Every table and row of one database into a compressed file on this computer. */
  const backupDb = async (t: string, d: string): Promise<void> => {
    setWorking(`Backing up ${d}… (progress is under Tasks)`)
    try {
      const path = await window.api.dbc.backup(t, nameOf(t), d)
      const file = path.split(/[\\/]/).pop() ?? ''
      message.success(
        <span>
          {d} backed up on this computer.{' '}
          <a onClick={() => void window.api.dbc.backupShow(t, nameOf(t), file)}>Show the file</a>
        </span>,
        8
      )
      if (backupsFor === t) loadBackups(t)
    } catch (err) {
      message.error(errText(err), 10)
    } finally {
      setWorking('')
    }
  }

  const openBackups = (t: string): void => {
    setBackupsFor(t)
    loadBackups(t)
  }

  const deleteBackup = (t: string, file: string): void => {
    modal.confirm({
      title: 'Delete this backup?',
      content: `${file} is moved to the trash of this computer.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.api.dbc.backupDelete(t, nameOf(t), file)
          loadBackups(t)
        } catch (err) {
          message.error(errText(err), 8)
        }
      }
    })
  }

  const runRestore = async (r: { target: string; file: string; into: string }): Promise<void> => {
    setWorking(`Restoring ${r.into}…`)
    try {
      const res = await window.api.dbc.backupRestore(r.target, nameOf(r.target), r.file, r.into)
      if (res.error) modal.error({ title: 'The restore stopped at an error', content: <div><p>{res.statements} statement{res.statements === 1 ? '' : 's'} ran before it. Those changes stay, so {r.into} may be incomplete.</p><pre className="log-box" style={{ maxHeight: 200 }}>{res.error}</pre></div>, width: 560 })
      else message.success(`${r.into} restored from ${r.file}`, 6)
      if (r.target === target) await loadTables()
      refreshDbs(r.target)
    } catch (err) {
      message.error(errText(err), 10)
    } finally {
      setWorking('')
    }
  }

  const importSql = async (t: string, d: string): Promise<void> => {
    setWorking('Running the SQL file…')
    try {
      const r = await window.api.dbc.importSql(t, d)
      if (!r) return
      if (r.error) modal.error({ title: `${r.file} stopped at an error`, content: <div><p>{r.statements} statement{r.statements === 1 ? '' : 's'} ran before it. Those changes stay.</p><pre className="log-box" style={{ maxHeight: 200 }}>{r.error}</pre></div>, width: 560 })
      else message.success(`${r.file}: ${r.statements} statement${r.statements === 1 ? '' : 's'} ran`)
      if (t === target) await loadTables()
      refreshDbs(t)
    } catch (err) {
      message.error(errText(err), 10)
    } finally {
      setWorking('')
    }
  }

  const connMenu = (n: { target: string; conn?: DbConnection }, isOpen: boolean, mine: boolean): MenuProps['items'] => [
    isOpen ? { key: 'close', label: 'Close connection', onClick: () => void closeTarget(n.target) } : { key: 'open', label: 'Open connection', onClick: () => void openTarget(n.target, n.conn?.database) },
    { key: 'query', label: 'New query', disabled: !isOpen, onClick: () => { focusOn(n.target); newQuery() } },
    { key: 'newdb', label: 'New database…', disabled: !isOpen, onClick: () => newDatabase(n.target) },
    { key: 'refresh', label: 'Refresh', disabled: !isOpen, onClick: () => refreshDbs(n.target) },
    { key: 'backups', label: 'Backups and restore…', disabled: !isOpen, onClick: () => openBackups(n.target) },
    ...(n.conn ? [{ key: 'schedule', label: `Scheduled backups to Google Drive…${n.conn.backupProjectId ? ' (on)' : ''}`, onClick: () => setScheduleFor(n.conn ?? null) }] : []),
    ...(n.conn && mine ? [{ type: 'divider' as const }, { key: 'edit', label: 'Edit connection…', onClick: () => { setEditingConn(n.conn ?? null); setFormOpen(true) } }, { key: 'delete', label: 'Delete connection', danger: true, onClick: () => n.conn && removeConn(n.conn) }] : [])
  ]

  const dbMenu = (t: string, d: string): MenuProps['items'] => [
    { key: 'open', label: 'Open database', onClick: () => focusOn(t, d) },
    { key: 'query', label: 'New query', onClick: () => { focusOn(t, d); newQuery() } },
    { key: 'table', label: 'New table…', onClick: () => { focusOn(t, d); setDesigner({ target: t, db: d, table: null }) } },
    { type: 'divider' },
    { key: 'run', label: 'Run SQL file…', onClick: () => void importSql(t, d) },
    { key: 'dump', label: 'Export SQL file', children: [{ key: 'dump-all', label: 'Structure and data', onClick: () => void exportSql(t, d, null, true) }, { key: 'dump-structure', label: 'Structure only', onClick: () => void exportSql(t, d, null, false) }] },
    { type: 'divider' },
    { key: 'backup', label: 'Back up database', onClick: () => void backupDb(t, d) },
    { key: 'backups', label: 'Backups and restore…', onClick: () => openBackups(t) },
    { type: 'divider' },
    { key: 'drop', label: 'Drop database…', danger: true, disabled: SYSTEM.has(d), onClick: () => dropDatabase(t, d) }
  ]

  const tableMenu = (t: string, d: string, tb: DbTableSummary): MenuProps['items'] => [
    { key: 'open', label: tb.view ? 'Open view' : 'Open table', onClick: () => pick(tb.name) },
    ...(tb.view ? [] : [{ key: 'design', label: 'Design table…', onClick: () => setDesigner({ target: t, db: d, table: tb.name }) }]),
    { key: 'query', label: 'New query', onClick: () => newQuery(`SELECT * FROM \`${tb.name}\` LIMIT 100;`) },
    ...(tb.view ? [] : [{ key: 'dup', label: 'Duplicate table…', onClick: () => duplicateTable(t, d, tb.name) }, { key: 'rename', label: 'Rename…', onClick: () => renameTable(t, d, tb.name) }]),
    { type: 'divider' },
    { key: 'dump', label: 'Export SQL file', children: tb.view ? [{ key: 'dump-structure', label: 'Definition', onClick: () => void exportSql(t, d, tb.name, false) }] : [{ key: 'dump-all', label: 'Structure and data', onClick: () => void exportSql(t, d, tb.name, true) }, { key: 'dump-structure', label: 'Structure only', onClick: () => void exportSql(t, d, tb.name, false) }] },
    { type: 'divider' },
    ...(tb.view ? [] : [{ key: 'truncate', label: 'Empty table…', danger: true, onClick: () => truncateTable(t, d, tb.name) }]),
    { key: 'drop', label: tb.view ? 'Drop view…' : 'Drop table…', danger: true, onClick: () => dropTable(t, d, tb) }
  ]

  const shownTables = useMemo(() => tables.filter((t) => t.name.toLowerCase().includes(tableFilter.trim().toLowerCase())), [tables, tableFilter])

  return (
    <div className="db-client">
      <div className="card db-side">
        <div className="db-side-head">
          <b>Connections</b>
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => { setEditingConn(null); setFormOpen(true) }}>
            New connection
          </Button>
        </div>
        <div className="db-tree">
          {nodes.length === 0 && (
            <div className="db-tree-empty">
              <b>No connections yet</b>
              <span>Add one with "New connection": the database's address, user name and password, directly or through SSH.</span>
            </div>
          )}
          {nodes.map((n) => {
            const st = opened[n.target]
            const isOpen = !!st?.dbs
            const mine = !n.conn || n.conn.ownerId === me.id || me.role === 'admin'
            return (
              <div key={n.target} className={`db-conn ${target === n.target ? 'current' : ''}`}>
                <Dropdown trigger={['contextMenu']} menu={{ items: connMenu(n, isOpen, mine) }}>
                <div className="db-conn-row">
                  <button type="button" className="db-conn-main" title={isOpen ? 'Click to fold or unfold' : 'Click to connect'} onClick={() => (isOpen ? setFolded((f) => ({ ...f, [n.target]: !f[n.target] })) : void openTarget(n.target, n.conn?.database))}>
                    <span className={`db-dot ${isOpen ? 'on' : ''}`} aria-label={isOpen ? 'Connected' : 'Not connected'} />
                    <span className="db-conn-text">
                      <b>{n.name}</b>
                      <small>{n.sub}</small>
                    </span>
                    {st?.loading && <Spin size="small" />}
                    {n.conn?.shared && <Tooltip title="Shared with the team"><TeamOutlined className="db-shared" /></Tooltip>}
                  </button>
                  <span className="db-conn-actions">
                    {isOpen && (
                      <Tooltip title="Close connection">
                        <Button size="small" type="text" icon={<DisconnectOutlined />} aria-label={`Close ${n.name}`} onClick={() => void closeTarget(n.target)} />
                      </Tooltip>
                    )}
                    {n.conn && mine && (
                      <>
                        <Tooltip title="Edit connection">
                          <Button size="small" type="text" icon={<EditOutlined />} aria-label={`Edit ${n.name}`} onClick={() => { setEditingConn(n.conn ?? null); setFormOpen(true) }} />
                        </Tooltip>
                        <Tooltip title="Delete connection">
                          <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`Delete ${n.name}`} onClick={() => n.conn && removeConn(n.conn)} />
                        </Tooltip>
                      </>
                    )}
                  </span>
                </div>
                </Dropdown>
                {st?.error && (
                  <div className="db-conn-error">
                    {st.error}{' '}
                    <button type="button" className="link" onClick={() => void openTarget(n.target, n.conn?.database)}>
                      Try again
                    </button>
                  </div>
                )}
                {isOpen && !folded[n.target] && (
                  <div className="db-dbs">
                    {st.dbs?.map((d) => {
                      const active = target === n.target && db === d
                      if (SYSTEM.has(d) && !active && !showSystem[n.target]) return null
                      return (
                        <div key={d}>
                          <Dropdown trigger={['contextMenu']} menu={{ items: dbMenu(n.target, d) }}>
                            <button type="button" className={`db-db ${active ? 'active' : ''} ${SYSTEM.has(d) ? 'system' : ''}`} onClick={() => { setTarget(n.target); setDb(d) }}>
                              <DatabaseOutlined />
                              <span>{d}</span>
                            </button>
                          </Dropdown>
                          {active && (
                            <div className="db-tables">
                              {tables.length > 8 && <Input size="small" allowClear prefix={<SearchOutlined />} placeholder="Find a table" value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} style={{ margin: '4px 0 6px' }} />}
                              {shownTables.map((t) => (
                                <Dropdown key={t.name} trigger={['contextMenu']} menu={{ items: tableMenu(n.target, d, t) }}>
                                <button type="button" className={`db-table ${t.name === table ? 'active' : ''}`} onClick={() => pick(t.name)} title={`${t.view ? 'View' : `About ${t.rows} rows, ${bytes(t.size)}`}`}>
                                  {t.view ? <EyeOutlined /> : <TableOutlined />}
                                  <span>{t.name}</span>
                                </button>
                                </Dropdown>
                              ))}
                              {shownTables.length === 0 && <div className="db-hint" style={{ padding: '4px 8px' }}>{tables.length ? 'No table matches.' : tablesLoading ? 'Loading…' : 'No tables yet. Use New table above.'}</div>}
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {(st.dbs ?? []).some((d) => SYSTEM.has(d)) && (
                      <button type="button" className="db-db system" onClick={() => setShowSystem((v) => ({ ...v, [n.target]: !v[n.target] }))}>
                        <span>{showSystem[n.target] ? 'Hide system databases' : `Show system databases (${(st.dbs ?? []).filter((d) => SYSTEM.has(d)).length})`}</span>
                      </button>
                    )}
                    {st.dbs?.length === 0 && <div className="db-hint" style={{ padding: '4px 8px' }}>This user sees no databases.</div>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => { void loadConns(); void loadTables(); if (target) void openTarget(target, db, true) }}>
          Refresh
        </Button>
      </div>

      <div className="card db-main">
        <div className="db-bar">
          <Button size="small" icon={<CaretRightOutlined />} onClick={() => newQuery()}>
            New query
          </Button>
          <Button size="small" icon={<TableOutlined />} disabled={!target || !db} onClick={() => target && db && setDesigner({ target, db, table: null })}>
            New table
          </Button>
          <Button size="small" icon={<ImportOutlined />} disabled={!target || !db} onClick={() => target && db && void importSql(target, db)}>
            Run SQL file
          </Button>
          <Dropdown trigger={['click']} disabled={!target || !db} menu={{ items: [{ key: 'all', label: `Whole database ${db ?? ''}: structure and data`, onClick: () => target && db && void exportSql(target, db, null, true) }, { key: 'structure', label: `Whole database ${db ?? ''}: structure only`, onClick: () => target && db && void exportSql(target, db, null, false) }, ...(table ? [{ key: 'table', label: `Only ${table}`, onClick: () => target && db && void exportSql(target, db, table, true) }] : [])] }}>
            <Button size="small" icon={<ExportOutlined />}>
              Export SQL <DownOutlined />
            </Button>
          </Dropdown>
          <Dropdown trigger={['click']} disabled={!target} menu={{ items: [{ key: 'now', disabled: !db, label: db ? `Back up ${db} now` : 'Open a database to back it up', onClick: () => target && db && void backupDb(target, db) }, { key: 'list', label: 'Backups and restore…', onClick: () => target && openBackups(target) }, { key: 'schedule', label: 'Scheduled backups to Google Drive…', disabled: !target?.startsWith('conn:'), onClick: () => setScheduleFor(conns.find((x) => `conn:${x.id}` === target) ?? null) }] }}>
            <Button size="small" icon={<HistoryOutlined />}>
              Backup <DownOutlined />
            </Button>
          </Dropdown>
          {working && (
            <span className="db-hint">
              <Spin size="small" /> {working}
            </span>
          )}
          <span className="db-hint" style={{ marginLeft: 'auto' }}>Right-click a connection, database or table for more.</span>
        </div>
        <Tabs
          type="editable-card"
          size="small"
          activeKey={tab}
          onChange={setTab}
          onEdit={(key, action) => (action === 'add' ? newQuery() : closeQuery(String(key)))}
          items={[
            {
              key: 'data',
              closable: false,
              label: table ? `Data: ${table}` : 'Data',
              children: !table ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={target ? 'Pick a table on the left to see its rows.' : nodes.length === 0 ? 'Add a connection on the left to start.' : 'Open a connection on the left.'} />
              ) : (
                <>
                  <div className="db-tools">
                    <Input
                      className="mono"
                      style={{ flex: 1, minWidth: 220 }}
                      allowClear
                      prefix={<span className="db-where">WHERE</span>}
                      placeholder="status = 'paid' AND total > 100"
                      spellCheck={false}
                      value={whereDraft}
                      onChange={(e) => setWhereDraft(e.target.value)}
                      onPressEnter={() => setView({ ...view, page: 1, where: whereDraft })}
                      onClear={() => setView({ ...view, page: 1, where: '' })}
                    />
                    <Button onClick={() => setView({ ...view, page: 1, where: whereDraft })}>Filter</Button>
                    <Tooltip title={editable ? '' : isView ? 'A view cannot be edited here.' : 'This table has no primary key, so its rows cannot be edited safely here. Use the Query tab.'}>
                      <Button icon={<PlusOutlined />} disabled={isView} onClick={() => { addForm.resetFields(); setAdding(true) }}>
                        Add row
                      </Button>
                    </Tooltip>
                    <Button danger icon={<DeleteOutlined />} disabled={!editable || selected.length === 0} onClick={removeRows}>
                      Delete{selected.length ? ` (${selected.length})` : ''}
                    </Button>
                    <Button icon={<DownloadOutlined />} disabled={!grid?.rows.length} onClick={() => void exportPage()}>
                      CSV
                    </Button>
                    <Button icon={<ReloadOutlined />} onClick={() => void loadGrid()} aria-label="Refresh rows" />
                  </div>
                  {!editable && info && <div className="db-hint" style={{ marginBottom: 8 }}>{isView ? 'This is a view: read only.' : 'No primary key: rows are read only here.'}</div>}
                  <Table<(string | null)[]>
                    size="small"
                    className="db-grid"
                    loading={loading}
                    rowKey={(_, i) => String(i)}
                    dataSource={grid?.rows ?? []}
                    scroll={{ x: 'max-content', y: 'calc(100vh - 420px)' }}
                    rowSelection={editable ? { selectedRowKeys: selected, onChange: setSelected } : undefined}
                    pagination={{ current: grid?.page ?? 1, pageSize: 100, total: grid?.total ?? 0, showSizeChanger: false, size: 'small', showTotal: (t) => `${t} row${t === 1 ? '' : 's'}` }}
                    onChange={(p, _f, sorter) => {
                      const s = Array.isArray(sorter) ? sorter[0] : sorter
                      setView({ ...view, page: p.current ?? 1, orderBy: s?.order ? String(s.columnKey) : undefined, descending: s?.order === 'descend' })
                    }}
                    columns={(grid?.columns.length ? grid.columns : (info?.columns.map((c) => c.name) ?? [])).map((c, i) => ({
                      title: (
                        <span>
                          {c}
                          {pk.includes(c) && <Tag style={{ marginLeft: 6 }}>key</Tag>}
                        </span>
                      ),
                      key: c,
                      sorter: true,
                      sortOrder: view.orderBy === c ? (view.descending ? ('descend' as const) : ('ascend' as const)) : null,
                      onCell: (r: (string | null)[]) => ({
                        onDoubleClick: () => editable && setEditing({ row: r, column: c, value: r[i] ?? '', isNull: r[i] === null }),
                        className: editable ? 'db-cell' : undefined
                      }),
                      render: (_: unknown, r: (string | null)[]) => <Cell value={r[i]} />
                    }))}
                  />
                  {editable && <div className="db-hint">Double-click a value to change it.</div>}
                </>
              )
            },
            {
              key: 'structure',
              label: 'Structure',
              closable: false,
              disabled: !table,
              children: info ? (
                <>
                  {!isView && (
                    <div className="db-tools">
                      <Button icon={<EditOutlined />} onClick={() => target && db && table && setDesigner({ target, db, table })}>
                        Design table
                      </Button>
                    </div>
                  )}
                  <Table
                    size="small"
                    rowKey="name"
                    pagination={false}
                    dataSource={info.columns}
                    columns={[
                      { title: 'Column', render: (_, c) => <b className="mono">{c.name}</b> },
                      { title: 'Type', render: (_, c) => <span className="mono">{c.type}</span> },
                      { title: 'Empty allowed', render: (_, c) => (c.nullable ? 'Yes' : 'No') },
                      { title: 'Key', render: (_, c) => (c.key === 'PRI' ? <Tag color="blue">Primary</Tag> : c.key === 'UNI' ? <Tag>Unique</Tag> : c.key === 'MUL' ? <Tag>Index</Tag> : '') },
                      { title: 'Default', render: (_, c) => (c.default === null ? <span className="db-null">{c.nullable ? 'NULL' : 'none'}</span> : <span className="mono">{c.default}</span>) },
                      { title: 'Extra', render: (_, c) => c.extra },
                      { title: 'Comment', render: (_, c) => c.comment }
                    ]}
                  />
                  {info.indexes.length > 0 && (
                    <p className="db-hint" style={{ marginTop: 14 }}>
                      Indexes: {info.indexes.map((i) => `${i.name} (${i.columns.join(', ')})${i.unique ? ' unique' : ''}`).join(' · ')}
                    </p>
                  )}
                  <pre className="log-box" style={{ maxHeight: 260, marginTop: 10 }}>
                    {info.createSql}
                  </pre>
                </>
              ) : (
                <Spin />
              )
            },
            ...queries.map((q) => ({
              key: q.key,
              label: q.title,
              children: (
                <QueryPane
                  paneKey={`sql-${project.id}-${q.key}`}
                  target={target}
                  db={db}
                  where={current?.name ?? 'no connection'}
                  as={current ? (current.conn ? `, as ${current.conn.username}` : ", as the database's root user") : ''}
                  dark={dark}
                  initialSql={q.sql}
                  onRan={() => {
                    void loadTables()
                    if (target) refreshDbs(target)
                  }}
                  onTitle={(title) => setQueries((list) => list.map((x) => (x.key === q.key ? { ...x, title } : x)))}
                />
              )
            }))
          ]}
        />
      </div>

      <Modal open={!!backupsFor} title={backupsFor ? `Backups of ${nameOf(backupsFor)}` : ''} width={820} footer={<Button onClick={() => setBackupsFor(null)}>Close</Button>} onCancel={() => setBackupsFor(null)} destroyOnClose>
        <p style={{ color: 'var(--muted)', marginTop: 0 }}>
          A backup holds every table, view and row of one database, in a compressed SQL file on this computer. Stored procedures, triggers and events are not included.
        </p>
        {!backupList && <Spin />}
        {backupList && (
          <>
            <div className="db-hint" style={{ marginBottom: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="mono" style={{ wordBreak: 'break-all' }}>{backupList.folder}</span>
              <Button size="small" icon={<FolderOpenOutlined />} onClick={() => backupsFor && void window.api.dbc.backupShow(backupsFor, nameOf(backupsFor))}>
                Open folder
              </Button>
            </div>
            <Table
              size="small"
              rowKey="file"
              dataSource={backupList.files}
              pagination={backupList.files.length > 8 ? { pageSize: 8, showSizeChanger: false } : false}
              locale={{ emptyText: 'No backups yet. Right-click a database and choose "Back up database".' }}
              columns={[
                { title: 'Database', dataIndex: 'database', render: (v: string) => <b>{v}</b> },
                { title: 'Taken', dataIndex: 'time', render: (v: number) => <span title={new Date(v).toLocaleString()}>{ago(v)}</span> },
                { title: 'Size', dataIndex: 'size', render: (v: number) => bytes(v) },
                {
                  title: '',
                  align: 'right' as const,
                  render: (_: unknown, f: { file: string; database: string }) => (
                    <Space size={6}>
                      <Button size="small" onClick={() => backupsFor && setRestoring({ target: backupsFor, file: f.file, into: f.database, ask: false })}>
                        Restore…
                      </Button>
                      <Button size="small" onClick={() => backupsFor && void window.api.dbc.backupShow(backupsFor, nameOf(backupsFor), f.file)}>
                        Show file
                      </Button>
                      <Button size="small" danger icon={<DeleteOutlined />} aria-label={`Delete ${f.file}`} onClick={() => backupsFor && deleteBackup(backupsFor, f.file)} />
                    </Space>
                  )
                }
              ]}
            />
          </>
        )}
      </Modal>
      <Modal
        open={!!restoring && !restoring.ask}
        title="Restore a backup"
        okText="Continue"
        okButtonProps={{ danger: true, disabled: !restoring || !/^[A-Za-z0-9_$]{1,64}$/.test(restoring.into) }}
        onCancel={() => setRestoring(null)}
        onOk={() => restoring && setRestoring({ ...restoring, ask: true })}
        destroyOnClose
      >
        {restoring && (
          <>
            <p style={{ marginTop: 0 }}>
              <span className="mono">{restoring.file}</span>
            </p>
            <label htmlFor="restore-into">Restore into the database</label>
            <Input id="restore-into" className="mono" value={restoring.into} spellCheck={false} onChange={(e) => setRestoring({ ...restoring, into: e.target.value.trim() })} style={{ marginTop: 6 }} />
            <Alert type="warning" showIcon style={{ marginTop: 12 }} message="Tables in that database with the same names are replaced" description="Their current rows are lost. Tables that are not in the backup stay as they are. If the database does not exist it is created. Type another name to restore beside the original and compare first." />
          </>
        )}
      </Modal>
      <ConfirmIdentity
        open={!!restoring?.ask}
        title="Confirm it is you"
        about={restoring ? `Restoring ${restoring.file} replaces tables in ${restoring.into} on ${nameOf(restoring.target)}. Enter a fresh code to go ahead.` : ''}
        okText="Restore"
        danger
        onCancel={() => setRestoring(null)}
        onProof={async (proof) => {
          if (!restoring) return
          const r = restoring
          // A wrong code throws here and is shown in this dialog; nothing has started yet.
          await window.api.session.confirm(proof, `restore ${r.file} into ${r.into}`)
          setRestoring(null)
          setBackupsFor(null)
          void runRestore(r)
        }}
      />
      <DbRemoteSchedule
        open={!!scheduleFor}
        conn={scheduleFor ? conns.find((x) => x.id === scheduleFor.id) ?? scheduleFor : null}
        projects={projects}
        databases={scheduleFor ? opened[`conn:${scheduleFor.id}`]?.dbs ?? [] : []}
        canOps={can(me.role as Role, 'ops')}
        onClose={() => setScheduleFor(null)}
        onChanged={() => void loadConns()}
      />
      <DbConnectionForm
        open={formOpen}
        editing={editingConn}
        projects={projects}
        onClose={() => setFormOpen(false)}
        onSaved={(c) => {
          setFormOpen(false)
          void loadConns()
          // Saving closes the old connection, so open it again with the new settings.
          void openTarget(`conn:${c.id}`, c.database)
        }}
      />

      {designer && (
        <TableDesigner
          open
          target={designer.target}
          database={designer.db}
          table={designer.table}
          onClose={() => setDesigner(null)}
          onDone={(name) => {
            const same = designer.target === target && designer.db === db
            setDesigner(null)
            if (!same) return
            void loadTables().then(() => {
              if (table === designer.table || !designer.table) pick(name)
              setReload((n) => n + 1)
            })
          }}
        />
      )}

      <Modal open={!!ask} title={ask?.title} okText={ask?.okText} okButtonProps={{ danger: ask?.danger, disabled: !ask?.value.trim() || (ask?.mustMatch !== undefined && ask.value.trim() !== ask.mustMatch) }} confirmLoading={asking} onCancel={() => setAsk(null)} onOk={() => void submitAsk()} destroyOnClose>
        {ask && (
          <>
            <label htmlFor="db-ask" style={{ display: 'block', marginBottom: 8 }}>
              {ask.label}
            </label>
            <Input id="db-ask" className="mono" autoFocus value={ask.value} maxLength={64} spellCheck={false} onChange={(e) => setAsk({ ...ask, value: e.target.value })} onPressEnter={() => void submitAsk()} />
            {ask.flag && (
              <Checkbox style={{ marginTop: 12 }} checked={ask.flagOn} onChange={(e) => setAsk({ ...ask, flagOn: e.target.checked })}>
                {ask.flag}
              </Checkbox>
            )}
            {ask.note && <p className="db-hint" style={{ margin: '10px 0 0' }}>{ask.note}</p>}
          </>
        )}
      </Modal>

      <Modal open={!!editing} title={editing ? `${table}.${editing.column}` : ''} okText="Save" confirmLoading={saving} onCancel={() => setEditing(null)} onOk={() => void saveCell()} destroyOnClose>
        {editing && (
          <>
            <Input.TextArea className="mono" autoFocus rows={Math.min(14, Math.max(3, editing.value.split('\n').length + 1))} disabled={editing.isNull} value={editing.isNull ? '' : editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} spellCheck={false} />
            <Checkbox style={{ marginTop: 10 }} checked={editing.isNull} disabled={!info?.columns.find((c) => c.name === editing.column)?.nullable} onChange={(e) => setEditing({ ...editing, isNull: e.target.checked })}>
              Set to NULL (no value)
            </Checkbox>
            <div className="db-hint" style={{ marginTop: 6 }}>Type: {info?.columns.find((c) => c.name === editing.column)?.type}</div>
          </>
        )}
      </Modal>

      <Modal open={adding} title={`Add a row to ${table}`} okText="Add row" confirmLoading={saving} onCancel={() => setAdding(false)} onOk={() => void addRow()} width={560} destroyOnClose>
        <Form form={addForm} layout="vertical" requiredMark={false} style={{ maxHeight: '60vh', overflow: 'auto', paddingRight: 6 }}>
          {info?.columns.map((c) => (
            <Form.Item key={c.name} name={c.name} label={<span className="mono">{c.name} <span className="db-hint">{c.type}</span></span>} style={{ marginBottom: 10 }}>
              <Input className="mono" spellCheck={false} placeholder={c.extra.includes('auto_increment') ? 'Filled in automatically' : c.default !== null ? `Default: ${c.default}` : c.nullable ? 'Empty = NULL' : 'Required'} />
            </Form.Item>
          ))}
        </Form>
        <div className="db-hint">Fields left empty get their default value.</div>
      </Modal>
    </div>
  )
}
