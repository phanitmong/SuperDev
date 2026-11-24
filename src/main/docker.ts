// Docker on the server: install it, see and control containers, run a new one,
// manage images, and bring Compose projects up and down.
// Every docker command runs as root, so the sign-in user does not have to be in the docker group.
import type { Client } from 'ssh2'
import type { DockerOverview, DockerRunInput } from '@shared/types'
import type { Sudo } from './deploy'
import { PATH_EXPORT, runPrivileged } from './deploy'
import { exec, shq, writeRemoteTemp } from './ssh'

const HEAD = `export LC_ALL=C
${PATH_EXPORT}`

const RE_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const RE_IMAGE = /^[a-z0-9]([A-Za-z0-9._/:@-]{0,198}[A-Za-z0-9])?$/
const RE_PATH = /^\/[^\0\n\r:,]{0,400}$/

function ref(value: string, what = 'container'): string {
  if (typeof value !== 'string' || !RE_REF.test(value)) throw new Error(`That is not a ${what} this page listed.`)
  return value
}

function folder(dir: string): string {
  const d = String(dir ?? '').trim().replace(/\/+$/, '')
  if (!RE_PATH.test(d) || d.split('/').includes('..')) throw new Error('Choose the folder that holds the compose file, for example /www/wwwroot/shop.')
  return d
}

