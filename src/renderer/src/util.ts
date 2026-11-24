export function bytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : digits)} ${units[i]}`
}

export function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function ago(ts?: number): string {
  if (!ts) return 'Never'
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return 'Just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(ts).toLocaleDateString()
}

export function levelColor(pct: number): string {
  if (pct >= 85) return '#f04a4a'
  if (pct >= 65) return '#f59a23'
  return '#19b36b'
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const SERVER_COLORS = ['#2f6bff', '#19b36b', '#f59a23', '#8b5cf6', '#ef5da8', '#14b8c4']

/**
 * A picture's address for use in CSS. Always quoted: an installed app loads its pictures by their full
 * path on the computer, and a path with a bracket, a quote or a space breaks an unquoted url().
 */
export function cssUrl(address: string): string {
  return `url("${address.replace(/\\/g, '%5C').replace(/"/g, '%22').replace(/\n/g, '')}")`
}
