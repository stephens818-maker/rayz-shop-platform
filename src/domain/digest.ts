/**
 * The morning email to the owner and managers: yesterday's sales by shop, who's working, off and
 * blocked today, and what Today flagged. Each person gets only their own shops and what their
 * permissions show. Settings live in brand_settings.digest.
 */
import { z } from "zod";
import type { Alert } from "./today";
import { ALERT_LABEL, SEVERITY_ORDER } from "./today";

export const DIGEST_ROLE_DEFAULTS = ["brand_owner", "brand_admin", "regional_manager", "shop_manager"];

export const DigestSettings = z.object({
  enabled: z.boolean().default(true),
  /** Local minutes after midnight; the cron runs every 5 minutes, so it goes out within 5 of this. */
  sendAtMin: z.number().int().min(4 * 60).max(11 * 60).default(7 * 60),
  /** Role keys whose people get it. */
  roles: z.array(z.string()).default(DIGEST_ROLE_DEFAULTS),
  /** People who get it even though their role doesn't. */
  include: z.array(z.uuid()).default([]),
  /** People who asked not to. */
  exclude: z.array(z.uuid()).default([]),
  sections: z.object({ sales: z.boolean().default(true), staff: z.boolean().default(true), alerts: z.boolean().default(true) }).default({ sales: true, staff: true, alerts: true }),
  /** Skip days a shop is closed everywhere (Sundays by default). */
  skipClosedDays: z.boolean().default(true),
});
export type DigestSettings = z.output<typeof DigestSettings>;

export const digestSettings = (raw: unknown): DigestSettings => DigestSettings.parse(raw && typeof raw === "object" ? raw : {});

export interface DigestSalesRow {
  shop: string;
  netCents: number;
  tickets: number;
  priorCents: number;
}

export interface DigestStaffShop {
  shop: string;
  working: string[];
  off: string[];
  blocked: string[];
}

export interface DigestContent {
  firstName: string;
  dateLabel: string;
  yesterdayLabel: string;
  sales: DigestSalesRow[] | null;
  staff: DigestStaffShop[] | null;
  alerts: Alert[] | null;
  link: string;
}

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function renderDigest(d: DigestContent): { subject: string; body: string } {
  const lines: string[] = [`Good morning ${d.firstName},`, "", `Here's ${d.dateLabel}.`];
  const urgent = d.alerts?.filter((a) => a.severity === "high").length ?? 0;
  if (d.sales) {
    const total = d.sales.reduce((a, r) => a + r.netCents, 0);
    const prior = d.sales.reduce((a, r) => a + r.priorCents, 0);
    lines.push("", `SALES ${d.yesterdayLabel.toUpperCase()}`, `${money(total)} net${prior ? ` (${pct(total, prior)} vs the week before)` : ""}`);
    for (const r of d.sales) lines.push(`  ${r.shop}: ${money(r.netCents)}, ${r.tickets} ticket${r.tickets === 1 ? "" : "s"}${r.priorCents ? ` (${pct(r.netCents, r.priorCents)})` : ""}`);
  }
  if (d.staff) {
    lines.push("", "TEAM TODAY");
    if (!d.staff.length) lines.push("  Nobody is scheduled.");
    for (const s of d.staff) {
      lines.push(`  ${s.shop}`);
      lines.push(`    Working: ${s.working.join(", ") || "nobody"}`);
      if (s.off.length) lines.push(`    Off: ${s.off.join(", ")}`);
      if (s.blocked.length) lines.push(`    Blocked: ${s.blocked.join(", ")}`);
    }
  }
  if (d.alerts) {
    lines.push("", "NEEDS ATTENTION");
    if (!d.alerts.length) lines.push("  Nothing flagged.");
    for (const a of [...d.alerts].sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity])) {
      lines.push(`  ${a.severity === "high" ? "! " : "- "}${a.shop ? `${a.shop}: ` : ""}${a.title}`);
      if (a.detail) lines.push(`    ${a.detail}`);
    }
  }
  lines.push("", `Open Today: ${d.link}`, "", "You get this because you manage one of the shops. Change who gets it under Setup → Morning digest.");
  const subject = `Ray'z ${d.dateLabel}${urgent ? `: ${urgent} urgent` : d.alerts?.length ? `: ${d.alerts.length} to look at` : ""}`;
  return { subject, body: lines.join("\n") };
}

const pct = (a: number, b: number) => {
  const x = Math.round(((a - b) / b) * 100);
  return `${x >= 0 ? "up" : "down"} ${Math.abs(x)}%`;
};

export const alertLine = (a: Alert) => `${ALERT_LABEL[a.type]}: ${a.title}`;
