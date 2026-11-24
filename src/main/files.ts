// File manager: browse and change files on a managed server. Everything runs
// as root through one bash script per action, so it works on files the SSH
// user cannot touch. `root` confines a caller to one folder tree.
import type { Client } from 'ssh2'
import { posix } from 'node:path'
import type { FileEntry, FileListing, FileSearchHit, FileSearchResult, FileText, TrashEntry } from '@shared/types'
import { MAX_EDIT_BYTES } from '@shared/types'
import { openSftp, shq, uploadFile, writeRemoteTemp } from './ssh'
import { runPrivileged, type Sudo } from './deploy'

export interface FileCtx {
  client: Client
  sudo: Sudo
  /** When set, every path must stay inside this folder. */
  root?: string
}

const LIST_LIMIT = 3000
const LONG = 15 * 60 * 1000

/** Folders nobody should delete, move or re-own by a slip of the mouse. */
const PROTECTED = ['/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/tmp', '/usr', '/var', '/www', '/www/wwwroot']

function cleanPath(p: unknown): string {
  if (typeof p !== 'string' || !p.startsWith('/') || p.length > 4000 || /[\0\n\r]/.test(p)) throw new Error('That is not a valid path. Paths start with "/".')
  return posix.normalize(p).replace(/(.)\/+$/, '$1')
}

function cleanName(n: unknown): string {
  if (typeof n !== 'string') throw new Error('A name is needed.')
  const name = n.trim()
  if (!name || name === '.' || name === '..' || name.length > 255 || /[/\0\n\r]/.test(name)) throw new Error('That name cannot be used. Names cannot contain "/" and cannot be "." or "..".')
  return name
}

function cleanList(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('Nothing was selected.')
  if (paths.length > 500) throw new Error('Select at most 500 items at a time.')
  return paths.map(cleanPath)
}

/**
 * Shell functions shared by every action.
 *   whole PATH  -> the real location (links followed); refused outside the allowed folder.
 *   item PATH   -> the entry itself (a link stays a link); its folder must be allowed.
 */
function prelude(ctx: FileCtx): string {
  return `
export LC_ALL=C
ROOT=${shq(ctx.root ?? '')}
PROTECTED=${shq(PROTECTED.join('\n'))}
die() { echo "$1"; exit 3; }
allowed() {
  [ -z "$ROOT" ] && return 0
  case "$1/" in "$ROOT"/*) return 0 ;; esac
  return 1
}
whole() {
  W=$(realpath -m -- "$1" 2>/dev/null) || die "That is not a valid path."
  allowed "$W" || die "Your role can only work inside $ROOT."
}
item() {
  local d
  d=$(realpath -m -- "$(dirname -- "$1")" 2>/dev/null) || die "That is not a valid path."
  I="\${d%/}/$(basename -- "$1")"
  [ "$d" = "/" ] && I="/$(basename -- "$1")"
  [ "$1" = "/" ] && I="/"
  allowed "$d" || die "Your role can only work inside $ROOT."
  [ -n "$ROOT" ] && [ "$I" = "$ROOT" ] && die "The top folder itself cannot be changed."
  return 0
}
guard() {
  if printf '%s\\n' "$PROTECTED" | grep -qxF -- "$1"; then die "$1 is a system folder and is protected here."; fi
}
owner_like() { chown -h --reference="$1" -- "$2" 2>/dev/null || true; }
`
}

async function run(ctx: FileCtx, body: string, timeoutMs = 60000): Promise<string> {
  const res = await runPrivileged(ctx.client, prelude(ctx) + body, ctx.sudo, undefined, timeoutMs)
  return res.stdout
}

function kind(c: string): FileEntry['type'] {
  return c === 'd' ? 'dir' : c === 'f' ? 'file' : c === 'l' ? 'link' : 'other'
}

