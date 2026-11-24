// Database client: browse and edit MySQL / MariaDB data and run SQL, in the
// manner of a desktop database tool. Statements run on the managed server
// through the SSH connection (as the database's root, over its local socket),
// so the database port never has to be open to the internet and no database
// password is stored anywhere.
import type { Client } from 'ssh2'
import type { DbColumn, DbDesignColumn, DbGridPage, DbResultSet, DbRunResult, DbTableDesign, DbTableInfo, DbTableSummary } from '@shared/types'
import { PATH_EXPORT, runPrivileged, type Sudo } from './deploy'
import { shq, writeRemoteTemp } from './ssh'

const HEAD = `export LC_ALL=C\n${PATH_EXPORT}\nSQL=$(command -v mariadb || command -v mysql || true)`
/** Rows kept from one result set. More than this is cut and reported as such. */
export const MAX_ROWS = 1000
/** Bytes of output read from the server for one run. */
export const MAX_BYTES = 24 * 1024 * 1024
const RE_IDENT = /^[^\0`\n\r]{1,64}$/

/** `name` as a quoted identifier. */
function id(name: unknown): string {
  if (typeof name !== 'string' || !RE_IDENT.test(name)) throw new Error('That name cannot be used.')
  return '`' + name + '`'
}

/** A value as a SQL literal. `null` becomes NULL. */
export function lit(value: string | null): string {
  if (value === null) return 'NULL'
  if (typeof value !== 'string') throw new Error('Values must be text or empty (NULL).')
  return (
    "'" +
    value.replace(/[\0\n\r\x1a\\']/g, (c) => {
      if (c === '\0') return '\\0'
      if (c === '\n') return '\\n'
      if (c === '\r') return '\\r'
      if (c === '\x1a') return '\\Z'
      return '\\' + c
    }) +
    "'"
  )
}

function unescapeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) => {
    if (e === 'lt') return '<'
    if (e === 'gt') return '>'
    if (e === 'amp') return '&'
    if (e === 'quot') return '"'
    if (e === 'apos') return "'"
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : ''
  })
}

/** Result sets from the `--xml` output of the mysql client. NULL and the text "NULL" stay different. */
export function parseXml(xml: string, maxRows = MAX_ROWS): DbResultSet[] {
  const sets: DbResultSet[] = []
  const reSet = /<resultset statement="([\s\S]*?)"[^>]*?(?:\/>|>([\s\S]*?)<\/resultset>)/g
  let m: RegExpExecArray | null
  while ((m = reSet.exec(xml))) {
    const columns: string[] = []
    const rows: (string | null)[][] = []
    let total = 0
    const reRow = /<row>([\s\S]*?)<\/row>/g
    let r: RegExpExecArray | null
    while ((r = reRow.exec(m[2] ?? ''))) {
      total++
      if (rows.length >= maxRows) continue
      const row: (string | null)[] = []
      const reField = /<field name="([^"]*)"(?:\s+xsi:nil="true"\s*\/>|\s*\/>|>([\s\S]*?)<\/field>)/g
      let f: RegExpExecArray | null
      let i = 0
      while ((f = reField.exec(r[1]))) {
        if (rows.length === 0) columns.push(unescapeXml(f[1]))
        row[i++] = f[0].includes('xsi:nil="true"') ? null : unescapeXml(f[2] ?? '')
      }
      rows.push(row)
    }
    sets.push({ statement: unescapeXml(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200), columns, rows, total, truncated: total > rows.length })
  }
  return sets
}

/** The database's message without the client's decoration: "Error 1064 at line 3: ...". */
function sqlError(text: string): string {
  const m = /ERROR (\d+) \(\w+\)( at line \d+)?: ([\s\S]*)/.exec(text)
  if (!m) return text.trim() || 'The statement failed.'
  return `Error ${m[1]}${m[2] ?? ''}: ${m[3].trim()}`
}

/** MariaDB writes a column's default as SQL text ('abc', NULL); MySQL writes the bare value. */
function plainDefault(v: string | null): string | null {
  if (v === null || v === 'NULL') return null
  const q = /^'([\s\S]*)'$/.exec(v)
  return q ? q[1].replace(/''/g, "'") : v
}

/** Run SQL text on the server. Never throws for a SQL error: it comes back in `error`. */
export async function run(client: Client, sudo: Sudo, database: string | null, sql: string, maxRows = MAX_ROWS): Promise<DbRunResult> {
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('Write a SQL statement first.')
  if (Buffer.byteLength(sql) > 2 * 1024 * 1024) throw new Error('That is more than 2 MB of SQL. Run large imports with the restore function instead.')
  const started = Date.now()
  const tmp = await writeRemoteTemp(client, sql.endsWith('\n') ? sql : sql + '\n')
  const script = `${HEAD}
Q=${shq(tmp)}
if [ -z "$SQL" ]; then unlink "$Q"; echo "@@SDEND nosql"; exit 0; fi
E=$(mktemp /tmp/superdevops-sqlerr-XXXXXX)
"$SQL" --xml --default-character-set=utf8mb4 ${database ? `-D ${shq(database)}` : ''} < "$Q" 2>"$E" | head -c ${MAX_BYTES}
RC=\${PIPESTATUS[0]}
printf '\\n@@SDEND %s\\n' "$RC"
cat "$E"
unlink "$E"; unlink "$Q"
exit 0`
  const res = await runPrivileged(client, script, sudo, undefined, 5 * 60 * 1000)
  const cut = res.stdout.lastIndexOf('\n@@SDEND ')
  if (cut < 0) throw new Error('The answer from the server was cut off. The result may be too large; add a LIMIT.')
  const tail = res.stdout.slice(cut + 9)
  const nl = tail.indexOf('\n')
  const rc = tail.slice(0, nl < 0 ? undefined : nl).trim()
  if (rc === 'nosql') throw new Error('MySQL or MariaDB is not installed on this server.')
  const errText = (nl < 0 ? '' : tail.slice(nl + 1)).trim()
  const body = res.stdout.slice(0, cut)
  const sets = parseXml(body, maxRows)
  // 141 = the output was cut by the size limit (broken pipe), not a SQL error.
  const tooBig = Buffer.byteLength(body) >= MAX_BYTES - 1 || rc === '141'
  return {
    sets,
    error: tooBig ? 'The result was larger than 24 MB and was cut. Add a LIMIT or select fewer columns.' : rc !== '0' ? sqlError(errText) : undefined,
    ms: Date.now() - started
  }
}

/** Runs SQL somewhere: on a managed server through its shell, or over a direct database connection. */
export type Exec = (database: string | null, sql: string, maxRows?: number) => Promise<DbRunResult>

/** SQL run on a managed server as the database's root, through the SSH connection. */
export function serverExec(client: Client, sudo: Sudo): Exec {
  return (database, sql, maxRows) => run(client, sudo, database, sql, maxRows)
}

export async function databases(exec: Exec): Promise<string[]> {
  const set = await one(exec, null, 'SHOW DATABASES', 5000)
  return set.rows.map((r) => r[0] ?? '').filter(Boolean)
}

async function one(exec: Exec, database: string | null, sql: string, maxRows = MAX_ROWS): Promise<DbResultSet> {
  const r = await exec(database, sql, maxRows)
  if (r.error) throw new Error(r.error)
  return r.sets[r.sets.length - 1] ?? { statement: '', columns: [], rows: [], total: 0, truncated: false }
}

export async function tables(exec: Exec, database: string): Promise<DbTableSummary[]> {
  const set = await one(exec, null, `SELECT table_name AS n, table_type AS t, COALESCE(table_rows, 0) AS r, COALESCE(data_length + index_length, 0) AS s, COALESCE(engine, '') AS e FROM information_schema.tables WHERE table_schema = ${lit(database)} ORDER BY table_name`, 5000)
  return set.rows.map((r) => ({ name: r[0] ?? '', view: r[1] === 'VIEW', rows: Number(r[2]) || 0, size: Number(r[3]) || 0, engine: r[4] ?? '' }))
}

export async function tableInfo(exec: Exec, database: string, table: string): Promise<DbTableInfo> {
  const r = await exec(
    null,
    `SELECT column_name, column_type, is_nullable, column_key, column_default, extra, column_comment FROM information_schema.columns WHERE table_schema = ${lit(database)} AND table_name = ${lit(table)} ORDER BY ordinal_position;
SELECT index_name, non_unique, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols FROM information_schema.statistics WHERE table_schema = ${lit(database)} AND table_name = ${lit(table)} GROUP BY index_name, non_unique ORDER BY index_name = 'PRIMARY' DESC, index_name;
SHOW CREATE TABLE ${id(database)}.${id(table)};`
  )
  const columns: DbColumn[] = (r.sets[0]?.rows ?? []).map((c) => ({ name: c[0] ?? '', type: c[1] ?? '', nullable: c[2] === 'YES', key: c[3] ?? '', default: plainDefault(c[4]), extra: c[5] ?? '', comment: c[6] ?? '' }))
  if (columns.length === 0) throw new Error(`The table ${table} does not exist in ${database}.`)
  if (r.error) throw new Error(r.error)
  return {
    columns,
    primaryKey: columns.filter((c) => c.key === 'PRI').map((c) => c.name),
    indexes: (r.sets[1]?.rows ?? []).map((i) => ({ name: i[0] ?? '', unique: i[1] === '0', columns: (i[2] ?? '').split(',') })),
    createSql: r.sets[2]?.rows[0]?.[1] ?? ''
  }
}

export interface BrowseOptions {
  page: number
  pageSize: number
  orderBy?: string
  descending?: boolean
  /** A condition as it would follow WHERE, typed by the person. */
  where?: string
}

export async function browse(exec: Exec, database: string, table: string, o: BrowseOptions): Promise<DbGridPage> {
  const size = Math.max(1, Math.min(500, Math.floor(o.pageSize) || 100))
  const page = Math.max(1, Math.floor(o.page) || 1)
  const where = (o.where ?? '').trim()
  if (where.includes(';')) throw new Error('The filter is one condition, without ";". Use the Query tab for whole statements.')
  const from = `FROM ${id(database)}.${id(table)}${where ? ` WHERE ${where}` : ''}`
  const r = await exec(null, `SELECT COUNT(*) ${from};\nSELECT * ${from}${o.orderBy ? ` ORDER BY ${id(o.orderBy)}${o.descending ? ' DESC' : ''}` : ''} LIMIT ${size} OFFSET ${(page - 1) * size};`, size)
  if (r.error) throw new Error(r.error)
  const data = r.sets[1]
  return { total: Number(r.sets[0]?.rows[0]?.[0]) || 0, columns: data?.columns ?? [], rows: data?.rows ?? [], page, pageSize: size }
}

type Row = Record<string, string | null>

function match(key: Row): string {
  const cols = Object.keys(key)
  if (cols.length === 0) throw new Error('This table has no primary key, so a single row cannot be picked out safely. Use the Query tab.')
  return cols.map((c) => (key[c] === null ? `${id(c)} IS NULL` : `${id(c)} = ${lit(key[c])}`)).join(' AND ')
}

/** Statements that change data end with the number of rows they touched. */
async function change(exec: Exec, sql: string): Promise<number> {
  const set = await one(exec, null, `${sql};\nSELECT ROW_COUNT();`)
  return Number(set.rows[0]?.[0]) || 0
}

export async function updateRow(exec: Exec, database: string, table: string, key: Row, changes: Row): Promise<number> {
  const cols = Object.keys(changes)
  if (cols.length === 0) return 0
  return change(exec, `UPDATE ${id(database)}.${id(table)} SET ${cols.map((c) => `${id(c)} = ${lit(changes[c])}`).join(', ')} WHERE ${match(key)} LIMIT 1`)
}

/** Columns left out get their default value. */
export async function insertRow(exec: Exec, database: string, table: string, values: Row): Promise<number> {
  const cols = Object.keys(values)
  const sql = cols.length ? `INSERT INTO ${id(database)}.${id(table)} (${cols.map(id).join(', ')}) VALUES (${cols.map((c) => lit(values[c])).join(', ')})` : `INSERT INTO ${id(database)}.${id(table)} () VALUES ()`
  return change(exec, sql)
}

export async function deleteRows(exec: Exec, database: string, table: string, keys: Row[]): Promise<number> {
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('Nothing was selected.')
  if (keys.length > 500) throw new Error('Delete at most 500 rows at a time.')
  // One statement per row, each limited to one row, so a wrong key can never take out more.
  const r = await exec(null, keys.map((k) => `DELETE FROM ${id(database)}.${id(table)} WHERE ${match(k)} LIMIT 1;\nSELECT ROW_COUNT();`).join('\n'))
  if (r.error) throw new Error(r.error)
  return r.sets.reduce((sum, s) => sum + (Number(s.rows[0]?.[0]) || 0), 0)
}

// ---------------------------------------------------------------- objects: databases and tables
const SYSTEM_DBS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys'])

async function must(exec: Exec, sql: string): Promise<void> {
  const r = await exec(null, sql)
  if (r.error) throw new Error(r.error)
}

export async function createDatabase(exec: Exec, name: string, charset = 'utf8mb4'): Promise<void> {
  if (!/^[a-z0-9_]{1,32}$/i.test(charset)) throw new Error('That character set name cannot be used.')
  await must(exec, `CREATE DATABASE ${id(name)} CHARACTER SET ${charset}`)
}

export async function dropDatabase(exec: Exec, name: string): Promise<void> {
  if (SYSTEM_DBS.has(String(name).toLowerCase())) throw new Error(`${name} belongs to the database server itself and cannot be dropped from here.`)
  await must(exec, `DROP DATABASE ${id(name)}`)
}

export async function dropTable(exec: Exec, database: string, table: string, view: boolean): Promise<void> {
  await must(exec, `DROP ${view ? 'VIEW' : 'TABLE'} ${id(database)}.${id(table)}`)
}

export async function truncateTable(exec: Exec, database: string, table: string): Promise<void> {
  await must(exec, `TRUNCATE TABLE ${id(database)}.${id(table)}`)
}

export async function renameTable(exec: Exec, database: string, table: string, to: string): Promise<void> {
  await must(exec, `RENAME TABLE ${id(database)}.${id(table)} TO ${id(database)}.${id(to)}`)
}

export async function duplicateTable(exec: Exec, database: string, table: string, to: string, withData: boolean): Promise<void> {
  const src = `${id(database)}.${id(table)}`
  const dst = `${id(database)}.${id(to)}`
  await must(exec, `CREATE TABLE ${dst} LIKE ${src}`)
  if (withData) await must(exec, `INSERT INTO ${dst} SELECT * FROM ${src}`)
}

// ---------------------------------------------------------------- table designer
const RE_TYPE = /^[a-z]+(\s*\([^()\;]{0,500}\))?(\s+(unsigned|zerofill))*$/i
const RE_RAW_DEFAULT = /^(NULL|CURRENT_TIMESTAMP(\(\d?\))?|NOW\(\)|TRUE|FALSE)$/i

function columnSql(c: DbDesignColumn, keepOnUpdate: boolean): string {
  const type = String(c.type ?? '').trim()
  if (!RE_TYPE.test(type)) throw new Error(`"${type || '(empty)'}" is not a column type this designer understands (column ${c.name}). Examples: int, varchar(255), decimal(10,2), text, datetime.`)
  const d = (c.default ?? '').trim()
  // Two quote marks stand for an empty text default; nothing typed means no default at all.
  const def = d === '' ? '' : ` DEFAULT ${d === "''" ? "''" : RE_RAW_DEFAULT.test(d) || /^-?\d+(\.\d+)?$/.test(d) ? d : lit(d)}`
  if (c.autoIncrement && def) throw new Error(`${c.name}: an auto-increment column cannot have a default value.`)
  return `${id(c.name)} ${type} ${c.nullable && !c.primary ? 'NULL' : 'NOT NULL'}${def}${c.autoIncrement ? ' AUTO_INCREMENT' : ''}${keepOnUpdate ? ' ON UPDATE CURRENT_TIMESTAMP' : ''}${c.comment ? ` COMMENT ${lit(c.comment)}` : ''}`
}

function checkDesign(d: DbTableDesign): void {
  if (!Array.isArray(d.columns) || d.columns.length === 0) throw new Error('A table needs at least one column.')
  const seen = new Set<string>()
  for (const c of d.columns) {
    const key = String(c.name ?? '').toLowerCase()
    if (!key.trim()) throw new Error('Every column needs a name.')
    if (seen.has(key)) throw new Error(`Two columns are called ${c.name}.`)
    seen.add(key)
  }
  if (d.columns.filter((c) => c.autoIncrement).length > 1) throw new Error('Only one column can be auto-increment.')
  const ai = d.columns.find((c) => c.autoIncrement)
  if (ai && !ai.primary) throw new Error(`${ai.name} is auto-increment, so it must be (part of) the primary key.`)
}

/** How a column from the database looks in the designer. */
export function toDesignColumn(c: DbColumn): DbDesignColumn {
  return { original: c.name, name: c.name, type: c.type, nullable: c.nullable, default: c.default === null ? '' : c.default === '' ? "''" : c.default, autoIncrement: /auto_increment/i.test(c.extra), primary: c.key === 'PRI', comment: c.comment }
}

/** The statements that create the table, or turn the existing one into the design. Empty when nothing changed. */
export async function designSql(exec: Exec, database: string, original: string | null, design: DbTableDesign): Promise<string> {
  checkDesign(design)
  const pk = design.columns.filter((c) => c.primary).map((c) => id(c.name))
  if (!original) {
    const lines = design.columns.map((c) => '  ' + columnSql(c, false))
    if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(', ')})`)
    return `CREATE TABLE ${id(database)}.${id(design.name)} (\n${lines.join(',\n')}\n) DEFAULT CHARSET=utf8mb4${design.comment ? ` COMMENT=${lit(design.comment)}` : ''};`
  }
  const info = await tableInfo(exec, database, original)
  const before = new Map(info.columns.map((c) => [c.name, c]))
  const kept = new Set(design.columns.map((c) => c.original).filter(Boolean) as string[])
  const parts: string[] = []
  for (const c of info.columns) if (!kept.has(c.name)) parts.push(`DROP COLUMN ${id(c.name)}`)
  let prev: string | null = null
  for (const c of design.columns) {
    const old = c.original ? before.get(c.original) : undefined
    if (c.original && !old) throw new Error(`The column ${c.original} no longer exists. Close the designer and open it again.`)
    if (!old) {
      parts.push(`ADD COLUMN ${columnSql(c, false)}${prev ? ` AFTER ${id(prev)}` : ' FIRST'}`)
    } else {
      const was = toDesignColumn(old)
      const same = was.name === c.name && was.type.toLowerCase() === c.type.trim().toLowerCase() && was.nullable === (c.nullable && !c.primary) && (was.default ?? '') === (c.default ?? '').trim() && was.autoIncrement === c.autoIncrement && (was.comment ?? '') === (c.comment ?? '')
      if (!same) {
        if (/generated/i.test(old.extra)) throw new Error(`${old.name} is a generated column; change it with SQL in a query tab.`)
        parts.push(`CHANGE COLUMN ${id(old.name)} ${columnSql(c, /on update current_timestamp/i.test(old.extra))}`)
      }
    }
    prev = c.name
  }
  const oldPk = info.primaryKey.map(id).join(', ')
  // Compared by the names the columns will have after this change.
  const renamed = new Map(design.columns.filter((c) => c.original).map((c) => [c.original as string, c.name]))
  const oldPkNow = info.primaryKey.filter((n) => kept.has(n)).map((n) => id(renamed.get(n) ?? n)).join(', ')
  if (oldPkNow !== pk.join(', ') || (oldPk && oldPkNow !== oldPk && pk.length === 0)) {
    if (info.primaryKey.length) parts.push('DROP PRIMARY KEY')
    if (pk.length) parts.push(`ADD PRIMARY KEY (${pk.join(', ')})`)
  }
  const out: string[] = []
  if (parts.length) out.push(`ALTER TABLE ${id(database)}.${id(original)}\n  ${parts.join(',\n  ')};`)
  if (design.name !== original) out.push(`RENAME TABLE ${id(database)}.${id(original)} TO ${id(database)}.${id(design.name)};`)
  return out.join('\n')
}