function lines<T>(text: string | undefined): T[] {
  const out: T[] = []
  for (const line of (text ?? '').split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{') && !t.startsWith('[')) continue
    try {
      const v = JSON.parse(t)
      if (Array.isArray(v)) out.push(...(v as T[]))
      else out.push(v as T)
    } catch {
      /* a line docker cut short; skip it */
    }
  }
  return out
}

export async function overview(client: Client, sudo: Sudo): Promise<DockerOverview> {
  const script = `${HEAD}
PM=""; for p in apt-get dnf yum; do if command -v "$p" >/dev/null 2>&1; then PM="$p"; break; fi; done
echo "@@pm=$PM"
if ! command -v docker >/dev/null 2>&1; then echo "@@installed=0"; exit 0; fi
echo "@@installed=1"
echo "@@version=$(docker --version 2>/dev/null | sed -n 's/^Docker version \\([^, ]*\\).*/\\1/p')"
echo "@@compose=$(docker compose version --short 2>/dev/null | head -1)"
if ! docker info >/dev/null 2>&1; then echo "@@running=0"; exit 0; fi
echo "@@running=1"
echo "@@section containers"
docker ps -a --no-trunc --format '{{json .}}' 2>/dev/null
echo "@@section stats"
timeout 20 docker stats --no-stream --format '{{json .}}' 2>/dev/null
echo "@@section images"
docker images --format '{{json .}}' 2>/dev/null
echo "@@section used"
docker ps -a --format '{{.Image}}' 2>/dev/null | sort -u
echo "@@section projects"
docker compose ls --all --format json 2>/dev/null
echo
echo "@@section disk"
docker system df --format '{{.Type}}|{{.Size}}|{{.Reclaimable}}' 2>/dev/null
echo "@@section end"`
  const res = await runPrivileged(client, script, sudo, undefined, 90000)
  const kv: Record<string, string> = {}
  const sec: Record<string, string> = {}
  let cur = ''
  for (const line of res.stdout.split('\n')) {
    const m = /^@@(\w+)=(.*)$/.exec(line)
    if (m) kv[m[1]] = m[2].trim()
    else if (line.startsWith('@@section ')) { cur = line.slice(10).trim(); sec[cur] = '' } // prettier-ignore
    else if (cur) sec[cur] += line + '\n'
  }
  const base: DockerOverview = { installed: kv.installed === '1', running: kv.running === '1', version: kv.version ?? '', compose: kv.compose ?? '', packageManager: kv.pm ?? '', containers: [], images: [], projects: [], disk: [] }
  if (!base.installed || !base.running) return base

  type Ps = { ID: string; Names: string; Image: string; State: string; Status: string; Ports: string; CreatedAt: string; Labels?: string }
  type St = { ID: string; Container: string; CPUPerc: string; MemUsage: string }
  const stats = new Map(lines<St>(sec.stats).map((s) => [s.ID.slice(0, 12), s]))
  base.containers = lines<Ps>(sec.containers)
    .map((c) => {
      const st = stats.get(c.ID.slice(0, 12))
      const project = /(?:^|,)com\.docker\.compose\.project=([^,]*)/.exec(c.Labels ?? '')?.[1]
      return { id: c.ID.slice(0, 12), name: c.Names, image: c.Image, state: c.State, status: c.Status, ports: c.Ports, created: c.CreatedAt.replace(/ [+-]\d{4}.*$/, ''), cpu: st?.CPUPerc, memory: st?.MemUsage?.split(' / ')[0], project }
    })
    .sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || a.name.localeCompare(b.name))

  const used = new Set((sec.used ?? '').split('\n').map((x) => x.trim()).filter(Boolean))
  type Im = { ID: string; Repository: string; Tag: string; Size: string; CreatedSince: string }
  base.images = lines<Im>(sec.images).map((i) => {
    const name = i.Repository === '<none>' ? '' : `${i.Repository}${i.Tag && i.Tag !== '<none>' ? `:${i.Tag}` : ''}`
    const id = i.ID.replace(/^sha256:/, '').slice(0, 12)
    return { id, name, size: i.Size, created: i.CreatedSince, used: used.has(name) || used.has(i.Repository) || used.has(id) || [...used].some((u) => u.startsWith(id)) }
  })
  type Pr = { Name: string; Status: string; ConfigFiles: string }
  base.projects = lines<Pr>(sec.projects).map((p) => ({ name: p.Name, status: p.Status, files: p.ConfigFiles }))
  base.disk = (sec.disk ?? '')
    .split('\n')
    .map((l) => l.trim().split('|'))
    .filter((p) => p.length === 3)
    .map(([type, size, reclaimable]) => ({ type, size, reclaimable }))
  return base
}

export async function install(client: Client, sudo: Sudo, log: (s: string) => void): Promise<void> {
  const script = `${HEAD}
if command -v docker >/dev/null 2>&1; then echo "==> Docker is already installed: $(docker --version)"
elif command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  echo "==> Installing Docker from the system's packages"
  apt-get update -y || echo "Some package lists could not be refreshed; trying with what is there."
  apt-get install -y docker.io || { echo "The docker.io package could not be installed."; exit 71; }
  # Compose is a separate package whose name differs between releases.
  apt-get install -y docker-compose-v2 2>/dev/null || apt-get install -y docker-compose-plugin 2>/dev/null || echo "Compose is not in this system's packages; containers work without it."
elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
  P=$(command -v dnf || command -v yum)
  echo "==> Installing Docker from Docker's own package repository"
  . /etc/os-release 2>/dev/null
  case "$ID" in fedora) D=fedora ;; rhel) D=rhel ;; *) D=centos ;; esac
  "$P" -y install dnf-plugins-core 2>/dev/null || "$P" -y install yum-utils 2>/dev/null
  if command -v dnf >/dev/null 2>&1 && dnf config-manager --help 2>&1 | grep -q addrepo; then dnf config-manager addrepo --from-repofile "https://download.docker.com/linux/$D/docker-ce.repo"
  elif command -v dnf >/dev/null 2>&1; then dnf config-manager --add-repo "https://download.docker.com/linux/$D/docker-ce.repo"
  else yum-config-manager --add-repo "https://download.docker.com/linux/$D/docker-ce.repo"; fi
  "$P" -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin || { echo "Docker could not be installed from download.docker.com."; exit 71; }
else
  echo "This server has no package manager this app knows (apt, dnf, yum)."; exit 72
fi
echo "==> Starting Docker and making it start with the server"
if [ -d /run/systemd/system ]; then systemctl enable --now docker || { systemctl status docker --no-pager -n 15 2>&1; exit 73; }
else service docker start 2>&1 || true; fi
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || { echo "Docker was installed but its service is not answering. Look at: journalctl -u docker -n 50"; exit 73; }
echo "==> $(docker --version)"
docker compose version 2>/dev/null || true`
  await runPrivileged(client, script, sudo, log, 20 * 60000)
}

/** Start or stop the Docker service itself. */
export async function service(client: Client, sudo: Sudo, action: 'start' | 'stop' | 'restart', log: (s: string) => void): Promise<void> {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Unknown action.')
  const script = `${HEAD}
echo "==> docker: ${action}"
if [ -d /run/systemd/system ]; then
  ${action === 'stop' ? 'systemctl stop docker.socket 2>/dev/null; ' : ''}systemctl ${action} docker || { systemctl status docker --no-pager -n 15 2>&1; exit 73; }
else service docker ${action} || exit 73; fi
${action === 'stop' ? 'echo "Docker is stopped. Its containers are stopped with it."' : 'for i in 1 2 3 4 5 6 7 8 9 10; do docker info >/dev/null 2>&1 && break; sleep 1; done; docker info >/dev/null 2>&1 && echo "Docker is running." || { echo "Docker did not come up."; exit 73; }'}`
  await runPrivileged(client, script, sudo, log, 120000)
}

export async function containerAction(client: Client, sudo: Sudo, id: string, action: 'start' | 'stop' | 'restart' | 'remove'): Promise<void> {
  ref(id)
  if (!['start', 'stop', 'restart', 'remove'].includes(action)) throw new Error('Unknown action.')
  const cmd = action === 'remove' ? `docker rm -f ${shq(id)}` : `docker ${action} ${shq(id)}`
  await runPrivileged(client, `${HEAD}\nOUT=$(${cmd} 2>&1) || { echo "$OUT" | tail -3; exit 74; }`, sudo, undefined, 120000)
}

/** The last lines a container wrote, newest at the bottom. */
export async function logs(client: Client, sudo: Sudo, id: string, count = 300): Promise<string> {
  ref(id)
  const n = Math.max(10, Math.min(2000, Math.floor(Number(count) || 300)))
  const res = await runPrivileged(client, `${HEAD}\ndocker logs --tail ${n} --timestamps ${shq(id)} 2>&1 | tail -c 400000`, sudo, undefined, 60000)
  return res.stdout
}

/** Split a command the way a shell would split plain words and quotes, so each word can be passed on safely quoted. */
function words(text: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3]))
  return out
}

