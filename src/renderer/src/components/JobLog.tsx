import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Badge, Button, Drawer, Empty, Popover, Space, Tag, Tooltip } from 'antd'
import { CheckCircleFilled, CloseCircleFilled, LoadingOutlined, UnorderedListOutlined } from '@ant-design/icons'
import { LABELS } from '../pages/Audit'
import { errText } from '../util'

// ---------------------------------------------------------------- every task this window has seen
// Kept outside any page, so a log that was closed (or whose page was left) can be opened again from "Tasks".

export interface Task {
  id: string
  title: string
  project?: string
  text: string
  state: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
}

const KEEP = 25
const MAX_TEXT = 400 * 1024
let tasks: Task[] = []
const titles = new Map<string, string>()
const watchers = new Set<() => void>()
let wired = false

// ---- kept on this computer, so the list is still there after the app is closed and opened again.
// Stored per signed-in person: someone else signing in on the same computer starts with an empty list.
const STORE_TEXT = 60 * 1024
let owner = ''
let saveTimer: ReturnType<typeof setTimeout> | undefined

function saveSoon(): void {
  if (!owner) return
  const who = owner
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const slim = tasks.map((t) => ({ ...t, text: t.text.length > STORE_TEXT ? '[earlier output left out]\n' + t.text.slice(-STORE_TEXT) : t.text }))
    // Not being able to write is not worth an error: the list simply is not kept this time.
    void window.api.tasks.save(who, slim).catch(() => undefined)
  }, 400)
}

/** Call when someone is signed in (or out, with ''). Loads that person's earlier tasks. */
export function setTaskOwner(next: string): void {
  if (next === owner) return
  owner = next
  if (!next) {
    tasks = []
    for (const w of watchers) w()
    return
  }
  void window.api.tasks
    .load(next)
    .then((raw) => {
      if (owner !== next) return
      const kept = (raw as Task[])
        .filter((t) => t && typeof t.id === 'string' && typeof t.text === 'string' && typeof t.title === 'string')
        .map((t) =>
          // A task that was still running when the app closed can no longer be followed from here.
          t.state === 'running' ? { ...t, state: 'failed' as const, endedAt: t.endedAt ?? Date.now(), text: t.text + '\n[The app was closed while this was running, so its end was not seen. It may have finished on the server.]\n' } : t
        )
      // Tasks already seen in this window stay in front of the loaded ones.
      tasks = [...tasks, ...kept.filter((k) => !tasks.some((t) => t.id === k.id))].slice(0, KEEP)
      for (const w of watchers) w()
    })
    .catch(() => undefined)
}

function changed(next: Task[]): void {
  tasks = next
  for (const w of watchers) w()
  saveSoon()
}

function put(id: string, patch: (t: Task | undefined) => Task): void {
  const old = tasks.find((t) => t.id === id)
  const fresh = patch(old)
  changed(old ? tasks.map((t) => (t.id === id ? fresh : t)) : [fresh, ...tasks].slice(0, KEEP))
}

function wire(): void {
  if (wired) return
  wired = true
  window.api.sites.onLog(({ jobId, chunk }) => {
    put(jobId, (t) => {
      const text = (t?.text ?? '') + chunk
      // Very long logs keep their end, which is the part that says how it went.
      return { ...(t ?? { id: jobId, title: titles.get(jobId) ?? 'Task', state: 'running', startedAt: Date.now() }), text: text.length > MAX_TEXT ? '[earlier output left out]\n' + text.slice(-MAX_TEXT) : text }
    })
  })
  window.api.sites.onJobState((p) => {
    if (p.state === 'running') {
      const title = titles.get(p.jobId) ?? `${LABELS[p.method ?? ''] ?? p.method ?? 'Task'}${p.target ? ` · ${p.target}` : ''}`
      // The same id starting again is a new run: its log starts empty.
      changed([{ id: p.jobId, title, project: p.project, text: '', state: 'running' as const, startedAt: Date.now() }, ...tasks.filter((t) => t.id !== p.jobId)].slice(0, KEEP))
    } else {
      put(p.jobId, (t) => ({ ...(t ?? { id: p.jobId, title: titles.get(p.jobId) ?? 'Task', text: '', startedAt: Date.now() }), state: p.state, endedAt: Date.now() }))
    }
  })
}

function subscribe(cb: () => void): () => void {
  wire()
  watchers.add(cb)
  return () => watchers.delete(cb)
}

function useTasks(): Task[] {
  return useSyncExternalStore(subscribe, () => tasks)
}

export interface Job {
  text: string
  state: 'idle' | 'running' | 'done' | 'failed'
  title: string
  open: boolean
  setOpen: (v: boolean) => void
  /** Run a server task and show its live output. Resolves true on success. */
  run: (title: string, fn: () => Promise<unknown>) => Promise<boolean>
}

