import { useEffect, useRef, useState } from 'react'
import { Alert, App as AntApp, AutoComplete, Button, Checkbox, Input, Modal, Spin, Tabs, Tooltip } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import type { DbColumn, DbDesignColumn, DbTableDesign } from '@shared/types'
import { errText } from '../util'

type Row = DbDesignColumn & { key: number; locked?: boolean }

const TYPES = ['int', 'bigint', 'tinyint(1)', 'decimal(10,2)', 'varchar(255)', 'varchar(100)', 'char(36)', 'text', 'longtext', 'date', 'datetime', 'timestamp', 'time', 'json', 'float', 'double', 'blob', "enum('a','b')"]

const fromDb = (c: DbColumn, key: number): Row => ({ key, original: c.name, name: c.name, type: c.type, nullable: c.nullable, default: c.default === null ? '' : c.default === '' ? "''" : c.default, autoIncrement: /auto_increment/i.test(c.extra), primary: c.key === 'PRI', comment: c.comment, locked: /generated/i.test(c.extra) })

/** Create a table, or change an existing one, by filling in a grid of columns. The SQL it will run can be read first. */
export default function TableDesigner({ open, target, database, table, onClose, onDone }: { open: boolean; target: string; database: string; table: string | null; onClose: () => void; onDone: (name: string) => void }) {
  const { message } = AntApp.useApp()
  const [name, setName] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState('columns')
  const [preview, setPreview] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const next = useRef(1)

  useEffect(() => {
    if (!open) return
    setTab('columns')
    setError('')
    setPreview('')
    setName(table ?? '')
    if (!table) {
      next.current = 2
      setRows([{ key: 1, name: 'id', type: 'int', nullable: false, default: '', autoIncrement: true, primary: true, comment: '' }])
      return
    }
    setLoading(true)
    setRows([])
    window.api.dbc
      .tableInfo(target, database, table)
      .then((info) => {
        setRows(info.columns.map((c, i) => fromDb(c, i + 1)))
        next.current = info.columns.length + 1
      })
      .catch((err) => setError(errText(err)))
      .finally(() => setLoading(false))
  }, [open, target, database, table])

  const design = (): DbTableDesign => ({ name: name.trim(), columns: rows.map(({ key: _k, locked: _l, ...c }) => ({ ...c, name: c.name.trim() })) })
  const set = (key: number, patch: Partial<Row>): void => setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  const showPreview = async (): Promise<void> => {
    setError('')
    try {
      if (!name.trim()) throw new Error('Give the table a name.')
      const sql = await window.api.dbc.designSql(target, database, table, design())
      setPreview(sql || '-- Nothing has changed, so nothing will run.')
    } catch (err) {
      setPreview('')
      setError(errText(err))
    }
  }

  const save = async (): Promise<void> => {
    setError('')
    if (!name.trim()) return setError('Give the table a name.')
    setSaving(true)
    try {
      const sql = await window.api.dbc.designApply(target, database, table, design())
      message.success(sql ? (table ? 'Table changed' : 'Table created') : 'Nothing had changed')
      onDone(name.trim())
    } catch (err) {
      setError(errText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      title={table ? `Design table: ${table}` : `New table in ${database}`}
      width={1040}
      onCancel={onClose}
      maskClosable={false}
      destroyOnClose
      okText={table ? 'Save changes' : 'Create table'}
      confirmLoading={saving}
      onOk={() => void save()}
    >
      <div className="td-name">
        <label htmlFor="td-name">Table name</label>
        <Input id="td-name" className="mono" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} spellCheck={false} style={{ maxWidth: 320 }} autoFocus={!table} />
      </div>
      <Tabs
        activeKey={tab}
        onChange={(k) => {
          setTab(k)
          if (k === 'sql') void showPreview()
        }}
        items={[
          {
            key: 'columns',
            label: 'Columns',
            children: loading ? (
              <div className="empty" style={{ padding: 30 }}>
                <Spin />
              </div>
            ) : (
              <>
                <div className="td-grid" role="table" aria-label="Columns">
                  <div className="td-row td-head" role="row">
                    <span>Name</span>
                    <span>Type</span>
                    <span title="A value is required">Not null</span>
                    <span title="Primary key">Key</span>
                    <span title="Numbered automatically">Auto inc</span>
                    <span>Default</span>
                    <span>Comment</span>
                    <span />
                  </div>
                  {rows.map((r) => (
                    <div key={r.key} className="td-row" role="row">
                      <Input className="mono" value={r.name} disabled={r.locked} onChange={(e) => set(r.key, { name: e.target.value })} maxLength={64} spellCheck={false} aria-label="Column name" />
                      <AutoComplete className="mono" value={r.type} disabled={r.locked} options={TYPES.map((t) => ({ value: t }))} filterOption={(text, o) => String(o?.value ?? '').startsWith(text.toLowerCase())} onChange={(v) => set(r.key, { type: v })} aria-label="Column type" />
                      <Checkbox checked={!r.nullable || r.primary} disabled={r.locked || r.primary} onChange={(e) => set(r.key, { nullable: !e.target.checked })} aria-label="Not null" />
                      <Checkbox checked={r.primary} disabled={r.locked} onChange={(e) => set(r.key, { primary: e.target.checked, ...(e.target.checked ? { nullable: false } : { autoIncrement: false }) })} aria-label="Primary key" />
                      <Checkbox checked={r.autoIncrement} disabled={r.locked} onChange={(e) => set(r.key, { autoIncrement: e.target.checked, ...(e.target.checked ? { primary: true, nullable: false, default: '' } : {}) })} aria-label="Auto increment" />
                      <Input className="mono" value={r.default} disabled={r.locked || r.autoIncrement} placeholder="none" onChange={(e) => set(r.key, { default: e.target.value })} spellCheck={false} aria-label="Default value" />
                      <Input value={r.comment} disabled={r.locked} onChange={(e) => set(r.key, { comment: e.target.value })} maxLength={200} aria-label="Comment" />
                      <Tooltip title={r.locked ? 'A generated column: change it with SQL' : r.original ? 'Remove this column and its data' : 'Remove'}>
                        <Button type="text" danger icon={<DeleteOutlined />} disabled={r.locked || rows.length === 1} aria-label={`Remove column ${r.name}`} onClick={() => setRows((list) => list.filter((x) => x.key !== r.key))} />
                      </Tooltip>
                    </div>
                  ))}
                </div>
                <Button icon={<PlusOutlined />} style={{ marginTop: 10 }} onClick={() => setRows((list) => [...list, { key: next.current++, name: '', type: 'varchar(255)', nullable: true, default: '', autoIncrement: false, primary: false, comment: '' }])}>
                  Add column
                </Button>
                <p className="db-hint" style={{ margin: '10px 0 0' }}>
                  Default: leave empty for none. <span className="mono">NULL</span>, <span className="mono">CURRENT_TIMESTAMP</span> and numbers are used as they are; <span className="mono">''</span> means empty text; anything else is taken as text.
                  {table ? ' Removing a column deletes what is stored in it. Indexes and foreign keys are not shown here; change those with SQL.' : ''}
                </p>
              </>
            )
          },
          { key: 'sql', label: 'SQL preview', children: <pre className="log-box" style={{ minHeight: 160, maxHeight: 360 }}>{preview || (error ? '' : 'Working it out…')}</pre> }
        ]}
      />
      {error && <Alert type="error" showIcon message={<span style={{ whiteSpace: 'pre-wrap' }}>{error}</span>} style={{ marginTop: 10 }} />}
    </Modal>
  )
}
