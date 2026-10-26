import "server-only";
import { and, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { customers } from "@/db/schema";
import { decodeFilter, filterSees } from "@/domain/client-filters";
import { EMPTY_SEGMENT, segmentProblem, segmentShopIds, type Segment } from "@/domain/marketing";
import { can, type StaffContext } from "./auth/staff";
import { filteredClientIds, panelSees } from "./client-filters";
import type { ClientPolicy } from "./client-privacy";
import { findClients } from "./client-search";
import { shopClientsScope, visitedScope } from "./customers";

export interface ClientListQuery {
  /** The condition on `customers`: reach, search and filters. */
  where: SQL | undefined;
  /** Search relevance, best first, when searching. */
  relevance: SQL | null;
  seg: Segment;
  /** Why the filters were dropped: they'd read a detail this person doesn't see. */
  problem: string | null;
  matched: Map<string, string[]>;
}

/**
 * Which clients the list shows. Barbers: clients they've cut. Everyone with "every client": the
 * whole brand, one profile per person whichever shops they visit; home shop and shops visited are
 * filters, not walls. An export is a report, so it keeps to the exporter's shops' clients (home
 * shop or a visit there) unless they work brand-wide. Filters need "Use advanced client filters"
 * and are refused when they'd read a hidden detail.
 */
export async function clientListQuery(
  ctx: StaffContext,
  policy: ClientPolicy,
  input: { q: string; f?: string | null; now?: Date; purpose?: "list" | "export" },
): Promise<ClientListQuery> {
  const full = can(ctx, "clients.view_all");
  let seg = can(ctx, "clients.filters") ? decodeFilter(input.f) : EMPTY_SEGMENT;
  const outside = !ctx.brandWide && segmentShopIds(seg).some((s) => !ctx.shopIds.includes(s));
  const problem = outside ? "Those filters name a location outside your access" : segmentProblem(seg, filterSees(panelSees(ctx, policy)));
  if (problem) seg = EMPTY_SEGMENT;
  const found = input.q ? await findClients(ctx, policy, input.q, { via: "clients", limit: 500, ownClientsOf: full ? undefined : ctx.staff.id, record: false }) : null;
  const ids = found?.ranked.map((r) => r.id) ?? [];
  const search = found ? (ids.length ? inArray(customers.id, ids) : sql`false`) : undefined;
  const scope = !full ? visitedScope({ staffId: ctx.staff.id }) : input.purpose === "export" && !ctx.brandWide ? shopClientsScope(ctx.shopIds) : undefined;
  const filtered = await filteredClientIds(seg, input.now ?? new Date());
  const relevance = ids.length ? sql`array_position(array[${sql.join(
    ids.map((i) => sql`${i}::uuid`),
    sql`, `,
  )}], ${customers.id})` : null;
  return {
    where: and(isNull(customers.deletedAt), search, scope, filtered ? sql`${customers.id} in ${filtered}` : undefined),
    relevance,
    seg,
    problem,
    matched: new Map((found?.ranked ?? []).map((r) => [r.id, [...r.matched]])),
  };
}
