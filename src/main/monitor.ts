// System monitor: one cheap command per sample, parsed from /proc.
import type { Client } from 'ssh2'
import type { DiskInfo, GpuInfo, GpuProc, MonitorSample, ProcInfo } from '@shared/types'
import { exec, plainForm, transportOf, wrapScript } from './ssh'

const SCRIPT = `
export LC_ALL=C
echo '@@cpu'; head -1 /proc/stat
echo '@@mem'; grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo
echo '@@load'; cat /proc/loadavg
echo '@@uptime'; cat /proc/uptime
echo '@@cores'; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo
echo '@@disk'; df -Pk 2>/dev/null
echo '@@net'; cat /proc/net/dev
echo '@@host'; hostname; uname -sr; (. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")
echo '@@cpumodel'; grep -m1 'model name' /proc/cpuinfo | cut -d: -f2
echo '@@procs'; ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -9
echo '@@gpu'
if command -v nvidia-smi >/dev/null 2>&1; then
  timeout 4 nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed --format=csv,noheader,nounits 2>/dev/null | sed 's/^/nvidia, /'
  echo '@@gpuprocs'; timeout 4 nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null | head -20
  echo '@@gpuids'; timeout 4 nvidia-smi --query-gpu=index,uuid --format=csv,noheader 2>/dev/null
  echo '@@gpu2'
fi
for d in /sys/class/drm/card[0-9]*/device; do
  [ -r "$d/gpu_busy_percent" ] || continue
  t=$(cat "$d"/hwmon/hwmon*/temp1_input 2>/dev/null | head -1)
  echo "amd, $(basename "$(dirname "$d")"), $(cat "$d/product_name" 2>/dev/null || echo AMD GPU), $(cat "$d/gpu_busy_percent" 2>/dev/null), $(cat "$d/mem_info_vram_used" 2>/dev/null), $(cat "$d/mem_info_vram_total" 2>/dev/null), $t"
done
`

interface Raw {
  ts: number
  cpuTotal: number
  cpuIdle: number
  rx: number
  tx: number
  sections: Record<string, string[]>
}

const previous = new Map<string, Raw>()

export function parseSections(text: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {}
  let current = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) {
      current = line.slice(2).trim()
      sections[current] = []
    } else if (current && line.trim() !== '') {
      sections[current].push(line)
    }
  }
  return sections
}

function toRaw(text: string): Raw {
  const sections = parseSections(text)
  const cpu = (sections.cpu?.[0] ?? '').trim().split(/\s+/).slice(1).map(Number)
  const cpuTotal = cpu.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
  const cpuIdle = (cpu[3] || 0) + (cpu[4] || 0)
  let rx = 0
  let tx = 0
  for (const line of sections.net ?? []) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/)
    if (!m) continue
    const name = m[1].trim()
    if (name === 'lo' || /^(docker|veth|br-|virbr|tun|tap|kube|cni|flannel)/.test(name)) continue
    const f = m[2].trim().split(/\s+/).map(Number)
    rx += f[0] || 0
    tx += f[8] || 0
  }
  return { ts: Date.now(), cpuTotal, cpuIdle, rx, tx, sections }
}

const SKIP_FS = /^(tmpfs|devtmpfs|udev|overlay|none|shm|efivarfs|squashfs|run|dev)$/
const SKIP_MOUNT = /^\/(snap|run|dev|sys|proc|boot\/efi|var\/lib\/docker)(\/|$)/

export function parseDisks(lines: string[]): DiskInfo[] {
  const disks: DiskInfo[] = []
  const seen = new Set<string>()
  for (const line of lines.slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 6) continue
    const fsName = f[0]
    const mount = f.slice(5).join(' ')
    if (SKIP_FS.test(fsName) || SKIP_MOUNT.test(mount) || fsName.startsWith('/dev/loop')) continue
    if (seen.has(fsName)) continue
    const total = Number(f[1]) * 1024
    const used = Number(f[2]) * 1024
    const avail = Number(f[3]) * 1024
    if (total < 256 * 1024 * 1024) continue // skip tiny pseudo and boot partitions
    seen.add(fsName)
    disks.push({ fs: fsName, mount, total, used, pct: Math.round((used / (used + avail || total)) * 1000) / 10 })
  }
  return disks.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount)))
}

