import "server-only";
import { payPeriodFor } from "@/domain/payroll";
import { LocalDate, addDays, isValidLocalDate, todayLocal, weekdayOf } from "@/lib/time";
import { StaffContext, reportShopIds } from "@/server/auth/staff";
import type { ReportScope } from "@/server/reports";

export type ReportParams = { preset?: string; from?: string; to?: string; shop?: string; staff?: string };

export const PRESETS: { id: string; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "week", label: "This week" },
  { id: "7d", label: "Last 7 days" },
  { id: "month", label: "This month" },
  { id: "lastmonth", label: "Last month" },
  { id: "payperiod", label: "This pay period" },
  { id: "lastpayperiod", label: "Last pay period" },
  { id: "30d", label: "Last 30 days" },
  { id: "ytd", label: "Year to date" },
];

export function presetRange(id: string, today: LocalDate = todayLocal()): { from: LocalDate; to: LocalDate } {
  const [y, m] = today.split("-").map(Number);
  const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
  switch (id) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case "week":
      return { from: addDays(today, -weekdayOf(today)), to: today };
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "month":
      return { from: monthStart, to: today };
    case "lastmonth": {
      const end = addDays(monthStart, -1);
      return { from: `${end.slice(0, 7)}-01`, to: end };
    }
    case "payperiod": {
      const p = payPeriodFor(today);
      return { from: p.start, to: today < p.end ? today : p.end };
    }
    case "lastpayperiod": {
      const p = payPeriodFor(addDays(payPeriodFor(today).start, -1));
      return { from: p.start, to: p.end };
    }
    case "ytd":
      return { from: `${y}-01-01`, to: today };
    default:
      return { from: addDays(today, -6), to: today };
  }
}

export function resolveScope(ctx: StaffContext, p: ReportParams): ReportScope & { preset: string | null; shopParam: string | null } {
  const custom = p.from && p.to && isValidLocalDate(p.from) && isValidLocalDate(p.to);
  const preset = custom ? null : (p.preset ?? "7d");
  let { from, to } = custom ? { from: p.from!, to: p.to! } : presetRange(preset!);
  if (from > to) [from, to] = [to, from];
  const shopIds = reportShopIds(ctx, p.shop ?? null);
  const staffId = ctx.isBarber ? ctx.staff.id : p.staff || null;
  return { shopIds, from, to, staffId, preset, shopParam: p.shop ?? null };
}