export async function list(ctx: FileCtx, dir: string): Promise<FileListing> {
  const out = await run(
    ctx,
    `
whole ${shq(cleanPath(dir))}
[ -d "$W" ] || die "That folder does not exist."
printf '%s\\0' "$W"
df -Pk -- "$W" 2>/dev/null | awk 'NR==2 {printf "%s %s", $2, $4}'
printf '\\0'
find "$W" -mindepth 1 -maxdepth 1 -printf '%y\\t%Y\\t%s\\t%T@\\t%m\\t%u\\t%g\\t%f\\0' 2>/dev/null | head -z -n ${LIST_LIMIT + 1}
`
  )
  const records = out.split('\0')
  const path = records[0] || '/'
  const [total, free] = (records[1] ?? '').split(' ').map((n) => Number(n) * 1024)
  const entries: FileEntry[] = []
  for (const rec of records.slice(2)) {
    if (!rec) continue
    const f = rec.split('\t')
    if (f.length < 8) continue
    const type = kind(f[0])
    entries.push({
      name: f.slice(7).join('\t'),
      type,
      isDir: type === 'dir' || (type === 'link' && f[1] === 'd'),
      size: Number(f[2]) || 0,
      mtime: Math.round(Number(f[3]) * 1000) || 0,
      mode: f[4].padStart(3, '0'),
      owner: f[5],
      group: f[6]
    })
  }
  const truncated = entries.length > LIST_LIMIT
  return { path, entries: entries.slice(0, LIST_LIMIT), truncated, diskTotal: total || 0, diskFree: free || 0, root: ctx.root ?? null }
}

export async function read(ctx: FileCtx, path: string): Promise<FileText> {
  const out = await run(
    ctx,
    `
whole ${shq(cleanPath(path))}
[ -d "$W" ] && die "That is a folder, not a file."
[ -f "$W" ] || die "That file does not exist."
S=$(stat -c %s -- "$W")
[ "$S" -gt ${MAX_EDIT_BYTES} ] && die "This file is larger than ${MAX_EDIT_BYTES / 1048576} MB. Download it to edit it on your computer."
stat -c '%y|%s' -- "$W"
stat -c '%a %U %G' -- "$W"
printf '%s\\n' "$W"
base64 -w0 -- "$W"
`
  )
  const nl1 = out.indexOf('\n')
  const nl2 = out.indexOf('\n', nl1 + 1)
  const nl3 = out.indexOf('\n', nl2 + 1)
  const data = Buffer.from(out.slice(nl3 + 1), 'base64')
  if (data.includes(0)) throw new Error('This looks like a binary file, so it cannot be edited as text. Download it instead.')
  const [mode, owner, group] = out.slice(nl1 + 1, nl2).split(' ')
  return { path: out.slice(nl2 + 1, nl3), content: data.toString('utf8'), version: out.slice(0, nl1), mode, owner, group }
}

const SEARCH_LIMIT = 500
/** Folders that are large and rarely what someone searches in. Included on request. */
const SEARCH_SKIP = ['.git', 'node_modules', 'vendor', '.cache', '.next', 'dist', 'build']

/**
 * Text in the files under a folder, like the content search of a hosting panel: grep, binary files skipped,
 * at most 20 matches per file and 500 in all, stopped after 25 seconds.
 */
export async function search(ctx: FileCtx, dir: string, query: string, opts: { caseSensitive?: boolean; include?: string; everything?: boolean } = {}): Promise<FileSearchResult> {
  const q = String(query ?? '')
  if (!q.trim()) throw new Error('Type something to search for.')
  if (q.length > 200 || /[\0\n\r]/.test(q)) throw new Error('Search for one line of at most 200 characters.')
  const include = String(opts.include ?? '').trim()
  const globs = include ? include.split(/[\s,]+/).filter(Boolean) : []
  if (globs.length > 10 || globs.some((g) => !/^[A-Za-z0-9*?._-]{1,40}$/.test(g))) throw new Error('File names to search in are patterns such as *.php or *.env, separated by spaces.')
  const skip = opts.everything ? [] : SEARCH_SKIP
  const out = await run(
    ctx,
    `
whole ${shq(cleanPath(dir))}
[ -d "$W" ] || die "That folder does not exist."
timeout 25 grep -rIHn -Z --binary-files=without-match -F ${opts.caseSensitive ? '' : '-i'} -m 20 ${skip.map((d) => `--exclude-dir=${shq(d)}`).join(' ')} ${globs.map((g) => `--include=${shq(g)}`).join(' ')} -e ${shq(q)} -- "$W" 2>/dev/null | head -n ${SEARCH_LIMIT + 1} | cut -c1-4500
true
`,
    40000
  )
  const hits: FileSearchHit[] = []
  for (const row of out.split('\n')) {
    const z = row.indexOf('\0')
    if (z < 0) continue
    const rest = row.slice(z + 1)
    const colon = rest.indexOf(':')
    const line = Number(rest.slice(0, colon))
    if (!Number.isInteger(line)) continue
    hits.push({ path: row.slice(0, z), line, text: rest.slice(colon + 1).slice(0, 300) })
  }
  return { hits: hits.slice(0, SEARCH_LIMIT), truncated: hits.length > SEARCH_LIMIT }
}