function build(prev: Raw, cur: Raw): MonitorSample {
  const s = cur.sections
  const dTotal = cur.cpuTotal - prev.cpuTotal
  const dIdle = cur.cpuIdle - prev.cpuIdle
  const cpu = dTotal > 0 ? Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100)) : 0
  const seconds = Math.max(0.2, (cur.ts - prev.ts) / 1000)

  const mem: Record<string, number> = {}
  for (const line of s.mem ?? []) {
    const m = line.match(/^(\w+):\s+(\d+)/)
    if (m) mem[m[1]] = Number(m[2]) * 1024
  }
  const memTotal = mem.MemTotal || 0
  const memAvail = mem.MemAvailable ?? (mem.MemFree || 0) + (mem.Buffers || 0) + (mem.Cached || 0)
  const load = (s.load?.[0] ?? '0 0 0').split(/\s+/).slice(0, 3).map(Number) as [number, number, number]

  const procs: ProcInfo[] = (s.procs ?? []).slice(1).map((line) => {
    const f = line.trim().split(/\s+/)
    return { pid: Number(f[0]), user: f[1] ?? '', cpu: Number(f[2]) || 0, mem: Number(f[3]) || 0, cmd: f.slice(4).join(' ') }
  })

  return {
    ts: cur.ts,
    cpu: Math.round(cpu * 10) / 10,
    cores: Number(s.cores?.[0]) || 1,
    load,
    mem: {
      total: memTotal,
      available: memAvail,
      used: Math.max(0, memTotal - memAvail),
      swapTotal: mem.SwapTotal || 0,
      swapUsed: Math.max(0, (mem.SwapTotal || 0) - (mem.SwapFree || 0))
    },
    disks: parseDisks(s.disk ?? []),
    net: {
      rxRate: Math.max(0, (cur.rx - prev.rx) / seconds),
      txRate: Math.max(0, (cur.tx - prev.tx) / seconds),
      rxTotal: cur.rx,
      txTotal: cur.tx
    },
    uptime: Number((s.uptime?.[0] ?? '0').split(' ')[0]) || 0,
    hostname: s.host?.[0] ?? '',
    kernel: s.host?.[1] ?? '',
    os: s.host?.[2] ?? '',
    cpuModel: (s.cpumodel?.[0] ?? '').trim(),
    ...parseGpus(s),
    procs
  }
}

/** Says why a server that let us sign in still gave no status, using what it answered. */
export function explainNoStats(res: { code: number | null; stdout: string; stderr: string }): string {
  const said = (res.stderr.trim() || res.stdout.trim()).replace(/\s+/g, ' ').slice(0, 240)
  const lead = 'Signed in to the server, but could not read its status. '
  if (!said) {
    return lead + 'The server closed the command without answering. It may be overloaded or still starting, or its SSH service limits commands for this user. Press Try again; if it keeps happening, open the Terminal page to see what the server shows.'
  }
  if (/bash.*(not found|No such file)|not recognized|CommandNotFound/i.test(said)) {
    return lead + `This server has no bash shell, which Apsara Panel needs (Linux with bash; Windows servers are not supported). The server answered: "${said}"`
  }
  if (/not available|nologin|restricted|not allowed|forced|interactive|sftp/i.test(said)) {
    return lead + `This SSH user is not allowed to run commands (no normal shell, or a restricted or forced command). Use a user with a normal bash login, such as root or a sudo user. The server answered: "${said}"`
  }
  return lead + `The server did not run the status command. It may not be a Linux server, or this user has a restricted shell. The server answered: "${said}"`
}

/**
 * The status command came back empty. Ask the server two very small questions
 * so the message can say where it stops, instead of guessing.
 */
