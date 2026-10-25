/**
 * Bulk edit: one change applied to many services, products, barbers or schedules. Price changes
 * are a new amount, a percent or a fixed step; schedule templates are a named week of shifts
 * applied to many barbers at one shop.
 */
import { z } from "zod";
import { WEEKDAYS, minutesToLabel } from "@/lib/time";

export const PriceChange = z.object({
  mode: z.enum(["set", "pct", "add"]),
  /** Cents for set and add; percent (10 = +10%) for pct. */
  value: z.number().finite(),
  /** Percent changes round to the cent or the whole dollar. */
  round: z.enum(["cent", "dollar"]).default("cent"),
});
export type PriceChange = z.output<typeof PriceChange>;

export const MAX_PRICE_CENTS = 1_000_000;

export function applyPriceChange(cents: number, ch: PriceChange): number {
  const raw = ch.mode === "set" ? ch.value : ch.mode === "add" ? cents + ch.value : cents * (1 + ch.value / 100);
  const rounded = ch.mode === "pct" && ch.round === "dollar" ? Math.round(raw / 100) * 100 : Math.round(raw);
  return Math.min(MAX_PRICE_CENTS, Math.max(0, rounded));
}

export const describePriceChange = (ch: PriceChange) =>
  ch.mode === "set" ? `set to $${(ch.value / 100).toFixed(2)}` : ch.mode === "add" ? `${ch.value >= 0 ? "+" : "−"}$${(Math.abs(ch.value) / 100).toFixed(2)}` : `${ch.value >= 0 ? "+" : ""}${ch.value}%${ch.round === "dollar" ? " (to the dollar)" : ""}`;

export const TemplateRow = z.object({
  weekday: z.number().int().min(0).max(6),
  startMin: z.number().int().min(0).max(24 * 60),
  endMin: z.number().int().min(0).max(24 * 60),
});
export type TemplateRow = z.output<typeof TemplateRow>;

export const ScheduleTemplateInput = z.object({
  id: z.uuid().nullish(),
  name: z.string().trim().min(1, "Name the template").max(60),
  rows: z.array(TemplateRow).max(28, "At most four shifts a day"),
});

/** A shift ends after it starts, and one day's shifts don't overlap. */
export function templateProblem(rows: TemplateRow[]): string | null {
  for (const r of rows) if (r.endMin <= r.startMin) return `${WEEKDAYS[r.weekday]}: ${minutesToLabel(r.endMin % (24 * 60))} is before ${minutesToLabel(r.startMin)}`;
  const sorted = [...rows].sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].weekday === sorted[i - 1].weekday && sorted[i].startMin < sorted[i - 1].endMin) return `${WEEKDAYS[sorted[i].weekday]}: two shifts overlap`;
  return null;
}

export const weeklyHours = (rows: TemplateRow[]) => rows.reduce((a, r) => a + (r.endMin - r.startMin), 0) / 60;

/** Per-row outcome of a bulk change, so one refusal doesn't hide the rest. */
export interface BulkResult {
  id: string;
  label: string;
  ok: boolean;
  error?: string;
}
export const bulkSummary = (rs: BulkResult[]) => {
  const ok = rs.filter((r) => r.ok).length;
  return rs.length === ok ? `Updated ${ok}` : `Updated ${ok} of ${rs.length}`;
};