/** Save text. `version` (from read) makes the save fail when someone else changed the file meanwhile. */
export async function write(ctx: FileCtx, path: string, content: string, version?: string): Promise<string> {
  if (typeof content !== 'string') throw new Error('Nothing to save.')
  if (Buffer.byteLength(content) > MAX_EDIT_BYTES) throw new Error(`Text larger than ${MAX_EDIT_BYTES / 1048576} MB cannot be saved from the editor.`)
  const p = cleanPath(path)
  const tmp = await writeRemoteTemp(ctx.client, content)
  const out = await run(
    ctx,
    `
T=${shq(tmp)}
trap 'rm -f -- "$T"' EXIT
whole ${shq(p)}
if [ -e "$W" ]; then
  [ -f "$W" ] || die "That path is not a regular file."
  ${version ? `[ "$(stat -c '%y|%s' -- "$W")" = ${shq(version)} ] || die "This file was changed on the server after you opened it. Reopen it to see the new version."` : ''}
  cat -- "$T" > "$W" || die "The file could not be written."
else
  D=$(dirname -- "$W")
  [ -d "$D" ] || die "The folder $D does not exist."
  cat -- "$T" > "$W" || die "The file could not be written."
  chmod 644 -- "$W"
  owner_like "$D" "$W"
fi
stat -c '%y|%s' -- "$W"
`
  )
  return out.trim().split('\n').pop() ?? ''
}

export async function create(ctx: FileCtx, dir: string, name: string, what: 'file' | 'dir'): Promise<void> {
  await run(
    ctx,
    `
whole ${shq(cleanPath(dir))}
[ -d "$W" ] || die "That folder does not exist."
N="\${W%/}/"${shq(cleanName(name))}
[ -e "$N" ] || [ -L "$N" ] && die "Something with that name already exists here."
${what === 'dir' ? 'mkdir -- "$N" && chmod 755 -- "$N"' : ': > "$N" && chmod 644 -- "$N"'} || die "It could not be created."
owner_like "$W" "$N"
`
  )
}

export async function rename(ctx: FileCtx, path: string, newName: string): Promise<void> {
  await run(
    ctx,
    `
item ${shq(cleanPath(path))}
guard "$I"
[ -e "$I" ] || [ -L "$I" ] || die "That item no longer exists."
N="$(dirname -- "$I")/"${shq(cleanName(newName))}
[ "$N" = "$I" ] && exit 0
[ -e "$N" ] || [ -L "$N" ] && die "Something with that name already exists here."
mv -T -- "$I" "$N" || die "It could not be renamed."
`
  )
}

