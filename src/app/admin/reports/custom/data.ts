import "server-only";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { roles, staff, staffShops } from "@/db/schema";
import type { FilterOptions, PanelSees } from "@/domain/client-filters";
import { reportView } from "@/domain/permissions";
import {
  EVENT_TYPES,
  REPORT_SOURCES,
  SOURCE_KEYS,
  reportLabel,
  sourceReport,
  allFields,
  fieldUse,
  type FieldDef,
  type FieldUse,
  type ReportSource,
} from "@/domain/report-builder";
import { can, openShops, type StaffContext } from "@/server/auth/staff";
import {
  listBarberGroups,
  barbersAt,
  visibleBarberGroups,
} from "@/server/barbers";
import { clientPolicy } from "@/server/client-privacy";
import { filterOptions, reportSees } from "@/server/client-filters";
import { listLocationGroups, visibleGroups } from "@/server/locations";
import { exportDenied } from "@/server/report-builder/saved";

type Option = { id: string; name: string };

export interface BuilderOptions {
  /** `needs`: why this person can't pick a source that's built. */
  sources: { key: string; label: string; ready: boolean; hint: string; needs?: string }[];
  /** Every field, with how this person may use it: hidden details are listed but can't be added. */
  fields: (FieldDef & { use: FieldUse })[];
  /** The event log's, sales' and appointments' fields; no event fields without "Use the event log". */
  sourceFields: Partial<Record<ReportSource, (FieldDef & { use: FieldUse })[]>>;
  /** The event types an event log report can pick. */
  eventTypes: { key: string; label: string; category: string }[];
  /** Null without "Use advanced client filters". */
  filters: FilterOptions | null;
  sees: PanelSees;
  shops: Option[];
  shopGroups: (Option & { shopIds: string[] })[];
  /** Null without "See every barber's numbers": a report covers only their own visits. */
  barbers: Option[] | null;
  barberGroups: (Option & { staffIds: string[] })[];
  roles: Option[];
  /** Staff at their shops with an email address, for scheduled emails. */
  recipients: Option[];
  may: {
    build: boolean;
    export: string | null;
    /** Why this person can't export a report over a source other than customers. */
    exportFlat: string | null;
    events: boolean;
    blast: boolean;
    template: boolean;
  };
  me: string;
}

/** Everything the builder's pickers offer this person. */
export async function builderOptions(
  ctx: StaffContext,
): Promise<BuilderOptions> {
  const policy = await clientPolicy(ctx);
  const sees = reportSees(ctx, policy);
  const allStaff = can(ctx, "reports.all_staff");
  const events = can(ctx, "analytics.events");
  const [filters, locGroups, visible, bGroups, roleRows, people] =
    await Promise.all([
      can(ctx, "clients.filters")
        ? filterOptions(ctx, policy)
        : Promise.resolve(null),
      listLocationGroups(),
      allStaff ? barbersAt(ctx.shopIds) : Promise.resolve([]),
      allStaff ? listBarberGroups() : Promise.resolve([]),
      db
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .orderBy(asc(roles.sortOrder), asc(roles.name)),
      db
        .selectDistinct({ id: staff.id, name: staff.displayLabel })
        .from(staff)
        .innerJoin(staffShops, eq(staffShops.staffId, staff.id))
        .where(
          and(
            eq(staff.active, true),
            eq(staff.kind, "person"),
            isNotNull(staff.email),
            ctx.brandWide
              ? undefined
              : inArray(
                  staffShops.shopId,
                  ctx.shopIds.length ? ctx.shopIds : [ctx.staff.id],
                ),
          ),
        )
        .orderBy(asc(staff.displayLabel)),
    ]);
  return {
    sources: REPORT_SOURCES.map((s) => {
      const report = sourceReport(s.key);
      const needs =
        s.key === "events" && !events
          ? "needs event log access"
          : report && !can(ctx, reportView(report))
            ? `needs "${reportLabel(report)}"`
            : undefined;
      return { key: s.key, label: s.label, hint: s.hint, ready: s.ready && !needs, needs };
    }),
    fields: allFields(policy.custom).map((f) => ({
      ...f,
      use: fieldUse(f, sees),
    })),
    sourceFields: Object.fromEntries(
      SOURCE_KEYS.filter((k) => k !== "customers" && (k !== "events" || events))
        .map((k) => [
          k,
          allFields([], k).map((f) => ({ ...f, use: fieldUse(f, sees) })),
        ]),
    ),
    eventTypes: events ? EVENT_TYPES : [],
    filters,
    sees,
    shops: openShops(ctx).map((s) => ({ id: s.id, name: s.name })),
    shopGroups: visibleGroups(locGroups, ctx.shopIds).map((g) => ({
      id: g.id,
      name: g.name,
      shopIds: g.shopIds.filter((id) => ctx.shopIds.includes(id)),
    })),
    barbers: allStaff
      ? visible
          .filter((b) => b.active !== false)
          .map((b) => ({ id: b.id, name: b.name }))
      : null,
    barberGroups: visibleBarberGroups(bGroups, visible).map((g) => ({
      id: g.id,
      name: g.name,
      staffIds: g.staffIds,
    })),
    roles: roleRows,
    recipients: people,
    may: {
      build: can(ctx, "report_builder.build"),
      export: exportDenied(ctx, "customers"),
      exportFlat: exportDenied(ctx, "events"),
      events,
      blast: can(ctx, "campaign_center.create"),
      template: ctx.brandWide,
    },
    me: ctx.staff.id,
  };
}
