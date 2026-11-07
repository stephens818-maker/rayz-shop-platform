import type { Permission } from "./permissions";

/**
 * Tip pools (ST-N7). Ray'z has none: a ticket's tip goes to the barbers on its services
 * (tipWeights in src/domain/handoff.ts), each for work they did themselves. If a shared pool is
 * ever added, owners, managers and supervisors can't take from it (FLSA section 3(m)(2)(B); they
 * keep only tips for services they provide themselves), so every pool's members go through
 * tipPoolProblem.
 */

/** Holding any of these makes someone a manager or supervisor for tip pooling: they hire, schedule, direct or pay others. */
export const TIP_POOL_EXCLUDED_PERMISSIONS: readonly Permission[] = [
  "staff.manage",
  "schedules.edit",
  "timesheet.edit",
  "timesheet.approve",
  "timeoff.approve",
  "payroll.run",
  "payroll.approve",
  "compensation.edit",
  "permissions.manage",
  "tips.approve",
];

export interface PoolMember {
  staffId: string;
  label: string;
  isOwner: boolean;
  permissions: ReadonlySet<Permission>;
}

export const poolExcluded = (m: Pick<PoolMember, "isOwner" | "permissions">) => m.isOwner || TIP_POOL_EXCLUDED_PERMISSIONS.some((p) => m.permissions.has(p));

/** Null when everyone may share the pool; otherwise who can't, and why. */
export function tipPoolProblem(members: readonly PoolMember[]): string | null {
  const out = members.filter(poolExcluded);
  if (!out.length) return null;
  return `${out.map((m) => m.label).join(", ")} can't share a tip pool: owners, managers and supervisors keep only the tips for services they provide themselves.`;
}