/** Copy or move items into a folder. Without `overwrite`, existing names stop the whole action before anything changes. */
export async function transfer(ctx: FileCtx, mode: 'copy' | 'move', paths: string[], destDir: string, overwrite = false): Promise<void> {
  const list = cleanList(paths)
  await run(
    ctx,
    `
whole ${shq(cleanPath(destDir))}
DEST="$W"
[ -d "$DEST" ] || die "The destination folder does not exist."
SRC=()
TGT=()
for P in ${list.map(shq).join(' ')}; do
  item "$P"
  ${mode === 'move' ? 'guard "$I"' : ''}
  [ -e "$I" ] || [ -L "$I" ] || die "$I no longer exists."
  B=$(basename -- "$I")
  T="\${DEST%/}/$B"
  case "$DEST/" in "$I"/*) die "A folder cannot be ${mode === 'copy' ? 'copied' : 'moved'} into itself." ;; esac
  if [ "$T" = "$I" ]; then
    ${
      mode === 'move'
        ? 'continue'
        : `# Copying next to the original: pick a free name.
    E=""; S="$B"
    if [ ! -d "$I" ]; then case "$B" in ?*.*) E=".\${B##*.}"; S="\${B%.*}" ;; esac; fi
    T="\${DEST%/}/$S (copy)$E"; n=2
    while [ -e "$T" ] || [ -L "$T" ]; do T="\${DEST%/}/$S (copy $n)$E"; n=$((n+1)); done`
    }
  elif [ -e "$T" ] || [ -L "$T" ]; then
    ${overwrite ? ':' : 'die "EXISTS:$B"'}
  fi
  SRC+=("$I"); TGT+=("$T")
done
for i in "\${!SRC[@]}"; do
  S="\${SRC[$i]}"; T="\${TGT[$i]}"
  if [ -d "$S" ] && [ ! -L "$S" ] && [ -d "$T" ] && [ ! -L "$T" ]; then
    cp -a -- "$S/." "$T/" || die "Copying $S failed."
    ${mode === 'move' ? 'rm -rf -- "$S"' : ''}
  else
    ${mode === 'move' ? 'mv -fT -- "$S" "$T"' : 'cp -afT -- "$S" "$T"'} || die "${mode === 'copy' ? 'Copying' : 'Moving'} $S failed."
  fi
done
`,
    LONG
  ).catch((err: Error) => {
    const m = /EXISTS:(.*)$/.exec(err.message)
    if (m) throw new Error(`EXISTS:${m[1]}`)
    throw err
  })
}

/** Where deleted items wait until they are restored or the trash is emptied. One folder per item: `data` and a `meta` file. */
const TRASH = '/var/lib/superdevops/trash'

/** Delete items. Unless `permanent`, they are moved to the trash and can be restored. */
export async function remove(ctx: FileCtx, paths: string[], permanent = false, by = ''): Promise<void> {
  const list = cleanList(paths)
  const who = by.replace(/[^\w.@-]/g, '').slice(0, 40)
  await run(
    ctx,
    `
TRASH=${shq(TRASH)}
ALL=()
for P in ${list.map(shq).join(' ')}; do
  item "$P"
  guard "$I"
  [ -e "$I" ] || [ -L "$I" ] || die "$I no longer exists."
  ALL+=("$I")
done
${permanent ? '' : 'mkdir -p -- "$TRASH" && chmod 700 -- "$TRASH" || die "The trash folder could not be created."'}
n=0
for I in "\${ALL[@]}"; do
  case "$I/" in "$TRASH"/*) FOREVER=1 ;; *) FOREVER=${permanent ? 1 : 0} ;; esac
  if [ "$FOREVER" = 1 ]; then
    rm -rf --one-file-system -- "$I" || die "$I could not be deleted."
  else
    n=$((n+1))
    E="$TRASH/$(date +%s%N)-$n"
    mkdir -- "$E" || die "The trash folder could not be written."
    printf '%s\\n%s\\n%s\\n' "$I" "$(date +%s)" ${shq(who)} > "$E/meta"
    mv -- "$I" "$E/data" || { rm -rf -- "$E"; die "$I could not be moved to the trash."; }
  fi
done
`,
    LONG
  )
}

/** Shell loop over trash entries this caller may see: sets E (entry folder), ID and ORIG for each. */
const EACH_TRASH = `
TRASH=${shq(TRASH)}
each_trash() {
  local E
  [ -d "$TRASH" ] || return 0
  for E in "$TRASH"/*/; do
    E="\${E%/}"
    [ -f "$E/meta" ] || continue
    ORIG=$(sed -n 1p "$E/meta")
    allowed "$(dirname -- "$ORIG")" || continue
    ID=$(basename -- "$E")
    "$1" "$E"
  done
}
`

