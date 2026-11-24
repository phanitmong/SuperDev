import type { GroupMember, GroupRole, ServerGroup } from '@shared/types'

/** What each role is called and its colour, in the order servers are listed inside a project. */
export const ROLES: { key: GroupRole; label: string; color: string }[] = [
  { key: 'lb', label: 'Load balancer', color: 'magenta' },
  { key: 'frontend', label: 'Frontend', color: 'blue' },
  { key: 'api', label: 'API', color: 'geekblue' },
  { key: 'worker', label: 'Worker', color: 'purple' },
  { key: 'database', label: 'Database', color: 'gold' },
  { key: 'cache', label: 'Cache', color: 'orange' },
  { key: 'storage', label: 'Storage', color: 'cyan' },
  { key: 'other', label: 'Other', color: 'default' }
]
export const ROLE_OF: Record<GroupRole, { label: string; color: string }> = Object.fromEntries(ROLES.map((r) => [r.key, r])) as unknown as Record<GroupRole, { label: string; color: string }>
const ORDER: Record<string, number> = Object.fromEntries(ROLES.map((r, i) => [r.key, i]))

export function roleText(m: GroupMember): string {
  return m.label ? `${ROLE_OF[m.role].label} · ${m.label}` : ROLE_OF[m.role].label
}

/** Members in role order (load balancer first, storage last), then by label. */
export function sortMembers(members: GroupMember[]): GroupMember[] {
  return [...members].sort((a, b) => ORDER[a.role] - ORDER[b.role] || (a.label ?? '').localeCompare(b.label ?? '', undefined, { numeric: true }))
}

/** Each server's place in projects, for showing it beside the server's name. */
export function placesOf(groups: ServerGroup[]): Map<string, { group: ServerGroup; member: GroupMember }[]> {
  const out = new Map<string, { group: ServerGroup; member: GroupMember }[]>()
  for (const g of groups) for (const m of g.members) out.set(m.projectId, [...(out.get(m.projectId) ?? []), { group: g, member: m }])
  return out
}
