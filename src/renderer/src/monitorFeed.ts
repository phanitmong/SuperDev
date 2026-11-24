// Live monitor samples per server, shared by the Overview page and the dashboard.
// Sampling goes on (more slowly) while nobody is looking, so charts are still
// there when you come back.
import { useEffect, useState } from 'react'
import type { MonitorSample } from '@shared/types'
import { errText } from './util'

const INTERVAL = 3000
/** Slower sampling while another page is open, so the charts are still there when you come back. */
const BACKGROUND_INTERVAL = 10000
export const KEEP = 200

export interface Feed {
  history: MonitorSample[]
  error: string | null
  running: boolean
  watchers: Set<() => void>
  timer?: ReturnType<typeof setTimeout>
}

/** Samples per server, kept for as long as the app stays signed in and connected. */
const feeds = new Map<string, Feed>()

// A different person may sign in next: start clean.
window.api.session.onChange((state) => {
  if (state.user) return
  for (const f of feeds.values()) if (f.timer) clearTimeout(f.timer)
  feeds.clear()
})

function feedOf(id: string): Feed {
  let f = feeds.get(id)
  if (!f) {
    f = { history: [], error: null, running: false, watchers: new Set() }
    feeds.set(id, f)
  }
  return f
}

function startFeed(id: string): void {
  const f = feedOf(id)
  if (f.running) return
  f.running = true
  f.error = null
  let first = true
  const tick = async (): Promise<void> => {
    try {
      // Only the first sample may open the connection; later ones stop when it is closed.
      const sample = await window.api.monitor.sample(id, first)
      first = false
      f.history = [...f.history.slice(-(KEEP - 1)), sample]
      f.timer = setTimeout(tick, f.watchers.size > 0 ? INTERVAL : BACKGROUND_INTERVAL)
    } catch (err) {
      // Stop on failure so a wrong password is not retried in a loop.
      f.running = false
      f.error = errText(err)
    }
    f.watchers.forEach((w) => w())
  }
  void tick()
}


/** Follow one server's samples. Changing `attempt` retries after an error. */
export function useFeed(id: string, attempt = 0): Feed {
  const [, redraw] = useState(0)
  useEffect(() => {
    const f = feedOf(id)
    const watch = (): void => redraw((n) => n + 1)
    f.watchers.add(watch)
    if (!f.running) startFeed(id)
    else if (f.timer) {
      // Coming back to the page: take a fresh sample now instead of waiting for the slow timer.
      clearTimeout(f.timer)
      f.running = false
      startFeed(id)
    }
    return () => {
      f.watchers.delete(watch)
    }
  }, [id, attempt])
  return feedOf(id)
}