export async function trashList(ctx: FileCtx): Promise<TrashEntry[]> {
  const out = await run(
    ctx,
    `${EACH_TRASH}
show() {
  local D="$1/data" T=f S=0
  if [ -L "$D" ]; then T=l; elif [ -d "$D" ]; then T=d; else S=$(stat -c %s -- "$D" 2>/dev/null || echo 0); fi
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\0' "$ID" "$(sed -n 2p "$1/meta")" "$(sed -n 3p "$1/meta")" "$T" "$S" "$ORIG"
}
each_trash show
`
  )
  return out
    .split('\0')
    .filter(Boolean)
    .map((rec) => {
      const f = rec.split('\t')
      const path = f.slice(5).join('\t')
      return { id: f[0], deletedAt: (Number(f[1]) || 0) * 1000, by: f[2], isDir: f[3] === 'd', size: Number(f[4]) || 0, path, name: path.split('/').pop() ?? path }
    })
    .sort((a, b) => b.deletedAt - a.deletedAt)
}

function cleanIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) throw new Error('Nothing was selected.')
  for (const id of ids) if (typeof id !== 'string' || !/^[0-9]{1,24}-[0-9]{1,6}$/.test(id)) throw new Error('That trash entry is not valid.')
  return ids as string[]
}

/** Put items back where they were. Nothing is overwritten. */
export async function trashRestore(ctx: FileCtx, ids: string[]): Promise<void> {
  const list = cleanIds(ids)
  await run(
    ctx,
    `${EACH_TRASH}
WANT=${shq(list.join('\n'))}
back() {
  printf '%s\\n' "$WANT" | grep -qxF -- "$ID" || return 0
  item "$ORIG"
  [ -e "$I" ] || [ -L "$I" ] && die "$I already exists. Rename or remove it first, then restore."
  mkdir -p -- "$(dirname -- "$I")" || die "The original folder could not be created."
  mv -- "$1/data" "$I" || die "$I could not be restored."
  rm -rf -- "$1"
}
each_trash back
`,
    LONG
  )
}

/** Delete trash entries for good. Without ids, everything this caller may see. */
export async function trashPurge(ctx: FileCtx, ids?: string[]): Promise<void> {
  const list = ids ? cleanIds(ids) : null
  await run(
    ctx,
    `${EACH_TRASH}
WANT=${shq(list ? list.join('\n') : '')}
gone() {
  ${list ? `printf '%s\\n' "$WANT" | grep -qxF -- "$ID" || return 0` : ''}
  rm -rf --one-file-system -- "$1" || die "An item could not be deleted."
}
each_trash gone
`,
    LONG
  )
}

export interface PermInput {
  mode: string
  owner?: string
  group?: string
  recursive: boolean
}

export async function chmod(ctx: FileCtx, paths: string[], input: PermInput): Promise<void> {
  const list = cleanList(paths)
  if (!/^[0-7]{3,4}$/.test(input.mode)) throw new Error('Permissions are three digits from 0 to 7, for example 644 or 755.')
  if (ctx.root && (input.mode.length === 4 || input.owner || input.group)) throw new Error('Your role can set basic permissions only, not the owner or special bits.')
  const name = /^[a-z_][a-z0-9_.-]{0,31}\$?$/i
  for (const n of [input.owner, input.group]) if (n && !name.test(n)) throw new Error(`"${n}" is not a valid user or group name.`)
  const own = input.owner ? `${input.owner}${input.group ? ':' + input.group : ''}` : input.group ? `:${input.group}` : ''
  const r = input.recursive ? '-R' : ''
  await run(
    ctx,
    `
${input.owner ? `id -- ${shq(input.owner)} >/dev/null 2>&1 || die "There is no user named ${input.owner} on this server."` : ''}
${input.group ? `getent group -- ${shq(input.group)} >/dev/null 2>&1 || die "There is no group named ${input.group} on this server."` : ''}
for P in ${list.map(shq).join(' ')}; do
  item "$P"
  guard "$I"
  [ -e "$I" ] || die "$I no longer exists."
  [ -L "$I" ] && die "$I is a link. Change the file it points to instead."
  chmod ${r} ${input.mode} -- "$I" || die "Permissions could not be changed on $I."
  ${own ? `chown -h ${r} ${shq(own)} -- "$I" || die "The owner could not be changed on $I."` : ''}
done
`,
    LONG
  )
}