interface CleanRun {
  image: string
  name: string
  ports: string[]
  volumes: string[]
  env: string[]
  restart: string
  command: string
}

function cleanRun(o: DockerRunInput): CleanRun {
  const image = String(o.image ?? '').trim()
  if (!RE_IMAGE.test(image)) throw new Error('Enter the image, for example nginx:alpine or ghcr.io/owner/app:1.2.')
  const name = String(o.name ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name)) throw new Error('Name the container with letters, numbers, dots, dashes or underscores.')
  const ports: string[] = []
  const seen = new Set<number>()
  for (const p of o.ports ?? []) {
    const host = Number(p.host)
    const inside = Number(p.container)
    if (!(Number.isInteger(host) && host >= 1 && host <= 65535 && Number.isInteger(inside) && inside >= 1 && inside <= 65535)) throw new Error('Ports are numbers from 1 to 65535.')
    if (seen.has(host)) throw new Error(`Port ${host} on the server is listed twice.`)
    seen.add(host)
    // Docker opens published ports past the server's firewall, so "this server only" is the default.
    ports.push(`${p.public === true ? '' : '127.0.0.1:'}${host}:${inside}`)
  }
  const volumes: string[] = []
  for (const v of o.volumes ?? []) {
    const host = String(v.host ?? '').trim()
    const inside = String(v.container ?? '').trim()
    // Left side: a folder on the server, or the name of a Docker volume.
    if (!(RE_PATH.test(host) && !host.split('/').includes('..')) && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(host)) throw new Error(`"${host}" is neither a folder path on the server nor a volume name.`)
    if (!RE_PATH.test(inside)) throw new Error(`"${inside}" is not a path inside the container. Example: /var/lib/data`)
    if (['/', '/etc', '/root', '/var/run/docker.sock', '/run/docker.sock'].includes(host)) throw new Error(`${host} gives the container control over the whole server. It is not offered here; use the terminal if you really need it.`)
    volumes.push(`${host}:${inside}`)
  }
  const env: string[] = []
  for (const e of o.env ?? []) {
    const key = String(e.key ?? '').trim()
    if (!key && !e.value) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(key)) throw new Error(`"${key}" is not a variable name. Use letters, numbers and underscores.`)
    const value = String(e.value ?? '')
    if (/[\n\r\0]/.test(value) || value.length > 4000) throw new Error(`The value of ${key} must be one line.`)
    env.push(`${key}=${value}`)
  }
  const restart = o.restart ?? 'unless-stopped'
  if (!['no', 'always', 'unless-stopped', 'on-failure'].includes(restart)) throw new Error('Unknown restart choice.')
  const command = String(o.command ?? '').trim()
  if (/[\n\r\0]/.test(command) || command.length > 1000) throw new Error('The command must be one line.')
  return { image, name, ports, volumes, env, restart, command }
}