async function diagnoseSilence(client: Client): Promise<string> {
  const lead = 'Signed in to the server, but could not read its status. '
  const show = (r: { code: number | null; stdout: string; stderr: string; signal?: string }): string => {
    const said = (r.stderr.trim() || r.stdout.trim()).replace(/\s+/g, ' ').slice(0, 200)
    return `exit code ${r.code ?? 'none'}${r.signal ? `, signal ${r.signal}` : ''}, ${said ? `answer "${said}"` : 'no answer'}`
  }
  let plain
  try {
    plain = await exec(client, 'echo sd-probe-ok', { timeoutMs: 10000 })
  } catch (err) {
    return lead + `Even the simplest command failed: ${err instanceof Error ? err.message : String(err)}`
  }
  if (!plain.stdout.includes('sd-probe-ok')) {
    return (
      lead +
      `This SSH user cannot run commands: even "echo" came back with ${show(plain)}. On Ubuntu the usual causes are: ` +
      '(1) the user is limited to file transfer (ForceCommand internal-sftp in /etc/ssh/sshd_config), ' +
      '(2) the user\'s shell is /bin/false or /usr/sbin/nologin (see /etc/passwd), ' +
      '(3) the key\'s line in ~/.ssh/authorized_keys starts with command="...", ' +
      '(4) ~/.bashrc or ~/.profile starts another program (tmux, screen, exec zsh) or exits. ' +
      'Check from your computer: ssh -i YOUR_KEY USER@HOST "echo ok" must print ok.'
    )
  }
  let viaBash
  try {
    viaBash = await exec(client, `bash -c 'echo sd-bash-ok; command -v base64 head df ps'`, { timeoutMs: 10000 })
  } catch (err) {
    return lead + `Simple commands work, but bash could not be started: ${err instanceof Error ? err.message : String(err)}`
  }
  if (!viaBash.stdout.includes('sd-bash-ok')) {
    return lead + `Simple commands work, but bash does not run for this user (${show(viaBash)}). Apsara Panel needs bash; on Ubuntu: apt install bash, or check that the user may run /bin/bash.`
  }
  if (!/base64/.test(viaBash.stdout)) {
    return lead + 'The server has no "base64" program, which Apsara Panel uses to send its commands. On Ubuntu: apt install coreutils.'
  }
  // Simple things work. Try the status command each way and say what each did.
  const mode = await transportOf(client)
  const ways: [string, () => Promise<{ code: number | null; stdout: string; stderr: string; signal?: string }>][] = [
    ['plain', () => exec(client, plainForm(wrapScript(SCRIPT)), { timeoutMs: 15000 })],
    ['typed in', () => exec(client, 'bash -s', { stdin: SCRIPT, timeoutMs: 15000 })],
    ['first line only', () => exec(client, `bash -c 'echo @@cpu; head -1 /proc/stat'`, { timeoutMs: 10000 })]
  ]
  const facts: string[] = [`way of sending in use: ${mode}`]
  for (const [name, run] of ways) {
    try {
      const r = await run()
      facts.push(`${name}: ${r.stdout.includes('@@cpu') ? `works (${r.stdout.length} characters)` : show(r)}`)
    } catch (err) {
      facts.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return lead + `Simple commands and bash work, but the status command came back empty. Please send this message: ${facts.join('; ')}.`
}

/** Connections where the script has to be typed into bash instead of sent as a command. */
const typedIn = new WeakSet<Client>()

async function readRaw(client: Client): Promise<Raw> {
  const typed = (): ReturnType<typeof exec> => exec(client, 'bash -s', { stdin: SCRIPT, timeoutMs: 15000 })
  let res = typedIn.has(client) ? await typed() : await exec(client, wrapScript(SCRIPT), { timeoutMs: 15000 })
  if (res.stdout.includes('@@cpu')) return toRaw(res.stdout)
  if (res.stdout.trim() || res.stderr.trim()) throw new Error(explainNoStats(res))
  // Empty answer. A busy server can drop a command, so wait and ask in the other way.
  await new Promise((r) => setTimeout(r, 800))
  res = await typed()
  if (res.stdout.includes('@@cpu')) {
    typedIn.add(client)
    return toRaw(res.stdout)
  }
  throw new Error(await diagnoseSilence(client))
}

/** Take one sample. CPU and network rates are computed against the previous sample. */
export async function sample(key: string, client: Client): Promise<MonitorSample> {
  let prev = previous.get(key)
  if (!prev || Date.now() - prev.ts > 60000) {
    prev = await readRaw(client)
    await new Promise((r) => setTimeout(r, 600))
  }
  const cur = await readRaw(client)
  previous.set(key, cur)
  return build(prev, cur)
}

export function forget(key: string): void {
  previous.delete(key)
}

const num = (v: string | undefined): number | undefined => {
  const n = Number(String(v ?? '').trim())
  return v !== undefined && String(v).trim() !== '' && Number.isFinite(n) ? n : undefined
}

/** Graphics cards: NVIDIA through nvidia-smi, AMD through the kernel's own files. Absent on servers without one. */
export function parseGpus(s: Record<string, string[]>): { gpus?: GpuInfo[]; gpuProcs?: GpuProc[] } {
  const gpus: GpuInfo[] = []
  for (const line of [...(s.gpu ?? []), ...(s.gpu2 ?? [])]) {
    const f = line.split(',').map((x) => x.trim())
    if (f[0] === 'nvidia' && f.length >= 6) {
      // MiB from nvidia-smi; "[N/A]" or "[Not Supported]" become missing values.
      const memUsed = num(f[4])
      const memTotal = num(f[5])
      gpus.push({ index: num(f[1]) ?? gpus.length, vendor: 'nvidia', name: f[2] || 'NVIDIA GPU', util: num(f[3]) ?? 0, memUsed: (memUsed ?? 0) * 1048576, memTotal: (memTotal ?? 0) * 1048576, temp: num(f[6]), power: num(f[7]), powerLimit: num(f[8]), fan: num(f[9]) })
    } else if (f[0] === 'amd' && f.length >= 6) {
      const temp = num(f[6])
      gpus.push({ index: gpus.length, vendor: 'amd', name: f[2] || 'AMD GPU', util: num(f[3]) ?? 0, memUsed: num(f[4]) ?? 0, memTotal: num(f[5]) ?? 0, temp: temp !== undefined ? Math.round(temp / 1000) : undefined })
    }
  }
  if (!gpus.length) return {}
  const ids = new Map<string, number>()
  for (const line of s.gpuids ?? []) {
    const [i, uuid] = line.split(',').map((x) => x.trim())
    if (uuid) ids.set(uuid, Number(i))
  }
  const gpuProcs: GpuProc[] = []
  for (const line of s.gpuprocs ?? []) {
    const f = line.split(',').map((x) => x.trim())
    const pid = num(f[1])
    if (pid === undefined) continue
    gpuProcs.push({ gpu: ids.get(f[0]) ?? 0, pid, name: (f[2] ?? '').split('/').pop() || f[2] || '', mem: (num(f[3]) ?? 0) * 1048576 })
  }
  return { gpus, gpuProcs }
}