export async function compress(ctx: FileCtx, paths: string[], archiveName: string, format: 'tar.gz' | 'zip'): Promise<void> {
  const list = cleanList(paths)
  let name = cleanName(archiveName)
  if (!name.toLowerCase().endsWith('.' + format)) name += '.' + format
  await run(
    ctx,
    `
NAMES=()
DIR=""
for P in ${list.map(shq).join(' ')}; do
  item "$P"
  [ -e "$I" ] || [ -L "$I" ] || die "$I no longer exists."
  D=$(dirname -- "$I")
  [ -n "$DIR" ] && [ "$D" != "$DIR" ] && die "Select items from one folder."
  DIR="$D"; NAMES+=("$(basename -- "$I")")
done
OUT="\${DIR%/}/"${shq(name)}
[ -e "$OUT" ] && die "$(basename -- "$OUT") already exists here. Pick another name."
cd -- "$DIR" || die "The folder cannot be opened."
${
  format === 'zip'
    ? `command -v zip >/dev/null 2>&1 || die "The zip tool is not installed on this server. Use .tar.gz, or install it with: apt install zip"
zip -qry "$OUT" "\${NAMES[@]/#/./}" || { rm -f -- "$OUT"; die "The archive could not be made."; }`
    : `tar -czf "$OUT" -- "\${NAMES[@]}" || { rm -f -- "$OUT"; die "The archive could not be made."; }`
}
owner_like "$DIR" "$OUT"
`,
    LONG
  )
}

/** Unpack `$A` into `$DEST` through a private folder, so the new files get the destination's owner and no special bits. */
const UNPACK = `
# Mac leftovers ("._name" files, __MACOSX, .DS_Store) are skipped. A pattern with nothing to skip is not an error.
unzip_clean() { local out rc; if out=\$(unzip -oq -- "\$1" -d "\$2" -x "__MACOSX/*" "._*" "*/._*" ".DS_Store" "*/.DS_Store" 2>&1); then rc=0; else rc=\$?; fi; printf '%s\\n' "\$out" | grep -v -e '^caution: excluded filename not matched' -e '^\$' || true; return \$rc; }
unpack() {
  local A="$1" DEST="$2" KIND="$3" TMPD
  TMPD=$(mktemp -d -- "\${DEST%/}/.superdevops-unpack-XXXXXX") || die "The destination folder cannot be written."
  case "$KIND" in
    zip)
      command -v unzip >/dev/null 2>&1 || { rmdir "$TMPD"; die "The unzip tool is not installed on this server. Install it with: apt install unzip"; }
      unzip_clean "$A" "$TMPD" || { rm -rf -- "$TMPD"; die "The archive could not be unpacked. It may be damaged."; } ;;
    *)
      tar -xf "$A" --no-same-owner --no-same-permissions --exclude="._*" --exclude=__MACOSX --exclude=.DS_Store -C "$TMPD" || { rm -rf -- "$TMPD"; die "The archive could not be unpacked. It may be damaged."; } ;;
  esac
  chown -hR --reference="$DEST" -- "$TMPD" 2>/dev/null || true
  chmod -R u-s,g-s -- "$TMPD" 2>/dev/null || true
  cp -a -- "$TMPD/." "$DEST/" || { rm -rf -- "$TMPD"; die "The unpacked files could not be put in place."; }
  rm -rf -- "$TMPD"
}
`

