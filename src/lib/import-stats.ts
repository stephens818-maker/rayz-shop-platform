import type { ImportStats } from "@/server/importer";

const $ = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The reconciliation lines that matter for each file type. `kind: "all"` shows every non-zero line. */
export function statLines(kind: string, s: Partial<ImportStats>): [string, string][] {
  const n = (k: keyof ImportStats) => Number(s[k] ?? 0);
  const all = kind === "all";
  const lines: [string, number | string, boolean][] = [
    ["Clients created", n("clientsCreated"), kind === "clients" || n("clientsCreated") > 0],
    ["Clients updated", n("clientsUpdated"), kind === "clients" || (all && n("clientsUpdated") > 0)],
    ["Duplicates merged into one client", n("duplicatesMerged"), kind === "clients" || (all && n("duplicatesMerged") > 0)],
    ["Appointments imported", n("appointmentsImported"), kind === "appointments" || (all && n("appointmentsImported") > 0)],
    ["Appointments updated", n("appointmentsUpdated"), (kind === "appointments" || all) && n("appointmentsUpdated") > 0],
    ["Past visits", n("pastVisits"), kind === "appointments" || (all && n("pastVisits") > 0)],
    ["No-shows", n("noShows"), kind === "appointments" || (all && n("noShows") > 0)],
    ["Cancellations", n("cancellations"), kind === "appointments" || (all && n("cancellations") > 0)],
    ["Upcoming bookings", n("upcomingImported"), kind === "appointments" || (all && n("upcomingImported") > 0)],
    ["Tickets imported", n("salesImported"), kind === "transactions" || (all && n("salesImported") > 0)],
    ["Tickets linked to a visit", n("salesLinkedToVisits"), kind === "transactions" || (all && n("salesLinkedToVisits") > 0)],
    ["Voided/refunded in Squire", n("salesVoided"), kind === "transactions" || (all && n("salesVoided") > 0)],
    ["Ticket totals", $(n("salesTotalCents")), kind === "transactions" || (all && n("salesTotalCents") > 0)],
    ["Tips", $(n("tipsCents")), kind === "transactions" || (all && n("tipsCents") > 0)],
    ["Loyalty accounts", n("loyaltyAccounts"), kind === "loyalty" || n("loyaltyAccounts") > 0],
    ["Rewards available", n("rewardsImported"), kind === "loyalty" || n("rewardsImported") > 0],
    ["Gift cards", n("giftCards"), kind === "gift_cards" || (all && n("giftCards") > 0)],
    ["Gift card balances", $(n("giftCardBalanceCents")), kind === "gift_cards" || (all && n("giftCardBalanceCents") > 0)],
    ["Former barbers added (inactive)", n("formerBarbersCreated"), n("formerBarbersCreated") > 0],
    ["Already imported (no change)", n("alreadyImported"), n("alreadyImported") > 0],
  ];
  return lines.filter(([, , show]) => show).map(([l, v]) => [l, String(v)]);
}

/** Splits a saved run's stats into counters and `skipped:<reason>` tallies. */
export function splitRunStats(raw: Record<string, number> | null | undefined): { stats: Partial<ImportStats>; skipped: Record<string, number> } {
  const stats: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (k.startsWith("skipped:")) skipped[k.slice(8)] = v;
    else stats[k] = v;
  }
  return { stats: stats as Partial<ImportStats>, skipped };
}