export async function designApply(exec: Exec, database: string, original: string | null, design: DbTableDesign): Promise<string> {
  const sql = await designSql(exec, database, original, design)
  if (!sql) return ''
  await must(exec, sql)
  return sql
}

// ---------------------------------------------------------------- dump to SQL text
const DUMP_ROWS = 200000
const DUMP_BYTES = 64 * 1024 * 1024

/** One table (or view) as SQL: its definition and, for a table, its rows. */
/**
 * One table (or view) as SQL, handed to `sink` piece by piece so a large table never sits in memory whole.
 * `budget` is the export's size limit; a backup passes null and has none. Returns the number of rows written.
 */
async function dumpOne(exec: Exec, database: string, table: string, withData: boolean, budget: { bytes: number } | null, sink: (sql: string) => void | Promise<void>): Promise<number> {
  const info = await tableInfo(exec, database, table)
  const isView = /^CREATE\s+(OR\s+REPLACE\s+)?(ALGORITHM|DEFINER|SQL\s+SECURITY|VIEW)/i.test(info.createSql)
  // A view's definition names its database and the account that made it. Both are taken out,
  // so it can be loaded into a database of another name, on a server without that account.
  const createSql = isView ? info.createSql.split(`${id(database)}.`).join('').replace(/\sDEFINER=(`[^`]*`|'[^']*'|[^\s@]+)@(`[^`]*`|'[^']*'|\S+)/i, '') : info.createSql
  await sink(`-- ${isView ? 'View' : 'Table'}: ${table}\nDROP ${isView ? 'VIEW' : 'TABLE'} IF EXISTS ${id(table)};\n${createSql};\n\n`)
  if (isView || !withData) return 0
  // Bytes travel as hex so they come back exactly.
  const binary = info.columns.map((c) => /blob|binary/i.test(c.type))
  const select = info.columns.map((c, i) => (binary[i] ? `HEX(${id(c.name)})` : id(c.name))).join(', ')
  const cols = info.columns.map((c) => id(c.name)).join(', ')
  const order = info.primaryKey.length ? ` ORDER BY ${info.primaryKey.map(id).join(', ')}` : ''
  let total = 0
  for (let offset = 0; ; offset += 1000) {
    const r = await exec(null, `SELECT ${select} FROM ${id(database)}.${id(table)}${order} LIMIT 1000 OFFSET ${offset}`, 1000)
    if (r.error) throw new Error(r.error)
    const rows = r.sets[r.sets.length - 1]?.rows ?? []
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200).map((row) => '(' + row.map((v, c) => (v === null ? 'NULL' : binary[c] ? (v === '' ? "''" : `UNHEX('${v}')`) : lit(v))).join(', ') + ')')
      const stmt = `INSERT INTO ${id(table)} (${cols}) VALUES\n${chunk.join(',\n')};\n`
      if (budget) {
        budget.bytes += stmt.length
        if (budget.bytes > DUMP_BYTES) throw new Error('The export passed 64 MB. For a database this size, use "Back up database" instead.')
      }
      await sink(stmt)
    }
    total += rows.length
    if (rows.length < 1000) break
    if (budget && total >= DUMP_ROWS) throw new Error(`${table} has more than ${DUMP_ROWS} rows. For a table this size, use "Back up database" instead.`)
  }
  await sink('\n')
  return total
}