/** Pull the image and start a new container from it. Variable values travel in a file, never on a command line. */
export async function run(client: Client, sudo: Sudo, input: DockerRunInput, log: (s: string) => void): Promise<void> {
  const o = cleanRun(input)
  const envFile = o.env.length ? await writeRemoteTemp(client, o.env.join('\n') + '\n') : ''
  const args = [`--name ${shq(o.name)}`, `--restart ${shq(o.restart)}`, ...o.ports.map((p) => `-p ${shq(p)}`), ...o.volumes.map((v) => `-v ${shq(v)}`)]
  const script = `${HEAD}
tidy() { ${envFile ? `[ -e ${shq(envFile)} ] && unlink ${shq(envFile)}` : ':'}; }
docker info >/dev/null 2>&1 || { tidy; echo "Docker is not running on this server."; exit 73; }
if docker inspect ${shq(o.name)} >/dev/null 2>&1; then tidy; echo "A container named ${o.name} already exists. Remove it first or choose another name."; exit 75; fi
echo "==> Fetching ${o.image}"
docker pull ${shq(o.image)} || { docker image inspect ${shq(o.image)} >/dev/null 2>&1 && echo "Could not fetch a newer copy; using the image already on this server." || { tidy; echo "The image could not be fetched. Check its name, and sign in to its registry in the terminal if it is private."; exit 76; }; }
echo "==> Starting ${o.name}"
ID=$(docker run -d ${args.join(' ')}${envFile ? ` --env-file ${shq(envFile)}` : ''} ${shq(o.image)}${o.command ? ' ' + words(o.command).map(shq).join(' ') : ''} 2>&1) || { tidy; echo "$ID"; docker rm -f ${shq(o.name)} >/dev/null 2>&1; echo "The container could not be started, so it was not kept."; exit 77; }
tidy
sleep 2
STATE=$(docker inspect -f '{{.State.Status}}' ${shq(o.name)} 2>/dev/null)
if [ "$STATE" != running ]; then
  echo "The container started and stopped again ($STATE). Its last output:"
  docker logs --tail 30 ${shq(o.name)} 2>&1
  exit 78
fi
echo "==> ${o.name} is running."
docker ps --filter name=^${o.name}$ --format 'Ports: {{.Ports}}'`
  try {
    await runPrivileged(client, script, sudo, log, 30 * 60000)
  } finally {
    if (envFile) await exec(client, `[ -e ${shq(envFile)} ] && unlink ${shq(envFile)}; true`, { timeoutMs: 10000 }).catch(() => undefined)
  }
}

export async function pull(client: Client, sudo: Sudo, image: string, log: (s: string) => void): Promise<void> {
  const name = String(image ?? '').trim()
  if (!RE_IMAGE.test(name)) throw new Error('Enter the image, for example nginx:alpine.')
  await runPrivileged(client, `${HEAD}\necho "==> Fetching ${name}"\ndocker pull ${shq(name)} || { echo "The image could not be fetched."; exit 76; }`, sudo, log, 30 * 60000)
}

export async function removeImage(client: Client, sudo: Sudo, id: string): Promise<void> {
  ref(id, 'image')
  await runPrivileged(client, `${HEAD}\nOUT=$(docker rmi ${shq(id)} 2>&1) || { case "$OUT" in *"being used"*|*"is using"*) echo "A container still uses this image. Remove the container first.";; *) echo "$OUT" | tail -2;; esac; exit 79; }`, sudo, undefined, 120000)
}

/** Remove what nothing uses: stopped containers are kept; images no container uses, and build leftovers, go. */
export async function prune(client: Client, sudo: Sudo, log: (s: string) => void): Promise<void> {
  await runPrivileged(client, `${HEAD}\necho "==> Removing images that no container uses"\ndocker image prune -af 2>&1 | tail -3\necho "==> Removing build leftovers"\ndocker builder prune -f 2>&1 | tail -1\necho\ndocker system df`, sudo, log, 10 * 60000)
}

// ---- Compose -----------------------------------------------------------------
const FIND = `F=""; for n in compose.yaml compose.yml docker-compose.yml docker-compose.yaml; do [ -f "$DIR/$n" ] && { F="$DIR/$n"; break; }; done
[ -n "$F" ] || { echo "There is no compose.yaml or docker-compose.yml in $DIR."; exit 81; }
docker compose version >/dev/null 2>&1 || { echo "Compose is not installed on this server. Press Install on the Docker page again to add it."; exit 82; }`

export async function composeUp(client: Client, sudo: Sudo, dir: string, log: (s: string) => void): Promise<void> {
  const d = folder(dir)
  const script = `${HEAD}
DIR=${shq(d)}
${FIND}
cd "$DIR" || exit 81
echo "==> Checking $F"
docker compose -f "$F" config -q || { echo "The compose file has a mistake (above). Nothing was changed."; exit 83; }
echo "==> Fetching images"
docker compose -f "$F" pull --ignore-buildable 2>&1 || docker compose -f "$F" pull 2>&1 || echo "Some images could not be fetched; continuing with what is on the server."
echo "==> Starting"
docker compose -f "$F" up -d --build --remove-orphans || { echo "The project could not be started."; exit 84; }
sleep 2
docker compose -f "$F" ps`
  await runPrivileged(client, script, sudo, log, 60 * 60000)
}

/** Stop and remove the project's containers and networks. Volumes (the data) are kept. */
export async function composeDown(client: Client, sudo: Sudo, dir: string, log: (s: string) => void): Promise<void> {
  const d = folder(dir)
  await runPrivileged(client, `${HEAD}\nDIR=${shq(d)}\n${FIND}\ncd "$DIR" || exit 81\necho "==> Stopping the project in $DIR"\ndocker compose -f "$F" down || exit 84\necho "Stopped. Named volumes were kept."`, sudo, log, 10 * 60000)
}