/** Follows one task. Its output and state survive closing the drawer and leaving the page. */
export function useJob(jobId: string): Job {
  const all = useTasks()
  const task = all.find((t) => t.id === jobId)
  const [open, setOpen] = useState(false)

  const run = useCallback(
    async (jobTitle: string, fn: () => Promise<unknown>): Promise<boolean> => {
      setOpen(true)
      return runTask(jobId, jobTitle, fn)
    },
    [jobId]
  )

  return { text: task?.text ?? '', state: task?.state ?? 'idle', title: task?.title ?? '', open, setOpen, run }
}

/** Run a server task under a task id chosen at the moment (useJob follows one fixed id). Resolves true on success. */
export async function runTask(jobId: string, jobTitle: string, fn: () => Promise<unknown>): Promise<boolean> {
  // Already going: leave it running instead of starting it twice.
  if (tasks.find((t) => t.id === jobId)?.state === 'running') return false
  titles.set(jobId, jobTitle)
  put(jobId, () => ({ id: jobId, title: jobTitle, text: '', state: 'running', startedAt: Date.now() }))
  try {
    await fn()
    put(jobId, (t) => ({ ...(t as Task), state: 'done', endedAt: t?.endedAt ?? Date.now() }))
    return true
  } catch (err) {
    // Errors raised before any output would otherwise leave the log empty.
    put(jobId, (t) => ({ ...(t as Task), text: t?.text || `[failed] ${errText(err)}\n`, state: 'failed', endedAt: t?.endedAt ?? Date.now() }))
    return false
  }
}

function StateTag({ state }: { state: Job['state'] }) {
  return state === 'running' ? <Tag color="processing">Running</Tag> : state === 'failed' ? <Tag color="red">Failed</Tag> : <Tag color="green">Done</Tag>
}

function LogDrawer({ open, title, state, text, note, onClose }: { open: boolean; title: string; state: Job['state']; text: string; note?: string; onClose: () => void }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: 'end' })
  }, [text, open])
  return (
    <Drawer
      open={open}
      width={640}
      onClose={onClose}
      styles={{ body: { padding: 16 } }}
      title={
        <Space>
          {title}
          <StateTag state={state} />
        </Space>
      }
    >
      {note && <p className="task-note">{note}</p>}
      <pre className="log-box">
        {text || 'Starting…'}
        <div ref={end} />
      </pre>
    </Drawer>
  )
}

export function JobDrawer({ job }: { job: Job }) {
  return <LogDrawer open={job.open} title={job.title} state={job.state} text={job.text} note={job.state === 'running' ? 'You can close this. The task keeps running; open it again from Tasks at the top of the window.' : undefined} onClose={() => job.setOpen(false)} />
}

function when(t: Task, now: number): string {
  const s = Math.max(0, Math.round(((t.endedAt ?? now) - t.startedAt) / 1000))
  const took = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
  return t.state === 'running' ? `running for ${took}` : `took ${took}`
}

/** "Tasks" in the top bar: what is running and what just finished, each with its log one click away. */
export function TasksButton() {
  const all = useTasks()
  const [listOpen, setListOpen] = useState(false)
  const [showing, setShowing] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const running = all.filter((t) => t.state === 'running').length
  const shown = all.find((t) => t.id === showing)

  useEffect(() => {
    if (!listOpen && !running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [listOpen, running])

  const list = (
    <div className="task-list">
      {all.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No tasks yet. Deploys, installs, copies and backups show up here." />}
      {all.map((t) => (
        <button key={t.id} type="button" className="task-row" onClick={() => { setShowing(t.id); setListOpen(false) }}>
          <span className={`task-icon ${t.state}`}>{t.state === 'running' ? <LoadingOutlined /> : t.state === 'failed' ? <CloseCircleFilled /> : <CheckCircleFilled />}</span>
          <span className="task-text">
            <b>{t.title}</b>
            <small>
              {t.project ? `${t.project} · ` : ''}
              {when(t, now)}
            </small>
          </span>
          <StateTag state={t.state} />
        </button>
      ))}
      {all.some((t) => t.state !== 'running') && (
        <Button size="small" type="text" onClick={() => changed(tasks.filter((t) => t.state === 'running'))}>
          Clear finished
        </Button>
      )}
    </div>
  )

  return (
    <>
      <Popover open={listOpen} onOpenChange={setListOpen} trigger="click" placement="bottomRight" title="Tasks" content={list}>
        <Tooltip title={running ? `${running} task${running === 1 ? '' : 's'} running` : 'Tasks'}>
          <Badge count={running} size="small" offset={[-4, 6]}>
            <Button type="text" icon={running ? <LoadingOutlined /> : <UnorderedListOutlined />} aria-label={`Tasks${running ? `, ${running} running` : ''}`}>
              {running ? 'Tasks' : null}
            </Button>
          </Badge>
        </Tooltip>
      </Popover>
      <LogDrawer open={!!shown} title={shown?.title ?? ''} state={shown?.state ?? 'idle'} text={shown?.text ?? ''} onClose={() => setShowing(null)} />
    </>
  )
}