/** A table, or every table of a database when `table` is null, as SQL text that recreates it. */
export async function dump(exec: Exec, database: string, table: string | null, withData: boolean): Promise<string> {
  const budget = { bytes: 0 }
  let list: DbTableSummary[]
  if (table) list = (await tables(exec, database)).filter((t) => t.name === table)
  else list = await tables(exec, database)
  if (table && list.length === 0) throw new Error(`The table ${table} does not exist in ${database}.`)
  // Views last: they read from the tables.
  list.sort((a, b) => Number(a.view) - Number(b.view))
  let out = `-- Apsara Panel SQL export\n-- Database: ${database}\n-- ${new Date().toISOString()}\n\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n`
  for (const t of list)
    await dumpOne(exec, database, t.name, withData, budget, (sql) => {
      out += sql
    })
  return out + 'SET FOREIGN_KEY_CHECKS = 1;\n'
}

/**
 * A whole database, tables, views and every row, written through `sink` with no size limit: a backup.
 * Stored procedures, triggers and events are not part of it.
 */
export async function backup(exec: Exec, database: string, sink: (sql: string) => void | Promise<void>, log: (line: string) => void): Promise<{ tables: number; rows: number }> {
  const list = await tables(exec, database)
  // Views last: they read from the tables.
  list.sort((a, b) => Number(a.view) - Number(b.view))
  await sink(`-- Apsara Panel database backup\n-- Database: ${database}\n-- ${new Date().toISOString()}\n-- Tables, views and rows. Stored procedures, triggers and events are not included.\n\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n`)
  let rows = 0
  for (const t of list) {
    const n = await dumpOne(exec, database, t.name, true, null, sink)
    rows += n
    log(t.view ? `${t.name}: view\n` : `${t.name}: ${n} row${n === 1 ? '' : 's'}\n`)
  }
  await sink('SET FOREIGN_KEY_CHECKS = 1;\n')
  return { tables: list.length, rows }
}