function archiveKind(name: string): 'zip' | 'tar' | null {
  const n = name.toLowerCase()
  if (n.endsWith('.zip')) return 'zip'
  if (/\.(tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/.test(n)) return 'tar'
  return null
}

export async function extract(ctx: FileCtx, path: string, destDir: string): Promise<void> {
  const p = cleanPath(path)
  const k = archiveKind(p)
  if (!k) throw new Error('Only .zip, .tar, .tar.gz, .tgz, .tar.bz2 and .tar.xz archives can be unpacked.')
  await run(
    ctx,
    `${UNPACK}
whole ${shq(p)}
A="$W"
[ -f "$A" ] || die "That archive does not exist."
whole ${shq(cleanPath(destDir))}
[ -d "$W" ] || die "The destination folder does not exist."
unpack "$A" "$W" ${k}
`,
    LONG
  )
}

/** Total size of a file or folder, in bytes. */
export async function size(ctx: FileCtx, path: string): Promise<number> {
  const out = await run(ctx, `item ${shq(cleanPath(path))}\ndu -sb -- "$I" 2>/dev/null | cut -f1`, 120000)
  return Number(out.trim()) || 0
}

/**
 * Put a file that already sits on this machine into a folder on the server.
 * `packed` means the local file is a .tar.gz of a folder, unpacked into a new folder called `name`.
 */
export async function putUpload(ctx: FileCtx, localPath: string, destDir: string, name: string, packed: boolean, overwrite: boolean): Promise<void> {
  const dir = cleanPath(destDir)
  const n = cleanName(name)
  // Check before sending anything large.
  await run(
    ctx,
    `
whole ${shq(dir)}
[ -d "$W" ] || die "That folder does not exist."
T="\${W%/}/"${shq(n)}
if [ -e "$T" ] || [ -L "$T" ]; then
  ${overwrite ? `${packed ? '[ -d "$T" ] || die "$T exists and is not a folder."' : '[ -d "$T" ] && die "$T is a folder, so a file cannot replace it."'}` : `die ${shq('EXISTS:' + n)}`}
fi
exit 0
`
  )
  const tmp = `/tmp/superdevops-up-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  const sftp = await openSftp(ctx.client)
  try {
    await uploadFile(sftp, localPath, tmp)
  } finally {
    sftp.end()
  }
  await run(
    ctx,
    `${UNPACK}
T0=${shq(tmp)}
trap 'rm -f -- "$T0"' EXIT
whole ${shq(dir)}
D="$W"
T="\${D%/}/"${shq(n)}
${
  packed
    ? `mkdir -p -- "$T" || die "The folder could not be created."
owner_like "$D" "$T"
unpack "$T0" "$T" tar`
    : `whole "$T"
cat -- "$T0" > "$W" || die "The file could not be written."
[ "$W" = "$T" ] && { chmod 644 -- "$T"; owner_like "$D" "$T"; }`
}
exit 0
`,
    LONG
  )
}

/** Copy a file from the server to this machine. A folder arrives as a .tar.gz. */
export async function fetch(ctx: FileCtx, path: string, localPath: string): Promise<void> {
  const tmp = `/tmp/superdevops-dl-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  try {
    await run(
      ctx,
      `
item ${shq(cleanPath(path))}
[ -e "$I" ] || die "That item no longer exists."
T=${shq(tmp)}
( umask 077; : > "$T" )
if [ -d "$I" ]; then
  tar -czf "$T" -C "$(dirname -- "$I")" -- "$(basename -- "$I")" || { rm -f -- "$T"; die "The folder could not be packed."; }
else
  whole "$I"
  [ -f "$W" ] || { rm -f -- "$T"; die "Only regular files and folders can be downloaded."; }
  cat -- "$W" > "$T" || { rm -f -- "$T"; die "The file could not be read."; }
fi
chown "\${SUDO_USER:-$(id -un)}" -- "$T"
`,
      LONG
    )
    const sftp = await openSftp(ctx.client)
    try {
      await new Promise<void>((resolve, reject) => sftp.fastGet(tmp, localPath, (err) => (err ? reject(err) : resolve())))
    } finally {
      sftp.end()
    }
  } finally {
    await runPrivileged(ctx.client, `rm -f -- ${shq(tmp)}`, ctx.sudo, undefined, 20000).catch(() => undefined)
  }
}
